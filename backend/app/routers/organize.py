"""Endpoints for configuring, previewing, and applying library folder reorganization."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.models import (
    OrganizeApplyRequest,
    OrganizeApplyResponse,
    OrganizePreviewRequest,
    OrganizePreviewResponse,
    OrganizeSettings,
)
from app.routers._deps import get_effective_settings, resolve_library
from app.services.navidrome import trigger_navidrome_scan
from app.services.organizer import (
    VALID_TEMPLATES,
    apply_organize_plan,
    build_organize_preview,
)
from app.services.scanner import scan_library

router = APIRouter(prefix="/api", tags=["organize"])


@router.get("/settings/organize", response_model=OrganizeSettings)
async def get_organize_settings(request: Request) -> OrganizeSettings:
    """Return persisted library folder organization preferences for the active library."""
    db = request.app.state.db
    lib = resolve_library(request)
    return db.get_organize_settings(library_id=lib.id)


@router.put("/settings/organize", response_model=OrganizeSettings)
async def put_organize_settings(
    request: Request,
    payload: OrganizeSettings,
) -> OrganizeSettings:
    """Save library folder organization preferences for the active library into /config/m4.db."""
    if payload.template not in VALID_TEMPLATES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid template '{payload.template}'. Valid options: {', '.join(sorted(VALID_TEMPLATES))}.",
        )
    db = request.app.state.db
    lib = resolve_library(request)
    return db.save_organize_settings(payload, library_id=lib.id)


@router.post("/organize/preview", response_model=OrganizePreviewResponse)
async def post_organize_preview(
    request: Request,
    payload: OrganizePreviewRequest | None = None,
) -> OrganizePreviewResponse:
    """Generate a dry-run reorganization preview for the active library or a subset of tracks."""
    db = request.app.state.db
    lib = resolve_library(request)

    org_settings = (
        payload.settings
        if (payload and payload.settings is not None)
        else db.get_organize_settings(library_id=lib.id)
    )
    if org_settings.template not in VALID_TEMPLATES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid template '{org_settings.template}'.",
        )

    tracks = scan_library(lib.path, db, library_id=lib.id)
    return build_organize_preview(
        lib.path,
        tracks,
        org_settings,
        filter_paths=payload.paths if payload else None,
    )


@router.post("/organize/apply", response_model=OrganizeApplyResponse)
async def post_organize_apply(
    request: Request,
    payload: OrganizeApplyRequest | None = None,
) -> OrganizeApplyResponse:
    """Execute library folder reorganization moves on disk and optionally trigger a Navidrome scan."""
    app_settings = get_effective_settings(request)
    db = request.app.state.db
    lib = resolve_library(request)

    org_settings = (
        payload.settings
        if (payload and payload.settings is not None)
        else db.get_organize_settings(library_id=lib.id)
    )
    if org_settings.template not in VALID_TEMPLATES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid template '{org_settings.template}'.",
        )

    tracks = scan_library(lib.path, db, library_id=lib.id)
    moved, moved_sidecars, skipped, errors, removed_empty_dirs = apply_organize_plan(
        lib.path,
        db,
        tracks,
        org_settings,
        filter_paths=payload.paths if payload else None,
        library_id=lib.id,
    )

    should_scan = (
        (payload.trigger_navidrome_scan if payload else True)
        and bool(moved)
        and not lib.is_staging
    )
    navidrome_sync = await trigger_navidrome_scan(app_settings, requested=should_scan)

    return OrganizeApplyResponse(
        moved=moved,
        moved_sidecars=moved_sidecars,
        skipped=skipped,
        errors=errors,
        removed_empty_dirs=removed_empty_dirs,
        navidrome_sync=navidrome_sync,
    )
