"""Track inspection, single/bulk tag editing, raw tag viewer, and embedded cover art endpoints."""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, Response, UploadFile

from app.models import (
    AlbumMergeRequest,
    AlbumMergeResponse,
    BulkUpdateError,
    BulkUpdateRequest,
    BulkUpdateResponse,
    CopyArtworkRequest,
    OrganizeMoveResult,
    RawTagsResponse,
    TrackDeleteResponse,
    TrackMetadata,
    TrackUpdateRequest,
    TrackUpdateResponse,
)
from app.routers._deps import resolve_library
from app.services.navidrome import trigger_navidrome_scan
from app.services.organizer import (
    _TRACK_SIDECAR_EXTS,
    _prune_empty_parents,
    apply_organize_plan,
)
from app.services.scanner import scan_library
from app.services.tags import (
    EDITABLE_FIELDS,
    InvalidTrackPathError,
    TagServiceError,
    TrackNotFoundError,
    delete_track_artwork,
    read_raw_tags,
    read_track_artwork,
    read_track_metadata,
    resolve_track_path,
    write_track_artwork,
    write_track_metadata,
)

router = APIRouter(prefix="/api", tags=["tracks"])

MAX_ARTWORK_BYTES = 15 * 1024 * 1024  # 15 MiB
ALLOWED_IMAGE_MIMES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"}


def _tag_snapshot(track: TrackMetadata) -> dict[str, str | None]:
    return {field: getattr(track, field) for field in EDITABLE_FIELDS}


def _raise_http_for_tag_error(exc: Exception) -> None:
    if isinstance(exc, TrackNotFoundError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, InvalidTrackPathError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, PermissionError):
        raise HTTPException(
            status_code=403,
            detail="Permission denied writing audio file. Verify PUID/PGID and music mount permissions.",
        ) from exc
    if isinstance(exc, TagServiceError):
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    raise HTTPException(status_code=500, detail=f"Audio tag error: {exc}") from exc


@router.get("/track", response_model=TrackMetadata)
async def get_track(
    request: Request,
    path: str = Query(..., description="Relative POSIX path of the track inside the active library"),
) -> TrackMetadata:
    """Read live metadata for a single audio track directly from disk."""
    db = request.app.state.db
    lib = resolve_library(request)
    try:
        track = read_track_metadata(lib.path, path)
    except Exception as exc:
        _raise_http_for_tag_error(exc)
    db.upsert_tracks([track], library_id=lib.id)
    return track


@router.get("/track/raw", response_model=RawTagsResponse)
async def get_track_raw_tags(
    request: Request,
    path: str = Query(..., description="Relative POSIX path of the track inside the active library"),
) -> RawTagsResponse:
    """Return all raw tag frames/keys directly from disk for inspecting hidden Navidrome grouping tags."""
    lib = resolve_library(request)
    try:
        return read_raw_tags(lib.path, path)
    except Exception as exc:
        _raise_http_for_tag_error(exc)


