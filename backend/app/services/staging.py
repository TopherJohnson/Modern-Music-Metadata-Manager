"""Staging / Inbox preview, single-track drop-in detection, cross-mount safe import, and undo (Issue #8)."""

from __future__ import annotations

import errno
import logging
import os
import shutil
import uuid
from collections import Counter, defaultdict
from pathlib import Path

from app.config import STAGING_LIBRARY_ID, LibraryConfig
from app.database import Database
from app.models import (
    AuditEntry,
    BulkUpdateError,
    OrganizeMoveResult,
    OrganizeSettings,
    StagingImportPlanItem,
    StagingImportPreviewResponse,
    TrackMetadata,
)
from app.services.musicbrainz import _normalize_title
from app.services.organizer import (
    _TRACK_SIDECAR_EXTS,
    _build_target_filename,
    _is_album_sidecar,
    _is_missing_for_template,
    _prune_empty_parents,
    compute_target_rel_path,
)
from app.services.tags import read_track_metadata, resolve_track_path

logger = logging.getLogger(__name__)


def _move_file_cross_mount(src: Path, dest: Path) -> None:
    """Move a file safely across same-mount or cross-mount Docker volumes without corruption."""
    if src == dest:
        return
    if dest.exists():
        raise FileExistsError(f"Destination file already exists: {dest.name}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.rename(src, dest)
        return
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise

    # Cross-device move: copy -> verify byte size -> atomic replace -> unlink source
    tmp_dest = dest.parent / f".m4tmp-{uuid.uuid4().hex[:8]}-{dest.name}"
    try:
        src_size = src.stat().st_size
        shutil.copy2(src, tmp_dest)
        if tmp_dest.stat().st_size != src_size:
            raise OSError(f"Size mismatch copying {src.name} across filesystems.")
        os.replace(tmp_dest, dest)
    except Exception:
        try:
            if tmp_dest.exists():
                tmp_dest.unlink()
        except OSError:
            pass
        raise

    src.unlink()


def _album_match_key(artist: str | None, album: str | None) -> tuple[str, str] | None:
    album_clean = (album or "").strip()
    if not album_clean or album_clean == "Unknown Album":
        return None
    norm_album = _normalize_title(album_clean)
    norm_artist = _normalize_title(artist or "")
    if not norm_album:
        return None
    return norm_artist, norm_album


def _build_existing_album_dir_map(
    target_tracks: list[TrackMetadata],
) -> dict[tuple[str, str], tuple[str, str]]:
    """Map normalized `(artist, album)` -> `(existing_rel_dir, canonical_album_title)` in target library."""
    dir_counts: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    title_counts: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)

    for track in target_tracks:
        artist_val = track.album_artist or track.artist
        key = _album_match_key(artist_val, track.album)
        if key is None:
            continue
        rel_dir = Path(track.path).parent.as_posix()
        if rel_dir in {"", "."}:
            continue
        dir_counts[key][rel_dir] += 1
        title_counts[key][(track.album or "").strip()] += 1

    result: dict[tuple[str, str], tuple[str, str]] = {}
    for key, counts in dir_counts.items():
        best_dir = counts.most_common(1)[0][0]
        best_title = title_counts[key].most_common(1)[0][0]
        result[key] = (best_dir, best_title)
    return result


