"""Safe library folder, filename, and sidecar organizer with dry-run preview, collision checks, and undo."""

from __future__ import annotations

import logging
import re
import shutil
import uuid
from collections import Counter, defaultdict
from pathlib import Path

from app.config import SUPPORTED_EXTENSIONS
from app.database import Database
from app.models import (
    AuditEntry,
    BulkUpdateError,
    MovePlanItem,
    OrganizeMoveResult,
    OrganizePreviewResponse,
    OrganizeSettings,
    TrackMetadata,
)
from app.services.tags import read_track_metadata, resolve_track_path

logger = logging.getLogger(__name__)

VALID_TEMPLATES: frozenset[str] = frozenset(
    {"artist_album", "artist_year_album", "album_only", "album_with_artist"}
)

_TRACK_SIDECAR_EXTS: frozenset[str] = frozenset({".lrc", ".txt"})
_ALBUM_ART_STEMS: frozenset[str] = frozenset(
    {"cover", "folder", "front", "back", "album", "artwork", "disc", "cd"}
)
_ALBUM_ART_EXTS: frozenset[str] = frozenset({".jpg", ".jpeg", ".png", ".webp", ".gif"})
_ALBUM_MISC_EXTS: frozenset[str] = frozenset({".cue", ".log"})
_ALBUM_EXACT_NAMES: frozenset[str] = frozenset({"booklet.pdf", "album.nfo"})

_ILLEGAL_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_MULTI_SPACE_RE = re.compile(r"\s+")


def sanitize_segment(value: str, fallback: str = "Unknown") -> str:
    """Convert a metadata tag into a safe cross-platform path component (Linux/macOS/SMB/Windows)."""
    cleaned = _ILLEGAL_CHARS_RE.sub("-", value)
    cleaned = _MULTI_SPACE_RE.sub(" ", cleaned).strip(" .")
    if len(cleaned) > 120:
        cleaned = cleaned[:120].rstrip(" .")
    if not cleaned or cleaned in {".", ".."}:
        return fallback
    return cleaned


def _extract_year(track: TrackMetadata) -> str | None:
    for raw in (track.year, track.release_date):
        if raw:
            match = re.match(r"^\s*(\d{4})", raw)
            if match:
                return match.group(1)
    return None


def _parse_num_and_total(raw: str | None) -> tuple[int | None, int | None]:
    if not raw:
        return None, None
    match = re.match(r"^\s*(\d+)(?:\s*/\s*(\d+))?", raw)
    if not match:
        return None, None
    num = int(match.group(1))
    total = int(match.group(2)) if match.group(2) else None
    return num, total


def _build_target_filename(track: TrackMetadata, rename_files: bool) -> str:
    if not rename_files:
        return track.filename

    ext = Path(track.filename).suffix.lower() or f".{track.format.lower()}"
    title_raw = (track.title or "").strip() or Path(track.filename).stem
    title_part = sanitize_segment(title_raw, fallback="Untitled")

    track_num, _ = _parse_num_and_total(track.track_number)
    disc_num, disc_total = _parse_num_and_total(track.disc_number)

    if track_num is not None:
        track_str = f"{track_num:02d}"
        if disc_num is not None and (disc_num > 1 or (disc_total is not None and disc_total > 1)):
            prefix = f"{disc_num}-{track_str}"
        else:
            prefix = track_str
        return f"{prefix} - {title_part}{ext}"

    return f"{title_part}{ext}"


def compute_target_rel_path(track: TrackMetadata, settings: OrganizeSettings) -> str:
    """Compute the expected POSIX relative path inside `/music` for a track under `settings`."""
    template = settings.template if settings.template in VALID_TEMPLATES else "artist_album"

    is_compilation = track.compilation == "1"
    if is_compilation and not (track.album_artist or "").strip():
        artist_raw = settings.compilation_folder.strip() or "Various Artists"
    else:
        artist_raw = (track.album_artist or track.artist or "Unknown Artist").strip()

    album_raw = (track.album or "Unknown Album").strip()
    artist_dir = sanitize_segment(artist_raw, fallback="Unknown Artist")
    album_dir = sanitize_segment(album_raw, fallback="Unknown Album")
    year = _extract_year(track)

    if template == "artist_year_album":
        album_folder = f"{year} - {album_dir}" if year else album_dir
        rel_dir = f"{artist_dir}/{album_folder}"
    elif template == "album_only":
        rel_dir = album_dir
    elif template == "album_with_artist":
        rel_dir = f"{album_dir} - {artist_dir}"
    else:
        rel_dir = f"{artist_dir}/{album_dir}"

    filename = _build_target_filename(track, settings.rename_files)
    return f"{rel_dir}/{filename}"


