"""Shared FastAPI router helpers (active library resolution)."""

from __future__ import annotations

from fastapi import HTTPException, Request

from app.config import LibraryConfig, Settings


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