def _plan_staging_sidecars(
    staging_root: Path,
    target_root: Path,
    import_items: list[StagingImportPlanItem],
    selected_all_in_dir: dict[str, bool],
) -> tuple[list[OrganizeMoveResult], dict[str, list[OrganizeMoveResult]]]:
    """Plan companion track sidecars (.lrc/.txt) and album sidecars (cover.*, .cue, .log) for staging import."""
    sidecars: list[OrganizeMoveResult] = []
    by_track: dict[str, list[OrganizeMoveResult]] = defaultdict(list)
    seen_sources: set[str] = set()
    claimed_targets: set[str] = set()

    # 1. Per-track sidecars matching audio stem
    for item in import_items:
        src_audio = (staging_root / item.source_path).resolve()
        dst_audio = (target_root / item.target_path).resolve()
        src_dir = src_audio.parent
        if not src_dir.is_dir():
            continue

        for ext in _TRACK_SIDECAR_EXTS:
            candidate = src_dir / f"{src_audio.stem}{ext}"
            if not candidate.is_file():
                continue
            sc_src_rel = candidate.relative_to(staging_root).as_posix()
            if sc_src_rel in seen_sources:
                continue
            sc_dst_abs = dst_audio.parent / f"{dst_audio.stem}{ext}"
            sc_dst_rel = sc_dst_abs.relative_to(target_root).as_posix()
            if sc_dst_abs.exists() or sc_dst_rel.casefold() in claimed_targets:
                continue
            seen_sources.add(sc_src_rel)
            claimed_targets.add(sc_dst_rel.casefold())
            mv = OrganizeMoveResult(source_path=sc_src_rel, target_path=sc_dst_rel)
            sidecars.append(mv)
            by_track[item.source_path].append(mv)

    # 2. Album-level sidecars when all staged tracks in that folder are moving to the same destination folder
    items_by_src_dir: dict[str, list[StagingImportPlanItem]] = defaultdict(list)
    for item in import_items:
        items_by_src_dir[Path(item.source_path).parent.as_posix()].append(item)

    for src_dir_rel, dir_items in items_by_src_dir.items():
        if src_dir_rel in {"", "."} or not selected_all_in_dir.get(src_dir_rel, False):
            continue
        dest_dirs = {Path(i.target_path).parent.as_posix() for i in dir_items}
        if len(dest_dirs) != 1:
            continue
        dest_dir_rel = next(iter(dest_dirs))
        src_dir_abs = (staging_root / src_dir_rel).resolve()
        if not src_dir_abs.is_dir():
            continue

        owner_track = dir_items[0].source_path
        for entry in sorted(src_dir_abs.iterdir()):
            if not entry.is_file() or not _is_album_sidecar(entry):
                continue
            sc_src_rel = entry.relative_to(staging_root).as_posix()
            if sc_src_rel in seen_sources:
                continue
            sc_dst_abs = (target_root / dest_dir_rel / entry.name).resolve()
            sc_dst_rel = sc_dst_abs.relative_to(target_root).as_posix()
            if sc_dst_abs.exists() or sc_dst_rel.casefold() in claimed_targets:
                continue
            seen_sources.add(sc_src_rel)
            claimed_targets.add(sc_dst_rel.casefold())
            mv = OrganizeMoveResult(source_path=sc_src_rel, target_path=sc_dst_rel)
            sidecars.append(mv)
            by_track[owner_track].append(mv)

    return sidecars, by_track


