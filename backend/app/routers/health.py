"""Health check endpoint reporting container and mount readiness."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Request

from app import __version__
from app.models import HealthResponse

router = APIRouter(prefix="/api", tags=["health"])


def _check_dir_permissions(path: Path) -> tuple[bool, bool, bool]:
    """Return `(exists, readable, writable)` for a directory path."""
    if not path.exists() or not path.is_dir():
        return False, False, False

    readable = os.access(path, os.R_OK | os.X_OK)
    writable = os.access(path, os.W_OK | os.X_OK)

    # Also detect read-only filesystem mounts on Linux (e.g. Docker `:ro` volume).
    if writable and hasattr(os, "statvfs") and hasattr(os, "ST_RDONLY"):
        try:
            if os.statvfs(path).f_flag & os.ST_RDONLY:
                writable = False
        except OSError:
            pass

    return True, readable, writable


@router.get("/health", response_model=HealthResponse)
async def get_health(request: Request) -> HealthResponse:
    """Return container status and music/config mount readability & writability."""
    settings = request.app.state.settings
    db = request.app.state.db

    music_exists, music_readable, music_writable = _check_dir_permissions(
        settings.music_dir
    )
    _, _, config_writable = _check_dir_permissions(settings.config_dir)

    healthy = music_exists and music_readable and music_writable and config_writable
    status = "ok" if healthy else "degraded"

    return HealthResponse(
        status=status,
        version=__version__,
        music_dir=str(settings.music_dir),
        music_dir_exists=music_exists,
        music_dir_readable=music_readable,
        music_dir_writable=music_writable,
        config_dir=str(settings.config_dir),
        config_dir_writable=config_writable,
        navidrome_configured=settings.navidrome_configured,
        cached_tracks=db.count_cached_tracks(),
    )
