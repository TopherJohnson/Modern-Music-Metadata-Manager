"""MusicBrainz API v2 and Cover Art Archive client for album identification and artwork lookup."""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from typing import Any

import httpx

from app import __version__
from app.models import MusicBrainzReleaseCandidate, MusicBrainzReleaseDetail, MusicBrainzTrackInfo

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
