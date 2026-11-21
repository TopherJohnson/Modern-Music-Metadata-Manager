"""Mutagen-based audio metadata and cover art reader/writer for MP3, FLAC, M4A, OGG, and OPUS."""

from __future__ import annotations

import base64
import re
from pathlib import Path
from typing import Any

from mutagen.flac import FLAC, Picture
from mutagen.id3 import (
    APIC,
    ID3,
    ID3NoHeaderError,
    TALB,
    TCOM,
    TCON,
    TDRC,
    TIT2,
    TPE1,
    TPE2,
    TPOS,
    TRCK,
)
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis

from app.config import SUPPORTED_EXTENSIONS
from app.models import TrackMetadata

EDITABLE_FIELDS: tuple[str, ...] = (
    "title",
    "artist",
    "album_artist",
    "album",
    "year",
    "track_number",
    "disc_number",
    "genre",
    "composer",
)

_ID3_TEXT_FRAMES: dict[str, tuple[str, type]] = {
    "title": ("TIT2", TIT2),
    "artist": ("TPE1", TPE1),
    "album_artist": ("TPE2", TPE2),
    "album": ("TALB", TALB),
    "year": ("TDRC", TDRC),
    "track_number": ("TRCK", TRCK),
    "disc_number": ("TPOS", TPOS),
    "genre": ("TCON", TCON),
    "composer": ("TCOM", TCOM),
}

_VORBIS_KEYS: dict[str, str] = {
    "title": "TITLE",
    "artist": "ARTIST",
    "album_artist": "ALBUMARTIST",
    "album": "ALBUM",
    "year": "DATE",
    "track_number": "TRACKNUMBER",
    "disc_number": "DISCNUMBER",
    "genre": "GENRE",
    "composer": "COMPOSER",
}

_MP4_TEXT_ATOMS: dict[str, str] = {
    "title": "\xa9nam",
    "artist": "\xa9ART",
    "album_artist": "aART",
    "album": "\xa9alb",
    "year": "\xa9day",
    "genre": "\xa9gen",
    "composer": "\xa9wrt",
}


class TagServiceError(Exception):
    """Base error raised by the tag service."""


class InvalidTrackPathError(TagServiceError):
    """Raised when a requested track path is outside MUSIC_DIR or unsupported."""


class TrackNotFoundError(TagServiceError):
    """Raised when a requested track file does not exist on disk."""


def resolve_track_path(music_dir: Path, rel_path: str) -> tuple[Path, str]:
    """Resolve and validate a relative track path inside `music_dir`.

    Prevents path traversal outside `music_dir` and ensures the file extension
    is one of the supported audio formats.
    """
    cleaned = rel_path.strip().lstrip("/")
    if not cleaned:
        raise InvalidTrackPathError("Track path must not be empty.")

    root = music_dir.resolve()
    candidate = (root / cleaned).resolve()

    if not candidate.is_relative_to(root):
        raise InvalidTrackPathError("Track path escapes the configured music directory.")

    if candidate.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise InvalidTrackPathError(
            f"Unsupported audio format '{candidate.suffix}'. "
            f"Supported formats: {', '.join(sorted(SUPPORTED_EXTENSIONS))}."
        )

    if not candidate.is_file():
        raise TrackNotFoundError(f"Track file not found: {cleaned}")

    normalized_rel = candidate.relative_to(root).as_posix()
    return candidate, normalized_rel


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def _parse_int_pair(raw: str | None) -> tuple[int, int] | None:
    """Parse '3' or '3/12' into a (number, total) tuple for MP4 trkn/disk atoms."""
    if not raw:
        return None
    match = re.match(r"^\s*(\d+)(?:\s*/\s*(\d+))?\s*$", raw)
    if not match:
        return None
    num = int(match.group(1))
    total = int(match.group(2)) if match.group(2) else 0
    return (num, total)


def _format_int_pair(pair: tuple[int, int] | list[int] | None) -> str | None:
    if not pair or not pair[0]:
        return None
    num = int(pair[0])
    total = int(pair[1]) if len(pair) > 1 and pair[1] else 0
    return f"{num}/{total}" if total > 0 else str(num)


def _detect_image_mime(data: bytes, fallback: str = "image/jpeg") -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    return fallback


def _open_audio(file_path: Path):
    ext = file_path.suffix.lower()
    if ext == ".mp3":
        return MP3(file_path)
    if ext == ".flac":
        return FLAC(file_path)
    if ext == ".m4a":
        return MP4(file_path)
    if ext == ".ogg":
        return OggVorbis(file_path)
    if ext == ".opus":
        return OggOpus(file_path)
    raise InvalidTrackPathError(f"Unsupported extension: {ext}")


