"""MusicBrainz API v2 and Cover Art Archive client for album identification and artwork lookup."""

from __future__ import annotations

import asyncio
import difflib
import logging
import random
import re
import time
import unicodedata
from pathlib import Path
from typing import Any

import httpx

from app import __version__
from app.models import (
    MusicBrainzReleaseCandidate,
    MusicBrainzReleaseDetail,
    MusicBrainzTrackCandidate,
    MusicBrainzTrackInfo,
    MusicBrainzTrackMatch,
    TrackMetadata,
)

logger = logging.getLogger(__name__)

MUSICBRAINZ_BASE = "https://musicbrainz.org/ws/2"
COVERART_BASE = "https://coverartarchive.org"
USER_AGENT = (
    f"ModernMusicMetadataManager/{__version__} "
    "( https://github.com/TopherJohnson/Modern-Music-Metadata-Manager )"
)

_MBID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Polite 1 request/second serializer + short TTL response cache
_mb_lock = asyncio.Lock()
_mb_last_call: float = 0.0
_CACHE_TTL_SECONDS = 900.0  # 15 minutes
_mb_cache: dict[str, tuple[float, dict[str, Any]]] = {}

_RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 4


class MusicBrainzError(Exception):
    """Raised when MusicBrainz or Cover Art Archive requests fail."""


def validate_mbid(mbid: str) -> str:
    cleaned = mbid.strip()
    if not _MBID_RE.match(cleaned):
        raise MusicBrainzError("Invalid MusicBrainz Release ID (expected UUID).")
    return cleaned


def _escape_lucene(term: str) -> str:
    special = r'+-&|!(){}[]^"~*?:\/'
    return "".join(f"\\{ch}" if ch in special else ch for ch in term.strip())


def _format_artist_credit(credits: list[dict[str, Any]] | None) -> tuple[str, str | None]:
    if not credits:
        return "Unknown Artist", None
    parts: list[str] = []
    first_mbid: str | None = None
    for entry in credits:
        artist_obj = entry.get("artist") or {}
        if first_mbid is None and artist_obj.get("id"):
            first_mbid = str(artist_obj["id"])
        name = entry.get("name") or artist_obj.get("name") or ""
        joinphrase = entry.get("joinphrase") or ""
        parts.append(f"{name}{joinphrase}")
    joined = "".join(parts).strip()
    return joined or "Unknown Artist", first_mbid


def _extract_year(date_str: str | None) -> str | None:
    if not date_str:
        return None
    match = re.match(r"^(\d{4})", date_str.strip())
    return match.group(1) if match else None


def _parse_release_summary(item: dict[str, Any]) -> MusicBrainzReleaseCandidate:
    mbid = str(item["id"])
    artist_name, artist_mbid = _format_artist_credit(item.get("artist-credit"))
    date_str = (item.get("date") or "").strip() or None

    media = item.get("media") or []
    disc_count = len(media) if media else 1
    track_count = sum(int(m.get("track-count") or 0) for m in media)
    if track_count == 0 and item.get("track-count"):
        track_count = int(item["track-count"])

    formats = []
    for m in media:
        fmt = (m.get("format") or "").strip()
        if fmt and fmt not in formats:
            formats.append(fmt)

    label: str | None = None
    label_info = item.get("label-info") or []
    for li in label_info:
        lbl = (li.get("label") or {}).get("name")
        if lbl:
            label = str(lbl)
            break

    return MusicBrainzReleaseCandidate(
        mbid=mbid,
        title=str(item.get("title") or "Untitled Release"),
        artist=artist_name,
        artist_mbid=artist_mbid,
        date=date_str,
        year=_extract_year(date_str),
        country=(item.get("country") or "").strip() or None,
        status=(item.get("status") or "").strip() or None,
        disambiguation=(item.get("disambiguation") or "").strip() or None,
        track_count=track_count,
        disc_count=disc_count,
        format=" / ".join(formats) if formats else None,
        label=label,
        score=int(item.get("score") or 0),
        cover_art_url=f"/api/musicbrainz/cover/{mbid}?size=500",
    )


