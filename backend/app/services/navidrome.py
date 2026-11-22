"""Optional Navidrome Subsonic API integration for triggering library rescans."""

from __future__ import annotations

import hashlib
import logging
import secrets

import httpx

from app.config import Settings
from app.models import NavidromeSyncResult

logger = logging.getLogger(__name__)

SUBSONIC_API_VERSION = "1.16.1"
SUBSONIC_CLIENT_NAME = "M4-Metadata-Manager"


async def trigger_navidrome_scan(
    settings: Settings,
    *,
    requested: bool = True,
) -> NavidromeSyncResult:
    """Trigger Navidrome's Subsonic `startScan` endpoint if configured.

    Uses Subsonic's salted MD5 token authentication (`t = md5(password + salt)`).
    Errors are captured gracefully so on-disk tag saves never fail because of
    transient network or Navidrome downtime.
    """
    if not settings.navidrome_configured:
        return NavidromeSyncResult(
            triggered=False,
            configured=False,
            ok=False,
            detail="Navidrome integration not configured.",
        )

    if not requested or not settings.navidrome_auto_scan:
        return NavidromeSyncResult(
            triggered=False,
            configured=True,
            ok=True,
            detail="Auto-scan skipped.",
        )

    salt = secrets.token_hex(6)
    token = hashlib.md5(
        f"{settings.navidrome_pass}{salt}".encode("utf-8")
    ).hexdigest()

    url = f"{settings.navidrome_url}/rest/startScan"
    params = {
        "u": settings.navidrome_user,
        "t": token,
        "s": salt,
        "v": SUBSONIC_API_VERSION,
        "c": SUBSONIC_CLIENT_NAME,
        "f": "json",
    }

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:
        logger.warning("Failed to trigger Navidrome scan at %s: %s", url, exc)
        return NavidromeSyncResult(
            triggered=True,
            configured=True,
            ok=False,
            detail=f"Navidrome unreachable: {exc}",
        )

    subsonic = payload.get("subsonic-response", {})
    if subsonic.get("status") == "ok":
        return NavidromeSyncResult(
            triggered=True,
            configured=True,
            ok=True,
            detail="Navidrome scan started.",
        )

    err = subsonic.get("error", {})
    err_msg = err.get("message") or "Unknown Subsonic API error"
    logger.warning("Navidrome startScan returned error: %s", err_msg)
    return NavidromeSyncResult(
        triggered=True,
        configured=True,
        ok=False,
        detail=f"Navidrome rejected scan: {err_msg}",
    )


async def test_navidrome_connection(
    url: str | None,
    user: str | None,
    password: str | None,
) -> NavidromeSyncResult:
    """Verify Navidrome reachability and credentials via Subsonic `/rest/ping.view`."""
    clean_url = (url or "").strip().rstrip("/")
    clean_user = (user or "").strip()
    clean_pass = (password or "").strip()
    if not clean_url or not clean_user or not clean_pass:
        return NavidromeSyncResult(
            triggered=False,
            configured=False,
            ok=False,
            detail="Enter Navidrome URL, username, and password to test.",
        )

    salt = secrets.token_hex(6)
    token = hashlib.md5(f"{clean_pass}{salt}".encode("utf-8")).hexdigest()
    params = {
        "u": clean_user,
        "t": token,
        "s": salt,
        "v": SUBSONIC_API_VERSION,
        "c": SUBSONIC_CLIENT_NAME,
        "f": "json",
    }

    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            response = await client.get(f"{clean_url}/rest/ping.view", params=params)
            response.raise_for_status()
            payload = response.json()
    except Exception as exc:
        return NavidromeSyncResult(
            triggered=False,
            configured=True,
            ok=False,
            detail=f"Could not reach Navidrome at {clean_url}: {exc}",
        )

    subsonic = payload.get("subsonic-response", {})
    if subsonic.get("status") == "ok":
        server_ver = subsonic.get("serverVersion") or subsonic.get("version")
        return NavidromeSyncResult(
            triggered=False,
            configured=True,
            ok=True,
            detail=f"Connected to Navidrome ({server_ver})" if server_ver else "Connected to Navidrome",
        )

    err = subsonic.get("error", {})
    err_msg = err.get("message") or "Invalid credentials or Subsonic API error"
    return NavidromeSyncResult(
        triggered=False,
        configured=True,
        ok=False,
        detail=f"Navidrome rejected login: {err_msg}",
    )

