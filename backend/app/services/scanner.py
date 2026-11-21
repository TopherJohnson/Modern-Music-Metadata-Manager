"""Library scanner with mtime/size SQLite caching and Artist -> Album -> Track grouping."""

from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from collections import defaultdict
from pathlib import Path

from app.config import SUPPORTED_EXTENSIONS
from app.database import Database
from app.models import AlbumGroup, ArtistGroup, LibraryResponse, LibraryStats, TrackMetadata
from app.services.tags import read_track_metadata

logger = logging.getLogger(__name__)


def _parse_sort_number(value: str | None) -> int:
    if not value:
        return 999999
    match = re.match(r"^\s*(\d+)", value)
    return int(match.group(1)) if match else 999999


def _stable_id(*parts: str) -> str:
    digest = hashlib.sha1("::".join(parts).encode("utf-8")).hexdigest()
    return digest[:12]


def scan_library(
    music_dir: Path,
    db: Database,
    *,
    force_rescan: bool = False,
) -> list[TrackMetadata]:
    """Scan `music_dir` and return metadata for all supported audio tracks.

    Uses the SQLite cache in `/config/m4.db` keyed by `(path, mtime, file_size)` so
    subsequent requests stay fast even on large libraries.
    """
    if not music_dir.exists() or not music_dir.is_dir():
        return []

    root = music_dir.resolve()
    cached = {} if force_rescan else db.get_cached_tracks()

    discovered_paths: set[str] = set()
    tracks: list[TrackMetadata] = []
    to_upsert: list[TrackMetadata] = []

    for dirpath, dirnames, filenames in os.walk(root):
        # Skip hidden directories (e.g., .Trash, @eaDir, .git)
        dirnames[:] = sorted(
            d for d in dirnames if not d.startswith(".") and d != "@eaDir"
        )
        for filename in sorted(filenames):
            if filename.startswith("."):
                continue
            ext = Path(filename).suffix.lower()
            if ext not in SUPPORTED_EXTENSIONS:
                continue

            full_path = Path(dirpath) / filename
            try:
                rel_path = full_path.relative_to(root).as_posix()
                stat = full_path.stat()
            except OSError as exc:
                logger.warning("Skipping unreadable file %s: %s", full_path, exc)
                continue

            discovered_paths.add(rel_path)
            existing = cached.get(rel_path)
            if (
                existing is not None
                and abs(existing.mtime - stat.st_mtime) < 1e-4
                and existing.file_size == stat.st_size
            ):
                tracks.append(existing)
                continue

            try:
                meta = read_track_metadata(root, rel_path)
            except Exception as exc:
                logger.warning("Failed to parse audio metadata for %s: %s", rel_path, exc)
                continue

            tracks.append(meta)
            to_upsert.append(meta)

    stale_paths = [p for p in cached.keys() if p not in discovered_paths]
    if to_upsert:
        db.upsert_tracks(to_upsert)
    if stale_paths:
        db.remove_paths(stale_paths)

    return tracks


def _matches_query(track: TrackMetadata, tokens: list[str]) -> bool:
    haystack = " ".join(
        part.lower()
        for part in (
            track.title,
            track.artist,
            track.album_artist,
            track.album,
            track.genre,
            track.composer,
            track.year,
            track.format,
            track.path,
        )
        if part
    )
    return all(token in haystack for token in tokens)


def build_library_response(
    tracks: list[TrackMetadata],
    *,
    query: str | None = None,
) -> LibraryResponse:
    """Group a flat track list into Artist -> Album -> Track hierarchy with optional filtering."""
    filtered = tracks
    if query and query.strip():
        tokens = [tok.lower() for tok in query.strip().split() if tok]
        if tokens:
            filtered = [t for t in tracks if _matches_query(t, tokens)]

    grouped: dict[str, dict[str, list[TrackMetadata]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for track in filtered:
        artist_name = (
            track.album_artist or track.artist or "Unknown Artist"
        ).strip() or "Unknown Artist"
        album_name = (track.album or "Unknown Album").strip() or "Unknown Album"
        grouped[artist_name][album_name].append(track)

    artists: list[ArtistGroup] = []
    total_albums = 0
    total_duration = 0.0

    for artist_name in sorted(grouped.keys(), key=lambda s: s.casefold()):
        albums_map = grouped[artist_name]
        album_groups: list[AlbumGroup] = []

        for album_name, album_tracks in albums_map.items():
            sorted_tracks = sorted(
                album_tracks,
                key=lambda t: (
                    _parse_sort_number(t.disc_number),
                    _parse_sort_number(t.track_number),
                    (t.title or t.filename).casefold(),
                    t.filename.casefold(),
                ),
            )
            years = sorted({t.year for t in sorted_tracks if t.year})
            genres = sorted({t.genre for t in sorted_tracks if t.genre})
            formats = sorted({t.format for t in sorted_tracks if t.format})
            cover_track = next((t.path for t in sorted_tracks if t.has_artwork), None)
            album_duration = round(sum(t.duration for t in sorted_tracks), 2)

            album_groups.append(
                AlbumGroup(
                    id=_stable_id(artist_name.casefold(), album_name.casefold()),
                    title=album_name,
                    artist=artist_name,
                    year=years[0] if years else None,
                    genre=genres[0] if genres else None,
                    cover_track_path=cover_track,
                    track_count=len(sorted_tracks),
                    total_duration=album_duration,
                    formats=formats,
                    tracks=sorted_tracks,
                )
            )
            total_duration += album_duration

        album_groups.sort(
            key=lambda a: (
                a.year or "9999",
                a.title.casefold(),
            )
        )
        total_albums += len(album_groups)
        artists.append(
            ArtistGroup(
                id=_stable_id(artist_name.casefold()),
                name=artist_name,
                album_count=len(album_groups),
                track_count=sum(a.track_count for a in album_groups),
                albums=album_groups,
            )
        )

    stats = LibraryStats(
        artist_count=len(artists),
        album_count=total_albums,
        track_count=len(filtered),
        total_duration=round(total_duration, 2),
    )
    return LibraryResponse(
        stats=stats,
        artists=artists,
        scanned_at=time.time(),
    )
