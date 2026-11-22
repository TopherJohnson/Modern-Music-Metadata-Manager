"""MusicBrainz release search, Cover Art Archive proxy, and one-click album apply endpoints."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query, Request, Response

from app.models import (
    BulkUpdateError,
    MusicBrainzApplyRequest,
    MusicBrainzApplyResponse,
    MusicBrainzApplyTrackRequest,
    MusicBrainzApplyTrackResponse,
    MusicBrainzReleaseCandidate,
    MusicBrainzReleaseDetail,
    MusicBrainzTrackCandidate,
    TrackMetadata,
)
from app.routers._deps import resolve_library
from app.services.musicbrainz import (
    MusicBrainzError,
    fetch_cover_art,
    get_release_detail,
    search_recordings,
    search_releases,
)
from app.services.navidrome import trigger_navidrome_scan
from app.services.tags import (
    EDITABLE_FIELDS,
    read_track_metadata,
    write_track_artwork,
    write_track_metadata,
)

router = APIRouter(prefix="/api/musicbrainz", tags=["musicbrainz"])


def _tag_snapshot(track: TrackMetadata) -> dict[str, str | None]:
    return {field: getattr(track, field) for field in EDITABLE_FIELDS}


@router.get("/search", response_model=list[MusicBrainzReleaseCandidate])
async def search_musicbrainz_releases(
    album: str = Query(..., min_length=1, description="Album title to search on MusicBrainz"),
    artist: str | None = Query(default=None, description="Optional artist name"),
    limit: int = Query(default=10, ge=1, le=20),
) -> list[MusicBrainzReleaseCandidate]:
    """Search MusicBrainz for candidate album releases."""
    try:
        return await search_releases(album=album, artist=artist, limit=limit)
    except MusicBrainzError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/release/{mbid}", response_model=MusicBrainzReleaseDetail)
async def get_musicbrainz_release(mbid: str) -> MusicBrainzReleaseDetail:
    """Fetch detailed release metadata and tracklist for a MusicBrainz release ID."""
    try:
        return await get_release_detail(mbid)
    except MusicBrainzError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/cover/{mbid}")
async def proxy_musicbrainz_cover(
    mbid: str,
    size: int = Query(default=500, description="Preferred Cover Art Archive thumbnail size (250, 500, or 1200)"),
) -> Response:
    """Proxy Cover Art Archive front cover image so the UI previews releases cleanly."""
    try:
        result = await fetch_cover_art(mbid, size=size)
    except MusicBrainzError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if result is None:
        raise HTTPException(status_code=404, detail="No cover art available on Cover Art Archive.")

    image_bytes, mime_type = result
    return Response(
        content=image_bytes,
        media_type=mime_type,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.post("/apply", response_model=MusicBrainzApplyResponse)
async def apply_musicbrainz_release(
    request: Request,
    payload: MusicBrainzApplyRequest,
) -> MusicBrainzApplyResponse:
    """Apply metadata and/or cover art from a chosen MusicBrainz release onto target tracks."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    if not payload.apply_metadata and not payload.apply_artwork and not payload.apply_track_titles:
        raise HTTPException(
            status_code=400,
            detail="Select at least one option (metadata, artwork, or track titles) to apply.",
        )

    release: MusicBrainzReleaseDetail | None = None
    if payload.apply_metadata or payload.apply_track_titles:
        try:
            release = await get_release_detail(payload.mbid)
        except MusicBrainzError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    cover_result: tuple[bytes, str] | None = None
    artwork_note: str | None = None
    if payload.apply_artwork:
        try:
            cover_result = await fetch_cover_art(payload.mbid, size=1200)
        except MusicBrainzError as exc:
            artwork_note = str(exc)
        if cover_result is None and artwork_note is None:
            artwork_note = "No cover image found on Cover Art Archive for this release."
            if not payload.apply_metadata and not payload.apply_track_titles:
                raise HTTPException(status_code=404, detail=artwork_note)

    target_paths = list(dict.fromkeys(payload.paths))
    tag_batch_id = uuid.uuid4().hex[:12] if len(target_paths) > 1 else None
    art_batch_id = uuid.uuid4().hex[:12] if len(target_paths) > 1 else None

    # Build album-level tag updates from MusicBrainz release
    shared_updates: dict[str, str | None] = {}
    if payload.apply_metadata and release is not None:
        shared_updates = {
            "album": release.title,
            "album_artist": release.artist,
            "year": release.year,
            "release_date": release.date,
            "album_version": release.disambiguation,
            "compilation": "1" if release.compilation else None,
            "musicbrainz_album_id": release.mbid,
            "musicbrainz_album_artist_id": release.artist_mbid,
        }
        if release.genre:
            shared_updates["genre"] = release.genre

    updated: list[TrackMetadata] = []
    errors: list[BulkUpdateError] = []
    artwork_applied = False

    for idx, rel_path in enumerate(target_paths):
        try:
            file_updates = dict(shared_updates)
            if (
                payload.apply_track_titles
                and release is not None
                and idx < len(release.tracks)
            ):
                mb_track = release.tracks[idx]
                file_updates["title"] = mb_track.title
                file_updates["track_number"] = f"{mb_track.track_number}/{mb_track.track_total}"
                file_updates["disc_number"] = f"{mb_track.disc_number}/{mb_track.disc_total}"
                if mb_track.artist:
                    file_updates["artist"] = mb_track.artist

            after: TrackMetadata | None = None
            if file_updates:
                before, after = write_track_metadata(lib.path, rel_path, file_updates)
                db.record_audit(
                    path=after.path,
                    action="musicbrainz_apply",
                    before_tags=_tag_snapshot(before),
                    after_tags=_tag_snapshot(after),
                    library_id=lib.id,
                    batch_id=tag_batch_id,
                )

            if cover_result is not None:
                img_bytes, img_mime = cover_result
                after = write_track_artwork(
                    lib.path,
                    rel_path,
                    img_bytes,
                    mime_type=img_mime,
                )
                artwork_applied = True
                db.record_audit(
                    path=after.path,
                    action="musicbrainz_artwork",
                    before_tags={},
                    after_tags={"mbid": payload.mbid, "artwork_hash": after.artwork_hash},
                    library_id=lib.id,
                    batch_id=art_batch_id,
                )

            if after is None:
                after = read_track_metadata(lib.path, rel_path)
            updated.append(after)
        except Exception as exc:
            errors.append(BulkUpdateError(path=rel_path, error=str(exc)))

    if updated:
        db.upsert_tracks(updated, library_id=lib.id)

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=payload.trigger_navidrome_scan and bool(updated)
    )
    return MusicBrainzApplyResponse(
        updated=updated,
        errors=errors,
        navidrome_sync=navidrome_sync,
        artwork_applied=artwork_applied,
        artwork_note=artwork_note,
    )