def _is_missing_for_template(track: TrackMetadata, settings: OrganizeSettings) -> bool:
    missing_album = not (track.album or "").strip()
    missing_artist = (
        not (track.album_artist or track.artist or "").strip()
        and track.compilation != "1"
    )
    missing_title = settings.rename_files and not (track.title or "").strip()

    if settings.template == "album_only":
        return missing_album or missing_title
    return missing_album or missing_artist or missing_title


def track_needs_reorganize(track: TrackMetadata, settings: OrganizeSettings) -> bool:
    """Return True if this track is eligible for reorganization and sits outside its target path."""
    if not settings.enabled:
        return False
    if settings.skip_missing_metadata and _is_missing_for_template(track, settings):
        return False
    return track.path != compute_target_rel_path(track, settings)


def _is_album_sidecar(path: Path) -> bool:
    name_low = path.name.lower()
    if name_low in _ALBUM_EXACT_NAMES:
        return True
    ext = path.suffix.lower()
    if ext in _ALBUM_MISC_EXTS:
        return True
    if ext in _ALBUM_ART_EXTS and path.stem.lower() in _ALBUM_ART_STEMS:
        return True
    return False


def _plan_sidecar_moves(
    root: Path,
    move_items: list[MovePlanItem],
) -> tuple[list[OrganizeMoveResult], dict[str, list[OrganizeMoveResult]]]:
    """Compute track-level (.lrc/.txt) and album-level (cover.jpg/folder.jpg/.cue/.log) sidecar moves.

    Returns `(all_sidecars, sidecars_by_owner_track_source_path)`.
    """
    sidecars: list[OrganizeMoveResult] = []
    by_track: dict[str, list[OrganizeMoveResult]] = defaultdict(list)
    planned_sources: set[str] = set()
    planned_targets: set[str] = set()

    # 1. Track-matched sidecars (e.g. `01 - Intro.lrc` moving with `01 - Intro.mp3`)
    for item in move_items:
        src_abs = (root / item.source_path).resolve()
        dst_abs = (root / item.target_path).resolve()
        src_dir = src_abs.parent
        if not src_dir.is_dir():
            continue

        src_stem_low = src_abs.stem.casefold()
        for sibling in sorted(src_dir.iterdir()):
            if not sibling.is_file():
                continue
            ext = sibling.suffix.lower()
            if ext not in _TRACK_SIDECAR_EXTS:
                continue
            if sibling.stem.casefold() != src_stem_low:
                continue

            sc_src_rel = sibling.relative_to(root).as_posix()
            sc_dst_abs = dst_abs.parent / f"{dst_abs.stem}{sibling.suffix}"
            sc_dst_rel = sc_dst_abs.relative_to(root).as_posix()

            if sc_src_rel == sc_dst_rel:
                continue
            if sc_src_rel.casefold() in planned_sources or sc_dst_rel.casefold() in planned_targets:
                continue
            is_case_only = sc_src_rel.casefold() == sc_dst_rel.casefold()
            if not is_case_only and sc_dst_abs.exists():
                continue

            planned_sources.add(sc_src_rel.casefold())
            planned_targets.add(sc_dst_rel.casefold())
            move = OrganizeMoveResult(source_path=sc_src_rel, target_path=sc_dst_rel)
            sidecars.append(move)
            by_track[item.source_path].append(move)

    # 2. Album-level sidecars (cover.jpg, folder.png, .cue, .log, etc.) when an entire folder moves together
    moves_by_src_dir: dict[Path, list[MovePlanItem]] = defaultdict(list)
    for item in move_items:
        src_dir = (root / item.source_path).resolve().parent
        moves_by_src_dir[src_dir].append(item)

    for src_dir, dir_moves in moves_by_src_dir.items():
        if not src_dir.is_dir() or src_dir == root:
            continue

        dest_dirs = {(root / m.target_path).resolve().parent for m in dir_moves}
        if len(dest_dirs) != 1:
            continue
        dst_dir = next(iter(dest_dirs))
        if dst_dir == src_dir:
            continue

        # Only move album-level sidecars if every audio file currently in src_dir is part of this move
        moving_src_names = {Path(m.source_path).name.casefold() for m in dir_moves}
        remaining_audio = any(
            f.is_file()
            and f.suffix.lower() in SUPPORTED_EXTENSIONS
            and f.name.casefold() not in moving_src_names
            for f in src_dir.iterdir()
        )
        if remaining_audio:
            continue

        owner_track = dir_moves[-1].source_path
        for sibling in sorted(src_dir.iterdir()):
            if not sibling.is_file() or not _is_album_sidecar(sibling):
                continue

            sc_src_rel = sibling.relative_to(root).as_posix()
            sc_dst_abs = dst_dir / sibling.name
            sc_dst_rel = sc_dst_abs.relative_to(root).as_posix()

            if sc_src_rel.casefold() in planned_sources or sc_dst_rel.casefold() in planned_targets:
                continue
            if sc_dst_abs.exists():
                continue

            planned_sources.add(sc_src_rel.casefold())
            planned_targets.add(sc_dst_rel.casefold())
            move = OrganizeMoveResult(source_path=sc_src_rel, target_path=sc_dst_rel)
            sidecars.append(move)
            by_track[owner_track].append(move)

    return sidecars, by_track


