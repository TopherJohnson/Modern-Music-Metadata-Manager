"""Library scanner with mtime/size SQLite caching, artwork deduplication, and Navidrome split diagnostics."""

from __future__ import annotations

import difflib
import hashlib
import logging
import os
import re
import time
import unicodedata
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
    MusicBrainzReleaseDetail,
    NavidromeSplitWarning,
    OrganizeSettings,
    TrackMetadata,
)
from app.services.completeness import populate_library_completeness
from app.services.organizer import track_needs_reorganize
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
    library_id: str = "default",
) -> list[TrackMetadata]:
    """Scan `music_dir` and return metadata for all supported audio tracks.

    Uses the SQLite cache in `/config/m4.db` keyed by `(library_id, path, mtime, file_size)` so
    subsequent requests stay fast even on large libraries.
    """
    if not music_dir.exists() or not music_dir.is_dir():
        return []

    root = music_dir.resolve()
    cached = {} if force_rescan else db.get_cached_tracks(library_id=library_id)

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
        db.upsert_tracks(to_upsert, library_id=library_id)
    if stale_paths:
        db.remove_paths(stale_paths, library_id=library_id)

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
    organize_settings: OrganizeSettings | None = None,
    mb_release_cache: dict[str, MusicBrainzReleaseDetail] | None = None,
    album_mb_links: dict[str, str] | None = None,
    missing_ignores: dict[str, set[tuple[int, int]]] | None = None,
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

            needs_reorganize = False
            if organize_settings and organize_settings.enabled:
                out_of_place = sum(
                    1
                    for t in sorted_tracks
                    if track_needs_reorganize(t, organize_settings)
                )
                if out_of_place > 0:
                    needs_reorganize = True
                    navidrome_warnings.append(
                        NavidromeSplitWarning(
                            field="folder_structure",
                            label="Folder Structure",
                            severity="structure",
                            message=f"{out_of_place} of {len(sorted_tracks)} track{'s' if len(sorted_tracks) != 1 else ''} don't match your configured folder layout.",
                            values=[],
                        )
                    )

            album_duration = round(sum(t.duration for t in sorted_tracks), 2)

            album_groups.append(
                AlbumGroup(
                    id=_stable_id(artist_name, album_name),
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
                    needs_reorganize=needs_reorganize,
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
                id=_stable_id(artist_name),
                name=artist_name,
                album_count=len(album_groups),
                track_count=sum(a.track_count for a in album_groups),
                albums=album_groups,
            )
        )

    _detect_cross_album_conflicts(artists)
    populate_library_completeness(
        artists,
        mb_release_cache=mb_release_cache,
        album_mb_links=album_mb_links,
        missing_ignores=missing_ignores,
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


from app.services.musicbrainz import _strip_latin_accents_preserve_unicode

_SERIES_TOKEN_RE = re.compile(
    r"\b(?:\d+|ii|iii|iv|v|vi|vii|viii|ix|x)\b",
    re.IGNORECASE,
)
_GENERIC_DUMP_DIRS: frozenset[str] = frozenset(
    {"", ".", "downloads", "download", "music", "misc", "singles", "unsorted", "inbox", "incoming"}
)


def _normalize_album_key(value: str) -> str:
    folded = _strip_latin_accents_preserve_unicode(value).replace("&", " and ")
    tokens: list[str] = []
    current: list[str] = []
    for ch in folded:
        if ch.isalnum():
            current.append(ch)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return " ".join(tokens).strip()


def _extract_series_tokens(norm_title: str) -> tuple[str, ...]:
    """Return numeric / Roman-numeral tokens so Vol. 1 vs Vol. 2 are never flagged as typos."""
    return tuple(_SERIES_TOKEN_RE.findall(norm_title))


def _detect_cross_album_conflicts(artists: list[ArtistGroup]) -> None:
    """Detect probable split/near-duplicate albums across AlbumGroup entries (Issue #2).

    Signals checked:
      1. Normalized album title match (same normalized artist; ignores punctuation/casing).
      2. High-threshold fuzzy title similarity (>= 0.88, same artist, guarded against Vol. 1/2 etc.).
      3. Shared non-root, non-generic parent folder on disk.
      4. Shared MusicBrainz Album ID across separate AlbumGroup entries.
    """
    all_albums: list[AlbumGroup] = [
        album for artist in artists for album in artist.albums
    ]
    if len(all_albums) < 2:
        return

    albums_by_id: dict[str, AlbumGroup] = {a.id: a for a in all_albums}
    # Map album.id -> {sibling_album_id: set[reason_str]}
    conflicts: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))

    def record_pair(a: AlbumGroup, b: AlbumGroup, reason: str) -> None:
        if a.id == b.id:
            return
        conflicts[a.id][b.id].add(reason)
        conflicts[b.id][a.id].add(reason)

    # Pre-compute normalized keys
    norm_artist: dict[str, str] = {}
    norm_title: dict[str, str] = {}
    for album in all_albums:
        norm_artist[album.id] = _normalize_album_key(album.artist)
        norm_title[album.id] = _normalize_album_key(album.title)

    # Signal 1 & 2: Normalized title match & high-threshold fuzzy similarity (same normalized artist)
    by_artist_norm: dict[str, list[AlbumGroup]] = defaultdict(list)
    for album in all_albums:
        if album.title == "Unknown Album":
            continue
        by_artist_norm[norm_artist[album.id]].append(album)

    for artist_albums in by_artist_norm.values():
        if len(artist_albums) < 2:
            continue
        for i in range(len(artist_albums)):
            a = artist_albums[i]
            na = norm_title[a.id]
            if not na:
                continue
            tokens_a = _extract_series_tokens(na)
            for j in range(i + 1, len(artist_albums)):
                b = artist_albums[j]
                nb = norm_title[b.id]
                if not nb:
                    continue
                if na == nb:
                    record_pair(a, b, "same title ignoring punctuation/casing")
                    continue

                if len(na) >= 6 and len(nb) >= 6:
                    # Guard against Vol. 1 vs Vol. 2, Disc 1 vs Disc 2, Part II vs Part III, 2021 vs 2022
                    if tokens_a != _extract_series_tokens(nb):
                        continue
                    ratio = difflib.SequenceMatcher(None, na, nb).ratio()
                    if ratio >= 0.88:
                        record_pair(a, b, "near-duplicate album title")

    # Signal 3: Shared non-root, non-generic parent folder on disk
    by_dir: dict[str, list[AlbumGroup]] = defaultdict(list)
    for album in all_albums:
        album_dirs = {
            Path(t.path).parent.as_posix()
            for t in album.tracks
        }
        for rel_dir in album_dirs:
            leaf = Path(rel_dir).name.lower() if rel_dir not in {"", "."} else ""
            if rel_dir in {"", "."} or leaf in _GENERIC_DUMP_DIRS:
                continue
            by_dir[rel_dir].append(album)

    for dir_albums in by_dir.values():
        # Guard against large flat folders holding unrelated albums (e.g. >4 distinct albums in one folder)
        if 2 <= len(dir_albums) <= 4:
            for i in range(len(dir_albums)):
                for j in range(i + 1, len(dir_albums)):
                    if (
                        dir_albums[i].title == "Unknown Album"
                        and dir_albums[j].title == "Unknown Album"
                    ):
                        continue
                    record_pair(dir_albums[i], dir_albums[j], "files share the same folder")

    # Signal 4: Shared MusicBrainz Album ID across separate AlbumGroup entries
    by_mbid: dict[str, list[AlbumGroup]] = defaultdict(list)
    for album in all_albums:
        mbids = {
            (t.musicbrainz_album_id or "").strip().lower()
            for t in album.tracks
            if (t.musicbrainz_album_id or "").strip()
        }
        for mbid in mbids:
            by_mbid[mbid].append(album)

    for mbid_albums in by_mbid.values():
        if len(mbid_albums) >= 2:
            for i in range(len(mbid_albums)):
                for j in range(i + 1, len(mbid_albums)):
                    record_pair(mbid_albums[i], mbid_albums[j], "same MusicBrainz Album ID")

    # Attach consolidated NavidromeSplitWarning to each affected album
    for album_id, sibling_map in conflicts.items():
        album = albums_by_id[album_id]
        related_ids = sorted(
            sibling_map.keys(),
            key=lambda sid: albums_by_id[sid].title.casefold(),
        )
        sibling_labels: list[str] = []
        all_reasons: list[str] = []
        for sid in related_ids:
            sib = albums_by_id[sid]
            label = (
                sib.title
                if sib.artist.casefold() == album.artist.casefold()
                else f"{sib.artist} — {sib.title}"
            )
            sibling_labels.append(label)
            for reason in sorted(sibling_map[sid]):
                if reason not in all_reasons:
                    all_reasons.append(reason)

        quoted = ", ".join(f'"{lbl}"' for lbl in sibling_labels[:3])
        if len(sibling_labels) > 3:
            quoted += f" (+{len(sibling_labels) - 3} more)"
        reason_str = "; ".join(all_reasons)

        album.navidrome_warnings.append(
            NavidromeSplitWarning(
                field="duplicate_album",
                label="Possible Split Album",
                severity="split",
                message=f"Probable split with {quoted} ({reason_str}). Merge them to unify tags in Navidrome.",
                values=sibling_labels[:6],
                related_album_ids=related_ids,
            )
        )

