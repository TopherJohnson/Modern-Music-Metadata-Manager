"""Optional slskd (Soulseek) REST API client, smart candidate ranker, and download manager (Issue #6)."""

from __future__ import annotations

import asyncio
import logging
import time
import urllib.parse
import uuid
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any

import httpx

from app.config import Settings
from app.models import (
    SlskdCandidate,
    SlskdDownloadFile,
    SlskdDownloadsResponse,
    SlskdQueueDownloadResponse,
    SlskdSearchRequest,
    SlskdSearchResponse,
    SlskdStatusResponse,
    SlskdTransferItem,
)
from app.services.musicbrainz import _title_similarity

logger = logging.getLogger(__name__)

_AUDIO_EXTENSIONS: frozenset[str] = frozenset(
    {".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aiff", ".aif", ".alac"}
)
_LOSSLESS_FORMATS: frozenset[str] = frozenset({"FLAC", "WAV", "AIFF", "AIF", "ALAC"})

# Remember ranking criteria per search_id so "Refresh Peers" re-ranks consistently,
# and track M⁴-created search IDs so we never delete searches started manually in slskd.
_SEARCH_CONTEXT: dict[str, tuple[float, dict[str, Any]]] = {}
_OWNED_SEARCH_IDS: set[str] = set()
_SEARCH_CTX_TTL = 1800.0


class SlskdError(Exception):
    """Raised when communicating with the configured slskd instance fails."""


def _headers(settings: Settings) -> dict[str, str]:
    if not settings.slskd_url or not settings.slskd_api_key:
        raise SlskdError("slskd is not configured (set SLSKD_URL and SLSKD_API_KEY).")
    return {
        "X-API-Key": settings.slskd_api_key,
        "Accept": "application/json",
    }


def _split_peer_path(raw_path: str) -> tuple[str, str, str]:
    """Split a Soulseek peer filename (Windows or POSIX separators) into (directory, basename, ext)."""
    if "\\" in raw_path:
        p = PureWindowsPath(raw_path)
    else:
        p = PurePosixPath(raw_path)
    basename = p.name or raw_path
    directory = str(p.parent) if str(p.parent) not in {"", "."} else ""
    ext = (p.suffix or "").lower()
    return directory, basename, ext


def _format_from_ext(ext: str) -> str:
    clean = ext.lstrip(".").upper()
    if clean == "AIF":
        return "AIFF"
    return clean or "AUDIO"


