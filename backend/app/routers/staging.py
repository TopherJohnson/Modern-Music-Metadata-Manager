"""Staging / Inbox status, dry-run destination preview, and cross-mount import endpoints (Issue #8)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request

from app.config import STAGING_LIBRARY_ID, LibraryConfig, Settings
from app.models import (
    StagingImportApplyRequest,
    StagingImportApplyResponse,
    StagingImportPreviewRequest,
    StagingImportPreviewResponse,
    StagingStatusResponse,
)
from app.routers._deps import get_effective_settings
from app.routers.health import _check_dir_permissions
from app.services.navidrome import trigger_navidrome_scan
from app.services.scanner import build_library_response, scan_library
from app.services.staging import apply_staging_import, build_staging_import_preview

router = APIRouter(prefix="/api/staging", tags=["staging"])


def _require_staging(settings: Settings) -> LibraryConfig:
    staging_lib = settings.staging_library
    if staging_lib is None:
        raise HTTPException(
            status_code=400,
            detail="Staging / Inbox is not configured (set M4_STAGING_DIR).",
        )
    return staging_lib


def _resolve_target_library(settings: Settings, target_library_id: str | None) -> LibraryConfig:
    if not target_library_id:
        return settings.default_library
    if target_library_id.strip().lower() == STAGING_LIBRARY_ID:
        raise HTTPException(
            status_code=400,
            detail="Cannot import into Staging — pick a real target music library.",
        )
    lib = settings.get_library(target_library_id)
    if lib is None or lib.is_staging:
        raise HTTPException(
            status_code=404,
            detail=f"Target library '{target_library_id}' not found.",
        )
    return lib


@router.get("/status", response_model=StagingStatusResponse)
async def get_staging_status(
    request: Request,
    rescan: bool = Query(default=False, description="Force fresh scan of staging directory"),
) -> StagingStatusResponse:
    """Return Staging mount readiness and pending track/album counts."""
    settings: Settings = request.app.state.settings
    db = request.app.state.db

    if not settings.staging_configured or settings.staging_dir is None:
        return StagingStatusResponse(configured=False)

    exists, readable, writable = _check_dir_permissions(settings.staging_dir)
    if not exists or not readable:
        return StagingStatusResponse(
            configured=True,
            path=str(settings.staging_dir),
            exists=exists,
            readable=readable,
            writable=writable,
        )

    tracks = scan_library(
        settings.staging_dir,
        db,
        force_rescan=rescan,
        library_id=STAGING_LIBRARY_ID,
    )
    grouped = build_library_response(tracks)
    return StagingStatusResponse(
        configured=True,
        path=str(settings.staging_dir),
        exists=exists,
        readable=readable,
        writable=writable,
        track_count=grouped.stats.track_count,
        album_count=grouped.stats.album_count,
    )


@router.post("/preview", response_model=StagingImportPreviewResponse)
async def preview_staging_import(
    request: Request,
    payload: StagingImportPreviewRequest,
) -> StagingImportPreviewResponse:
    """Compute dry-run destination paths inside the target library (with single-track drop-in detection)."""
    settings: Settings = request.app.state.settings
    db = request.app.state.db

    staging_lib = _require_staging(settings)
    target_lib = _resolve_target_library(settings, payload.target_library_id)

    staging_tracks = scan_library(
        staging_lib.path, db, force_rescan=False, library_id=STAGING_LIBRARY_ID
    )
    target_tracks = scan_library(
        target_lib.path, db, force_rescan=False, library_id=target_lib.id
    )
    target_org = db.get_organize_settings(library_id=target_lib.id)

    preview, _ = build_staging_import_preview(
        staging_lib.path,
        staging_tracks,
        target_lib,
        target_tracks,
        target_org,
        paths=payload.paths,
    )
    return preview


@router.post("/import", response_model=StagingImportApplyResponse)
async def apply_staging_import_endpoint(
    request: Request,
    payload: StagingImportApplyRequest,
) -> StagingImportApplyResponse:
    """Move staged tracks + companion sidecars into the target library and trigger one Navidrome scan."""
    settings = get_effective_settings(request)
    db = request.app.state.db

    staging_lib = _require_staging(settings)
    target_lib = _resolve_target_library(settings, payload.target_library_id)

    staging_tracks = scan_library(
        staging_lib.path, db, force_rescan=False, library_id=STAGING_LIBRARY_ID
    )
    target_tracks = scan_library(
        target_lib.path, db, force_rescan=False, library_id=target_lib.id
    )
    target_org = db.get_organize_settings(library_id=target_lib.id)

    (
        batch_id,
        imported,
        moved_sidecars,
        skipped,
        errors,
        removed_empty_dirs,
    ) = apply_staging_import(
        staging_lib.path,
        staging_tracks,
        target_lib,
        target_tracks,
        target_org,
        db,
        paths=payload.paths,
    )

    navidrome_sync = await trigger_navidrome_scan(
        settings,
        requested=payload.trigger_navidrome_scan and bool(imported),
    )

    return StagingImportApplyResponse(
        target_library_id=target_lib.id,
        batch_id=batch_id,
        imported=imported,
        moved_sidecars=moved_sidecars,
        skipped=skipped,
        errors=errors,
        removed_empty_dirs=removed_empty_dirs,
        navidrome_sync=navidrome_sync,
    )