def build_organize_preview(
    music_dir: Path,
    tracks: list[TrackMetadata],
    settings: OrganizeSettings,
    *,
    filter_paths: list[str] | None = None,
) -> OrganizePreviewResponse:
    """Generate a dry-run reorganization plan without modifying any files on disk."""
    root = music_dir.resolve()
    allowed_set = set(filter_paths) if filter_paths else None
    scoped_tracks = (
        [t for t in tracks if t.path in allowed_set] if allowed_set is not None else tracks
    )

    raw_entries: list[tuple[TrackMetadata, str, str | None]] = []
    target_counts: Counter[str] = Counter()

    for track in scoped_tracks:
        if settings.skip_missing_metadata and _is_missing_for_template(track, settings):
            raw_entries.append((track, track.path, "missing_metadata"))
            continue

        target_rel = compute_target_rel_path(track, settings)
        raw_entries.append((track, target_rel, None))
        if target_rel != track.path:
            target_counts[target_rel.casefold()] += 1

    existing_by_lower = {t.path.casefold(): t.path for t in tracks}

    items: list[MovePlanItem] = []
    moves_count = 0
    unchanged_count = 0
    skipped_count = 0
    conflict_count = 0

    for track, target_rel, skip_reason in raw_entries:
        artist_label = (track.album_artist or track.artist or "Unknown Artist").strip()
        album_label = (track.album or "Unknown Album").strip()

        if skip_reason == "missing_metadata":
            skipped_count += 1
            items.append(
                MovePlanItem(
                    source_path=track.path,
                    target_path=track.path,
                    album=album_label,
                    artist=artist_label,
                    status="skipped",
                    reason="Missing required Artist/Album tags — identify or tag this track first.",
                )
            )
            continue

        if target_rel == track.path:
            unchanged_count += 1
            items.append(
                MovePlanItem(
                    source_path=track.path,
                    target_path=target_rel,
                    album=album_label,
                    artist=artist_label,
                    status="unchanged",
                    reason=None,
                )
            )
            continue

        target_key = target_rel.casefold()
        is_case_only_rename = track.path.casefold() == target_key
        dest_abs = (root / target_rel).resolve()

        if not dest_abs.is_relative_to(root):
            conflict_count += 1
            items.append(
                MovePlanItem(
                    source_path=track.path,
                    target_path=target_rel,
                    album=album_label,
                    artist=artist_label,
                    status="conflict",
                    reason="Target path escapes the configured music directory.",
                )
            )
            continue

        if target_counts[target_key] > 1:
            conflict_count += 1
            items.append(
                MovePlanItem(
                    source_path=track.path,
                    target_path=target_rel,
                    album=album_label,
                    artist=artist_label,
                    status="conflict",
                    reason="Multiple tracks map to the same destination filename.",
                )
            )
            continue

        if not is_case_only_rename and (
            dest_abs.exists()
            or (
                target_key in existing_by_lower
                and existing_by_lower[target_key] != track.path
            )
        ):
            conflict_count += 1
            items.append(
                MovePlanItem(
                    source_path=track.path,
                    target_path=target_rel,
                    album=album_label,
                    artist=artist_label,
                    status="conflict",
                    reason="A different file already exists at the destination path.",
                )
            )
            continue

        moves_count += 1
        items.append(
            MovePlanItem(
                source_path=track.path,
                target_path=target_rel,
                album=album_label,
                artist=artist_label,
                status="move",
                reason=None,
            )
        )

    order = {"move": 0, "conflict": 1, "skipped": 2, "unchanged": 3}
    items.sort(key=lambda i: (order.get(i.status, 9), i.target_path.casefold()))

    sidecars: list[OrganizeMoveResult] = []
    if settings.move_sidecars:
        move_items = [i for i in items if i.status == "move"]
        sidecars, _ = _plan_sidecar_moves(root, move_items)

    return OrganizePreviewResponse(
        settings=settings,
        total_tracks=len(scoped_tracks),
        moves_count=moves_count,
        unchanged_count=unchanged_count,
        skipped_count=skipped_count,
        conflict_count=conflict_count,
        sidecar_moves_count=len(sidecars),
        items=items,
        sidecars=sidecars,
    )


