"""Lightweight SQLite persistence in /config/m4.db for scan cache, settings, and audit history."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.models import AuditEntry, TrackMetadata


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS track_cache (
    path TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    mtime REAL NOT NULL,
    file_size INTEGER NOT NULL,
    duration REAL NOT NULL DEFAULT 0.0,
    bitrate INTEGER,
    sample_rate INTEGER,
    has_artwork INTEGER NOT NULL DEFAULT 0,
    artwork_mime TEXT,
    title TEXT,
    artist TEXT,
    album_artist TEXT,
    album TEXT,
    year TEXT,
    track_number TEXT,
    disc_number TEXT,
    genre TEXT,
    composer TEXT
);

CREATE TABLE IF NOT EXISTS audit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    path TEXT NOT NULL,
    action TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_history_timestamp
    ON audit_history (timestamp DESC);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class Database:
    """Thin SQLite wrapper used for caching scanned track metadata and recording edits."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._initialized = False

    def init(self) -> None:
        """Create the config directory and initialize tables if needed."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA_SQL)
        self._initialized = True

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path, timeout=15.0)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            yield conn
            conn.commit()
        finally:
            conn.close()

    def get_cached_tracks(self) -> dict[str, TrackMetadata]:
        """Return all cached tracks keyed by their relative POSIX path."""
        if not self._initialized and not self.db_path.exists():
            return {}
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM track_cache").fetchall()
        return {row["path"]: self._row_to_track(row) for row in rows}

    def count_cached_tracks(self) -> int:
        if not self.db_path.exists():
            return 0
        with self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS cnt FROM track_cache").fetchone()
        return int(row["cnt"]) if row else 0

    def upsert_tracks(self, tracks: list[TrackMetadata]) -> None:
        """Insert or update cached metadata rows."""
        if not tracks:
            return
        params = [
            (
                t.path,
                t.filename,
                t.format,
                t.mtime,
                t.file_size,
                t.duration,
                t.bitrate,
                t.sample_rate,
                1 if t.has_artwork else 0,
                t.artwork_mime,
                t.title,
                t.artist,
                t.album_artist,
                t.album,
                t.year,
                t.track_number,
                t.disc_number,
                t.genre,
                t.composer,
            )
            for t in tracks
        ]
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO track_cache (
                    path, filename, format, mtime, file_size, duration,
                    bitrate, sample_rate, has_artwork, artwork_mime,
                    title, artist, album_artist, album, year,
                    track_number, disc_number, genre, composer
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    filename=excluded.filename,
                    format=excluded.format,
                    mtime=excluded.mtime,
                    file_size=excluded.file_size,
                    duration=excluded.duration,
                    bitrate=excluded.bitrate,
                    sample_rate=excluded.sample_rate,
                    has_artwork=excluded.has_artwork,
                    artwork_mime=excluded.artwork_mime,
                    title=excluded.title,
                    artist=excluded.artist,
                    album_artist=excluded.album_artist,
                    album=excluded.album,
                    year=excluded.year,
                    track_number=excluded.track_number,
                    disc_number=excluded.disc_number,
                    genre=excluded.genre,
                    composer=excluded.composer
                """,
                params,
            )

    def remove_paths(self, paths: list[str]) -> None:
        """Delete stale rows whose files no longer exist on disk."""
        if not paths:
            return
        with self._connect() as conn:
            conn.executemany(
                "DELETE FROM track_cache WHERE path = ?",
                [(p,) for p in paths],
            )

    def record_audit(
        self,
        path: str,
        action: str,
        before_tags: dict[str, Any],
        after_tags: dict[str, Any],
    ) -> None:
        """Append a metadata edit event for audit/undo history."""
        ts = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO audit_history (timestamp, path, action, before_json, after_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (ts, path, action, json.dumps(before_tags), json.dumps(after_tags)),
            )

    def get_audit_history(self, limit: int = 50) -> list[AuditEntry]:
        """Return the most recent metadata modification records."""
        if not self.db_path.exists():
            return []
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, timestamp, path, action, before_json, after_json
                FROM audit_history
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [
            AuditEntry(
                id=row["id"],
                timestamp=row["timestamp"],
                path=row["path"],
                action=row["action"],
                before_tags=json.loads(row["before_json"]),
                after_tags=json.loads(row["after_json"]),
            )
            for row in rows
        ]

    @staticmethod
    def _row_to_track(row: sqlite3.Row) -> TrackMetadata:
        return TrackMetadata(
            path=row["path"],
            filename=row["filename"],
            format=row["format"],
            mtime=float(row["mtime"]),
            file_size=int(row["file_size"]),
            duration=float(row["duration"]),
            bitrate=row["bitrate"],
            sample_rate=row["sample_rate"],
            has_artwork=bool(row["has_artwork"]),
            artwork_mime=row["artwork_mime"],
            title=row["title"],
            artist=row["artist"],
            album_artist=row["album_artist"],
            album=row["album"],
            year=row["year"],
            track_number=row["track_number"],
            disc_number=row["disc_number"],
            genre=row["genre"],
            composer=row["composer"],
        )