@router.put("/track", response_model=TrackUpdateResponse)
async def put_track(
    request: Request,
    payload: TrackUpdateRequest,
) -> TrackUpdateResponse:
    """Write updated metadata tags directly to an audio file on disk."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    updates = {
        field: getattr(payload, field)
        for field in EDITABLE_FIELDS
        if field in payload.model_fields_set
    }

    try:
        if updates:
            before, after = write_track_metadata(lib.path, payload.path, updates)
            db.upsert_tracks([after], library_id=lib.id)
            db.record_audit(
                path=after.path,
                action="update_track",
                before_tags=_tag_snapshot(before),
                after_tags=_tag_snapshot(after),
                library_id=lib.id,
            )
        else:
            after = read_track_metadata(lib.path, payload.path)
            db.upsert_tracks([after], library_id=lib.id)
    except Exception as exc:
        _raise_http_for_tag_error(exc)

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=payload.trigger_navidrome_scan and bool(updates)
    )
    return TrackUpdateResponse(track=after, navidrome_sync=navidrome_sync)


@router.delete("/track", response_model=TrackDeleteResponse)
async def delete_track(
    request: Request,
    path: str = Query(..., description="Relative POSIX path of the track inside the active library"),
    delete_sidecars: bool = Query(default=True, description="Also delete matching track-level sidecars (.lrc/.txt)"),
    cleanup_empty_dirs: bool = Query(default=True, description="Remove empty parent directories after deletion"),
    trigger_navidrome_scan_flag: bool = Query(default=True, alias="trigger_navidrome_scan"),
) -> TrackDeleteResponse:
    """Permanently delete a single audio track file (and optional matching sidecars) from disk."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)
    root = lib.path.resolve()

    try:
        file_path, rel_path = resolve_track_path(root, path)
    except Exception as exc:
        _raise_http_for_tag_error(exc)

    # Best-effort metadata snapshot for the audit log (allow deleting even corrupted files)
    before_audit: dict[str, str | None] = {"path": rel_path}
    try:
        snap = read_track_metadata(root, rel_path)
        before_audit.update(
            {
                "title": snap.title,
                "artist": snap.artist,
                "album": snap.album,
                "format": snap.format,
            }
        )
    except Exception:
        pass

    parent_dir = file_path.parent
    stem_low = file_path.stem.casefold()

    try:
        file_path.unlink()
    except Exception as exc:
        _raise_http_for_tag_error(exc)

    deleted_sidecars: list[str] = []
    if delete_sidecars and parent_dir.is_dir():
        for sibling in sorted(parent_dir.iterdir()):
            if (
                sibling.is_file()
                and sibling.suffix.lower() in _TRACK_SIDECAR_EXTS
                and sibling.stem.casefold() == stem_low
            ):
                try:
                    sc_rel = sibling.relative_to(root).as_posix()
                    sibling.unlink()
                    deleted_sidecars.append(sc_rel)
                except OSError:
                    pass

    removed_empty_dirs = 0
    if cleanup_empty_dirs:
        removed_empty_dirs = _prune_empty_parents(parent_dir, root)

    db.remove_paths([rel_path], library_id=lib.id)
    after_audit: dict[str, object] = {"deleted": "true"}
    if deleted_sidecars:
        after_audit["deleted_sidecars"] = ", ".join(deleted_sidecars)
    db.record_audit(
        path=rel_path,
        action="delete_track",
        before_tags=before_audit,
        after_tags=after_audit,
        library_id=lib.id,
    )

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=trigger_navidrome_scan_flag
    )
    return TrackDeleteResponse(
        deleted_path=rel_path,
        deleted_sidecars=deleted_sidecars,
        removed_empty_dirs=removed_empty_dirs,
        navidrome_sync=navidrome_sync,
    )


