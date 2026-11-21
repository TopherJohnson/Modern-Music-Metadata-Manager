"""Library browsing, scanning, audit history + undo, and manual Navidrome sync endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.models import AuditEntry, LibraryResponse, NavidromeSyncResult, UndoResponse
from app.services.navidrome import trigger_navidrome_scan
from app.services.organizer import undo_track_move
from app.services.scanner import build_library_response, scan_library
from app.services.tags import (
    EDITABLE_FIELDS,
    TrackNotFoundError,
    write_track_metadata,
)

router = APIRouter(prefix="/api", tags=["library"])


@router.get("/library", response_model=LibraryResponse)
async def get_library(
    request: Request,
    q: str | None = Query(default=None, description="Optional search query across tags and paths"),
    rescan: bool = Query(default=False, description="Force re-reading all files instead of using SQLite cache"),
) -> LibraryResponse:
    """Return the music library grouped by Artist -> Album -> Track."""
    settings = request.app.state.settings
    db = request.app.state.db

    tracks = scan_library(settings.music_dir, db, force_rescan=rescan)
    return build_library_response(
        tracks, query=q, organize_settings=db.get_organize_settings()
    )


@router.post("/library/scan", response_model=LibraryResponse)
async def post_library_scan(request: Request) -> LibraryResponse:
    """Force a full rescan of the `/music` directory and refresh the SQLite cache."""
    settings = request.app.state.settings
    db = request.app.state.db

    tracks = scan_library(settings.music_dir, db, force_rescan=True)
    return build_library_response(
        tracks, organize_settings=db.get_organize_settings()
    )


@router.get("/history", response_model=list[AuditEntry])
async def get_history(
    request: Request,
    limit: int = Query(default=100, ge=1, le=500),
) -> list[AuditEntry]:
    """Return recent metadata edit and file move audit entries stored in `/config/m4.db`."""
    db = request.app.state.db
    return db.get_audit_history(limit=limit)


@router.post("/history/{entry_id}/undo", response_model=UndoResponse)
async def undo_history_entry(
    request: Request,
    entry_id: int,
    trigger_navidrome_scan_flag: bool = Query(default=True, alias="trigger_navidrome_scan"),
) -> UndoResponse:
    """Revert a previous tag edit or file move recorded in `/config/m4.db`."""
    settings = request.app.state.settings
    db = request.app.state.db

    entry = db.get_audit_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Audit history entry not found.")
    if entry.undone:
        raise HTTPException(status_code=409, detail="This change has already been undone.")
    if not entry.can_undo:
        raise HTTPException(
            status_code=400,
            detail=f"Action '{entry.action}' cannot be automatically undone.",
        )

    restored_sidecars = 0
    if entry.action == "move_track":
        try:
            restored_track, restored_sidecars = undo_track_move(
                settings.music_dir, db, entry
            )
        except TrackNotFoundError as exc:
            raise HTTPException(
                status_code=404,
                detail="File is no longer at its moved location (it may have been moved or deleted since).",
            ) from exc
        except FileExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not undo move: {exc}") from exc

        navidrome_sync = await trigger_navidrome_scan(
            settings, requested=trigger_navidrome_scan_flag
        )
        return UndoResponse(
            entry_id=entry.id,
            action=entry.action,
            restored_path=restored_track.path,
            restored_sidecars=restored_sidecars,
            track=restored_track,
            navidrome_sync=navidrome_sync,
        )

    # Tag edit undo: restore every changed field back to its recorded `before_tags` value
    restore_updates: dict[str, str | None] = {}
    for field in entry.changed_fields:
        if field in EDITABLE_FIELDS:
            raw_val = entry.before_tags.get(field)
            restore_updates[field] = raw_val if isinstance(raw_val, str) else None

    if not restore_updates:
        raise HTTPException(status_code=400, detail="No restorable tag fields found in this entry.")

    try:
        before, after = write_track_metadata(
            settings.music_dir, entry.path, restore_updates
        )
    except TrackNotFoundError as exc:
        raise HTTPException(
            status_code=404,
            detail="Track file was not found at its recorded path (undo any move first, or rescan).",
        ) from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not restore tags: {exc}") from exc

    db.upsert_tracks([after])
    db.mark_audit_undone(entry.id)
    db.record_audit(
        path=after.path,
        action="undo_tags",
        before_tags={f: getattr(before, f) for f in EDITABLE_FIELDS},
        after_tags={f: getattr(after, f) for f in EDITABLE_FIELDS},
    )

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=trigger_navidrome_scan_flag
    )
    return UndoResponse(
        entry_id=entry.id,
        action=entry.action,
        restored_path=after.path,
        restored_sidecars=0,
        track=after,
        navidrome_sync=navidrome_sync,
    )


@router.post("/navidrome/scan", response_model=NavidromeSyncResult)
async def post_navidrome_scan(request: Request) -> NavidromeSyncResult:
    """Manually trigger a Navidrome Subsonic `startScan` call."""
    settings = request.app.state.settings
    return await trigger_navidrome_scan(settings, requested=True)