def rank_slskd_responses(
    responses: list[dict[str, Any]],
    *,
    query: str,
    track_title: str | None = None,
    artist: str | None = None,
    preferred_formats: list[str] | None = None,
    expected_length_ms: int | None = None,
    limit: int = 40,
) -> tuple[list[SlskdCandidate], int]:
    """Filter and rank peer audio files from slskd search responses."""
    pref_set = {f.strip().upper() for f in (preferred_formats or []) if f.strip()}
    wants_lossless = bool(pref_set & _LOSSLESS_FORMATS)
    expected_sec = (
        expected_length_ms / 1000.0
        if expected_length_ms and expected_length_ms > 0
        else None
    )
    title_target = (track_title or "").strip() or query

    candidates: list[SlskdCandidate] = []
    total_files = 0

    for resp in responses:
        username = str(resp.get("username") or "").strip()
        if not username:
            continue
        has_free_slot = bool(resp.get("hasFreeUploadSlot"))
        upload_speed = int(resp.get("uploadSpeed") or 0)
        queue_length = int(resp.get("queueLength") or 0)

        files = resp.get("files") or []
        for f in files:
            total_files += 1
            if f.get("isLocked"):
                continue
            raw_name = str(f.get("filename") or "").strip()
            if not raw_name:
                continue

            directory, basename, ext = _split_peer_path(raw_name)
            if not ext:
                raw_ext = str(f.get("extension") or "").strip().lower()
                if raw_ext:
                    ext = raw_ext if raw_ext.startswith(".") else f".{raw_ext}"
            if ext not in _AUDIO_EXTENSIONS:
                continue

            fmt = _format_from_ext(ext)
            size = int(f.get("size") or 0)
            bit_rate = int(f["bitRate"]) if f.get("bitRate") is not None else None
            sample_rate = int(f["sampleRate"]) if f.get("sampleRate") is not None else None
            bit_depth = int(f["bitDepth"]) if f.get("bitDepth") is not None else None
            length_sec = int(f["length"]) if f.get("length") is not None else None

            score = 25
            reasons: list[str] = []

            # 1. Audio format alignment with album
            if pref_set and fmt in pref_set:
                score += 28
                reasons.append(f"Matches album {fmt}")
            elif wants_lossless and fmt in _LOSSLESS_FORMATS:
                score += 22
                reasons.append(f"Lossless {fmt}")
            elif fmt == "FLAC":
                score += 18
                reasons.append("Lossless FLAC")
            elif fmt == "MP3" and bit_rate is not None:
                if bit_rate >= 300:
                    score += 14
                    reasons.append(f"MP3 {bit_rate}k")
                elif bit_rate < 192:
                    score -= 10
                    reasons.append(f"Low bitrate ({bit_rate}k)")

            # 2. Title relevance on filename stem
            stem = basename[: -len(ext)] if ext and basename.lower().endswith(ext) else basename
            sim = _title_similarity(title_target, stem)
            if sim >= 0.85:
                score += 25
                reasons.append("Strong title match")
            elif sim >= 0.62:
                score += 16
                reasons.append("Title match")
            elif sim >= 0.42:
                score += 6
            elif artist and _title_similarity(artist, f"{directory} {stem}") >= 0.55:
                score += 4

            # 3. Duration closeness against MusicBrainz track length
            dur_diff: float | None = None
            if expected_sec is not None and length_sec is not None and length_sec > 0:
                dur_diff = abs(length_sec - expected_sec)
                if dur_diff <= 3.0:
                    score += 24
                    reasons.append(f"Duration within {round(dur_diff)}s")
                elif dur_diff <= 8.0:
                    score += 16
                    reasons.append(f"Duration within {round(dur_diff)}s")
                elif dur_diff <= 18.0:
                    score += 8
                elif dur_diff > 45.0:
                    score -= 18
                    reasons.append(f"Duration differs by {round(dur_diff)}s")

            # 4. Peer availability & speed
            if has_free_slot:
                score += 14
                reasons.append("Free slot")
            elif queue_length >= 10:
                score -= 8

            if upload_speed >= 1_000_000:
                score += 6
            elif upload_speed >= 300_000:
                score += 3

            clamped = max(1, min(100, score))
            candidates.append(
                SlskdCandidate(
                    username=username,
                    filename=raw_name,
                    basename=basename,
                    directory=directory,
                    extension=ext,
                    format=fmt,
                    size=size,
                    bit_rate=bit_rate,
                    sample_rate=sample_rate,
                    bit_depth=bit_depth,
                    length_sec=length_sec,
                    duration_diff_sec=round(dur_diff, 1) if dur_diff is not None else None,
                    has_free_upload_slot=has_free_slot,
                    upload_speed=upload_speed,
                    queue_length=queue_length,
                    score=clamped,
                    reasons=reasons[:4],
                )
            )

    candidates.sort(
        key=lambda c: (
            -c.score,
            not c.has_free_upload_slot,
            -c.upload_speed,
            c.queue_length,
            c.basename.casefold(),
        )
    )
    return candidates[:limit], total_files


async def check_slskd_status(settings: Settings) -> SlskdStatusResponse:
    """Ping the configured slskd instance to verify API reachability."""
    if not settings.slskd_configured or not settings.slskd_url:
        return SlskdStatusResponse(configured=False, connected=False)

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{settings.slskd_url}/api/v0/application",
                headers=_headers(settings),
            )
            if resp.status_code == 401 or resp.status_code == 403:
                return SlskdStatusResponse(
                    configured=True,
                    connected=False,
                    detail="Invalid SLSKD_API_KEY (HTTP 401/403).",
                )
            resp.raise_for_status()
            data = resp.json() if resp.content else {}
            version = (
                data.get("version", {}).get("full")
                if isinstance(data.get("version"), dict)
                else data.get("version")
            )
            return SlskdStatusResponse(
                configured=True,
                connected=True,
                detail=f"Connected to slskd {version}" if version else "Connected to slskd",
            )
    except httpx.HTTPError as exc:
        return SlskdStatusResponse(
            configured=True,
            connected=False,
            detail=f"Could not reach slskd at {settings.slskd_url}: {exc}",
        )


