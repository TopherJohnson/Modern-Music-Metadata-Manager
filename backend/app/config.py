"""Application configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


SUPPORTED_EXTENSIONS: frozenset[str] = frozenset(
    {".mp3", ".flac", ".m4a", ".ogg", ".opus"}
)


@dataclass(frozen=True)
class Settings:
    """Runtime settings for M⁴."""

    music_dir: Path
    config_dir: Path
    static_dir: Path | None
    navidrome_url: str | None
    navidrome_user: str | None
    navidrome_pass: str | None
    navidrome_auto_scan: bool
    log_level: str

    @property
    def db_path(self) -> Path:
        return self.config_dir / "m4.db"

    @property
    def navidrome_configured(self) -> bool:
        return bool(self.navidrome_url and self.navidrome_user and self.navidrome_pass)


def _clean_env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def _resolve_static_dir() -> Path | None:
    env_static = _clean_env("M4_STATIC_DIR")
    if env_static:
        p = Path(env_static)
        return p if p.is_dir() else None

    # Default locations: container (/app/static) or local dev (frontend/dist)
    repo_root = Path(__file__).resolve().parents[2]
    candidates = [
        Path("/app/static"),
        repo_root / "frontend" / "dist",
    ]
    for candidate in candidates:
        if candidate.is_dir() and (candidate / "index.html").is_file():
            return candidate
    return None


def load_settings() -> Settings:
    """Load runtime settings from the current process environment."""
    music_dir = Path(os.environ.get("M4_MUSIC_DIR", "/music"))
    config_dir = Path(os.environ.get("M4_CONFIG_DIR", "/config"))
    navidrome_url = _clean_env("NAVIDROME_URL")
    if navidrome_url:
        navidrome_url = navidrome_url.rstrip("/")

    auto_scan_raw = os.environ.get("NAVIDROME_AUTO_SCAN", "true").strip().lower()
    navidrome_auto_scan = auto_scan_raw not in {"0", "false", "no", "off"}

    return Settings(
        music_dir=music_dir,
        config_dir=config_dir,
        static_dir=_resolve_static_dir(),
        navidrome_url=navidrome_url,
        navidrome_user=_clean_env("NAVIDROME_USER"),
        navidrome_pass=_clean_env("NAVIDROME_PASS"),
        navidrome_auto_scan=navidrome_auto_scan,
        log_level=os.environ.get("M4_LOG_LEVEL", "info").lower(),
    )
