"""Optional basic authentication with HMAC-signed HttpOnly session cookies and HTTP Basic support."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from pathlib import Path

from fastapi import Request

from app.config import Settings

SESSION_COOKIE_NAME = "m4_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days


def load_or_create_session_secret(settings: Settings) -> bytes:
    """Return signing key from M4_SESSION_SECRET or persist one in /config/.session_secret."""
    if settings.session_secret:
        return settings.session_secret.encode("utf-8")

    secret_file: Path = settings.config_dir / ".session_secret"
    try:
        settings.config_dir.mkdir(parents=True, exist_ok=True)
        if secret_file.is_file():
            existing = secret_file.read_text(encoding="utf-8").strip()
            if len(existing) >= 32:
                return existing.encode("utf-8")
        generated = secrets.token_hex(32)
        secret_file.write_text(generated, encoding="utf-8")
        try:
            secret_file.chmod(0o600)
        except OSError:
            pass
        return generated.encode("utf-8")
    except OSError:
        return secrets.token_bytes(32)


def verify_credentials(settings: Settings, username: str, password: str) -> bool:
    """Constant-time credential comparison against configured M4_AUTH_USER/M4_AUTH_PASS."""
    if not settings.auth_enabled:
        return True
    assert settings.auth_user is not None and settings.auth_pass is not None
    user_ok = hmac.compare_digest(username.encode("utf-8"), settings.auth_user.encode("utf-8"))
    pass_ok = hmac.compare_digest(password.encode("utf-8"), settings.auth_pass.encode("utf-8"))
    return user_ok and pass_ok


def create_session_token(username: str, secret: bytes) -> str:
    """Build a signed `user|exp|sig` cookie token."""
    expires = int(time.time()) + SESSION_TTL_SECONDS
    payload = f"{username}|{expires}"
    sig = hmac.new(secret, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    raw = f"{payload}|{sig}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def verify_session_token(token: str | None, expected_user: str | None, secret: bytes) -> str | None:
    """Verify a signed session cookie token and return the username if valid."""
    if not token or not expected_user:
        return None
    try:
        decoded = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8")
        username, exp_str, sig = decoded.rsplit("|", 2)
        expires = int(exp_str)
    except Exception:
        return None

    if expires < int(time.time()):
        return None
    if not hmac.compare_digest(username.encode("utf-8"), expected_user.encode("utf-8")):
        return None

    payload = f"{username}|{expires}"
    expected_sig = hmac.new(secret, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected_sig):
        return None
    return username


def _verify_basic_header(auth_header: str | None, settings: Settings) -> str | None:
    if not auth_header or not auth_header.lower().startswith("basic "):
        return None
    b64_part = auth_header[6:].strip()
    try:
        decoded = base64.b64decode(b64_part).decode("utf-8")
        username, password = decoded.split(":", 1)
    except Exception:
        return None
    if verify_credentials(settings, username, password):
        return username
    return None


def authenticate_request(request: Request) -> str | None:
    """Return authenticated username via session cookie or HTTP Basic header, or None."""
    settings: Settings = request.app.state.settings
    if not settings.auth_enabled:
        return None

    secret: bytes = request.app.state.session_secret
    cookie_token = request.cookies.get(SESSION_COOKIE_NAME)
    user = verify_session_token(cookie_token, settings.auth_user, secret)
    if user:
        return user

    return _verify_basic_header(request.headers.get("authorization"), settings)