def _extract_mb_error_detail(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        if isinstance(body, dict) and isinstance(body.get("error"), str):
            return body["error"].strip()
    except Exception:
        pass
    if resp.status_code == 503:
        return "MusicBrainz is temporarily busy or rate-limiting requests (HTTP 503). Please retry in a few seconds."
    return f"MusicBrainz returned HTTP {resp.status_code}."


async def _mb_get_json(path: str, params: dict[str, Any]) -> dict[str, Any]:
    global _mb_last_call

    cache_key = f"{path}?{'&'.join(f'{k}={v}' for k, v in sorted(params.items()))}"
    cached = _mb_cache.get(cache_key)
    if cached and (time.monotonic() - cached[0]) < _CACHE_TTL_SECONDS:
        return cached[1]

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }

    last_error: str = "MusicBrainz request failed."

    async with _mb_lock:
        # Re-check cache after acquiring lock in case an identical request just finished
        cached = _mb_cache.get(cache_key)
        if cached and (time.monotonic() - cached[0]) < _CACHE_TTL_SECONDS:
            return cached[1]

        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            for attempt in range(1, _MAX_ATTEMPTS + 1):
                elapsed = time.monotonic() - _mb_last_call
                if elapsed < 1.15:
                    await asyncio.sleep(1.15 - elapsed)

                try:
                    resp = await client.get(
                        f"{MUSICBRAINZ_BASE}{path}",
                        params={**params, "fmt": "json"},
                        headers=headers,
                    )
                except httpx.HTTPError as exc:
                    _mb_last_call = time.monotonic()
                    last_error = f"MusicBrainz network error: {exc}"
                    if attempt < _MAX_ATTEMPTS:
                        backoff = (1.5 * attempt) + random.uniform(0.1, 0.5)
                        logger.warning(
                            "MusicBrainz request error on attempt %d/%d (%s); retrying in %.1fs",
                            attempt,
                            _MAX_ATTEMPTS,
                            exc,
                            backoff,
                        )
                        await asyncio.sleep(backoff)
                        continue
                    raise MusicBrainzError(last_error) from exc

                _mb_last_call = time.monotonic()

                if resp.status_code == 200:
                    payload = resp.json()
                    _mb_cache[cache_key] = (time.monotonic(), payload)
                    return payload

                last_error = _extract_mb_error_detail(resp)
                if resp.status_code in _RETRYABLE_STATUSES and attempt < _MAX_ATTEMPTS:
                    retry_after_raw = resp.headers.get("Retry-After")
                    try:
                        retry_after = float(retry_after_raw) if retry_after_raw else 0.0
                    except ValueError:
                        retry_after = 0.0
                    backoff = max(retry_after, (1.4 * attempt) + random.uniform(0.2, 0.6))
                    logger.warning(
                        "MusicBrainz HTTP %d on attempt %d/%d (%s); retrying in %.1fs",
                        resp.status_code,
                        attempt,
                        _MAX_ATTEMPTS,
                        last_error,
                        backoff,
                    )
                    await asyncio.sleep(backoff)
                    continue

                raise MusicBrainzError(last_error)

    raise MusicBrainzError(last_error)


async def search_releases(
    album: str,
    artist: str | None = None,
    *,
    limit: int = 10,
) -> list[MusicBrainzReleaseCandidate]:
    """Search MusicBrainz releases matching an album title and optional artist name."""
    clauses: list[str] = []
    if album and album.strip():
        clauses.append(f'release:"{_escape_lucene(album)}"')
    if artist and artist.strip():
        clauses.append(f'artist:"{_escape_lucene(artist)}"')

    if not clauses:
        return []

    query = " AND ".join(clauses)
    data = await _mb_get_json("/release", {"query": query, "limit": limit})
    releases = data.get("releases") or []

    # If strict quoted AND query returned nothing, retry with relaxed unquoted terms
    if not releases and album.strip():
        relaxed_parts = [p for p in (album.strip(), (artist or "").strip()) if p]
        data = await _mb_get_json(
            "/release", {"query": " ".join(relaxed_parts), "limit": limit}
        )
        releases = data.get("releases") or []

    return [_parse_release_summary(item) for item in releases if item.get("id")]


def _release_rank_key(release: dict[str, Any]) -> tuple[int, int, str]:
    status = (release.get("status") or "").lower()
    rg = release.get("release-group") or {}
    primary = (rg.get("primary-type") or "").lower()
    secondary = {s.lower() for s in (rg.get("secondary-types") or [])}

    status_rank = 0 if status == "official" else 1
    if primary == "album" and "compilation" not in secondary and "live" not in secondary:
        type_rank = 0
    elif primary in {"ep", "single"} and "compilation" not in secondary:
        type_rank = 1
    elif primary == "album":
        type_rank = 2
    else:
        type_rank = 3
    date_str = (release.get("date") or "9999").strip() or "9999"
    return (status_rank, type_rank, date_str)