def _extract_id3_tags(audio: MP3) -> dict[str, str | None]:
    tags: ID3 | None = audio.tags
    result: dict[str, str | None] = {field: None for field in EDITABLE_FIELDS}
    if not tags:
        return result

    for field, (frame_id, _) in _ID3_TEXT_FRAMES.items():
        frame = tags.get(frame_id)
        if frame is not None and getattr(frame, "text", None):
            result[field] = _clean_text(frame.text[0])

    # Legacy ID3v2.3 fallback for year
    if not result["year"]:
        tyer = tags.get("TYER")
        if tyer is not None and getattr(tyer, "text", None):
            result["year"] = _clean_text(tyer.text[0])

    return result


def _extract_vorbis_tags(audio: FLAC | OggVorbis | OggOpus) -> dict[str, str | None]:
    tags = audio.tags
    result: dict[str, str | None] = {field: None for field in EDITABLE_FIELDS}
    if not tags:
        return result

    def first(*keys: str) -> str | None:
        for key in keys:
            values = tags.get(key) or tags.get(key.lower())
            if values:
                val = _clean_text(values[0])
                if val is not None:
                    return val
        return None

    result["title"] = first("TITLE")
    result["artist"] = first("ARTIST")
    result["album_artist"] = first("ALBUMARTIST", "ALBUM ARTIST")
    result["album"] = first("ALBUM")
    result["year"] = first("DATE", "YEAR")
    result["genre"] = first("GENRE")
    result["composer"] = first("COMPOSER")

    track_num = first("TRACKNUMBER")
    track_total = first("TRACKTOTAL", "TOTALTRACKS")
    if track_num and "/" not in track_num and track_total:
        result["track_number"] = f"{track_num}/{track_total}"
    else:
        result["track_number"] = track_num

    disc_num = first("DISCNUMBER")
    disc_total = first("DISCTOTAL", "TOTALDISCS")
    if disc_num and "/" not in disc_num and disc_total:
        result["disc_number"] = f"{disc_num}/{disc_total}"
    else:
        result["disc_number"] = disc_num

    return result


def _extract_mp4_tags(audio: MP4) -> dict[str, str | None]:
    tags = audio.tags
    result: dict[str, str | None] = {field: None for field in EDITABLE_FIELDS}
    if not tags:
        return result

    for field, atom in _MP4_TEXT_ATOMS.items():
        values = tags.get(atom)
        if values:
            result[field] = _clean_text(values[0])

    trkn = tags.get("trkn")
    if trkn:
        result["track_number"] = _format_int_pair(trkn[0])

    disk = tags.get("disk")
    if disk:
        result["disc_number"] = _format_int_pair(disk[0])

    return result


def _read_artwork_from_audio(audio: Any) -> tuple[bytes, str] | None:
    if isinstance(audio, MP3):
        if not audio.tags:
            return None
        apics = audio.tags.getall("APIC")
        if not apics:
            return None
        chosen = next((a for a in apics if a.type == 3), apics[0])
        mime = chosen.mime or _detect_image_mime(chosen.data)
        return bytes(chosen.data), mime

    if isinstance(audio, FLAC):
        if not audio.pictures:
            return None
        chosen = next((p for p in audio.pictures if p.type == 3), audio.pictures[0])
        mime = chosen.mime or _detect_image_mime(chosen.data)
        return bytes(chosen.data), mime

    if isinstance(audio, (OggVorbis, OggOpus)):
        if not audio.tags:
            return None
        blocks = audio.tags.get("METADATA_BLOCK_PICTURE") or audio.tags.get(
            "metadata_block_picture"
        )
        if not blocks:
            return None
        pictures: list[Picture] = []
        for raw_b64 in blocks:
            try:
                pic = Picture(base64.b64decode(raw_b64))
                pictures.append(pic)
            except Exception:
                continue
        if not pictures:
            return None
        chosen = next((p for p in pictures if p.type == 3), pictures[0])
        mime = chosen.mime or _detect_image_mime(chosen.data)
        return bytes(chosen.data), mime

    if isinstance(audio, MP4):
        if not audio.tags:
            return None
        covers = audio.tags.get("covr")
        if not covers:
            return None
        cover = covers[0]
        raw_bytes = bytes(cover)
        if getattr(cover, "imageformat", None) == MP4Cover.FORMAT_PNG:
            mime = "image/png"
        elif getattr(cover, "imageformat", None) == MP4Cover.FORMAT_JPEG:
            mime = "image/jpeg"
        else:
            mime = _detect_image_mime(raw_bytes)
        return raw_bytes, mime

    return None