async def _fetch_search_results(
    client: httpx.AsyncClient,
    settings: Settings,
    search_id: str,
    ctx: dict[str, Any],
) -> SlskdSearchResponse:
    headers = _headers(settings)
    meta_resp = await client.get(
        f"{settings.slskd_url}/api/v0/searches/{search_id}",
        headers=headers,
    )
    meta_resp.raise_for_status()
    meta = meta_resp.json() if meta_resp.content else {}

    resp_list = await client.get(
        f"{settings.slskd_url}/api/v0/searches/{search_id}/responses",
        headers=headers,
    )
    resp_list.raise_for_status()
    responses = resp_list.json() if resp_list.content else []
    if not isinstance(responses, list):
        responses = []

    candidates, file_count = rank_slskd_responses(
        responses,
        query=str(ctx.get("query") or meta.get("searchText") or ""),
        track_title=ctx.get("track_title"),
        artist=ctx.get("artist"),
        preferred_formats=ctx.get("preferred_formats"),
        expected_length_ms=ctx.get("expected_length_ms"),
    )

    state = str(meta.get("state") or "Completed")
    is_complete = bool(meta.get("isComplete")) or state.lower().startswith("completed")
    return SlskdSearchResponse(
        search_id=search_id,
        query=str(ctx.get("query") or meta.get("searchText") or ""),
        state=state,
        is_complete=is_complete,
        response_count=len(responses),
        file_count=file_count,
        candidates=candidates,
    )


async def _stop_and_delete_search_http(
    client: httpx.AsyncClient,
    settings: Settings,
    search_id: str,
) -> bool:
    """Stop (best-effort PUT) and delete (DELETE) a single search ID on slskd, tolerating 404."""
    headers = _headers(settings)
    encoded_id = urllib.parse.quote(search_id, safe="")
    url = f"{settings.slskd_url}/api/v0/searches/{encoded_id}"

    # Best-effort stop in case the search is still active in slskd
    try:
        await client.put(url, headers=headers)
    except httpx.HTTPError:
        pass

    resp = await client.delete(url, headers=headers)
    if resp.status_code == 404:
        return True
    resp.raise_for_status()
    return True


async def delete_slskd_search(
    settings: Settings,
    search_id: str,
    *,
    require_owned: bool = True,
) -> bool:
    """Stop and delete an M⁴-created search from slskd (Issue #14).

    Never deletes searches that were not created by M⁴ when `require_owned=True`.
    Treats HTTP 404 (already deleted in slskd) as success.
    """
    _headers(settings)
    cleaned_id = search_id.strip()
    if not cleaned_id:
        return False

    is_owned = cleaned_id in _OWNED_SEARCH_IDS or cleaned_id in _SEARCH_CONTEXT
    if require_owned and not is_owned:
        logger.debug(
            "Skipping delete for slskd search %s (not created by M⁴)", cleaned_id
        )
        return False

    _SEARCH_CONTEXT.pop(cleaned_id, None)
    _OWNED_SEARCH_IDS.discard(cleaned_id)

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            return await _stop_and_delete_search_http(client, settings, cleaned_id)
    except httpx.HTTPError as exc:
        raise SlskdError(f"Could not delete slskd search {cleaned_id}: {exc}") from exc