def build_staging_import_preview(
    staging_dir: Path,
    staging_tracks: list[TrackMetadata],
    target_lib: LibraryConfig,
    target_tracks: list[TrackMetadata],
    target_org_settings: OrganizeSettings,
    *,
    paths: list[str] | None = None,
) -> tuple[StagingImportPreviewResponse, dict[str, list[OrganizeMoveResult]]]:
    """Compute a dry-run preview of where staged tracks will land in `target_lib`."""
    staging_root = staging_dir.resolve()
    target_root = target_lib.path.resolve()

    # Always organize imported files using target library's template (default artist_album)
    effective_settings = target_org_settings.model_copy(update={"enabled": True})

    if paths is not None:
        wanted = set(paths)
        selected_tracks = [t for t in staging_tracks if t.path in wanted]
    else:
        selected_tracks = list(staging_tracks)

    # Track whether all staged files in each folder are being imported together (for album sidecars)
    total_in_dir = Counter(Path(t.path).parent.as_posix() for t in staging_tracks)
    selected_in_dir = Counter(Path(t.path).parent.as_posix() for t in selected_tracks)
    selected_all_in_dir = {
        d: selected_in_dir[d] >= total_in_dir[d] for d in selected_in_dir
    }

    existing_album_dirs = _build_existing_album_dir_map(target_tracks)

    items: list[StagingImportPlanItem] = []
    target_counts: Counter[str] = Counter()

    for track in sorted(selected_tracks, key=lambda t: t.path.casefold()):
        artist_label = (track.album_artist or track.artist or "Unknown Artist").strip()
        album_label = (track.album or "Unknown Album").strip()

        if effective_settings.skip_missing_metadata and _is_missing_for_template(
            track, effective_settings
        ):
            items.append(
                StagingImportPlanItem(
                    source_path=track.path,
                    target_path=compute_target_rel_path(track, effective_settings),
                    album=album_label,
                    artist=artist_label,
                    status="skipped",
                    reason="Missing required Artist or Album metadata — tag or identify before importing.",
                )
            )
            continue

        # Detect single-track / partial-album drop-in into an existing target library album folder
        drop_in = False
        existing_album_title: str | None = None
        match_key = _album_match_key(track.album_artist or track.artist, track.album)
        if match_key and match_key in existing_album_dirs:
            existing_dir, canonical_title = existing_album_dirs[match_key]
            filename = _build_target_filename(track, effective_settings.rename_files)
            target_rel = f"{existing_dir}/{filename}"
            drop_in = True
            existing_album_title = canonical_title
        else:
            target_rel = compute_target_rel_path(track, effective_settings)

        target_counts[target_rel.casefold()] += 1
        items.append(
            StagingImportPlanItem(
                source_path=track.path,
                target_path=target_rel,
                album=album_label,
                artist=artist_label,
                status="import",
                drop_in=drop_in,
                existing_album_title=existing_album_title,
            )
        )

    # Validate destination collisions (existing file in target library or duplicate staged targets)
    for item in items:
        if item.status != "import":
            continue
        if target_counts[item.target_path.casefold()] > 1:
            item.status = "conflict"
            item.reason = "Multiple staged files resolve to the same destination filename."
            continue
        dest_abs = (target_root / item.target_path).resolve()
        if not dest_abs.is_relative_to(target_root):
            item.status = "conflict"
            item.reason = "Computed destination escapes the target library directory."
            continue
        if dest_abs.exists():
            item.status = "conflict"
            item.reason = "A file already exists at this destination in the target library."

    ready_items = [i for i in items if i.status == "import"]
    sidecars: list[OrganizeMoveResult] = []
    sidecars_by_track: dict[str, list[OrganizeMoveResult]] = {}
    if effective_settings.move_sidecars and ready_items:
        sidecars, sidecars_by_track = _plan_staging_sidecars(
            staging_root, target_root, ready_items, selected_all_in_dir
        )

    preview = StagingImportPreviewResponse(
        target_library_id=target_lib.id,
        target_library_name=target_lib.name,
        target_library_path=str(target_lib.path),
        template=effective_settings.template,
        rename_files=effective_settings.rename_files,
        total_tracks=len(items),
        import_count=len(ready_items),
        drop_in_count=sum(1 for i in ready_items if i.drop_in),
        skipped_count=sum(1 for i in items if i.status == "skipped"),
        conflict_count=sum(1 for i in items if i.status == "conflict"),
        sidecar_moves_count=len(sidecars),
        items=items,
        sidecars=sidecars,
    )
    return preview, sidecars_by_track


