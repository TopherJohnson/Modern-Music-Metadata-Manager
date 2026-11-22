"""Missing-track detection (Tier 1 offline + Tier 2 MusicBrainz) and local library stray-track matching (Issue #5)."""

from __future__ import annotations

import re
from collections import Counter, defaultdict

from app.models import (
    AlbumGroup,
    ArtistGroup,
    MissingTrackCandidate,
    MissingTrackItem,
    MusicBrainzReleaseDetail,
    TrackMetadata,
)
from app.services.musicbrainz import (
    _duration_diff_sec,
    _normalize_title,
    _title_similarity,
    match_tracks_to_release,
)

_TRACK_PAIR_RE = re.compile(r"^\s*(\d+)(?:\s*(?:/|of)\s*(\d+))?", re.IGNORECASE)
_MAX_REASONABLE_TRACK = 200
_MAX_REASONABLE_DISC = 20
_MAX_GAPS_PER_DISC = 60
_OUTLIER_JUMP_THRESHOLD = 25


def _parse_num_and_total(
    value: str | None,
    *,
    max_val: int,
) -> tuple[int | None, int | None]:
    if not value:
        return None, None
    match = _TRACK_PAIR_RE.match(value)
    if not match:
        return None, None
    num = int(match.group(1))
    total = int(match.group(2)) if match.group(2) else None
    if num <= 0 or num > max_val:
        num = None
    if total is not None and (total <= 0 or total > max_val):
        total = None
    return num, total


def _most_common_int(values: list[int]) -> int | None:
    if not values:
        return None
    counts = Counter(values)
    # Break ties in favor of the largest declared total
    return max(counts.items(), key=lambda item: (item[1], item[0]))[0]


def get_primary_album_mbid(album: AlbumGroup) -> str | None:
    """Return the most common non-empty MusicBrainz Album ID tagged on an album's tracks."""
    mbids = [
        (t.musicbrainz_album_id or "").strip().lower()
        for t in album.tracks
        if (t.musicbrainz_album_id or "").strip()
    ]
    if not mbids:
        return None
    return Counter(mbids).most_common(1)[0][0]