async def search_recordings(
    title: str,
    artist: str | None = None,
    album: str | None = None,
    *,
    duration_sec: float | None = None,
    limit: int = 12,
) -> list[MusicBrainzTrackCandidate]:
    """Search MusicBrainz recordings to identify a single track (including untagged files)."""
    clauses: list[str] = []
    if title and title.strip():
        clauses.append(f'recording:"{_escape_lucene(title)}"')
    if artist and artist.strip():
        clauses.append(f'artist:"{_escape_lucene(artist)}"')
    if album and album.strip():
        clauses.append(f'release:"{_escape_lucene(album)}"')

    if not clauses:
        return []

    query = " AND ".join(clauses)
    data = await _mb_get_json("/recording", {"query": query, "limit": 12})
    recordings = data.get("recordings") or []

    # Fallback to relaxed unquoted query if strict quoted search found nothing
    if not recordings:
        relaxed_parts = [
            p
            for p in ((title or "").strip(), (artist or "").strip(), (album or "").strip())
            if p
        ]
        if relaxed_parts:
            data = await _mb_get_json(
                "/recording", {"query": " ".join(relaxed_parts), "limit": 12}
            )
            recordings = data.get("recordings") or []

    candidates: list[MusicBrainzTrackCandidate] = []
    seen_pairs: set[tuple[str, str, str]] = set()

    for rec in recordings:
        rec_id = str(rec.get("id") or "")
        if not rec_id:
            continue
        rec_title = str(rec.get("title") or "Untitled")
        rec_artist, rec_artist_mbid = _format_artist_credit(rec.get("artist-credit"))
        length_raw = rec.get("length")
        length_ms = int(length_raw) if length_raw else None
        score = int(rec.get("score") or 0)

        releases = list(rec.get("releases") or [])
        if not releases:
            candidates.append(
                MusicBrainzTrackCandidate(
                    recording_mbid=rec_id,
                    title=rec_title,
                    artist=rec_artist,
                    artist_mbid=rec_artist_mbid,
                    album_artist=rec_artist,
                    length_ms=length_ms,
                    score=score,
                )
            )
            continue

        releases.sort(key=_release_rank_key)
        emitted_for_rec = 0
        for rel in releases:
            if emitted_for_rec >= 2:
                break
            rel_id = str(rel.get("id") or "")
            album_title = (rel.get("title") or "").strip() or None
            rel_date = (rel.get("date") or "").strip() or None
            rel_year = _extract_year(rel_date)

            dedup_key = (
                rec_title.casefold(),
                rec_artist.casefold(),
                (album_title or "").casefold(),
            )
            if dedup_key in seen_pairs:
                continue
            seen_pairs.add(dedup_key)

            rel_artist, rel_artist_mbid = _format_artist_credit(rel.get("artist-credit"))
            album_artist = rel_artist if rel_artist != "Unknown Artist" else rec_artist
            artist_mbid = rel_artist_mbid or rec_artist_mbid

            rg = rel.get("release-group") or {}
            primary_type = (rg.get("primary-type") or "").strip() or None
            secondary_types = rg.get("secondary-types") or []
            release_type = (
                f"{primary_type} ({secondary_types[0]})"
                if primary_type and secondary_types
                else primary_type
            )

            track_num_str: str | None = None
            disc_num_str: str | None = None
            media = rel.get("media") or []
            disc_total = len(media) if media else 1
            if media:
                med = media[0]
                disc_pos = int(med.get("position") or 1)
                disc_num_str = f"{disc_pos}/{disc_total}" if disc_total > 1 else str(disc_pos)
                track_total = int(med.get("track-count") or 0)
                tracks_in_med = med.get("track") or []
                if tracks_in_med:
                    t_num = str(
                        tracks_in_med[0].get("number")
                        or tracks_in_med[0].get("position")
                        or ""
                    ).strip()
                    if t_num:
                        track_num_str = (
                            f"{t_num}/{track_total}"
                            if track_total > 0 and "/" not in t_num
                            else t_num
                        )

            candidates.append(
                MusicBrainzTrackCandidate(
                    recording_mbid=rec_id,
                    release_mbid=rel_id or None,
                    title=rec_title,
                    artist=rec_artist,
                    artist_mbid=artist_mbid,
                    album=album_title,
                    album_artist=album_artist,
                    date=rel_date,
                    year=rel_year,
                    country=(rel.get("country") or "").strip() or None,
                    release_type=release_type,
                    track_number=track_num_str,
                    disc_number=disc_num_str,
                    length_ms=length_ms,
                    score=score,
                    cover_art_url=(
                        f"/api/musicbrainz/cover/{rel_id}?size=500" if rel_id else None
                    ),
                )
            )
            emitted_for_rec += 1

    # Boost matches whose duration closely matches the local audio file
    def sort_key(c: MusicBrainzTrackCandidate) -> tuple[int, int, int]:
        duration_close = 1
        if duration_sec and duration_sec > 0 and c.length_ms:
            diff = abs((c.length_ms / 1000.0) - duration_sec)
            duration_close = 0 if diff <= 5.0 else 1
        is_studio_album = (
            0
            if (c.release_type or "").lower() == "album"
            else 1
        )
        return (duration_close, -c.score, is_studio_album)

    candidates.sort(key=sort_key)
    return candidates[:limit]


