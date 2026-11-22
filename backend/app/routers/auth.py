"""Optional Basic Auth session login/logout/status endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response

from app.config import Settings
from app.models import AuthStatusResponse, LoginRequest
from app.services.auth import (
    SESSION_COOKIE_NAME,
    SESSION_TTL_SECONDS,
    authenticate_request,
    create_session_token,
    verify_credentials,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _is_https(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    forwarded = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return forwarded == "https"


@router.get("/status", response_model=AuthStatusResponse)
async def get_auth_status(request: Request) -> AuthStatusResponse:
    """Report whether Basic Auth is enabled and whether this client is authenticated."""
    settings: Settings = request.app.state.settings
    if not settings.auth_enabled:
        return AuthStatusResponse(enabled=False, authenticated=True, username=None)

    user = authenticate_request(request)
    return AuthStatusResponse(
        enabled=True,
        authenticated=user is not None,
        username=user,
    )


@router.post("/login", response_model=AuthStatusResponse)
async def post_login(
    request: Request,
    response: Response,
    payload: LoginRequest,
) -> AuthStatusResponse:
    """Validate credentials against M4_AUTH_USER / M4_AUTH_PASS and set an HttpOnly session cookie."""
    settings: Settings = request.app.state.settings
    if not settings.auth_enabled:
        return AuthStatusResponse(enabled=False, authenticated=True, username=None)

    if not verify_credentials(settings, payload.username, payload.password):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    secret: bytes = request.app.state.session_secret
    token = create_session_token(payload.username, secret)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=_is_https(request),
        path="/",
    )
    return AuthStatusResponse(
        enabled=True,
        authenticated=True,
        username=payload.username,
    )


@router.post("/logout", response_model=AuthStatusResponse)
async def post_logout(request: Request, response: Response) -> AuthStatusResponse:
    """Clear the M⁴ session cookie."""
    settings: Settings = request.app.state.settings
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")
    return AuthStatusResponse(
        enabled=settings.auth_enabled,
        authenticated=not settings.auth_enabled,
        username=None,
    )