def _move_file_safe(src_abs: Path, dest_abs: Path) -> None:
    """Move a file safely across directories, handling case-only renames on macOS/Windows mounts."""
    is_case_only = str(src_abs).casefold() == str(dest_abs).casefold()
    if not is_case_only and dest_abs.exists():
        raise FileExistsError(f"Destination already exists: {dest_abs.name}")

    dest_abs.parent.mkdir(parents=True, exist_ok=True)
    if is_case_only:
        tmp_path = src_abs.with_name(f".m4-rename-{uuid.uuid4().hex}{src_abs.suffix}")
        shutil.move(str(src_abs), str(tmp_path))
        shutil.move(str(tmp_path), str(dest_abs))
    else:
        shutil.move(str(src_abs), str(dest_abs))


def _prune_empty_parents(start_dir: Path, music_root: Path) -> int:
    """Remove empty parent directories walking upward strictly inside `music_root`."""
    removed = 0
    current = start_dir.resolve()
    root = music_root.resolve()

    while current != root and current.is_relative_to(root):
        try:
            if not current.exists() or not current.is_dir():
                break
            if any(current.iterdir()):
                break
            current.rmdir()
            removed += 1
            current = current.parent
        except OSError:
            break

    return removed


def apply_organize_plan(
    music_dir: Path,
    db: Database,
    tracks: list[TrackMetadata],
    settings: OrganizeSettings,
    *,
    filter_paths: list[str] | None = None,
    library_id: str = "default",
) -> tuple[list[OrganizeMoveResult], list[OrganizeMoveResult], int, list[BulkUpdateError], int]:
    """Execute planned audio & sidecar moves safely on disk, updating SQLite cache and audit history."""
    root = music_dir.resolve()
    plan = build_organize_preview(
        root, tracks, settings, filter_paths=filter_paths
    )

    move_items = [i for i in plan.items if i.status == "move"]
    batch_id = uuid.uuid4().hex[:12] if len(move_items) > 1 else None

    sidecars_by_track: dict[str, list[OrganizeMoveResult]] = {}
    if settings.move_sidecars and move_items:
        _, sidecars_by_track = _plan_sidecar_moves(root, move_items)

    moved: list[OrganizeMoveResult] = []
    moved_sidecars: list[OrganizeMoveResult] = []
    errors: list[BulkUpdateError] = []
    removed_paths: list[str] = []
    upserted_tracks: list[TrackMetadata] = []
    candidate_empty_dirs: set[Path] = set()
    skipped = plan.skipped_count + plan.unchanged_count

    for item in plan.items:
        if item.status == "conflict":
            errors.append(
                BulkUpdateError(
                    path=item.source_path,
                    error=item.reason or "Destination conflict.",
                )
            )
            continue
        if item.status != "move":
            continue

        try:
            src_abs, src_rel = resolve_track_path(root, item.source_path)
            dest_abs = (root / item.target_path).resolve()
            if not dest_abs.is_relative_to(root):
                raise ValueError("Target path escapes music directory.")

            old_parent = src_abs.parent
            _move_file_safe(src_abs, dest_abs)

            new_rel = dest_abs.relative_to(root).as_posix()
            refreshed = read_track_metadata(root, new_rel)

            # Move any companion sidecar files associated with this track/folder
            track_sidecars_moved: list[dict[str, str]] = []
            for sc in sidecars_by_track.get(item.source_path, []):
                sc_src_abs = (root / sc.source_path).resolve()
                sc_dst_abs = (root / sc.target_path).resolve()
                if (
                    sc_src_abs.is_relative_to(root)
                    and sc_dst_abs.is_relative_to(root)
                    and sc_src_abs.is_file()
                ):
                    try:
                        _move_file_safe(sc_src_abs, sc_dst_abs)
                        moved_sidecars.append(sc)
                        track_sidecars_moved.append(
                            {"source": sc.source_path, "target": sc.target_path}
                        )
                    except Exception as sc_exc:
                        logger.warning(
                            "Could not move sidecar %s -> %s: %s",
                            sc.source_path,
                            sc.target_path,
                            sc_exc,
                        )

            removed_paths.append(src_rel)
            upserted_tracks.append(refreshed)
            moved.append(OrganizeMoveResult(source_path=src_rel, target_path=new_rel))

            after_audit: dict[str, object] = {"path": new_rel}
            if track_sidecars_moved:
                after_audit["sidecars"] = track_sidecars_moved

            db.record_audit(
                path=new_rel,
                action="move_track",
                before_tags={"path": src_rel},
                after_tags=after_audit,
                library_id=library_id,
                batch_id=batch_id,
            )

            if old_parent != dest_abs.parent:
                candidate_empty_dirs.add(old_parent)
        except Exception as exc:
            logger.warning("Failed to move %s -> %s: %s", item.source_path, item.target_path, exc)
            errors.append(BulkUpdateError(path=item.source_path, error=str(exc)))

    if removed_paths:
        db.remove_paths(removed_paths, library_id=library_id)
    if upserted_tracks:
        db.upsert_tracks(upserted_tracks, library_id=library_id)

    removed_empty_dirs = 0
    if settings.cleanup_empty_dirs and candidate_empty_dirs:
        for old_dir in sorted(
            candidate_empty_dirs, key=lambda p: len(p.parts), reverse=True
        ):
            removed_empty_dirs += _prune_empty_parents(old_dir, root)

    return moved, moved_sidecars, skipped, errors, removed_empty_dirs


