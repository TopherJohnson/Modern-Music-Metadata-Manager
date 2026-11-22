"""In-app integration settings (slskd & Navidrome) persisted in /config/m4.db."""

from __future__ import annotations

from dataclasses import replace

from fastapi import APIRouter, Request

from app.config import Settings
from app.models import (
    IntegrationSettingsResponse,
    IntegrationSettingsStored,
    IntegrationSettingsUpdateRequest,
    NavidromeSyncResult,
    SlskdStatusResponse,
    TestNavidromeRequest,
    TestSlskdRequest,
)
from app.routers._deps import get_effective_settings
from app.services.navidrome import test_navidrome_connection
from app.services.slskd import check_slskd_status

router = APIRouter(prefix="/api/settings/integrations", tags=["settings"])


def _build_safe_response(
    base: Settings,
    stored: IntegrationSettingsStored | None,
) -> IntegrationSettingsResponse:
    """Return effective settings with secrets masked as booleans."""
    eff_slskd_url = (
        stored.slskd_url
        if (stored and stored.slskd_url is not None)
        else base.slskd_url
    )
    eff_slskd_key = (
        stored.slskd_api_key
        if (stored and stored.slskd_api_key is not None)
        else base.slskd_api_key
    )
    slskd_enabled = (
        stored.slskd_enabled
        if (stored and stored.slskd_enabled is not None)
        else bool(eff_slskd_url and eff_slskd_key)
    )
    slskd_from_env = bool(
        base.slskd_configured
        and (
            stored is None
            or (
                stored.slskd_enabled is None
                and stored.slskd_url is None
                and stored.slskd_api_key is None
            )
        )
    )

    eff_nav_url = (
        stored.navidrome_url
        if (stored and stored.navidrome_url is not None)
        else base.navidrome_url
    )
    eff_nav_user = (
        stored.navidrome_user
        if (stored and stored.navidrome_user is not None)
        else base.navidrome_user
    )
    eff_nav_pass = (
        stored.navidrome_pass
        if (stored and stored.navidrome_pass is not None)
        else base.navidrome_pass
    )
    eff_nav_auto = (
        stored.navidrome_auto_scan
        if (stored and stored.navidrome_auto_scan is not None)
        else base.navidrome_auto_scan
    )
    nav_enabled = (
        stored.navidrome_enabled
        if (stored and stored.navidrome_enabled is not None)
        else bool(eff_nav_url and eff_nav_user and eff_nav_pass)
    )
    nav_from_env = bool(
        base.navidrome_configured
        and (
            stored is None
            or (
                stored.navidrome_enabled is None
                and stored.navidrome_url is None
                and stored.navidrome_user is None
                and stored.navidrome_pass is None
            )
        )
    )

    return IntegrationSettingsResponse(
        slskd_enabled=bool(slskd_enabled),
        slskd_url=eff_slskd_url,
        slskd_api_key_set=bool(eff_slskd_key),
        slskd_from_env=slskd_from_env,
        navidrome_enabled=bool(nav_enabled),
        navidrome_url=eff_nav_url,
        navidrome_user=eff_nav_user,
        navidrome_pass_set=bool(eff_nav_pass),
        navidrome_auto_scan=bool(eff_nav_auto),
        navidrome_from_env=nav_from_env,
    )


@router.get("", response_model=IntegrationSettingsResponse)
async def get_integrations(request: Request) -> IntegrationSettingsResponse:
    """Return current effective integration settings (secrets masked)."""
    base: Settings = request.app.state.settings
    db = request.app.state.db
    stored = db.get_integration_settings()
    return _build_safe_response(base, stored)


