"""Lightweight SQLite persistence in /config/m4.db for scan cache, settings, and audit history."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.models import AuditEntry, OrganizeSettings, TrackMetadata


TRACK_CACHE_DDL = """
CREATE TABLE IF NOT EXISTS track_cache (
    library_id TEXT NOT NULL DEFAULT 'default',
    path TEXT NOT NULL,
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    mtime REAL NOT NULL,
    file_size INTEGER NOT NULL,
    duration REAL NOT NULL DEFAULT 0.0,
    bitrate INTEGER,
    sample_rate INTEGER,
    has_artwork INTEGER NOT NULL DEFAULT 0,
    artwork_mime TEXT,
    artwork_hash TEXT,
    artwork_size INTEGER,
    title TEXT,
    artist TEXT,
    album_artist TEXT,
    album TEXT,
    year TEXT,
    track_number TEXT,
    disc_number TEXT,
    genre TEXT,
    composer TEXT,
    release_date TEXT,
    album_version TEXT,
    compilation TEXT,
    musicbrainz_album_id TEXT,
    musicbrainz_album_artist_id TEXT,
    PRIMARY KEY (library_id, path)
);
"""

SCHEMA_SQL = (
    TRACK_CACHE_DDL
    + """
CREATE TABLE IF NOT EXISTS audit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    library_id TEXT NOT NULL DEFAULT 'default',
    batch_id TEXT,
    path TEXT NOT NULL,
    action TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_audit_history_timestamp
    ON audit_history (timestamp DESC);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""
)

# Columns added after v0.1.0 initial schema; auto-migrated on startup.
_TRACK_CACHE_MIGRATIONS: tuple[tuple[str, str], ...] = (
    ("artwork_hash", "TEXT"),
    ("artwork_size", "INTEGER"),
    ("release_date", "TEXT"),
    ("album_version", "TEXT"),
    ("compilation", "TEXT"),
    ("musicbrainz_album_id", "TEXT"),
    ("musicbrainz_album_artist_id", "TEXT"),
)

_UNDOABLE_TAG_ACTIONS: frozenset[str] = frozenset(
    {"update_track", "bulk_update", "musicbrainz_apply", "musicbrainz_apply_track"}
)
_UNDOABLE_ACTIONS: frozenset[str] = _UNDOABLE_TAG_ACTIONS | {"move_track"}