@router.put("/tracks/bulk", response_model=BulkUpdateResponse)
async def put_tracks_bulk(
    request: Request,
    payload: BulkUpdateRequest,
) -> BulkUpdateResponse:
    """Apply shared tag edits across multiple tracks (e.g. album-level bulk update)."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    updates = {
        field: getattr(payload, field)
        for field in EDITABLE_FIELDS
        if field in payload.model_fields_set
    }

    target_paths = list(dict.fromkeys(payload.paths))
    batch_id = uuid.uuid4().hex[:12] if len(target_paths) > 1 else None

    updated: list[TrackMetadata] = []
    errors: list[BulkUpdateError] = []

    for rel_path in target_paths:
        try:
            if updates:
                before, after = write_track_metadata(lib.path, rel_path, updates)
                db.record_audit(
                    path=after.path,
                    action="bulk_update",
                    before_tags=_tag_snapshot(before),
                    after_tags=_tag_snapshot(after),
                    library_id=lib.id,
                    batch_id=batch_id,
                )
            else:
                after = read_track_metadata(lib.path, rel_path)
            updated.append(after)
        except Exception as exc:
            errors.append(BulkUpdateError(path=rel_path, error=str(exc)))

    if updated:
        db.upsert_tracks(updated, library_id=lib.id)

    navidrome_sync = await trigger_navidrome_scan(
        settings,
        requested=payload.trigger_navidrome_scan and bool(updated) and bool(updates),
    )
    return BulkUpdateResponse(
        updated=updated,
        errors=errors,
        navidrome_sync=navidrome_sync,
    )


_CANONICAL_ALBUM_FIELDS: tuple[str, ...] = (
    "album",
    "album_artist",
    "year",
    "release_date",
    "genre",
    "album_version",
    "compilation",
    "musicbrainz_album_id",
    "musicbrainz_album_artist_id",
)


@router.post("/albums/merge", response_model=AlbumMergeResponse)
async def merge_albums(
    request: Request,
    payload: AlbumMergeRequest,
) -> AlbumMergeResponse:
    """Merge multiple albums or move stray tracks into a unified canonical album.

    Applies shared album & Navidrome PID tags, optional per-track disc/track number
    overrides, optional cover art unification, and optional folder consolidation under
    a single undoable audit batch.
    """
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    shared_updates: dict[str, str | None] = {
        field: getattr(payload, field)
        for field in _CANONICAL_ALBUM_FIELDS
        if field in payload.model_fields_set
    }
    shared_updates["album"] = payload.album.strip()

    artwork: tuple[bytes, str] | None = None
    if payload.artwork_source_path:
        try:
            artwork = read_track_artwork(lib.path, payload.artwork_source_path)
        except Exception as exc:
            _raise_http_for_tag_error(exc)
        if artwork is None:
            raise HTTPException(
                status_code=404,
                detail="Selected artwork source track has no embedded cover image.",
            )

    target_paths = list(dict.fromkeys(payload.paths))
    overrides_by_path = {ov.path: ov for ov in payload.track_overrides}
    batch_id = uuid.uuid4().hex[:12] if len(target_paths) > 1 else None
    art_batch_id = (
        uuid.uuid4().hex[:12] if (artwork is not None and len(target_paths) > 1) else None
    )

    updated: list[TrackMetadata] = []
    errors: list[BulkUpdateError] = []
    artwork_applied = False

    for rel_path in target_paths:
        try:
            file_updates = dict(shared_updates)
            ov = overrides_by_path.get(rel_path)
            if ov is not None:
                if "track_number" in ov.model_fields_set:
                    file_updates["track_number"] = ov.track_number
                if "disc_number" in ov.model_fields_set:
                    file_updates["disc_number"] = ov.disc_number

            before, after = write_track_metadata(lib.path, rel_path, file_updates)
            db.record_audit(
                path=after.path,
                action="merge_albums",
                before_tags=_tag_snapshot(before),
                after_tags=_tag_snapshot(after),
                library_id=lib.id,
                batch_id=batch_id,
            )

            if artwork is not None and rel_path != payload.artwork_source_path:
                img_bytes, img_mime = artwork
                after = write_track_artwork(
                    lib.path,
                    rel_path,
                    img_bytes,
                    mime_type=img_mime,
                )
                artwork_applied = True
                db.record_audit(
                    path=after.path,
                    action="copy_artwork",
                    before_tags={},
                    after_tags={
                        "source_path": payload.artwork_source_path,
                        "artwork_hash": after.artwork_hash,
                    },
                    library_id=lib.id,
                    batch_id=art_batch_id,
                )

            updated.append(after)
        except Exception as exc:
            errors.append(BulkUpdateError(path=rel_path, error=str(exc)))

    if updated:
        db.upsert_tracks(updated, library_id=lib.id)

    moved: list[OrganizeMoveResult] = []
    moved_sidecars: list[OrganizeMoveResult] = []
    removed_empty_dirs = 0

    if payload.reorganize and updated:
        org_settings = db.get_organize_settings(library_id=lib.id)
        all_tracks = scan_library(lib.path, db, library_id=lib.id)
        moved, moved_sidecars, _skipped, move_errors, removed_empty_dirs = (
            apply_organize_plan(
                lib.path,
                db,
                all_tracks,
                org_settings,
                filter_paths=[t.path for t in updated],
                library_id=lib.id,
            )
        )
        errors.extend(move_errors)
        if moved:
            moved_map = {m.source_path: m.target_path for m in moved}
            refreshed_updated: list[TrackMetadata] = []
            for track in updated:
                new_path = moved_map.get(track.path)
                if new_path:
                    try:
                        refreshed_updated.append(read_track_metadata(lib.path, new_path))
                        continue
                    except Exception:
                        pass
                refreshed_updated.append(track)
            updated = refreshed_updated

    navidrome_sync = await trigger_navidrome_scan(
        settings,
        requested=payload.trigger_navidrome_scan and (bool(updated) or bool(moved)),
    )
    return AlbumMergeResponse(
        updated=updated,
        errors=errors,
        navidrome_sync=navidrome_sync,
        batch_id=batch_id,
        artwork_applied=artwork_applied,
        moved=moved,
        moved_sidecars=moved_sidecars,
        removed_empty_dirs=removed_empty_dirs,
    )


@router.get("/track/artwork")
async def get_track_artwork(
    request: Request,
    path: str = Query(..., description="Relative POSIX path of the track inside the active library"),
) -> Response:
    """Return the embedded front cover image for a track."""
    lib = resolve_library(request)
    try:
        artwork = read_track_artwork(lib.path, path)
    except Exception as exc:
        _raise_http_for_tag_error(exc)

    if artwork is None:
        raise HTTPException(status_code=404, detail="Track has no embedded artwork.")

    image_bytes, mime_type = artwork
    return Response(
        content=image_bytes,
        media_type=mime_type,
        headers={"Cache-Control": "no-cache"},
    )


@router.post("/track/artwork/copy", response_model=BulkUpdateResponse)
async def copy_track_artwork(
    request: Request,
    payload: CopyArtworkRequest,
) -> BulkUpdateResponse:
    """Copy an existing track's embedded cover artwork onto one or more target tracks."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    try:
        artwork = read_track_artwork(lib.path, payload.source_path)
    except Exception as exc:
        _raise_http_for_tag_error(exc)

    if artwork is None:
        raise HTTPException(
            status_code=404,
            detail="Source track has no embedded cover artwork to copy.",
        )

    image_bytes, mime_type = artwork
    target_paths = list(dict.fromkeys(payload.target_paths))
    batch_id = uuid.uuid4().hex[:12] if len(target_paths) > 1 else None

    updated: list[TrackMetadata] = []
    errors: list[BulkUpdateError] = []

    for rel_path in target_paths:
        try:
            after = write_track_artwork(
                lib.path,
                rel_path,
                image_bytes,
                mime_type=mime_type,
            )
            db.record_audit(
                path=after.path,
                action="copy_artwork",
                before_tags={},
                after_tags={
                    "source_path": payload.source_path,
                    "artwork_hash": after.artwork_hash,
                },
                library_id=lib.id,
                batch_id=batch_id,
            )
            updated.append(after)
        except Exception as exc:
            errors.append(BulkUpdateError(path=rel_path, error=str(exc)))

    if updated:
        db.upsert_tracks(updated, library_id=lib.id)

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=payload.trigger_navidrome_scan and bool(updated)
    )
    return BulkUpdateResponse(
        updated=updated,
        errors=errors,
        navidrome_sync=navidrome_sync,
    )