async def get_release_detail(mbid: str) -> MusicBrainzReleaseDetail:
    """Fetch complete release metadata, genre tags, and tracklist from MusicBrainz."""
    valid_id = validate_mbid(mbid)
    data = await _mb_get_json(
        f"/release/{valid_id}",
        {"inc": "artists+recordings+release-groups+labels+genres+tags"},
    )

    summary = _parse_release_summary(data)

    # Extract top genre from release or release-group genres/tags
    genre: str | None = None
    rg = data.get("release-group") or {}
    genre_candidates = (
        (data.get("genres") or [])
        + (rg.get("genres") or [])
        + (data.get("tags") or [])
        + (rg.get("tags") or [])
    )
    if genre_candidates:
        genre_candidates.sort(key=lambda g: int(g.get("count") or 0), reverse=True)
        top_name = (genre_candidates[0].get("name") or "").strip()
        if top_name:
            genre = top_name.title()

    secondary_types = [t.lower() for t in (rg.get("secondary-types") or [])]
    is_compilation = "compilation" in secondary_types

    media = data.get("media") or []
    disc_total = len(media) if media else 1
    tracks: list[MusicBrainzTrackInfo] = []
    for disc_idx, medium in enumerate(media, start=1):
        disc_pos = int(medium.get("position") or disc_idx)
        medium_tracks = medium.get("tracks") or []
        track_total = int(medium.get("track-count") or len(medium_tracks))
        for t_idx, trk in enumerate(medium_tracks, start=1):
            t_pos = int(trk.get("position") or t_idx)
            recording = trk.get("recording") or {}
            t_title = str(trk.get("title") or recording.get("title") or f"Track {t_pos}")
            t_artist, _ = _format_artist_credit(
                trk.get("artist-credit") or recording.get("artist-credit")
            )
            length_raw = trk.get("length") or recording.get("length")
            tracks.append(
                MusicBrainzTrackInfo(
                    disc_number=disc_pos,
                    disc_total=disc_total,
                    track_number=t_pos,
                    track_total=track_total,
                    title=t_title,
                    artist=t_artist if t_artist != "Unknown Artist" else summary.artist,
                    length_ms=int(length_raw) if length_raw else None,
                )
            )

    return MusicBrainzReleaseDetail(
        **summary.model_dump(),
        genre=genre,
        compilation=is_compilation,
        tracks=tracks,
    )


async def fetch_cover_art(mbid: str, *, size: int | None = 1200) -> tuple[bytes, str] | None:
    """Download front cover artwork for a MusicBrainz release from Cover Art Archive.

    Tries the requested thumbnail size first (e.g., 1200px or 500px), falling back to
    full-resolution `/front` if the resized thumbnail isn't generated.
    """
    valid_id = validate_mbid(mbid)
    headers = {"User-Agent": USER_AGENT}

    urls: list[str] = []
    if size in {250, 500, 1200}:
        urls.append(f"{COVERART_BASE}/release/{valid_id}/front-{size}")
    urls.append(f"{COVERART_BASE}/release/{valid_id}/front")

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        for url in urls:
            for attempt in range(1, 3):
                try:
                    resp = await client.get(url, headers=headers)
                    if resp.status_code == 404:
                        break
                    if resp.status_code in _RETRYABLE_STATUSES and attempt == 1:
                        await asyncio.sleep(1.2)
                        continue
                    resp.raise_for_status()
                    content_type = (
                        (resp.headers.get("content-type") or "image/jpeg")
                        .split(";")[0]
                        .strip()
                    )
                    if not content_type.startswith("image/"):
                        content_type = "image/jpeg"
                    if resp.content:
                        return resp.content, content_type
                    break
                except httpx.HTTPError as exc:
                    logger.debug("Cover Art Archive fetch failed for %s: %s", url, exc)
                    break

    return None