class Database:
    """Thin SQLite wrapper used for caching scanned track metadata and recording edits."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._initialized = False

    def init(self) -> None:
        """Create the config directory, initialize tables, and migrate schema if needed."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(SCHEMA_SQL)

            existing_cols = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(track_cache)").fetchall()
            }
            if "library_id" not in existing_cols:
                # Rebuild the regenerable scan cache with composite PRIMARY KEY (library_id, path)
                conn.execute("DROP TABLE track_cache")
                conn.executescript(TRACK_CACHE_DDL)
            else:
                migrated = False
                for col_name, col_type in _TRACK_CACHE_MIGRATIONS:
                    if col_name not in existing_cols:
                        conn.execute(
                            f"ALTER TABLE track_cache ADD COLUMN {col_name} {col_type}"
                        )
                        migrated = True
                if migrated:
                    conn.execute("DELETE FROM track_cache")

            audit_cols = {
                row["name"]
                for row in conn.execute("PRAGMA table_info(audit_history)").fetchall()
            }
            if "undone" not in audit_cols:
                conn.execute(
                    "ALTER TABLE audit_history ADD COLUMN undone INTEGER NOT NULL DEFAULT 0"
                )
            if "library_id" not in audit_cols:
                conn.execute(
                    "ALTER TABLE audit_history ADD COLUMN library_id TEXT NOT NULL DEFAULT 'default'"
                )
            if "batch_id" not in audit_cols:
                conn.execute("ALTER TABLE audit_history ADD COLUMN batch_id TEXT")

            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_audit_history_library ON audit_history (library_id, id DESC)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_audit_history_batch ON audit_history (batch_id)"
            )
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

    def get_cached_tracks(self, library_id: str = "default") -> dict[str, TrackMetadata]:
        """Return all cached tracks for `library_id` keyed by their relative POSIX path."""
        if not self._initialized and not self.db_path.exists():
            return {}
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM track_cache WHERE library_id = ?",
                (library_id,),
            ).fetchall()
        return {row["path"]: self._row_to_track(row) for row in rows}

    def count_cached_tracks(self, library_id: str | None = None) -> int:
        if not self.db_path.exists():
            return 0
        with self._connect() as conn:
            if library_id is None:
                row = conn.execute("SELECT COUNT(*) AS cnt FROM track_cache").fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*) AS cnt FROM track_cache WHERE library_id = ?",
                    (library_id,),
                ).fetchone()
        return int(row["cnt"]) if row else 0

    def upsert_tracks(
        self,
        tracks: list[TrackMetadata],
        library_id: str = "default",
    ) -> None:
        """Insert or update cached metadata rows for `library_id`."""
        if not tracks:
            return
        params = [
            (
                library_id,
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
                t.artwork_hash,
                t.artwork_size,
                t.title,
                t.artist,
                t.album_artist,
                t.album,
                t.year,
                t.track_number,
                t.disc_number,
                t.genre,
                t.composer,
                t.release_date,
                t.album_version,
                t.compilation,
                t.musicbrainz_album_id,
                t.musicbrainz_album_artist_id,
            )
            for t in tracks
        ]
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO track_cache (
                    library_id, path, filename, format, mtime, file_size, duration,
                    bitrate, sample_rate, has_artwork, artwork_mime,
                    artwork_hash, artwork_size,
                    title, artist, album_artist, album, year,
                    track_number, disc_number, genre, composer,
                    release_date, album_version, compilation,
                    musicbrainz_album_id, musicbrainz_album_artist_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(library_id, path) DO UPDATE SET
                    filename=excluded.filename,
                    format=excluded.format,
                    mtime=excluded.mtime,
                    file_size=excluded.file_size,
                    duration=excluded.duration,
                    bitrate=excluded.bitrate,
                    sample_rate=excluded.sample_rate,
                    has_artwork=excluded.has_artwork,
                    artwork_mime=excluded.artwork_mime,
                    artwork_hash=excluded.artwork_hash,
                    artwork_size=excluded.artwork_size,
                    title=excluded.title,
                    artist=excluded.artist,
                    album_artist=excluded.album_artist,
                    album=excluded.album,
                    year=excluded.year,
                    track_number=excluded.track_number,
                    disc_number=excluded.disc_number,
                    genre=excluded.genre,
                    composer=excluded.composer,
                    release_date=excluded.release_date,
                    album_version=excluded.album_version,
                    compilation=excluded.compilation,
                    musicbrainz_album_id=excluded.musicbrainz_album_id,
                    musicbrainz_album_artist_id=excluded.musicbrainz_album_artist_id
                """,
                params,
            )

    def remove_paths(self, paths: list[str], library_id: str = "default") -> None:
        """Delete stale rows whose files no longer exist on disk."""
        if not paths:
            return
        with self._connect() as conn:
            conn.executemany(
                "DELETE FROM track_cache WHERE library_id = ? AND path = ?",
                [(library_id, p) for p in paths],
            )

    def record_audit(
        self,
        path: str,
        action: str,
        before_tags: dict[str, Any],
        after_tags: dict[str, Any],
        *,
        library_id: str = "default",
        batch_id: str | None = None,
    ) -> None:
        """Append a metadata edit or file move event for audit/undo history."""
        ts = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO audit_history (timestamp, library_id, batch_id, path, action, before_json, after_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ts,
                    library_id,
                    batch_id,
                    path,
                    action,
                    json.dumps(before_tags),
                    json.dumps(after_tags),
                ),
            )

    def get_audit_history(
        self,
        limit: int = 100,
        *,
        library_id: str | None = None,
    ) -> list[AuditEntry]:
        """Return the most recent metadata modification records, optionally scoped by library."""
        if not self.db_path.exists():
            return []
        with self._connect() as conn:
            if library_id is None:
                rows = conn.execute(
                    """
                    SELECT id, timestamp, library_id, batch_id, path, action, before_json, after_json, undone
                    FROM audit_history
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, timestamp, library_id, batch_id, path, action, before_json, after_json, undone
                    FROM audit_history
                    WHERE library_id = ?
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (library_id, limit),
                ).fetchall()
        return [self._row_to_audit(row) for row in rows]

    def get_audit_entry(self, entry_id: int) -> AuditEntry | None:
        """Fetch a single audit history entry by ID."""
        if not self.db_path.exists():
            return None
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT id, timestamp, library_id, batch_id, path, action, before_json, after_json, undone
                FROM audit_history
                WHERE id = ?
                """,
                (entry_id,),
            ).fetchone()
        return self._row_to_audit(row) if row else None

    def get_audit_batch(
        self,
        batch_id: str,
        *,
        library_id: str | None = None,
    ) -> list[AuditEntry]:
        """Fetch all audit entries belonging to `batch_id` in reverse execution order (id DESC)."""
        if not self.db_path.exists():
            return []
        with self._connect() as conn:
            if library_id is None:
                rows = conn.execute(
                    """
                    SELECT id, timestamp, library_id, batch_id, path, action, before_json, after_json, undone
                    FROM audit_history
                    WHERE batch_id = ?
                    ORDER BY id DESC
                    """,
                    (batch_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT id, timestamp, library_id, batch_id, path, action, before_json, after_json, undone
                    FROM audit_history
                    WHERE batch_id = ? AND library_id = ?
                    ORDER BY id DESC
                    """,
                    (batch_id, library_id),
                ).fetchall()
        return [self._row_to_audit(row) for row in rows]

    def mark_audit_undone(self, entry_id: int) -> None:
        """Mark an audit history entry as already undone."""
        with self._connect() as conn:
            conn.execute(
                "UPDATE audit_history SET undone = 1 WHERE id = ?",
                (entry_id,),
            )

    @staticmethod
    def _row_to_audit(row: sqlite3.Row) -> AuditEntry:
        before = json.loads(row["before_json"])
        after = json.loads(row["after_json"])
        undone = bool(row["undone"])
        action = str(row["action"])

        changed_fields: list[str] = []
        for key in sorted(set(before.keys()) | set(after.keys())):
            if key == "sidecars":
                continue
            if before.get(key) != after.get(key):
                changed_fields.append(key)

        can_undo = (
            not undone
            and action in _UNDOABLE_ACTIONS
            and (
                (action == "move_track" and bool(before.get("path")) and bool(after.get("path")))
                or (action in _UNDOABLE_TAG_ACTIONS and bool(changed_fields))
            )
        )

        return AuditEntry(
            id=row["id"],
            timestamp=row["timestamp"],
            library_id=str(row["library_id"] or "default"),
            batch_id=row["batch_id"],
            path=row["path"],
            action=action,
            before_tags=before,
            after_tags=after,
            undone=undone,
            can_undo=can_undo,
            changed_fields=changed_fields,
        )

    def get_organize_settings(self, library_id: str = "default") -> OrganizeSettings:
        """Load persisted library folder organization preferences for `library_id`."""
        if not self.db_path.exists():
            return OrganizeSettings()
        scoped_key = f"organize_settings:{library_id}"
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                (scoped_key,),
            ).fetchone()
            if not row and library_id == "default":
                row = conn.execute(
                    "SELECT value FROM app_settings WHERE key = ?",
                    ("organize_settings",),
                ).fetchone()
        if not row:
            return OrganizeSettings()
        try:
            return OrganizeSettings.model_validate_json(row["value"])
        except Exception:
            return OrganizeSettings()

    def save_organize_settings(
        self,
        settings: OrganizeSettings,
        library_id: str = "default",
    ) -> OrganizeSettings:
        """Persist library folder organization preferences for `library_id` in app_settings."""
        payload = settings.model_dump_json()
        scoped_key = f"organize_settings:{library_id}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO app_settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (scoped_key, payload),
            )
        return settings

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
            artwork_hash=row["artwork_hash"],
            artwork_size=row["artwork_size"],
            title=row["title"],
            artist=row["artist"],
            album_artist=row["album_artist"],
            album=row["album"],
            year=row["year"],
            track_number=row["track_number"],
            disc_number=row["disc_number"],
            genre=row["genre"],
            composer=row["composer"],
            release_date=row["release_date"],
            album_version=row["album_version"],
            compilation=row["compilation"],
            musicbrainz_album_id=row["musicbrainz_album_id"],
            musicbrainz_album_artist_id=row["musicbrainz_album_artist_id"],
        )