def undo_track_move(
    music_dir: Path,
    db: Database,
    entry: AuditEntry,
    *,
    library_id: str = "default",
    batch_id: str | None = None,
) -> tuple[TrackMetadata, int]:
    """Revert a `move_track` audit entry, moving the audio file and any recorded sidecars back."""
    root = music_dir.resolve()
    original_rel = entry.before_tags.get("path")
    current_rel = entry.after_tags.get("path")
    if not isinstance(original_rel, str) or not isinstance(current_rel, str):
        raise ValueError("Move history entry is missing source or destination path.")

    src_abs, src_rel = resolve_track_path(root, current_rel)
    dest_abs = (root / original_rel).resolve()
    if not dest_abs.is_relative_to(root):
        raise ValueError("Original path escapes music directory.")

    old_parent = src_abs.parent
    _move_file_safe(src_abs, dest_abs)
    restored_rel = dest_abs.relative_to(root).as_posix()

    restored_sidecars = 0
    raw_sidecars = entry.after_tags.get("sidecars")
    if isinstance(raw_sidecars, list):
        for sc in raw_sidecars:
            if not isinstance(sc, dict):
                continue
            sc_orig = sc.get("source")
            sc_curr = sc.get("target")
            if not isinstance(sc_orig, str) or not isinstance(sc_curr, str):
                continue
            sc_src_abs = (root / sc_curr).resolve()
            sc_dst_abs = (root / sc_orig).resolve()
            if (
                sc_src_abs.is_relative_to(root)
                and sc_dst_abs.is_relative_to(root)
                and sc_src_abs.is_file()
            ):
                try:
                    _move_file_safe(sc_src_abs, sc_dst_abs)
                    restored_sidecars += 1
                except Exception as exc:
                    logger.warning("Could not restore sidecar %s: %s", sc_curr, exc)

    refreshed = read_track_metadata(root, restored_rel)
    db.remove_paths([src_rel], library_id=library_id)
    db.upsert_tracks([refreshed], library_id=library_id)
    db.mark_audit_undone(entry.id)
    db.record_audit(
        path=restored_rel,
        action="undo_move",
        before_tags={"path": src_rel},
        after_tags={"path": restored_rel},
        library_id=library_id,
        batch_id=batch_id,
    )

    if old_parent != dest_abs.parent:
        _prune_empty_parents(old_parent, root)

    return refreshed, restored_sidecars