async def sweep_expired_slskd_searches(
    settings: Settings,
    *,
    now: float | None = None,
) -> list[str]:
    """Evict expired entries from `_SEARCH_CONTEXT` and delete them from slskd (Issue #14 safety net)."""
    ts_now = now if now is not None else time.monotonic()
    expired_ids = [
        k for k, (ts, _) in list(_SEARCH_CONTEXT.items()) if ts_now - ts > _SEARCH_CTX_TTL
    ]
    if not expired_ids:
        return []

    for old_id in expired_ids:
        _SEARCH_CONTEXT.pop(old_id, None)
        _OWNED_SEARCH_IDS.discard(old_id)

    if not settings.slskd_configured:
        return expired_ids

    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            for old_id in expired_ids:
                try:
                    await _stop_and_delete_search_http(client, settings, old_id)
                except httpx.HTTPError as exc:
                    logger.debug(
                        "Best-effort TTL cleanup of slskd search %s failed: %s",
                        old_id,
                        exc,
                    )
    except Exception as exc:
        logger.debug("Best-effort TTL slskd sweep failed: %s", exc)

    return expired_ids


async def search_slskd(
    settings: Settings,
    payload: SlskdSearchRequest,
) -> SlskdSearchResponse:
    """Issue a search on slskd, briefly poll for peer responses, and return smart-ranked candidates."""
    headers = _headers(settings)
    search_id = str(uuid.uuid4())

    # Evict and delete stale M⁴ search contexts in slskd
    now = time.monotonic()
    await sweep_expired_slskd_searches(settings, now=now)

    ctx = {
        "query": payload.query.strip(),
        "track_title": payload.track_title,
        "artist": payload.artist,
        "preferred_formats": list(payload.preferred_formats),
        "expected_length_ms": payload.expected_length_ms,
    }
    _SEARCH_CONTEXT[search_id] = (now, ctx)
    _OWNED_SEARCH_IDS.add(search_id)

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            start_resp = await client.post(
                f"{settings.slskd_url}/api/v0/searches",
                headers=headers,
                json={
                    "id": search_id,
                    "searchText": payload.query.strip(),
                    "searchTimeout": 15000,
                    "filterResponses": True,
                },
            )
            start_resp.raise_for_status()
            created = start_resp.json() if start_resp.content else {}
            actual_id = str(created.get("id") or search_id)
            if actual_id != search_id:
                _SEARCH_CONTEXT.pop(search_id, None)
                _OWNED_SEARCH_IDS.discard(search_id)
                _SEARCH_CONTEXT[actual_id] = (now, ctx)
                _OWNED_SEARCH_IDS.add(actual_id)
                search_id = actual_id

            deadline = time.monotonic() + payload.timeout_sec
            while time.monotonic() < deadline:
                await asyncio.sleep(0.7)
                state_resp = await client.get(
                    f"{settings.slskd_url}/api/v0/searches/{search_id}",
                    headers=headers,
                )
                if state_resp.status_code != 200:
                    break
                meta = state_resp.json()
                state_str = str(meta.get("state") or "")
                resp_count = int(meta.get("responseCount") or 0)
                if meta.get("isComplete") or state_str.lower().startswith("completed"):
                    break
                # Early return once plenty of peer responses have arrived (user can still Refresh Peers)
                if resp_count >= 15 and (time.monotonic() + 2.0) >= deadline:
                    break

            return await _fetch_search_results(client, settings, search_id, ctx)
    except httpx.HTTPError as exc:
        raise SlskdError(f"slskd search failed: {exc}") from exc


async def refresh_slskd_search(
    settings: Settings,
    search_id: str,
) -> SlskdSearchResponse:
    """Re-fetch and re-rank responses for an in-flight or recently completed slskd search."""
    _headers(settings)
    ctx_entry = _SEARCH_CONTEXT.get(search_id)
    ctx = ctx_entry[1] if ctx_entry else {}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            return await _fetch_search_results(client, settings, search_id, ctx)
    except httpx.HTTPError as exc:
        raise SlskdError(f"Could not refresh slskd search: {exc}") from exc


