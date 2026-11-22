"""Optional slskd (Soulseek) search, download queueing, and transfer monitoring endpoints (Issue #6)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from app.config import Settings
from app.models import (
    SlskdDownloadsResponse,
    SlskdQueueDownloadRequest,
    SlskdQueueDownloadResponse,
    SlskdSearchRequest,
    SlskdSearchResponse,
    SlskdStatusResponse,
)
from app.routers._deps import get_effective_settings
from app.services.slskd import (
    SlskdError,
    check_slskd_status,
    clear_completed_slskd_downloads,
    list_slskd_downloads,
    queue_slskd_downloads,
    refresh_slskd_search,
    remove_slskd_download,
    search_slskd,
)

router = APIRouter(prefix="/api/slskd", tags=["slskd"])


def _require_slskd(settings: Settings) -> None:
    if not settings.slskd_configured:
        raise HTTPException(
            status_code=400,
            detail="slskd integration is not configured. Configure it in Settings or via SLSKD_URL / SLSKD_API_KEY.",
        )


@router.get("/status", response_model=SlskdStatusResponse)
async def get_slskd_status(request: Request) -> SlskdStatusResponse:
    """Return whether slskd is configured and reachable."""
    return await check_slskd_status(get_effective_settings(request))


@router.post("/search", response_model=SlskdSearchResponse)
async def post_slskd_search(
    request: Request,
    payload: SlskdSearchRequest,
) -> SlskdSearchResponse:
    """Issue a Soulseek search via slskd and return smart-ranked audio candidates."""
    settings = get_effective_settings(request)
    _require_slskd(settings)
    try:
        return await search_slskd(settings, payload)
    except SlskdError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/search/{search_id}", response_model=SlskdSearchResponse)
async def get_slskd_search_results(
    request: Request,
    search_id: str,
) -> SlskdSearchResponse:
    """Refresh peer responses for an existing slskd search ID."""
    settings = get_effective_settings(request)
    _require_slskd(settings)
    try:
        return await refresh_slskd_search(settings, search_id)
    except SlskdError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/download", response_model=SlskdQueueDownloadResponse)
async def post_slskd_download(
    request: Request,
    payload: SlskdQueueDownloadRequest,
) -> SlskdQueueDownloadResponse:
    """Queue one or more peer files for download in slskd."""
    settings = get_effective_settings(request)
    _require_slskd(settings)
    try:
        return await queue_slskd_downloads(settings, payload.username, payload.files)
    except SlskdError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/downloads", response_model=SlskdDownloadsResponse)
async def get_slskd_downloads(request: Request) -> SlskdDownloadsResponse:
    """Return active, completed, and failed download transfers from slskd."""
    settings = get_effective_settings(request)
    _require_slskd(settings)
    try:
        return await list_slskd_downloads(settings)
    except SlskdError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.delete("/downloads/completed")
async def delete_completed_slskd_downloads(request: Request) -> dict[str, bool]:
    """Clear completed transfers in slskd."""
    settings = get_effective_settings(request)
    _require_slskd(settings)
    try:
        await clear_completed_slskd_downloads(settings)
        return {"ok": True}
    except SlskdError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.delete("/downloads/{username}/{transfer_id}")
async def delete_slskd_download(
    request: Request,
    username: str,
    transfer_id: str,
) -> dict[str, bool]:
    """Cancel and remove a single transfer in slskd."""
    settings = get_effective_settings(request)
    _require_slskd(settings)
    try:
        await remove_slskd_download(settings, username, transfer_id)
        return {"ok": True}
    except SlskdError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