@router.get("/search/track", response_model=list[MusicBrainzTrackCandidate])
async def search_musicbrainz_track(
    title: str = Query(default="", description="Track title or guessed name from filename"),
    artist: str | None = Query(default=None, description="Optional artist name"),
    album: str | None = Query(default=None, description="Optional album name"),
    duration: float | None = Query(default=None, description="Local track duration in seconds for ranking"),
    limit: int = Query(default=12, ge=1, le=20),
) -> list[MusicBrainzTrackCandidate]:
    """Search MusicBrainz recordings to identify an individual track."""
    if not (title.strip() or (artist and artist.strip()) or (album and album.strip())):
        raise HTTPException(
            status_code=400,
            detail="Provide at least a track title, artist, or album to search.",
        )
    try:
        return await search_recordings(
            title=title,
            artist=artist,
            album=album,
            duration_sec=duration,
            limit=limit,
        )
    except MusicBrainzError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/apply/track", response_model=MusicBrainzApplyTrackResponse)
async def apply_musicbrainz_track(
    request: Request,
    payload: MusicBrainzApplyTrackRequest,
) -> MusicBrainzApplyTrackResponse:
    """Apply a MusicBrainz single-track match (metadata + optional cover art) to one audio file."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    updates: dict[str, str | None] = {
        "title": payload.title,
        "artist": payload.artist,
        "album_artist": payload.album_artist or payload.artist,
        "album": payload.album,
        "year": payload.year,
        "release_date": payload.release_date,
        "track_number": payload.track_number,
        "disc_number": payload.disc_number,
        "musicbrainz_album_id": payload.release_mbid,
        "musicbrainz_album_artist_id": payload.artist_mbid,
    }

    # If a release MBID was matched, enrich genre / compilation / version gracefully
    if payload.release_mbid:
        try:
            detail = await get_release_detail(payload.release_mbid)
            if detail.genre:
                updates["genre"] = detail.genre
            if detail.disambiguation:
                updates["album_version"] = detail.disambiguation
            if detail.compilation:
                updates["compilation"] = "1"
        except MusicBrainzError:
            pass

    try:
        before, after = write_track_metadata(lib.path, payload.path, updates)
        db.record_audit(
            path=after.path,
            action="musicbrainz_apply_track",
            before_tags=_tag_snapshot(before),
            after_tags=_tag_snapshot(after),
            library_id=lib.id,
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Failed to write track tags: {exc}") from exc

    artwork_applied = False
    artwork_note: str | None = None
    if payload.apply_artwork and payload.release_mbid:
        try:
            cover_result = await fetch_cover_art(payload.release_mbid, size=1200)
            if cover_result is not None:
                img_bytes, img_mime = cover_result
                after = write_track_artwork(
                    lib.path,
                    payload.path,
                    img_bytes,
                    mime_type=img_mime,
                )
                artwork_applied = True
                db.record_audit(
                    path=after.path,
                    action="musicbrainz_artwork",
                    before_tags={},
                    after_tags={"mbid": payload.release_mbid, "artwork_hash": after.artwork_hash},
                    library_id=lib.id,
                )
            else:
                artwork_note = "No cover image found on Cover Art Archive for this release."
        except Exception as exc:
            artwork_note = f"Tags saved, but cover art failed: {exc}"

    db.upsert_tracks([after], library_id=lib.id)
    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=payload.trigger_navidrome_scan
    )
    return MusicBrainzApplyTrackResponse(
        track=after,
        navidrome_sync=navidrome_sync,
        artwork_applied=artwork_applied,
        artwork_note=artwork_note,
    )