def read_track_metadata(music_dir: Path, rel_path: str) -> TrackMetadata:
    """Read technical info and standard metadata tags from an audio file on disk."""
    file_path, normalized_rel = resolve_track_path(music_dir, rel_path)
    stat = file_path.stat()
    audio = _open_audio(file_path)

    if isinstance(audio, MP3):
        tags = _extract_id3_tags(audio)
    elif isinstance(audio, (FLAC, OggVorbis, OggOpus)):
        tags = _extract_vorbis_tags(audio)
    elif isinstance(audio, MP4):
        tags = _extract_mp4_tags(audio)
    else:
        tags = {field: None for field in EDITABLE_FIELDS}

    artwork = _read_artwork_from_audio(audio)
    info = getattr(audio, "info", None)
    duration = float(getattr(info, "length", 0.0) or 0.0)
    bitrate_raw = getattr(info, "bitrate", None)
    bitrate = int(bitrate_raw) if bitrate_raw else None
    sample_rate_raw = getattr(info, "sample_rate", None)
    sample_rate = int(sample_rate_raw) if sample_rate_raw else None

    return TrackMetadata(
        path=normalized_rel,
        filename=file_path.name,
        format=file_path.suffix.lstrip(".").upper(),
        duration=round(duration, 2),
        bitrate=bitrate,
        sample_rate=sample_rate,
        file_size=stat.st_size,
        mtime=stat.st_mtime,
        has_artwork=artwork is not None,
        artwork_mime=artwork[1] if artwork else None,
        **tags,
    )


def write_track_metadata(
    music_dir: Path,
    rel_path: str,
    updates: dict[str, str | None],
) -> tuple[TrackMetadata, TrackMetadata]:
    """Apply tag updates directly to the audio file on disk.

    Returns `(before, after)` TrackMetadata snapshots for audit logging and cache updates.
    Only keys present in `updates` are modified.
    """
    file_path, normalized_rel = resolve_track_path(music_dir, rel_path)
    before = read_track_metadata(music_dir, normalized_rel)
    audio = _open_audio(file_path)

    if isinstance(audio, MP3):
        _apply_id3_updates(audio, updates)
    elif isinstance(audio, (FLAC, OggVorbis, OggOpus)):
        _apply_vorbis_updates(audio, updates)
    elif isinstance(audio, MP4):
        _apply_mp4_updates(audio, updates)
    else:
        raise InvalidTrackPathError(f"Unsupported audio type: {file_path.suffix}")

    audio.save()
    after = read_track_metadata(music_dir, normalized_rel)
    return before, after


def _apply_id3_updates(audio: MP3, updates: dict[str, str | None]) -> None:
    if audio.tags is None:
        try:
            audio.add_tags()
        except Exception:
            audio.tags = ID3()

    tags: ID3 = audio.tags
    for field, raw_val in updates.items():
        if field not in _ID3_TEXT_FRAMES:
            continue
        frame_id, frame_cls = _ID3_TEXT_FRAMES[field]
        cleaned = _clean_text(raw_val)
        tags.delall(frame_id)
        if field == "year":
            tags.delall("TYER")
        if cleaned is not None:
            tags.add(frame_cls(encoding=3, text=[cleaned]))


def _del_vorbis_keys(tags: Any, *keys: str) -> None:
    """Safely remove Vorbis comment keys (VCommentDict inherits from list, not dict)."""
    for key in keys:
        if key in tags:
            del tags[key]


def _apply_vorbis_updates(
    audio: FLAC | OggVorbis | OggOpus, updates: dict[str, str | None]
) -> None:
    if audio.tags is None:
        audio.add_tags()

    tags = audio.tags
    for field, raw_val in updates.items():
        if field not in _VORBIS_KEYS:
            continue
        key = _VORBIS_KEYS[field]
        cleaned = _clean_text(raw_val)

        if field == "album_artist":
            _del_vorbis_keys(tags, "ALBUM ARTIST", "album artist")
        elif field == "year":
            _del_vorbis_keys(tags, "YEAR", "year")
        elif field == "track_number":
            _del_vorbis_keys(tags, "TRACKTOTAL", "TOTALTRACKS")
            if cleaned and "/" in cleaned:
                num_part, total_part = [p.strip() for p in cleaned.split("/", 1)]
                if num_part:
                    tags["TRACKNUMBER"] = [num_part]
                else:
                    _del_vorbis_keys(tags, "TRACKNUMBER")
                if total_part:
                    tags["TRACKTOTAL"] = [total_part]
                continue
        elif field == "disc_number":
            _del_vorbis_keys(tags, "DISCTOTAL", "TOTALDISCS")
            if cleaned and "/" in cleaned:
                num_part, total_part = [p.strip() for p in cleaned.split("/", 1)]
                if num_part:
                    tags["DISCNUMBER"] = [num_part]
                else:
                    _del_vorbis_keys(tags, "DISCNUMBER")
                if total_part:
                    tags["DISCTOTAL"] = [total_part]
                continue

        if cleaned is None:
            _del_vorbis_keys(tags, key, key.lower())
        else:
            tags[key] = [cleaned]


