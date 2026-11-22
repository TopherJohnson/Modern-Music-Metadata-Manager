"""Shared FastAPI router helpers (active library resolution and effective runtime settings)."""

from __future__ import annotations

from dataclasses import replace

from fastapi import HTTPException, Request

from app.config import LibraryConfig, Settings
from app.database import Database


def resolve_library(request: Request) -> LibraryConfig:
    """Resolve the active configured library from `?library=` query param or `X-M4-Library` header."""
    settings: Settings = request.app.state.settings
    requested = (
        request.query_params.get("library")
        or request.headers.get("x-m4-library")
        or None
    )
    library = settings.get_library(requested)
    if library is None:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown library '{requested}'. Check GET /api/libraries for configured libraries.",
        )
    return library


def resolve_effective_settings(base: Settings, db: Database) -> Settings:
    """Merge persisted in-app integration overrides from `/config/m4.db` onto env defaults."""
    stored = db.get_integration_settings()
    if stored is None:
        return base

    # slskd: explicit disabled toggle hides integration even if env vars exist
    if stored.slskd_enabled is False:
        slskd_url = None
        slskd_api_key = None
    else:
        raw_url = stored.slskd_url if stored.slskd_url is not None else base.slskd_url
        slskd_url = raw_url.strip().rstrip("/") if raw_url and raw_url.strip() else None
        raw_key = (
            stored.slskd_api_key
            if stored.slskd_api_key is not None
            else base.slskd_api_key
        )
        slskd_api_key = raw_key.strip() if raw_key and raw_key.strip() else None

    # Navidrome: explicit disabled toggle hides integration even if env vars exist
    if stored.navidrome_enabled is False:
        nav_url = None
        nav_user = None
        nav_pass = None
        nav_auto = (
            stored.navidrome_auto_scan
            if stored.navidrome_auto_scan is not None
            else base.navidrome_auto_scan
        )
    else:
        raw_nav_url = (
            stored.navidrome_url
            if stored.navidrome_url is not None
            else base.navidrome_url
        )
        nav_url = (
            raw_nav_url.strip().rstrip("/")
            if raw_nav_url and raw_nav_url.strip()
            else None
        )
        raw_nav_user = (
            stored.navidrome_user
            if stored.navidrome_user is not None
            else base.navidrome_user
        )
        nav_user = (
            raw_nav_user.strip()
            if raw_nav_user and raw_nav_user.strip()
            else None
        )
        raw_nav_pass = (
            stored.navidrome_pass
            if stored.navidrome_pass is not None
            else base.navidrome_pass
        )
        nav_pass = (
            raw_nav_pass.strip()
            if raw_nav_pass and raw_nav_pass.strip()
            else None
        )
        nav_auto = (
            stored.navidrome_auto_scan
            if stored.navidrome_auto_scan is not None
            else base.navidrome_auto_scan
        )

    return replace(
        base,
        slskd_url=slskd_url,
        slskd_api_key=slskd_api_key,
        navidrome_url=nav_url,
        navidrome_user=nav_user,
        navidrome_pass=nav_pass,
        navidrome_auto_scan=nav_auto,
    )


def get_effective_settings(request: Request) -> Settings:
    """Return effective runtime settings combining env defaults with saved in-app overrides."""
    return resolve_effective_settings(request.app.state.settings, request.app.state.db)

