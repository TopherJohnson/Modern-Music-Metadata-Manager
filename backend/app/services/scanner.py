"""Library scanner with mtime/size SQLite caching, artwork deduplication, and Navidrome split diagnostics."""

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
from app.models import (
    AlbumGroup,
    ArtistGroup,
    ArtworkVariant,
    LibraryResponse,
    LibraryStats,
    NavidromeSplitWarning,
    TrackMetadata,
)
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


def _display_value(value: str | None) -> str:
    return value if value else "(empty)"


def _collect_artwork_variants(tracks: list[TrackMetadata]) -> list[ArtworkVariant]:
    """Deduplicate embedded cover images across an album's tracks using `artwork_hash`."""
    buckets: dict[str, list[TrackMetadata]] = defaultdict(list)
    for track in tracks:
        if track.has_artwork:
            key = track.artwork_hash or f"path:{track.path}"
            buckets[key].append(track)

    variants: list[ArtworkVariant] = []
    for art_hash, matching_tracks in buckets.items():
        sample = matching_tracks[0]
        variants.append(
            ArtworkVariant(
                hash=art_hash,
                sample_track_path=sample.path,
                mime=sample.artwork_mime,
                size=sample.artwork_size or 0,
                track_count=len(matching_tracks),
                track_paths=[t.path for t in matching_tracks],
            )
        )

    variants.sort(key=lambda v: (-v.track_count, -v.size, v.sample_track_path))
    return variants


def _compute_missing_fields(track: TrackMetadata) -> list[str]:
    missing: list[str] = []
    if not (track.title or "").strip():
        missing.append("title")
    if not (track.artist or track.album_artist or "").strip():
        missing.append("artist")
    if not (track.album or "").strip():
        missing.append("album")
    return missing


def _detect_navidrome_warnings(
    tracks: list[TrackMetadata],
    artwork_variants: list[ArtworkVariant],
) -> list[NavidromeSplitWarning]:
    """Detect major missing metadata and Navidrome PID.Album split-album discrepancies."""
    if not tracks:
        return []

    warnings: list[NavidromeSplitWarning] = []

    # 1. Major missing metadata checks (apply even to 1-track / stray files)
    missing_artist = sum(1 for t in tracks if not (t.artist or t.album_artist or "").strip())
    missing_album = sum(1 for t in tracks if not (t.album or "").strip())
    missing_title = sum(1 for t in tracks if not (t.title or "").strip())

    if missing_artist > 0:
        warnings.append(
            NavidromeSplitWarning(
                field="artist",
                label="Missing Artist",
                severity="missing",
                message=f"{missing_artist} of {len(tracks)} track{'s' if len(tracks) != 1 else ''} missing Artist / Album Artist tags (listed under Unknown Artist).",
                values=[],
            )
        )
    if missing_album > 0:
        warnings.append(
            NavidromeSplitWarning(
                field="album",
                label="Missing Album",
                severity="missing",
                message=f"{missing_album} of {len(tracks)} track{'s' if len(tracks) != 1 else ''} missing an Album tag (listed under Unknown Album).",
                values=[],
            )
        )
    if missing_title > 0:
        warnings.append(
            NavidromeSplitWarning(
                field="title",
                label="Missing Track Title",
                severity="missing",
                message=f"{missing_title} of {len(tracks)} track{'s' if len(tracks) != 1 else ''} missing a Title tag.",
                values=[],
            )
        )

    # Multi-track album consistency checks only apply when 2+ tracks are grouped together
    if len(tracks) <= 1:
        return warnings

    def check_field(field: str, label: str, reason: str) -> None:
        raw_vals = [(getattr(t, field) or "").strip() for t in tracks]
        distinct = sorted(set(raw_vals))
        if len(distinct) > 1:
            warnings.append(
                NavidromeSplitWarning(
                    field=field,
                    label=label,
                    severity="split",
                    message=reason,
                    values=[_display_value(v) for v in distinct[:6]],
                )
            )

    check_field(
        "musicbrainz_album_id",
        "MusicBrainz Album ID",
        "Navidrome groups by MusicBrainz Album ID first. Mixed or missing IDs across tracks split the album.",
    )
    check_field(
        "musicbrainz_album_artist_id",
        "MusicBrainz Album Artist ID",
        "Different MusicBrainz Album Artist IDs produce different albumartistid PIDs in Navidrome.",
    )
    check_field(
        "album_artist",
        "Album Artist",
        "Inconsistent Album Artist tags across tracks cause Navidrome to split the album.",
    )

    # Also detect missing album_artist combined with differing per-track artist (e.g. "feat." guests)
    if all(not (t.album_artist or "").strip() for t in tracks):
        distinct_artists = sorted({(t.artist or "").strip() for t in tracks})
        if len(distinct_artists) > 1:
            warnings.append(
                NavidromeSplitWarning(
                    field="album_artist",
                    label="Missing Album Artist",
                    severity="split",
                    message="Tracks have different Artist values and no Album Artist set; Navidrome splits these unless Album Artist is unified (or Compilation=1).",
                    values=[_display_value(v) for v in distinct_artists[:6]],
                )
            )

    check_field(
        "year",
        "Year / Date",
        "Navidrome includes release date in its default Album PID; mismatched years/dates split the album.",
    )
    check_field(
        "release_date",
        "Release Date (TDRL / RELEASEDATE)",
        "Navidrome uses RELEASEDATE/TDRL to disambiguate reissues; mismatched values split the album.",
    )
    check_field(
        "album_version",
        "Album Version",
        "Different album version / comment tags split an album into separate editions in Navidrome.",
    )
    check_field(
        "compilation",
        "Compilation Flag",
        "Some tracks are marked as part of a compilation while others are not.",
    )

    # Embedded artwork consistency (multiple distinct images or missing artwork on some tracks)
    tracks_without_art = sum(1 for t in tracks if not t.has_artwork)
    if len(artwork_variants) > 1:
        warnings.append(
            NavidromeSplitWarning(
                field="artwork",
                label="Multiple Embedded Covers",
                severity="artwork",
                message=f"{len(artwork_variants)} distinct embedded cover images found across tracks. Use Bulk Edit to apply one cover to the whole album.",
                values=[
                    f"{v.track_count} track{'s' if v.track_count != 1 else ''} ({v.mime or 'image'})"
                    for v in artwork_variants[:5]
                ],
            )
        )
    elif len(artwork_variants) == 1 and tracks_without_art > 0:
        warnings.append(
            NavidromeSplitWarning(
                field="artwork",
                label="Partial Cover Art",
                severity="artwork",
                message=f"{tracks_without_art} of {len(tracks)} tracks are missing embedded cover art.",
                values=[],
            )
        )

    return warnings


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
            track.release_date,
            track.album_version,
            track.musicbrainz_album_id,
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
            for track in sorted_tracks:
                track.missing_fields = _compute_missing_fields(track)

            years = sorted({t.year for t in sorted_tracks if t.year})
            genres = sorted({t.genre for t in sorted_tracks if t.genre})
            formats = sorted({t.format for t in sorted_tracks if t.format})
            artwork_variants = _collect_artwork_variants(sorted_tracks)
            cover_track = (
                artwork_variants[0].sample_track_path if artwork_variants else None
            )
            navidrome_warnings = _detect_navidrome_warnings(
                sorted_tracks, artwork_variants
            )
            has_missing_metadata = any(
                w.severity == "missing" for w in navidrome_warnings
            )
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
                    artwork_variants=artwork_variants,
                    navidrome_warnings=navidrome_warnings,
                    has_missing_metadata=has_missing_metadata,
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