def _apply_mp4_updates(audio: MP4, updates: dict[str, str | None]) -> None:
    if audio.tags is None:
        audio.add_tags()

    tags = audio.tags
    for field, raw_val in updates.items():
        cleaned = _clean_text(raw_val)
        if field in _MP4_TEXT_ATOMS:
            atom = _MP4_TEXT_ATOMS[field]
            if cleaned is None:
                tags.pop(atom, None)
            else:
                tags[atom] = [cleaned]
        elif field == "track_number":
            if cleaned is None:
                tags.pop("trkn", None)
            else:
                pair = _parse_int_pair(cleaned)
                if pair is None:
                    raise TagServiceError(
                        "MP4 track_number must be an integer or 'track/total' (e.g. '3' or '3/12')."
                    )
                tags["trkn"] = [pair]
        elif field == "disc_number":
            if cleaned is None:
                tags.pop("disk", None)
            else:
                pair = _parse_int_pair(cleaned)
                if pair is None:
                    raise TagServiceError(
                        "MP4 disc_number must be an integer or 'disc/total' (e.g. '1' or '1/2')."
                    )
                tags["disk"] = [pair]


def read_track_artwork(music_dir: Path, rel_path: str) -> tuple[bytes, str] | None:
    """Return `(image_bytes, mime_type)` for a track's embedded front cover art."""
    file_path, _ = resolve_track_path(music_dir, rel_path)
    audio = _open_audio(file_path)
    return _read_artwork_from_audio(audio)


def write_track_artwork(
    music_dir: Path,
    rel_path: str,
    image_data: bytes,
    mime_type: str | None = None,
) -> TrackMetadata:
    """Embed or replace the front cover image inside an audio file."""
    file_path, normalized_rel = resolve_track_path(music_dir, rel_path)
    mime = mime_type or _detect_image_mime(image_data)
    audio = _open_audio(file_path)

    if isinstance(audio, MP3):
        if audio.tags is None:
            try:
                audio.add_tags()
            except ID3NoHeaderError:
                audio.tags = ID3()
        audio.tags.delall("APIC")
        audio.tags.add(
            APIC(encoding=3, mime=mime, type=3, desc="Cover", data=image_data)
        )
    elif isinstance(audio, FLAC):
        pic = Picture()
        pic.type = 3
        pic.mime = mime
        pic.desc = "Cover"
        pic.data = image_data
        audio.clear_pictures()
        audio.add_picture(pic)
    elif isinstance(audio, (OggVorbis, OggOpus)):
        if audio.tags is None:
            audio.add_tags()
        pic = Picture()
        pic.type = 3
        pic.mime = mime
        pic.desc = "Cover"
        pic.data = image_data
        encoded = base64.b64encode(pic.write()).decode("ascii")
        audio.tags["METADATA_BLOCK_PICTURE"] = [encoded]
    elif isinstance(audio, MP4):
        if audio.tags is None:
            audio.add_tags()
        if mime == "image/png":
            fmt = MP4Cover.FORMAT_PNG
        elif mime in {"image/jpeg", "image/jpg"}:
            fmt = MP4Cover.FORMAT_JPEG
        else:
            raise TagServiceError(
                "MP4/M4A files only support JPEG or PNG embedded cover artwork."
            )
        audio.tags["covr"] = [MP4Cover(image_data, imageformat=fmt)]
    else:
        raise InvalidTrackPathError(f"Unsupported format for artwork: {file_path.suffix}")

    audio.save()
    return read_track_metadata(music_dir, normalized_rel)


def delete_track_artwork(music_dir: Path, rel_path: str) -> TrackMetadata:
    """Remove embedded cover art from an audio file."""
    file_path, normalized_rel = resolve_track_path(music_dir, rel_path)
    audio = _open_audio(file_path)

    if isinstance(audio, MP3):
        if audio.tags:
            audio.tags.delall("APIC")
    elif isinstance(audio, FLAC):
        audio.clear_pictures()
    elif isinstance(audio, (OggVorbis, OggOpus)):
        if audio.tags:
            _del_vorbis_keys(
                audio.tags, "METADATA_BLOCK_PICTURE", "metadata_block_picture"
            )
    elif isinstance(audio, MP4):
        if audio.tags:
            audio.tags.pop("covr", None)

    audio.save()
    return read_track_metadata(music_dir, normalized_rel)
