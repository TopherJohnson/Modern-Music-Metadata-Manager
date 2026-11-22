"""Library browsing, scanning, audit history + single/batch undo, and manual Navidrome sync endpoints."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Query, Request

from app.config import LibraryConfig
from app.database import Database
from app.models import (
    AuditEntry,
    BatchUndoResponse,
    BulkUpdateError,
    LibraryResponse,
    NavidromeSyncResult,
    TrackMetadata,
    UndoResponse,
)
from app.routers._deps import resolve_library
from app.services.navidrome import trigger_navidrome_scan
from app.services.organizer import undo_track_move
from app.services.scanner import build_library_response, scan_library
from app.services.tags import (
    EDITABLE_FIELDS,
    TrackNotFoundError,
    write_track_metadata,
)

router = APIRouter(prefix="/api", tags=["library"])


def _undo_single_entry(
    lib: LibraryConfig,
    db: Database,
    entry: AuditEntry,
    *,
    undo_batch_id: str | None = None,
) -> tuple[TrackMetadata, int]:
    """Revert one audit entry (move or tag edit) on disk and update SQLite cache + history."""
    if entry.action == "move_track":
        return undo_track_move(
            lib.path,
            db,
            entry,
            library_id=lib.id,
            batch_id=undo_batch_id,
        )

    restore_updates: dict[str, str | None] = {}
    for field in entry.changed_fields:
        if field in EDITABLE_FIELDS:
            raw_val = entry.before_tags.get(field)
            restore_updates[field] = raw_val if isinstance(raw_val, str) else None

    if not restore_updates:
        raise ValueError("No restorable tag fields found in this entry.")

    before, after = write_track_metadata(lib.path, entry.path, restore_updates)
    db.upsert_tracks([after], library_id=lib.id)
    db.mark_audit_undone(entry.id)
    db.record_audit(
        path=after.path,
        action="undo_tags",
        before_tags={f: getattr(before, f) for f in EDITABLE_FIELDS},
        after_tags={f: getattr(after, f) for f in EDITABLE_FIELDS},
        library_id=lib.id,
        batch_id=undo_batch_id,
    )
    return after, 0


@router.get("/library", response_model=LibraryResponse)
async def get_library(
    request: Request,
    q: str | None = Query(default=None, description="Optional search query across tags and paths"),
    rescan: bool = Query(default=False, description="Force re-reading all files instead of using SQLite cache"),
) -> LibraryResponse:
    """Return the active music library grouped by Artist -> Album -> Track."""
    db = request.app.state.db
    lib = resolve_library(request)

    tracks = scan_library(lib.path, db, force_rescan=rescan, library_id=lib.id)
    return build_library_response(
        tracks,
        query=q,
        organize_settings=db.get_organize_settings(library_id=lib.id),
    )


@router.post("/library/scan", response_model=LibraryResponse)
async def post_library_scan(request: Request) -> LibraryResponse:
    """Force a full rescan of the active library directory and refresh the SQLite cache."""
    db = request.app.state.db
    lib = resolve_library(request)

    tracks = scan_library(lib.path, db, force_rescan=True, library_id=lib.id)
    return build_library_response(
        tracks,
        organize_settings=db.get_organize_settings(library_id=lib.id),
    )


@router.get("/history", response_model=list[AuditEntry])
async def get_history(
    request: Request,
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[AuditEntry]:
    """Return recent metadata edit and file move audit entries for the active library."""
    db = request.app.state.db
    lib = resolve_library(request)
    return db.get_audit_history(limit=limit, library_id=lib.id)


@router.post("/history/batch/{batch_id}/undo", response_model=BatchUndoResponse)
async def undo_history_batch(
    request: Request,
    batch_id: str,
    trigger_navidrome_scan_flag: bool = Query(default=True, alias="trigger_navidrome_scan"),
) -> BatchUndoResponse:
    """Revert every remaining undoable entry in a grouped history batch in reverse order."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    entries = db.get_audit_batch(batch_id, library_id=lib.id)
    if not entries:
        raise HTTPException(status_code=404, detail="Audit history batch not found.")

    undoable = [e for e in entries if e.can_undo]
    if not undoable:
        raise HTTPException(
            status_code=409,
            detail="All changes in this batch have already been undone or cannot be undone.",
        )

    undo_batch_id = uuid.uuid4().hex[:12] if len(undoable) > 1 else None
    undone_count = 0
    restored_sidecars = 0
    errors: list[BulkUpdateError] = []

    for entry in undoable:
        try:
            _, sidecar_count = _undo_single_entry(
                lib, db, entry, undo_batch_id=undo_batch_id
            )
            undone_count += 1
            restored_sidecars += sidecar_count
        except Exception as exc:
            errors.append(BulkUpdateError(path=entry.path, error=str(exc)))

    navidrome_sync = await trigger_navidrome_scan(
        settings, requested=trigger_navidrome_scan_flag and undone_count > 0
    )
    return BatchUndoResponse(
        batch_id=batch_id,
        undone_count=undone_count,
        restored_sidecars=restored_sidecars,
        errors=errors,
        navidrome_sync=navidrome_sync,
    )


@router.post("/history/{entry_id}/undo", response_model=UndoResponse)
async def undo_history_entry(
    request: Request,
    entry_id: int,
    trigger_navidrome_scan_flag: bool = Query(default=True, alias="trigger_navidrome_scan"),
) -> UndoResponse:
    """Revert a single previous tag edit or file move recorded in `/config/m4.db`."""
    settings = request.app.state.settings
    db = request.app.state.db
    lib = resolve_library(request)

    entry = db.get_audit_entry(entry_id)
    if entry is None or entry.library_id != lib.id:
        raise HTTPException(status_code=404, detail="Audit history entry not found.")
    if entry.undone:
        raise HTTPException(status_code=409, detail="This change has already been undone.")
    if not entry.can_undo:
        raise HTTPException(
            status_code=400,
            detail=f"Action '{entry.action}' cannot be automatically undone.",
        )

    try:
        restored_track, restored_sidecars = _undo_single_entry(lib, db, entry)
    except TrackNotFoundError as exc:
        detail = (
            "File is no longer at its moved location (it may have been moved or deleted since)."
            if entry.action == "move_track"
            else "Track file was not found at its recorded path (undo any move first, or rescan)."
        )
        raise HTTPException(status_code=404, detail=detail) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not undo change: {exc}") from exc

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


@router.post("/navidrome/scan", response_model=NavidromeSyncResult)
async def post_navidrome_scan(request: Request) -> NavidromeSyncResult:
    """Manually trigger a Navidrome Subsonic `startScan` call."""
    settings = request.app.state.settings
    return await trigger_navidrome_scan(settings, requested=True)