@router.put("", response_model=IntegrationSettingsResponse)
async def update_integrations(
    request: Request,
    payload: IntegrationSettingsUpdateRequest,
) -> IntegrationSettingsResponse:
    """Persist in-app integration settings in `/config/m4.db` (takes effect immediately)."""
    base: Settings = request.app.state.settings
    db = request.app.state.db
    existing = db.get_integration_settings() or IntegrationSettingsStored()

    data = existing.model_dump()

    if "slskd_enabled" in payload.model_fields_set:
        data["slskd_enabled"] = payload.slskd_enabled
    if "slskd_url" in payload.model_fields_set:
        cleaned = (payload.slskd_url or "").strip().rstrip("/")
        data["slskd_url"] = cleaned or ""
    if payload.clear_slskd_api_key:
        data["slskd_api_key"] = ""
    elif (
        "slskd_api_key" in payload.model_fields_set
        and payload.slskd_api_key is not None
        and payload.slskd_api_key.strip() != ""
    ):
        data["slskd_api_key"] = payload.slskd_api_key.strip()

    if "navidrome_enabled" in payload.model_fields_set:
        data["navidrome_enabled"] = payload.navidrome_enabled
    if "navidrome_url" in payload.model_fields_set:
        cleaned = (payload.navidrome_url or "").strip().rstrip("/")
        data["navidrome_url"] = cleaned or ""
    if "navidrome_user" in payload.model_fields_set:
        data["navidrome_user"] = (payload.navidrome_user or "").strip()
    if payload.clear_navidrome_pass:
        data["navidrome_pass"] = ""
    elif (
        "navidrome_pass" in payload.model_fields_set
        and payload.navidrome_pass is not None
        and payload.navidrome_pass.strip() != ""
    ):
        data["navidrome_pass"] = payload.navidrome_pass.strip()
    if "navidrome_auto_scan" in payload.model_fields_set:
        data["navidrome_auto_scan"] = payload.navidrome_auto_scan

    saved = db.save_integration_settings(IntegrationSettingsStored(**data))
    return _build_safe_response(base, saved)


@router.post("/test-slskd", response_model=SlskdStatusResponse)
async def test_slskd(
    request: Request,
    payload: TestSlskdRequest,
) -> SlskdStatusResponse:
    """Test a slskd connection using unsaved form inputs or currently saved credentials."""
    eff = get_effective_settings(request)
    stored = request.app.state.db.get_integration_settings()
    fallback_url = (
        stored.slskd_url
        if (stored and stored.slskd_url)
        else eff.slskd_url or request.app.state.settings.slskd_url
    )
    fallback_key = (
        stored.slskd_api_key
        if (stored and stored.slskd_api_key)
        else eff.slskd_api_key or request.app.state.settings.slskd_api_key
    )

    test_url = (
        payload.url.strip().rstrip("/")
        if (payload.url and payload.url.strip())
        else fallback_url
    )
    test_key = (
        payload.api_key.strip()
        if (payload.api_key and payload.api_key.strip())
        else fallback_key
    )
    if not test_url or not test_key:
        return SlskdStatusResponse(
            configured=False,
            connected=False,
            detail="Enter both slskd URL and API key to test.",
        )

    probe_settings = replace(eff, slskd_url=test_url, slskd_api_key=test_key)
    return await check_slskd_status(probe_settings)


@router.post("/test-navidrome", response_model=NavidromeSyncResult)
async def test_navidrome(
    request: Request,
    payload: TestNavidromeRequest,
) -> NavidromeSyncResult:
    """Test a Navidrome connection using unsaved form inputs or currently saved credentials."""
    eff = get_effective_settings(request)
    stored = request.app.state.db.get_integration_settings()
    base: Settings = request.app.state.settings

    test_url = (
        payload.url.strip().rstrip("/")
        if (payload.url and payload.url.strip())
        else (stored.navidrome_url if (stored and stored.navidrome_url) else eff.navidrome_url or base.navidrome_url)
    )
    test_user = (
        payload.user.strip()
        if (payload.user and payload.user.strip())
        else (stored.navidrome_user if (stored and stored.navidrome_user) else eff.navidrome_user or base.navidrome_user)
    )
    test_pass = (
        payload.password.strip()
        if (payload.password and payload.password.strip())
        else (stored.navidrome_pass if (stored and stored.navidrome_pass) else eff.navidrome_pass or base.navidrome_pass)
    )
    return await test_navidrome_connection(test_url, test_user, test_pass)