@router.put("/track/artwork", response_model=BulkUpdateResponse)
async def put_track_artwork(
    request: Request,
    file: UploadFile = File(...),
    path: str | None = Form(default=None),
    paths: str | None = Form(default=None, description="Optional JSON array of track paths for bulk album artwork"),
    trigger_navidrome_scan_flag: bool = Form(default=True, alias="trigger_navidrome_scan"),
) -> BulkUpdateResponse:
    """Embed or replace cover art on a single track or a batch of tracks."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    target_paths: list[str] = []
    if paths:
        try:
            parsed = json.loads(paths)
            if not isinstance(parsed, list) or not all(isinstance(p, str) for p in parsed):
                raise ValueError("paths must be a JSON list of strings")
            target_paths.extend(parsed)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid paths payload: {exc}") from exc
    if path:
        target_paths.append(path)

    target_paths = list(dict.fromkeys(target_paths))
    if not target_paths:
        raise HTTPException(status_code=400, detail="At least one track path must be provided.")

    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded image file is empty.")
    if len(image_bytes) > MAX_ARTWORK_BYTES:
        raise HTTPException(status_code=413, detail="Artwork image exceeds 15 MiB limit.")

    content_type = (file.content_type or "").lower()
    if content_type and content_type not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported image type '{content_type}'. Use JPEG or PNG.",
        )

    batch_id = uuid.uuid4().hex[:12] if len(target_paths) > 1 else None
    updated: list[TrackMetadata] = []
    errors: list[BulkUpdateError] = []

    for rel_path in target_paths:
        try:
            after = write_track_artwork(
                lib.path,
                rel_path,
                image_bytes,
                mime_type=content_type or None,
            )
            db.record_audit(
                path=after.path,
                action="update_artwork",
                before_tags={},
                after_tags={
                    "artwork_mime": after.artwork_mime,
                    "artwork_hash": after.artwork_hash,
                },
                library_id=lib.id,
                batch_id=batch_id,
            )
            updated.append(after)
        except Exception as exc:
            errors.append(BulkUpdateError(path=rel_path, error=str(exc)))

    if updated:
        db.upsert_tracks(updated, library_id=lib.id)

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=trigger_navidrome_scan_flag and bool(updated)
    )
    return BulkUpdateResponse(
        updated=updated,
        errors=errors,
        navidrome_sync=navidrome_sync,
    )


@router.delete("/track/artwork", response_model=TrackUpdateResponse)
async def remove_track_artwork(
    request: Request,
    path: str = Query(..., description="Relative POSIX path of the track inside the active library"),
    trigger_navidrome_scan_flag: bool = Query(default=True, alias="trigger_navidrome_scan"),
) -> TrackUpdateResponse:
    """Remove embedded cover artwork from an audio file."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    try:
        after = delete_track_artwork(lib.path, path)
        db.upsert_tracks([after], library_id=lib.id)
        db.record_audit(
            path=after.path,
            action="delete_artwork",
            before_tags={},
            after_tags={"has_artwork": "false"},
            library_id=lib.id,
        )
    except Exception as exc:
        _raise_http_for_tag_error(exc)

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=trigger_navidrome_scan_flag
    )
    return TrackUpdateResponse(track=after, navidrome_sync=navidrome_sync)