def detect_local_missing_tracks(album: AlbumGroup) -> list[MissingTrackItem]:
    """Tier 1 offline detection of missing tracks & discs from track/disc number tags.

    Guardrails:
      - Skips "Unknown Album" and unnumbered albums (<50% tracks numbered when >=3 tracks).
      - Skips standalone 1-track singles unless explicitly tagged with N/Total (Total > 1) or Disc N/Total (Total > 1).
      - Handles continuous multi-disc numbering (e.g. Disc 1: 1..10, Disc 2: 11..20).
      - Ignores extreme high bonus-track outliers (e.g. hidden track #99 after #1..#10).
    """
    if not album.tracks or album.title == "Unknown Album":
        return []

    parsed: list[tuple[int | None, int | None, int | None, int | None]] = []
    for t in album.tracks:
        d_num, d_tot = _parse_num_and_total(t.disc_number, max_val=_MAX_REASONABLE_DISC)
        t_num, t_tot = _parse_num_and_total(t.track_number, max_val=_MAX_REASONABLE_TRACK)
        parsed.append((d_num, d_tot, t_num, t_tot))

    numbered = [p for p in parsed if p[2] is not None]
    if not numbered:
        return []
    if len(album.tracks) >= 3 and (len(numbered) / len(album.tracks)) < 0.5:
        return []

    # Guardrail: standalone 1-track singles require an explicit total > 1
    if len(album.tracks) == 1:
        d_num, d_tot, t_num, t_tot = parsed[0]
        has_explicit_track_total = t_tot is not None and t_tot > 1
        has_explicit_disc_total = d_tot is not None and d_tot > 1
        if not has_explicit_track_total and not has_explicit_disc_total:
            return []

    by_disc_nums: dict[int, set[int]] = defaultdict(set)
    by_disc_totals: dict[int, list[int]] = defaultdict(list)
    disc_totals_declared: list[int] = []
    present_discs: set[int] = set()

    for d_num, d_tot, t_num, t_tot in parsed:
        disc = d_num or 1
        present_discs.add(disc)
        if d_tot is not None and d_tot >= 2:
            disc_totals_declared.append(d_tot)
        if t_num is not None:
            by_disc_nums[disc].add(t_num)
        if t_tot is not None and t_tot >= 2:
            by_disc_totals[disc].append(t_tot)

    sorted_discs = sorted(present_discs)
    missing: list[MissingTrackItem] = []

    prev_disc_max: int | None = None
    for idx, disc in enumerate(sorted_discs):
        nums = sorted(by_disc_nums.get(disc, set()))
        if not nums:
            continue

        declared_total = _most_common_int(by_disc_totals.get(disc, []))

        # Detect continuous multi-disc numbering (e.g., Disc 1 ends at 10, Disc 2 starts at 11..13)
        expected_start = 1
        if (
            idx > 0
            and prev_disc_max is not None
            and nums[0] > prev_disc_max
            and (nums[0] - prev_disc_max) <= 3
        ):
            expected_start = prev_disc_max + 1

        # Trim extreme hidden-track outliers (e.g. track 99 after tracks 1..12)
        trimmed = list(nums)
        while (
            len(trimmed) >= 2
            and (trimmed[-1] - trimmed[-2]) > _OUTLIER_JUMP_THRESHOLD
            and (declared_total is None or trimmed[-1] > declared_total)
        ):
            trimmed.pop()

        effective_max = trimmed[-1]
        present_set = set(nums)
        disc_missing: list[MissingTrackItem] = []

        # 1. Sequence gaps within [expected_start .. effective_max]
        for n in range(expected_start, effective_max + 1):
            if n not in present_set:
                disc_missing.append(
                    MissingTrackItem(
                        disc_number=disc,
                        track_number=n,
                        source="local_gap",
                    )
                )

        # 2. Short of declared N/Total (e.g., 1/12..10/12 -> missing 11, 12)
        if (
            declared_total is not None
            and declared_total > effective_max
            and (declared_total - effective_max) <= _MAX_GAPS_PER_DISC
        ):
            for n in range(effective_max + 1, declared_total + 1):
                if n not in present_set:
                    disc_missing.append(
                        MissingTrackItem(
                            disc_number=disc,
                            track_number=n,
                            source="local_total",
                        )
                    )

        if len(disc_missing) <= _MAX_GAPS_PER_DISC:
            missing.extend(disc_missing)

        prev_disc_max = max(effective_max, declared_total or effective_max)

    # 3. Missing discs (e.g., Disc 1/2 present without Disc 2, or Disc 1 & 3 without Disc 2)
    declared_disc_total = _most_common_int(disc_totals_declared)
    expected_disc_max = max(
        declared_disc_total or 0,
        max(present_discs) if len(present_discs) >= 2 else 0,
    )
    if 2 <= expected_disc_max <= _MAX_REASONABLE_DISC:
        for d in range(1, expected_disc_max + 1):
            if d not in present_discs:
                missing.append(
                    MissingTrackItem(
                        disc_number=d,
                        track_number=0,
                        source="local_disc",
                    )
                )

    missing.sort(key=lambda item: (item.disc_number, item.track_number))
    return missing


def detect_musicbrainz_missing_tracks(
    album: AlbumGroup,
    release: MusicBrainzReleaseDetail,
) -> list[MissingTrackItem]:
    """Tier 2 detection: diff local album tracks against an official MusicBrainz release tracklist."""
    if not release.tracks:
        return []

    matches = match_tracks_to_release(album.tracks, release.tracks)
    matched_slots: set[tuple[int, int]] = {
        (m.mb_disc_number, m.mb_track_number)
        for m in matches
        if m.matched and m.mb_disc_number is not None and m.mb_track_number is not None
    }

    missing: list[MissingTrackItem] = []
    for mb_track in sorted(
        release.tracks,
        key=lambda t: (t.disc_number, t.track_number),
    ):
        if (mb_track.disc_number, mb_track.track_number) not in matched_slots:
            missing.append(
                MissingTrackItem(
                    disc_number=mb_track.disc_number,
                    track_number=mb_track.track_number,
                    title=mb_track.title,
                    artist=mb_track.artist,
                    length_ms=mb_track.length_ms,
                    source="musicbrainz",
                )
            )
    return missing


def _norm_artist(value: str | None) -> str:
    return _normalize_title(value)


