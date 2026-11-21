"""Library browsing, scanning, audit history, and manual Navidrome sync endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Query, Request

from app.models import AuditEntry, LibraryResponse, NavidromeSyncResult
from app.services.navidrome import trigger_navidrome_scan
from app.services.scanner import build_library_response, scan_library

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
    return build_library_response(tracks, query=q)


@router.post("/library/scan", response_model=LibraryResponse)
async def post_library_scan(request: Request) -> LibraryResponse:
    """Force a full rescan of the `/music` directory and refresh the SQLite cache."""
    settings = request.app.state.settings
    db = request.app.state.db

    tracks = scan_library(settings.music_dir, db, force_rescan=True)
    return build_library_response(tracks)


@router.get("/history", response_model=list[AuditEntry])
async def get_history(
    request: Request,
    limit: int = Query(default=50, ge=1, le=500),
) -> list[AuditEntry]:
    """Return recent metadata edit audit entries stored in `/config/m4.db`."""
    db = request.app.state.db
    return db.get_audit_history(limit=limit)


@router.post("/navidrome/scan", response_model=NavidromeSyncResult)
async def post_navidrome_scan(request: Request) -> NavidromeSyncResult:
    """Manually trigger a Navidrome Subsonic `startScan` call."""
    settings = request.app.state.settings
    return await trigger_navidrome_scan(settings, requested=True)