def apply_staging_import(
    staging_dir: Path,
    staging_tracks: list[TrackMetadata],
    target_lib: LibraryConfig,
    target_tracks: list[TrackMetadata],
    target_org_settings: OrganizeSettings,
    db: Database,
    *,
    paths: list[str] | None = None,
) -> tuple[
    str | None,
    list[OrganizeMoveResult],
    list[OrganizeMoveResult],
    int,
    list[BulkUpdateError],
    int,
]:
    """Execute cross-mount safe move of staged tracks + sidecars into `target_lib` with batch undo support."""
    staging_root = staging_dir.resolve()
    target_root = target_lib.path.resolve()

    plan, sidecars_by_track = build_staging_import_preview(
        staging_dir,
        staging_tracks,
        target_lib,
        target_tracks,
        target_org_settings,
        paths=paths,
    )

    ready_count = plan.import_count
    batch_id = uuid.uuid4().hex[:12] if ready_count > 1 else None

    imported: list[OrganizeMoveResult] = []
    moved_sidecars: list[OrganizeMoveResult] = []
    errors: list[BulkUpdateError] = []
    removed_staging_paths: list[str] = []
    upserted_target_tracks: list[TrackMetadata] = []
    candidate_empty_dirs: set[Path] = set()
    skipped = plan.skipped_count

    for item in plan.items:
        if item.status == "conflict":
            errors.append(
                BulkUpdateError(
                    path=item.source_path,
                    error=item.reason or "Destination conflict.",
                )
            )
            continue
        if item.status != "import":
            continue

        try:
            src_abs, src_rel = resolve_track_path(staging_root, item.source_path)
            dest_abs = (target_root / item.target_path).resolve()
            if not dest_abs.is_relative_to(target_root):
                raise ValueError("Target path escapes target library directory.")

            old_parent = src_abs.parent
            _move_file_cross_mount(src_abs, dest_abs)
            new_rel = dest_abs.relative_to(target_root).as_posix()
            refreshed = read_track_metadata(target_root, new_rel)

            # Move companion sidecars
            track_sidecars_moved: list[dict[str, str]] = []
            for sc in sidecars_by_track.get(item.source_path, []):
                sc_src_abs = (staging_root / sc.source_path).resolve()
                sc_dst_abs = (target_root / sc.target_path).resolve()
                if (
                    sc_src_abs.is_relative_to(staging_root)
                    and sc_dst_abs.is_relative_to(target_root)
                    and sc_src_abs.is_file()
                ):
                    try:
                        _move_file_cross_mount(sc_src_abs, sc_dst_abs)
                        moved_sidecars.append(sc)
                        track_sidecars_moved.append(
                            {"source": sc.source_path, "target": sc.target_path}
                        )
                    except Exception as sc_exc:
                        logger.warning(
                            "Could not move staged sidecar %s -> %s: %s",
                            sc.source_path,
                            sc.target_path,
                            sc_exc,
                        )

            removed_staging_paths.append(src_rel)
            upserted_target_tracks.append(refreshed)
            imported.append(OrganizeMoveResult(source_path=src_rel, target_path=new_rel))

            after_audit: dict[str, object] = {"path": new_rel}
            if track_sidecars_moved:
                after_audit["sidecars"] = track_sidecars_moved

            db.record_audit(
                path=new_rel,
                action="import_from_staging",
                before_tags={"path": src_rel, "source_library": STAGING_LIBRARY_ID},
                after_tags=after_audit,
                library_id=target_lib.id,
                batch_id=batch_id,
            )

            if old_parent != staging_root:
                candidate_empty_dirs.add(old_parent)
        except Exception as exc:
            logger.warning(
                "Failed to import %s -> %s: %s", item.source_path, item.target_path, exc
            )
            errors.append(BulkUpdateError(path=item.source_path, error=str(exc)))

    if removed_staging_paths:
        db.remove_paths(removed_staging_paths, library_id=STAGING_LIBRARY_ID)
    if upserted_target_tracks:
        db.upsert_tracks(upserted_target_tracks, library_id=target_lib.id)

    removed_empty_dirs = 0
    if candidate_empty_dirs:
        for old_dir in sorted(
            candidate_empty_dirs, key=lambda p: len(p.parts), reverse=True
        ):
            removed_empty_dirs += _prune_empty_parents(old_dir, staging_root)

    return batch_id, imported, moved_sidecars, skipped, errors, removed_empty_dirs


def undo_staging_import(
    target_lib: LibraryConfig,
    staging_dir: Path,
    db: Database,
    entry: AuditEntry,
    *,
    batch_id: str | None = None,
) -> tuple[TrackMetadata, int]:
    """Revert an `import_from_staging` audit entry by moving the audio file & sidecars back to Staging."""
    target_root = target_lib.path.resolve()
    staging_root = staging_dir.resolve()

    staging_rel = entry.before_tags.get("path")
    target_rel = entry.after_tags.get("path")
    if not isinstance(staging_rel, str) or not isinstance(target_rel, str):
        raise ValueError("Import history entry is missing source or destination path.")

    src_abs, src_rel = resolve_track_path(target_root, target_rel)
    dest_abs = (staging_root / staging_rel).resolve()
    if not dest_abs.is_relative_to(staging_root):
        raise ValueError("Original staging path escapes staging directory.")

    old_parent = src_abs.parent
    _move_file_cross_mount(src_abs, dest_abs)
    restored_rel = dest_abs.relative_to(staging_root).as_posix()

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
            sc_src_abs = (target_root / sc_curr).resolve()
            sc_dst_abs = (staging_root / sc_orig).resolve()
            if (
                sc_src_abs.is_relative_to(target_root)
                and sc_dst_abs.is_relative_to(staging_root)
                and sc_src_abs.is_file()
            ):
                try:
                    _move_file_cross_mount(sc_src_abs, sc_dst_abs)
                    restored_sidecars += 1
                except Exception as exc:
                    logger.warning("Could not restore sidecar %s to staging: %s", sc_curr, exc)

    refreshed = read_track_metadata(staging_root, restored_rel)
    db.remove_paths([src_rel], library_id=target_lib.id)
    db.upsert_tracks([refreshed], library_id=STAGING_LIBRARY_ID)
    db.mark_audit_undone(entry.id)
    db.record_audit(
        path=restored_rel,
        action="undo_import",
        before_tags={"path": src_rel},
        after_tags={"path": restored_rel},
        library_id=target_lib.id,
        batch_id=batch_id,
    )

    if old_parent != target_root:
        _prune_empty_parents(old_parent, target_root)

    return refreshed, restored_sidecars
