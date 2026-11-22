"""Album completeness verification (MusicBrainz), missing-track ignore rules, and local stray-track search (Issue #5)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.models import (
    AlbumCompletenessRequest,
    AlbumCompletenessResponse,
    AlbumGroup,
    BulkMissingTrackIgnoreRequest,
    LibrarySearchMissingResponse,
    MissingTrackIgnoreRequest,
)
from app.routers._deps import resolve_library
from app.services.completeness import (
    apply_ignore_rules,
    attach_auto_candidates,
    detect_musicbrainz_missing_tracks,
    get_primary_album_mbid,
    search_library_for_missing_track,
)
from app.services.musicbrainz import MusicBrainzError, get_release_detail
from app.services.scanner import build_library_response, scan_library

router = APIRouter(prefix="/api/albums/completeness", tags=["completeness"])


def _load_all_albums(request: Request) -> tuple[str, list[AlbumGroup]]:
    db = request.app.state.db
    lib = resolve_library(request)
    tracks = scan_library(lib.path, db, force_rescan=False, library_id=lib.id)
    lib_response = build_library_response(
        tracks,
        organize_settings=db.get_organize_settings(library_id=lib.id),
    )
    all_albums = [album for artist in lib_response.artists for album in artist.albums]
    return lib.id, all_albums


@router.post("/check", response_model=AlbumCompletenessResponse)
async def check_album_completeness(
    request: Request,
    payload: AlbumCompletenessRequest,
) -> AlbumCompletenessResponse:
    """Verify an album against a MusicBrainz release tracklist (cached in /config/m4.db)."""
    db = request.app.state.db
    library_id, all_albums = _load_all_albums(request)

    album = next((a for a in all_albums if a.id == payload.album_id), None)
    if album is None:
        raise HTTPException(status_code=404, detail="Album not found in the active library.")

    saved_links = db.get_album_mb_links(library_id=library_id)
    mbid = (
        (payload.mbid or "").strip().lower()
        or saved_links.get(album.id)
        or get_primary_album_mbid(album)
    )
    if not mbid:
        raise HTTPException(
            status_code=400,
            detail="No MusicBrainz Album ID is tagged on this album yet. Pick a release to check completeness.",
        )

    cached = False
    detail = None if payload.force_refresh else db.get_mb_release_cache(mbid)
    if detail is not None:
        cached = True
    else:
        try:
            detail = await get_release_detail(mbid)
        except MusicBrainzError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        db.save_mb_release_cache(detail)

    db.save_album_mb_link(album.id, detail.mbid, library_id=library_id)

    missing_items = detect_musicbrainz_missing_tracks(album, detail)
    if missing_items:
        attach_auto_candidates(album, missing_items, all_albums)

    ignores = db.get_missing_track_ignores(library_id=library_id).get(album.id, set())
    items, active_count, _ = apply_ignore_rules(album, missing_items, ignores)

    return AlbumCompletenessResponse(
        album_id=album.id,
        mbid=detail.mbid,
        release_title=detail.title,
        release_artist=detail.artist,
        release_track_count=len(detail.tracks) or detail.track_count,
        cached=cached,
        missing_tracks=items,
        missing_track_count=active_count,
    )


@router.post("/ignore")
async def set_missing_track_ignore(
    request: Request,
    payload: MissingTrackIgnoreRequest,
) -> dict[str, bool]:
    """Ignore or re-enable missing-track checks for a whole album or a specific track slot."""
    db = request.app.state.db
    lib = resolve_library(request)

    db.set_missing_track_ignore(
        payload.album_id,
        disc_number=payload.disc_number,
        track_number=payload.track_number,
        ignore=payload.ignore,
        clear_all=payload.clear_all,
        library_id=lib.id,
    )
    return {"ok": True}


@router.post("/ignore/bulk")
async def bulk_set_missing_track_ignore(
    request: Request,
    payload: BulkMissingTrackIgnoreRequest,
) -> dict[str, int | bool]:
    """Bulk ignore or re-enable missing-track checks across multiple selected albums."""
    db = request.app.state.db
    lib = resolve_library(request)

    updated_count = db.bulk_set_album_missing_ignore(
        payload.album_ids,
        ignore=payload.ignore,
        library_id=lib.id,
    )
    return {"ok": True, "updated_count": updated_count}


@router.get("/search-library", response_model=LibrarySearchMissingResponse)
async def search_library_missing_track(
    request: Request,
    album_id: str = Query(..., description="Target album ID to exclude from results"),
    q: str | None = Query(default=None, description="Missing track title or search phrase"),
    artist: str | None = Query(default=None, description="Expected track or album artist"),
    length_ms: int | None = Query(default=None, description="Optional MusicBrainz duration in milliseconds"),
    limit: int = Query(default=25, ge=1, le=50),
) -> LibrarySearchMissingResponse:
    """Search the active library outside `album_id` for stray tracks that might fill a missing slot."""
    _, all_albums = _load_all_albums(request)
    target_album = next((a for a in all_albums if a.id == album_id), None)
    effective_artist = (artist or "").strip() or (
        target_album.artist if target_album and target_album.artist != "Unknown Artist" else None
    )

    candidates = search_library_for_missing_track(
        all_albums,
        target_album_id=album_id,
        query=(q or "").strip() or None,
        artist=effective_artist,
        length_ms=length_ms,
        min_score=35 if (q and q.strip()) else 45,
        limit=limit,
    )
    return LibrarySearchMissingResponse(candidates=candidates)
