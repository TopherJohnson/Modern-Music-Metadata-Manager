"""Application configuration loaded from environment variables."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path


SUPPORTED_EXTENSIONS: frozenset[str] = frozenset(
    {".mp3", ".flac", ".m4a", ".ogg", ".opus"}
)

_SLUG_RE = re.compile(r"[^a-z0-9]+")


STAGING_LIBRARY_ID = "__staging__"


@dataclass(frozen=True)
class LibraryConfig:
    """Single configured music library (or staging inbox) root directory."""

    id: str
    name: str
    path: Path
    is_staging: bool = False


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
    libraries: tuple[LibraryConfig, ...] = ()
    auth_user: str | None = None
    auth_pass: str | None = None
    session_secret: str | None = None
    staging_dir: Path | None = None
    slskd_url: str | None = None
    slskd_api_key: str | None = None

    def __post_init__(self) -> None:
        if not self.libraries:
            object.__setattr__(
                self,
                "libraries",
                (LibraryConfig(id="default", name="Music", path=self.music_dir),),
            )

    @property
    def db_path(self) -> Path:
        return self.config_dir / "m4.db"

    @property
    def navidrome_configured(self) -> bool:
        return bool(self.navidrome_url and self.navidrome_user and self.navidrome_pass)

    @property
    def staging_configured(self) -> bool:
        return self.staging_dir is not None

    @property
    def staging_library(self) -> LibraryConfig | None:
        if self.staging_dir is None:
            return None
        return LibraryConfig(
            id=STAGING_LIBRARY_ID,
            name="Staging",
            path=self.staging_dir,
            is_staging=True,
        )

    @property
    def slskd_configured(self) -> bool:
        return bool(self.slskd_url and self.slskd_api_key)

    @property
    def auth_enabled(self) -> bool:
        return bool(self.auth_user and self.auth_pass)

    @property
    def default_library(self) -> LibraryConfig:
        return self.libraries[0]

    def get_library(self, library_id: str | None = None) -> LibraryConfig | None:
        if not library_id:
            return self.libraries[0]
        target = library_id.strip().lower()
        if target == STAGING_LIBRARY_ID:
            return self.staging_library
        for lib in self.libraries:
            if lib.id == target:
                return lib
        return None


def _clean_env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def _slugify(name: str, fallback: str) -> str:
    slug = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return slug or fallback


def _parse_libraries(raw: str | None, fallback_music_dir: Path) -> tuple[LibraryConfig, ...]:
    """Parse `M4_LIBRARIES` (e.g. `Main:/music/main,Soundtracks:/music/soundtracks`).

    Falls back to a single `default` library pointing to `M4_MUSIC_DIR` when unset.
    """
    if not raw:
        return (LibraryConfig(id="default", name="Music", path=fallback_music_dir),)

    configs: list[LibraryConfig] = []
    used_ids: set[str] = set()

    for idx, entry in enumerate(raw.split(","), start=1):
        piece = entry.strip()
        if not piece:
            continue

        if ":" in piece:
            name_part, path_part = piece.split(":", 1)
            name = name_part.strip() or f"Library {idx}"
            path = Path(path_part.strip())
        else:
            path = Path(piece)
            name = path.name or f"Library {idx}"

        base_id = _slugify(name, f"lib-{idx}")
        lib_id = base_id
        suffix = 2
        while lib_id in used_ids:
            lib_id = f"{base_id}-{suffix}"
            suffix += 1
        used_ids.add(lib_id)
        configs.append(LibraryConfig(id=lib_id, name=name, path=path))

    if not configs:
        return (LibraryConfig(id="default", name="Music", path=fallback_music_dir),)

    return tuple(configs)


def _resolve_static_dir() -> Path | None:
    env_static = _clean_env("M4_STATIC_DIR")
    if env_static:
        p = Path(env_static)
        return p if p.is_dir() else None

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
    libraries = _parse_libraries(_clean_env("M4_LIBRARIES"), music_dir)

    navidrome_url = _clean_env("NAVIDROME_URL")
    if navidrome_url:
        navidrome_url = navidrome_url.rstrip("/")

    auto_scan_raw = os.environ.get("NAVIDROME_AUTO_SCAN", "true").strip().lower()
    navidrome_auto_scan = auto_scan_raw not in {"0", "false", "no", "off"}

    staging_raw = _clean_env("M4_STAGING_DIR") or _clean_env("M4_INBOX_DIR")
    staging_dir = Path(staging_raw) if staging_raw else None

    slskd_url = _clean_env("SLSKD_URL")
    if slskd_url:
        slskd_url = slskd_url.rstrip("/")

    return Settings(
        music_dir=libraries[0].path,
        config_dir=config_dir,
        static_dir=_resolve_static_dir(),
        navidrome_url=navidrome_url,
        navidrome_user=_clean_env("NAVIDROME_USER"),
        navidrome_pass=_clean_env("NAVIDROME_PASS"),
        navidrome_auto_scan=navidrome_auto_scan,
        log_level=os.environ.get("M4_LOG_LEVEL", "info").lower(),
        libraries=libraries,
        auth_user=_clean_env("M4_AUTH_USER"),
        auth_pass=_clean_env("M4_AUTH_PASS"),
        session_secret=_clean_env("M4_SESSION_SECRET"),
        staging_dir=staging_dir,
        slskd_url=slskd_url,
        slskd_api_key=_clean_env("SLSKD_API_KEY"),
    )