def _score_candidate(
    track: TrackMetadata,
    source_album: AlbumGroup,
    *,
    query_title: str | None,
    target_artist: str | None,
    length_ms: int | None,
) -> tuple[int, str] | None:
    """Compute a 0..100 relevance score and human-readable match reason for a local candidate track."""
    local_title = (track.title or "").strip() or track.filename
    norm_q = _normalize_title(query_title)
    norm_local_title = _normalize_title(local_title)
    norm_target_artist = _norm_artist(target_artist)
    norm_track_artist = _norm_artist(track.artist or track.album_artist or source_album.artist)

    artist_match = False
    if norm_target_artist and norm_track_artist:
        if (
            norm_target_artist == norm_track_artist
            or norm_target_artist in norm_track_artist
            or norm_track_artist in norm_target_artist
        ):
            artist_match = True

    dur_diff = _duration_diff_sec(track.duration, length_ms)

    if norm_q:
        sim = _title_similarity(query_title, local_title)
        substring_hit = norm_q in norm_local_title or (
            norm_q in _normalize_title(track.filename)
        )
        if sim < 0.58 and not substring_hit:
            return None

        score = int(round(max(sim, 0.72 if substring_hit else 0.0) * 65))
        reasons: list[str] = []
        if sim >= 0.95:
            reasons.append("Exact title match")
        elif sim >= 0.78:
            reasons.append(f"Title {int(round(sim * 100))}% match")
        else:
            reasons.append("Partial title match")

        if artist_match:
            score += 20
            reasons.append("same artist")

        if dur_diff is not None:
            if dur_diff <= 5.0:
                score += 15
                reasons.append(f"duration within {round(dur_diff)}s")
            elif dur_diff <= 15.0:
                score += 8
                reasons.append(f"duration within {round(dur_diff)}s")
            elif dur_diff > 60.0:
                score -= 12

        if source_album.track_count <= 2 or source_album.title == "Unknown Album":
            score += 4

        clamped = max(1, min(100, score))
        return clamped, " · ".join(reasons)

    # No query title (e.g., manual search opened from an offline ghost row) -> filter by artist
    if norm_target_artist:
        if not artist_match:
            return None
        score = 65 if source_album.track_count <= 2 else 48
        if dur_diff is not None and dur_diff <= 5.0:
            score += 20
            return min(100, score), f"Same artist · duration within {round(dur_diff)}s"
        reason = (
            "Same artist · likely stray track"
            if source_album.track_count <= 2 or source_album.title == "Unknown Album"
            else "Same artist"
        )
        return score, reason

    return None


def search_library_for_missing_track(
    all_albums: list[AlbumGroup],
    *,
    target_album_id: str,
    query: str | None = None,
    artist: str | None = None,
    length_ms: int | None = None,
    min_score: int = 40,
    limit: int = 25,
) -> list[MissingTrackCandidate]:
    """Search the entire active library outside `target_album_id` for stray tracks matching a missing slot."""
    results: list[MissingTrackCandidate] = []
    for album in all_albums:
        if album.id == target_album_id:
            continue
        for track in album.tracks:
            scored = _score_candidate(
                track,
                album,
                query_title=query,
                target_artist=artist,
                length_ms=length_ms,
            )
            if scored is None:
                continue
            score, reason = scored
            if score < min_score:
                continue
            results.append(
                MissingTrackCandidate(
                    path=track.path,
                    filename=track.filename,
                    title=track.title,
                    artist=track.artist or track.album_artist,
                    album=album.title,
                    album_id=album.id,
                    album_track_count=album.track_count,
                    duration=track.duration,
                    score=score,
                    reason=reason,
                )
            )

    results.sort(
        key=lambda c: (
            -c.score,
            c.album_track_count,
            (c.title or c.filename).casefold(),
        )
    )
    return results[:limit]


def _build_title_index(
    all_albums: list[AlbumGroup],
) -> dict[str, list[tuple[TrackMetadata, AlbumGroup]]]:
    """Index all library tracks by normalized title words for fast O(1)-ish auto-hinting."""
    index: dict[str, list[tuple[TrackMetadata, AlbumGroup]]] = defaultdict(list)
    for album in all_albums:
        for track in album.tracks:
            norm = _normalize_title(track.title or track.filename)
            if not norm:
                continue
            index[norm].append((track, album))
            for tok in set(norm.split()):
                if len(tok) >= 4:
                    index[f"tok:{tok}"].append((track, album))
    return index