# ==============================================================================
# Track-to-release matching engine (disc/track #, duration, title similarity)
# ==============================================================================

_LEADING_INT_RE = re.compile(r"^\s*(\d+)")
_FILENAME_DISC_TRACK_RE = re.compile(r"^\s*(\d{1,2})\s*[-._]\s*(\d{1,3})(?:\s*[-._)\s]\s*|\s+)(.*)$")
_FILENAME_TRACK_RE = re.compile(r"^\s*(\d{1,3})(?:\s*[-._)\s]\s*|\s+)(.*)$")
_PAREN_NOISE_RE = re.compile(
    r"\s*[\(\[（【](?:feat\.?|ft\.?|remaster(?:ed)?|live|bonus|explicit|clean|deluxe|radio edit|version)[^\)\]）】]*[\)\]）】]",
    re.IGNORECASE,
)


def _parse_leading_int(value: str | None) -> int | None:
    if not value:
        return None
    match = _LEADING_INT_RE.match(value)
    if not match:
        return None
    num = int(match.group(1))
    return num if num > 0 else None


def _parse_filename_hint(filename: str) -> tuple[int | None, int | None, str]:
    """Extract optional `(disc_hint, track_hint, cleaned_title)` from an audio filename."""
    stem = Path(filename).stem.strip()
    m_dt = _FILENAME_DISC_TRACK_RE.match(stem)
    if m_dt:
        disc_n = int(m_dt.group(1))
        track_n = int(m_dt.group(2))
        rest = m_dt.group(3).strip(" -_.")
        if 1 <= disc_n <= 20 and 1 <= track_n <= 200:
            return disc_n, track_n, rest or stem

    m_t = _FILENAME_TRACK_RE.match(stem)
    if m_t:
        track_n = int(m_t.group(1))
        rest = m_t.group(2).strip(" -_.")
        if 1 <= track_n <= 200:
            return None, track_n, rest or stem

    return None, None, stem


def _strip_latin_accents_preserve_unicode(text: str) -> str:
    """Fold full-width/half-width forms (NFKC), casefold, and strip Latin/Greek/Cyrillic diacritics while preserving CJK/kana/Hangul."""
    nfkc = unicodedata.normalize("NFKC", text).casefold()
    out: list[str] = []
    for ch in nfkc:
        cp = ord(ch)
        # Preserve kana dakuten/handakuten (e.g. ガ, パ) and Hangul syllables intact
        if (0x3040 <= cp <= 0x30FF) or (0xAC00 <= cp <= 0xD7AF):
            out.append(ch)
            continue
        decomp = unicodedata.normalize("NFD", ch)
        if len(decomp) > 1:
            base = "".join(c for c in decomp if not unicodedata.combining(c))
            out.append(base if base else ch)
        else:
            out.append(ch)
    return "".join(out)


def _fold_katakana_to_hiragana(text: str) -> str:
    """Fold Japanese Katakana (U+30A1..U+30F6) to Hiragana (U+3041..U+3096) for script-agnostic kana comparison."""
    out: list[str] = []
    for ch in text:
        cp = ord(ch)
        if 0x30A1 <= cp <= 0x30F6:
            out.append(chr(cp - 0x60))
        else:
            out.append(ch)
    return "".join(out)


def _has_cjk_or_kana_or_hangul(text: str) -> bool:
    for ch in text:
        cp = ord(ch)
        if (
            (0x3040 <= cp <= 0x30FF)  # Hiragana & Katakana
            or (0x3400 <= cp <= 0x4DBF)  # CJK Extension A
            or (0x4E00 <= cp <= 0x9FFF)  # CJK Unified Ideographs
            or (0xF900 <= cp <= 0xFAFF)  # CJK Compatibility Ideographs
            or (0xAC00 <= cp <= 0xD7AF)  # Hangul Syllables
        ):
            return True
    return False


