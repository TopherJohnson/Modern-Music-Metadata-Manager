"""Track inspection, single/bulk tag editing, and embedded cover art endpoints."""

from __future__ import annotations

import json

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, Response, UploadFile

from app.models import (
    BulkUpdateError,
    BulkUpdateRequest,
    BulkUpdateResponse,
    TrackMetadata,
    TrackUpdateRequest,
    TrackUpdateResponse,
)
from app.services.navidrome import trigger_navidrome_scan
from app.services.tags import (
    EDITABLE_FIELDS,
    InvalidTrackPathError,
    TagServiceError,
    TrackNotFoundError,
    delete_track_artwork,
    read_track_artwork,
    read_track_metadata,
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
            detail="Permission denied writing audio file. Verify PUID/PGID and /music mount permissions.",
        ) from exc
    if isinstance(exc, TagServiceError):
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    raise HTTPException(status_code=500, detail=f"Audio tag error: {exc}") from exc


@router.get("/track", response_model=TrackMetadata)
async def get_track(
    request: Request,
    path: str = Query(..., description="Relative POSIX path of the track inside /music"),
) -> TrackMetadata:
    """Read live metadata for a single audio track directly from disk."""
    settings = request.app.state.settings
    db = request.app.state.db
    try:
        track = read_track_metadata(settings.music_dir, path)
    except Exception as exc:
        _raise_http_for_tag_error(exc)
    db.upsert_tracks([track])
    return track


@router.put("/track", response_model=TrackUpdateResponse)
async def put_track(
    request: Request,
    payload: TrackUpdateRequest,
) -> TrackUpdateResponse:
    """Write updated metadata tags directly to an audio file on disk."""
    settings = request.app.state.settings
    db = request.app.state.db

    updates = {
        field: getattr(payload, field)
        for field in EDITABLE_FIELDS
        if field in payload.model_fields_set
    }

    try:
        if updates:
            before, after = write_track_metadata(settings.music_dir, payload.path, updates)
            db.upsert_tracks([after])
            db.record_audit(
                path=after.path,
                action="update_track",
                before_tags=_tag_snapshot(before),
                after_tags=_tag_snapshot(after),
            )
        else:
            after = read_track_metadata(settings.music_dir, payload.path)
            db.upsert_tracks([after])
    except Exception as exc:
        _raise_http_for_tag_error(exc)

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=payload.trigger_navidrome_scan and bool(updates)
    )
    return TrackUpdateResponse(track=after, navidrome_sync=navidrome_sync)


@router.put("/tracks/bulk", response_model=BulkUpdateResponse)
async def put_tracks_bulk(
    request: Request,
    payload: BulkUpdateRequest,
) -> BulkUpdateResponse:
    """Apply shared tag edits across multiple tracks (e.g. album-level bulk update)."""
    settings = request.app.state.settings
    db = request.app.state.db

    updates = {
        field: getattr(payload, field)
        for field in EDITABLE_FIELDS
        if field in payload.model_fields_set
    }

    updated: list[TrackMetadata] = []
    errors: list[BulkUpdateError] = []

    for rel_path in payload.paths:
        try:
            if updates:
                before, after = write_track_metadata(settings.music_dir, rel_path, updates)
                db.record_audit(
                    path=after.path,
                    action="bulk_update",
                    before_tags=_tag_snapshot(before),
                    after_tags=_tag_snapshot(after),
                )
            else:
                after = read_track_metadata(settings.music_dir, rel_path)
            updated.append(after)
        except Exception as exc:
            errors.append(BulkUpdateError(path=rel_path, error=str(exc)))

    if updated:
        db.upsert_tracks(updated)

    navidrome_sync = await trigger_navidrome_scan(
        settings,
        requested=payload.trigger_navidrome_scan and bool(updated) and bool(updates),
    )
    return BulkUpdateResponse(
        updated=updated,
        errors=errors,
        navidrome_sync=navidrome_sync,
    )


@router.get("/track/artwork")
async def get_track_artwork(
    request: Request,
    path: str = Query(..., description="Relative POSIX path of the track inside /music"),
) -> Response:
    """Return the embedded front cover image for a track."""
    settings = request.app.state.settings
    try:
        artwork = read_track_artwork(settings.music_dir, path)
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

    # Deduplicate preserving order
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

    updated: list[TrackMetadata] = []
    errors: list[BulkUpdateError] = []

    for rel_path in target_paths:
        try:
            after = write_track_artwork(
                settings.music_dir,
                rel_path,
                image_bytes,
                mime_type=content_type or None,
            )
            db.record_audit(
                path=after.path,
                action="update_artwork",
                before_tags={},
                after_tags={"artwork_mime": after.artwork_mime},
            )
            updated.append(after)
        except Exception as exc:
            errors.append(BulkUpdateError(path=rel_path, error=str(exc)))

    if updated:
        db.upsert_tracks(updated)

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
    path: str = Query(..., description="Relative POSIX path of the track inside /music"),
    trigger_navidrome_scan_flag: bool = Query(default=True, alias="trigger_navidrome_scan"),
) -> TrackUpdateResponse:
    """Remove embedded cover artwork from an audio file."""
    settings = request.app.state.settings
    db = request.app.state.db

    try:
        after = delete_track_artwork(settings.music_dir, path)
        db.upsert_tracks([after])
        db.record_audit(
            path=after.path,
            action="delete_artwork",
            before_tags={},
            after_tags={"has_artwork": "false"},
        )
    except Exception as exc:
        _raise_http_for_tag_error(exc)

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=trigger_navidrome_scan_flag
    )
    return TrackUpdateResponse(track=after, navidrome_sync=navidrome_sync)
