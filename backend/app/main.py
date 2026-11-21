"""FastAPI application entrypoint for Modern Music Metadata Manager (M⁴)."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.config import Settings, load_settings
from app.database import Database
from app.routers import health, library, musicbrainz, organize, tracks


def create_app(settings: Settings | None = None) -> FastAPI:
    """Construct and configure the M⁴ FastAPI application."""
    active_settings = settings or load_settings()

    logging.basicConfig(
        level=getattr(logging, active_settings.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db = Database(active_settings.db_path)
        try:
            db.init()
        except OSError as exc:
            logging.getLogger(__name__).error(
                "Could not initialize SQLite database at %s: %s",
                active_settings.db_path,
                exc,
            )
        app.state.settings = active_settings
        app.state.db = db
        yield

    app = FastAPI(
        title="Modern Music Metadata Manager (M⁴)",
        description="Self-hosted companion to Navidrome for inspecting and editing audio metadata on disk.",
        version=__version__,
        lifespan=lifespan,
    )

    # Allow local Vite dev server during development
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:8080",
            "http://127.0.0.1:8080",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(library.router)
    app.include_router(tracks.router)
    app.include_router(musicbrainz.router)
    app.include_router(organize.router)

    static_dir = active_settings.static_dir
    if static_dir and static_dir.is_dir():
        _mount_spa(app, static_dir)

    return app


def _mount_spa(app: FastAPI, static_dir: Path) -> None:
    """Serve the compiled Vite frontend bundle and fall back to index.html for SPA routes."""
    assets_dir = static_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    index_html = static_dir / "index.html"

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/") or full_path == "api":
            raise HTTPException(status_code=404, detail="API endpoint not found.")

        candidate = (static_dir / full_path).resolve()
        static_root = static_dir.resolve()
        if (
            full_path
            and candidate.is_relative_to(static_root)
            and candidate.is_file()
        ):
            return FileResponse(candidate)

        return FileResponse(index_html)


app = create_app()