def _normalize_title(text: str | None) -> str:
    """Unicode-aware title normalizer preserving non-Latin scripts (Japanese, Chinese, Korean, Cyrillic, Greek, Arabic, Hebrew, Thai...)."""
    if not text:
        return ""
    raw_clean = _PAREN_NOISE_RE.sub(" ", text)
    folded = _strip_latin_accents_preserve_unicode(raw_clean)
    tokens: list[str] = []
    current: list[str] = []
    for ch in folded:
        if ch.isalnum():
            current.append(ch)
        else:
            if current:
                tokens.append("".join(current))
                current = []
    if current:
        tokens.append("".join(current))
    normalized = " ".join(tokens).strip()
    if normalized:
        return normalized
    # Fallback for symbol-only titles (e.g., "♥", "∞", "???") so non-empty raw strings never collapse to ""
    raw_fallback = unicodedata.normalize("NFKC", raw_clean).casefold().strip()
    return " ".join(raw_fallback.split())


def _title_similarity(local_text: str | None, mb_text: str | None) -> float:
    a = _normalize_title(local_text)
    b = _normalize_title(mb_text)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    a_kana = _fold_katakana_to_hiragana(a)
    b_kana = _fold_katakana_to_hiragana(b)
    if a_kana == b_kana:
        return 0.98

    ratio = max(
        difflib.SequenceMatcher(None, a, b).ratio(),
        difflib.SequenceMatcher(None, a_kana, b_kana).ratio() * 0.98,
    )
    # Boost when one normalized title cleanly contains the other (e.g., extra subtitle);
    # scale minimum length & ratio threshold by script (>=2 chars for CJK/kana/Hangul, >=4 chars for alphabetic)
    is_cjk = _has_cjk_or_kana_or_hangul(a) or _has_cjk_or_kana_or_hangul(b)
    min_len = 2 if is_cjk else 4
    min_share = 0.14 if is_cjk else 0.55
    if len(a_kana) >= min_len and len(b_kana) >= min_len and (a_kana in b_kana or b_kana in a_kana):
        shorter = min(len(a_kana), len(b_kana))
        longer = max(len(a_kana), len(b_kana))
        if shorter / longer >= min_share:
            ratio = max(ratio, 0.86)
    return ratio


def _duration_diff_sec(local_duration: float, mb_length_ms: int | None) -> float | None:
    if not mb_length_ms or mb_length_ms <= 0 or local_duration <= 0.5:
        return None
    return abs(local_duration - (mb_length_ms / 1000.0))


def _build_match_record(
    local: TrackMetadata,
    mb: MusicBrainzTrackInfo | None,
    *,
    method: str,
    confidence: str,
    reason: str | None,
) -> MusicBrainzTrackMatch:
    return MusicBrainzTrackMatch(
        local_path=local.path,
        local_filename=local.filename,
        local_title=local.title,
        local_artist=local.artist,
        local_track_number=local.track_number,
        local_disc_number=local.disc_number,
        local_duration=local.duration,
        matched=mb is not None,
        match_method=method,
        confidence=confidence,
        reason=reason,
        mb_disc_number=mb.disc_number if mb else None,
        mb_disc_total=mb.disc_total if mb else None,
        mb_track_number=mb.track_number if mb else None,
        mb_track_total=mb.track_total if mb else None,
        mb_title=mb.title if mb else None,
        mb_artist=mb.artist if mb else None,
        mb_length_ms=mb.length_ms if mb else None,
    )


_GENERIC_TITLE_RE = re.compile(
    r"^(?:track|audio\s*track|song|untitled|unknown|cd\s*track|トラック|曲)\s*\d*$",
    re.IGNORECASE,
)