def attach_auto_candidates(
    album: AlbumGroup,
    missing_items: list[MissingTrackItem],
    all_albums: list[AlbumGroup],
    title_index: dict[str, list[tuple[TrackMetadata, AlbumGroup]]] | None = None,
) -> None:
    """Auto-populate strong local library candidate matches on missing items that have a known title."""
    titled_items = [m for m in missing_items if m.title and m.title.strip()]
    if not titled_items:
        return

    idx = title_index if title_index is not None else _build_title_index(all_albums)

    for item in titled_items:
        norm_title = _normalize_title(item.title)
        if not norm_title:
            continue
        # Gather candidate pool via exact normalized title + significant words
        pool_by_path: dict[str, tuple[TrackMetadata, AlbumGroup]] = {}
        for pair in idx.get(norm_title, ()):
            if pair[1].id != album.id:
                pool_by_path[pair[0].path] = pair
        for tok in set(norm_title.split()):
            if len(tok) >= 4:
                for pair in idx.get(f"tok:{tok}", ()):
                    if pair[1].id != album.id:
                        pool_by_path[pair[0].path] = pair

        found: list[MissingTrackCandidate] = []
        for track, src_album in pool_by_path.values():
            scored = _score_candidate(
                track,
                src_album,
                query_title=item.title,
                target_artist=item.artist or album.artist,
                length_ms=item.length_ms,
            )
            if scored is None:
                continue
            score, reason = scored
            if score < 72:
                continue
            found.append(
                MissingTrackCandidate(
                    path=track.path,
                    filename=track.filename,
                    title=track.title,
                    artist=track.artist or track.album_artist,
                    album=src_album.title,
                    album_id=src_album.id,
                    album_track_count=src_album.track_count,
                    duration=track.duration,
                    score=score,
                    reason=reason,
                )
            )
        found.sort(key=lambda c: (-c.score, c.album_track_count))
        item.candidates = found[:3]


def apply_ignore_rules(
    album: AlbumGroup,
    missing_items: list[MissingTrackItem],
    ignored_slots: set[tuple[int, int]],
) -> tuple[list[MissingTrackItem], int, bool]:
    """Mark ignored missing items and compute active missing_track_count and whole-album ignore flag."""
    whole_album_ignored = (0, 0) in ignored_slots
    active_count = 0
    for item in missing_items:
        is_ignored = whole_album_ignored or (
            (item.disc_number, item.track_number) in ignored_slots
        )
        item.ignored = is_ignored
        if not is_ignored:
            active_count += 1
    return missing_items, active_count, whole_album_ignored


def populate_library_completeness(
    artists: list[ArtistGroup],
    *,
    mb_release_cache: dict[str, MusicBrainzReleaseDetail] | None = None,
    album_mb_links: dict[str, str] | None = None,
    missing_ignores: dict[str, set[tuple[int, int]]] | None = None,
) -> None:
    """Populate `missing_tracks`, `missing_track_count`, and completeness metadata across all albums."""
    all_albums: list[AlbumGroup] = [
        album for artist in artists for album in artist.albums
    ]
    if not all_albums:
        return

    cache = mb_release_cache or {}
    links = album_mb_links or {}
    ignores = missing_ignores or {}
    title_index: dict[str, list[tuple[TrackMetadata, AlbumGroup]]] | None = None

    for album in all_albums:
        album_ignores = ignores.get(album.id, set())

        # Resolve cached MusicBrainz release (explicit link first, then album's musicbrainz_album_id tag)
        resolved_mbid = links.get(album.id) or get_primary_album_mbid(album)
        cached_release = cache.get(resolved_mbid) if resolved_mbid else None

        if cached_release is not None and cached_release.tracks:
            missing_items = detect_musicbrainz_missing_tracks(album, cached_release)
            album.completeness_source = "musicbrainz"
            album.completeness_mbid = cached_release.mbid
            album.completeness_mb_title = cached_release.title
            if missing_items:
                if title_index is None:
                    title_index = _build_title_index(all_albums)
                attach_auto_candidates(album, missing_items, all_albums, title_index)
        else:
            missing_items = detect_local_missing_tracks(album)
            album.completeness_source = "local" if missing_items else None
            album.completeness_mbid = resolved_mbid
            album.completeness_mb_title = None

        items, active_count, whole_ignored = apply_ignore_rules(
            album, missing_items, album_ignores
        )
        album.missing_tracks = items
        album.missing_track_count = active_count
        album.missing_tracks_ignored = whole_ignored