async def queue_slskd_downloads(
    settings: Settings,
    username: str,
    files: list[SlskdDownloadFile],
) -> SlskdQueueDownloadResponse:
    """Queue one or more files from a peer for download on slskd."""
    headers = _headers(settings)
    encoded_user = urllib.parse.quote(username, safe="")
    body = [{"filename": f.filename, "size": f.size} for f in files]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{settings.slskd_url}/api/v0/transfers/downloads/{encoded_user}",
                headers=headers,
                json=body,
            )
            resp.raise_for_status()
            return SlskdQueueDownloadResponse(
                ok=True,
                username=username,
                queued_count=len(files),
                detail=f"Queued {len(files)} file(s) from {username} in slskd.",
            )
    except httpx.HTTPError as exc:
        raise SlskdError(f"Could not queue download in slskd: {exc}") from exc


def _classify_transfer_state(state: str) -> str:
    low = state.lower()
    if "succeeded" in low or ("completed" in low and "errored" not in low and "cancelled" not in low and "rejected" not in low and "timedout" not in low and "aborted" not in low):
        return "completed"
    if any(tok in low for tok in ("errored", "rejected", "cancelled", "timedout", "aborted", "failed")):
        return "failed"
    return "active"


async def list_slskd_downloads(settings: Settings) -> SlskdDownloadsResponse:
    """Fetch current download transfers from slskd (and sweep any expired M⁴ search contexts)."""
    headers = _headers(settings)
    await sweep_expired_slskd_searches(settings)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{settings.slskd_url}/api/v0/transfers/downloads",
                headers=headers,
            )
            resp.raise_for_status()
            raw_users = resp.json() if resp.content else []
    except httpx.HTTPError as exc:
        raise SlskdError(f"Could not read downloads from slskd: {exc}") from exc

    transfers: list[SlskdTransferItem] = []
    active_count = 0
    completed_count = 0
    failed_count = 0

    if isinstance(raw_users, list):
        for user_entry in raw_users:
            username = str(user_entry.get("username") or "")
            for directory_entry in user_entry.get("directories") or []:
                for f in directory_entry.get("files") or []:
                    filename = str(f.get("filename") or "")
                    _, basename, _ = _split_peer_path(filename)
                    state = str(f.get("state") or "Unknown")
                    bucket = _classify_transfer_state(state)
                    if bucket == "active":
                        active_count += 1
                    elif bucket == "completed":
                        completed_count += 1
                    else:
                        failed_count += 1

                    transfers.append(
                        SlskdTransferItem(
                            id=str(f.get("id") or f"{username}:{filename}"),
                            username=str(f.get("username") or username),
                            filename=filename,
                            basename=basename,
                            size=int(f.get("size") or 0),
                            bytes_transferred=int(f.get("bytesTransferred") or 0),
                            percent_complete=round(float(f.get("percentComplete") or 0.0), 1),
                            state=state,
                            average_speed=float(f.get("averageSpeed") or 0.0),
                            bytes_remaining=int(f.get("bytesRemaining") or 0),
                            requested_at=f.get("requestedAt"),
                            ended_at=f.get("endedAt"),
                            exception=f.get("exception"),
                        )
                    )

    order_rank = {"active": 0, "failed": 1, "completed": 2}
    transfers.sort(
        key=lambda t: (
            order_rank[_classify_transfer_state(t.state)],
            t.requested_at or "",
        ),
    )
    return SlskdDownloadsResponse(
        active_count=active_count,
        completed_count=completed_count,
        failed_count=failed_count,
        transfers=transfers,
    )


async def clear_completed_slskd_downloads(settings: Settings) -> None:
    """Clear completed transfers in slskd."""
    headers = _headers(settings)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.delete(
                f"{settings.slskd_url}/api/v0/transfers/downloads/all/completed",
                headers=headers,
            )
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise SlskdError(f"Could not clear completed downloads in slskd: {exc}") from exc


async def remove_slskd_download(
    settings: Settings,
    username: str,
    transfer_id: str,
) -> None:
    """Cancel and remove a single download transfer from slskd."""
    headers = _headers(settings)
    encoded_user = urllib.parse.quote(username, safe="")
    encoded_id = urllib.parse.quote(transfer_id, safe="")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.delete(
                f"{settings.slskd_url}/api/v0/transfers/downloads/{encoded_user}/{encoded_id}",
                params={"remove": "true"},
                headers=headers,
            )
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise SlskdError(f"Could not remove transfer in slskd: {exc}") from exc