def match_tracks_to_release(
    local_tracks: list[TrackMetadata],
    mb_tracks: list[MusicBrainzTrackInfo],
) -> list[MusicBrainzTrackMatch]:
    """Match local audio files to MusicBrainz release tracks without blind positional shifting.

    Priority pipeline (strict one-to-one assignment):
      1. Normalized track title similarity across the full release tracklist (boosted/tie-broken by duration closeness and matching disc/track #).
      2. Disc & Track number match for remaining unmatched tracks (verified against duration).
      3. Unambiguous duration match for untitled, unnumbered tracks.
      4. Unmatched tracks are flagged and left untouched rather than shifted off-by-one.
    """
    if not local_tracks:
        return []
    if not mb_tracks:
        return [
            _build_match_record(
                t,
                None,
                method="unmatched",
                confidence="none",
                reason="Release has no tracklist entries on MusicBrainz.",
            )
            for t in local_tracks
        ]

    disc_numbers_present = {m.disc_number for m in mb_tracks}
    is_single_disc = len(disc_numbers_present) <= 1

    # Index MB tracks by (disc_number, track_number) and by track_number alone
    by_disc_track: dict[tuple[int, int], int] = {}
    by_track_only: dict[int, list[int]] = {}
    for mb_idx, mb in enumerate(mb_tracks):
        by_disc_track.setdefault((mb.disc_number, mb.track_number), mb_idx)
        by_track_only.setdefault(mb.track_number, []).append(mb_idx)

    # Pre-compute parsed local metadata hints
    local_hints: list[tuple[int | None, int | None, str, bool]] = []
    for t in local_tracks:
        fn_disc, fn_track, fn_title = _parse_filename_hint(t.filename)
        tag_track = _parse_leading_int(t.track_number)
        tag_disc = _parse_leading_int(t.disc_number)
        eff_track = tag_track if tag_track is not None else fn_track
        eff_disc = tag_disc if tag_disc is not None else fn_disc
        eff_title = (t.title or "").strip() or fn_title
        from_tag = tag_track is not None
        local_hints.append((eff_disc, eff_track, eff_title, from_tag))

    assigned_mb: dict[int, tuple[int, str, str, str | None]] = {}
    used_mb_indices: set[int] = set()

    # ------------------------------------------------------------------
    # Stage 1: Track title similarity across the WHOLE MB release tracklist
    # ------------------------------------------------------------------
    title_pairs: list[tuple[float, int, int, str, str, str]] = []
    for local_idx, local in enumerate(local_tracks):
        eff_disc, eff_track, eff_title, _ = local_hints[local_idx]
        norm_title = _normalize_title(eff_title)
        if not norm_title or _GENERIC_TITLE_RE.match(norm_title):
            continue

        for mb_idx, mb in enumerate(mb_tracks):
            sim = _title_similarity(eff_title, mb.title)
            dur_diff = _duration_diff_sec(local.duration, mb.length_ms)
            pos_matches = eff_track == mb.track_number and (
                eff_disc == mb.disc_number
                or (eff_disc is None and is_single_disc)
            )
            pos_bonus = 0.15 if pos_matches else 0.0

            if sim >= 0.78:
                if dur_diff is not None and dur_diff <= 15.0:
                    score = sim + 0.35 + pos_bonus - (dur_diff / 100.0)
                    title_pairs.append(
                        (
                            score,
                            local_idx,
                            mb_idx,
                            "title_duration",
                            "high",
                            f"Matched by title ({int(round(sim * 100))}%) & duration (within {round(dur_diff)}s)",
                        )
                    )
                elif dur_diff is None or dur_diff <= 45.0:
                    score = sim + pos_bonus
                    title_pairs.append(
                        (
                            score,
                            local_idx,
                            mb_idx,
                            "title",
                            "high" if sim >= 0.90 or pos_matches else "medium",
                            f"Matched by title similarity ({int(round(sim * 100))}%)",
                        )
                    )
                elif sim >= 0.85:
                    score = sim - 0.10 + pos_bonus
                    title_pairs.append(
                        (
                            score,
                            local_idx,
                            mb_idx,
                            "title",
                            "high" if sim >= 0.98 and pos_matches else "medium",
                            f"Matched by title ({int(round(sim * 100))}%), duration differs by {round(dur_diff)}s",
                        )
                    )
            elif sim >= 0.55 and dur_diff is not None and dur_diff <= 10.0:
                score = sim + 0.25 + pos_bonus - (dur_diff / 100.0)
                title_pairs.append(
                    (
                        score,
                        local_idx,
                        mb_idx,
                        "title_duration",
                        "high",
                        f"Matched by title ({int(round(sim * 100))}%) & duration (within {round(dur_diff)}s)",
                    )
                )

    title_pairs.sort(key=lambda item: (-item[0], item[1], item[2]))
    for _, local_idx, mb_idx, method, confidence, reason in title_pairs:
        if local_idx in assigned_mb or mb_idx in used_mb_indices:
            continue
        assigned_mb[local_idx] = (mb_idx, method, confidence, reason)
        used_mb_indices.add(mb_idx)

    # ------------------------------------------------------------------
    # Stage 2: Disc & Track number matching (for remaining unmatched tracks)
    # ------------------------------------------------------------------
    stage2_candidates: dict[int, list[tuple[float, int, str, str | None]]] = {}
    for local_idx, local in enumerate(local_tracks):
        if local_idx in assigned_mb:
            continue
        eff_disc, eff_track, eff_title, from_tag = local_hints[local_idx]
        if eff_track is None:
            continue

        mb_idx: int | None = None
        if eff_disc is not None:
            mb_idx = by_disc_track.get((eff_disc, eff_track))
        elif is_single_disc:
            single_disc_num = next(iter(disc_numbers_present))
            mb_idx = by_disc_track.get((single_disc_num, eff_track))
        else:
            matches_for_num = [
                idx
                for idx in by_track_only.get(eff_track, [])
                if idx not in used_mb_indices
            ]
            if len(matches_for_num) == 1:
                mb_idx = matches_for_num[0]

        if mb_idx is None or mb_idx in used_mb_indices:
            continue

        mb = mb_tracks[mb_idx]
        sim = _title_similarity(eff_title, mb.title)
        dur_diff = _duration_diff_sec(local.duration, mb.length_ms)

        fit_score = (sim * 2.0) + (0.25 if from_tag else 0.0)
        if dur_diff is not None:
            fit_score += max(0.0, 1.5 - (dur_diff / 20.0))

        disc_label = (
            f"disc {mb.disc_number}, track {mb.track_number}"
            if not is_single_disc
            else f"track #{mb.track_number}"
        )
        if dur_diff is not None and dur_diff > 20.0 and sim < 0.55:
            confidence = "low"
            reason = f"Matched by {disc_label}, but duration differs by {round(dur_diff)}s — verify before applying"
        elif dur_diff is not None and dur_diff <= 10.0:
            confidence = "high"
            reason = f"Matched by {disc_label} (duration within {round(dur_diff)}s)"
        elif sim >= 0.65:
            confidence = "high"
            reason = f"Matched by {disc_label} & title"
        else:
            confidence = "high" if from_tag else "medium"
            reason = f"Matched by {'tag' if from_tag else 'filename'} {disc_label}"

        stage2_candidates.setdefault(mb_idx, []).append(
            (fit_score, local_idx, confidence, reason)
        )

    for mb_idx, cands in stage2_candidates.items():
        if mb_idx in used_mb_indices:
            continue
        cands.sort(key=lambda item: (-item[0], item[1]))
        _, best_local_idx, confidence, reason = cands[0]
        if best_local_idx in assigned_mb:
            continue
        assigned_mb[best_local_idx] = (mb_idx, "disc_track", confidence, reason)
        used_mb_indices.add(mb_idx)

    # ------------------------------------------------------------------
    # Stage 3: Pure duration match for untitled/unnumbered tracks
    # ------------------------------------------------------------------
    duration_pairs: list[tuple[float, int, int, str]] = []
    for local_idx, local in enumerate(local_tracks):
        if local_idx in assigned_mb or local.duration < 10.0:
            continue
        close: list[tuple[float, int]] = []
        for mb_idx, mb in enumerate(mb_tracks):
            if mb_idx in used_mb_indices:
                continue
            dur_diff = _duration_diff_sec(local.duration, mb.length_ms)
            if dur_diff is not None and dur_diff <= 4.0:
                close.append((dur_diff, mb_idx))
        if not close:
            continue
        close.sort(key=lambda item: item[0])
        if len(close) == 1 or (close[1][0] - close[0][0]) >= 3.0:
            best_diff, best_mb_idx = close[0]
            duration_pairs.append(
                (
                    best_diff,
                    local_idx,
                    best_mb_idx,
                    f"Matched by duration (within {best_diff:.1f}s)",
                )
            )

    duration_pairs.sort(key=lambda item: (item[0], item[1]))
    for _, local_idx, mb_idx, reason in duration_pairs:
        if local_idx in assigned_mb or mb_idx in used_mb_indices:
            continue
        assigned_mb[local_idx] = (mb_idx, "duration", "medium", reason)
        used_mb_indices.add(mb_idx)

    # ------------------------------------------------------------------
    # Stage 4: Build final ordered result (unmatched tracks stay untouched)
    # ------------------------------------------------------------------
    results: list[MusicBrainzTrackMatch] = []
    for local_idx, local in enumerate(local_tracks):
        match_tuple = assigned_mb.get(local_idx)
        if match_tuple is None:
            results.append(
                _build_match_record(
                    local,
                    None,
                    method="unmatched",
                    confidence="none",
                    reason="No reliable match in this MusicBrainz release — title & track number will be left unchanged.",
                )
            )
        else:
            mb_idx, method, confidence, reason = match_tuple
            results.append(
                _build_match_record(
                    local,
                    mb_tracks[mb_idx],
                    method=method,
                    confidence=confidence,
                    reason=reason,
                )
            )
    return results

