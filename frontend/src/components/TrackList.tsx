import { useEffect, useRef, useState } from "react";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Disc3,
  Filter,
  FolderInput,
  FolderOpen,
  FolderTree,
  GitMerge,
  Globe,
  ImagePlus,
  Images,
  Layers,
  Music,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { formatDuration, getArtworkUrl } from "../api/client";
import {
  MISSING_FIELD_OPTIONS,
  albumMatchesMissingField,
  countTracksMissingField,
  getMissingFieldOption,
  isTrackMissingField,
  type MissingFieldKey,
  type MissingScopeMode,
} from "../utils/missingFields";
import type { AlbumGroup, ArtistGroup, TrackMetadata } from "../types/music";

export type AlbumFilterMode = "all" | "mismatches" | "missing" | "structure";

interface TrackListProps {
  artists: ArtistGroup[];
  selectedAlbum: AlbumGroup | null;
  selectedTrackPath: string | null;
  isBulkEditingAlbum: boolean;
  albumFilter: AlbumFilterMode;
  missingField: MissingFieldKey | null;
  missingScope: MissingScopeMode;
  organizeEnabled: boolean;
  artworkRevision: number;
  loading: boolean;
  musicDir: string;
  onSelectAlbum: (artist: ArtistGroup, album: AlbumGroup) => void;
  onBackToAll: () => void;
  onSelectTrack: (track: TrackMetadata) => void;
  onStartBulkEdit: (album: AlbumGroup) => void;
  onIdentifyAlbum: (album: AlbumGroup) => void;
  onFindAlbumCover: (album: AlbumGroup) => void;
  onIdentifyTrack: (track: TrackMetadata) => void;
  onDeleteTrack: (track: TrackMetadata) => void;
  onMergeAlbums: (albums: AlbumGroup[]) => void;
  onIdentifyCombinedAlbums: (albums: AlbumGroup[]) => void;
  onMoveTracksToAlbum: (
    tracks: TrackMetadata[],
    sourceAlbumId: string | null
  ) => void;
  onOrganizeAlbum: (album: AlbumGroup) => void;
  onChangeAlbumFilter: (filter: AlbumFilterMode) => void;
  onChangeMissingField: (field: MissingFieldKey | null) => void;
  onChangeMissingScope: (scope: MissingScopeMode) => void;
  onRescan: () => void;
}

function AlbumCover({
  coverPath,
  alt,
  revision,
  sizeClass,
}: {
  coverPath: string | null;
  alt: string;
  revision: number;
  sizeClass: string;
}) {
  if (!coverPath) {
    return (
      <div
        className={`${sizeClass} flex items-center justify-center rounded-lg border border-border-subtle bg-surface-elevated text-ink-muted`}
      >
        <Disc3 className="h-8 w-8 opacity-40" />
      </div>
    );
  }
  return (
    <img
      src={getArtworkUrl(coverPath, revision)}
      alt={alt}
      loading="lazy"
      className={`${sizeClass} rounded-lg border border-border-subtle object-cover bg-surface-elevated`}
    />
  );
}

function hasMismatchWarning(album: AlbumGroup): boolean {
  return album.navidrome_warnings.some(
    (w) => w.severity === "split" || w.severity === "artwork"
  );
}

export function TrackList({
  artists,
  selectedAlbum,
  selectedTrackPath,
  isBulkEditingAlbum,
  albumFilter,
  missingField,
  missingScope,
  organizeEnabled,
  artworkRevision,
  loading,
  musicDir,
  onSelectAlbum,
  onBackToAll,
  onSelectTrack,
  onStartBulkEdit,
  onIdentifyAlbum,
  onFindAlbumCover,
  onIdentifyTrack,
  onDeleteTrack,
  onMergeAlbums,
  onIdentifyCombinedAlbums,
  onMoveTracksToAlbum,
  onOrganizeAlbum,
  onChangeAlbumFilter,
  onChangeMissingField,
  onChangeMissingScope,
  onRescan,
}: TrackListProps) {
  const [albumSelectMode, setAlbumSelectMode] = useState(false);
  const [checkedAlbumIds, setCheckedAlbumIds] = useState<string[]>([]);
  const [checkedTrackPaths, setCheckedTrackPaths] = useState<string[]>([]);
  const [missingMenuOpen, setMissingMenuOpen] = useState(false);
  const missingMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCheckedTrackPaths([]);
  }, [selectedAlbum?.id]);

  useEffect(() => {
    const validIds = new Set<string>();
    for (const artist of artists) {
      for (const album of artist.albums) {
        validIds.add(album.id);
      }
    }
    setCheckedAlbumIds((prev) => {
      const filtered = prev.filter((id) => validIds.has(id));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [artists]);

  useEffect(() => {
    if (!missingMenuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (
        missingMenuRef.current &&
        !missingMenuRef.current.contains(event.target as Node)
      ) {
        setMissingMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMissingMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [missingMenuOpen]);
  if (loading) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 bg-canvas p-8 text-ink-secondary">
        <RefreshCw className="h-5 w-5 animate-spin text-accent" />
        <p className="text-xs">Scanning audio metadata...</p>
      </main>
    );
  }

  const allAlbums: Array<{ artist: ArtistGroup; album: AlbumGroup }> = artists.flatMap(
    (artist) => artist.albums.map((album) => ({ artist, album }))
  );

  if (allAlbums.length === 0) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center bg-canvas p-8 text-center">
        <div className="max-w-sm rounded-xl border border-border-subtle bg-surface p-6">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-border-strong bg-surface-elevated text-accent">
            <FolderOpen className="h-5 w-5" />
          </div>
          <h2 className="text-sm font-semibold text-ink-primary">
            No audio files found
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-secondary">
            Mount your music library at{" "}
            <code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-primary">
              {musicDir}
            </code>{" "}
            or clear your search filter. Supports MP3, FLAC, M4A, OGG, and OPUS.
          </p>
          <button
            type="button"
            onClick={onRescan}
            className="m4-btn-primary mt-4"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Rescan Library
          </button>
        </div>
      </main>
    );
  }

  const activeMissingOption = getMissingFieldOption(missingField);
  const visibleAlbums = allAlbums.filter(({ album }) => {
    if (albumFilter === "missing" && !album.has_missing_metadata) return false;
    if (albumFilter === "mismatches" && !hasMismatchWarning(album)) return false;
    if (albumFilter === "structure" && !album.needs_reorganize) return false;
    if (missingField && !albumMatchesMissingField(album, missingField, missingScope)) {
      return false;
    }
    return true;
  });

  if (!selectedAlbum) {
    const missingCount = allAlbums.filter(
      ({ album }) => album.has_missing_metadata
    ).length;
    const mismatchedCount = allAlbums.filter(({ album }) =>
      hasMismatchWarning(album)
    ).length;
    const structureCount = allAlbums.filter(
      ({ album }) => album.needs_reorganize
    ).length;

    const toggleFilter = (target: Exclude<AlbumFilterMode, "all">) => {
      onChangeAlbumFilter(albumFilter === target ? "all" : target);
    };

    const primaryMissingOpts = MISSING_FIELD_OPTIONS.filter(
      (o) => o.group === "primary"
    );
    const advancedMissingOpts = MISSING_FIELD_OPTIONS.filter(
      (o) => o.group === "advanced"
    );
    const activeMissingCount = missingField
      ? allAlbums.filter(({ album }) =>
          albumMatchesMissingField(album, missingField, missingScope)
        ).length
      : 0;

    return (
      <main className="flex-1 overflow-y-auto bg-canvas p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-ink-primary">
              Library Albums
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              Select an album to inspect tracks or batch-edit tags
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Red Filter: Major Metadata Missing */}
            <button
              id="filter-missing-metadata-toggle"
              type="button"
              role="switch"
              aria-checked={albumFilter === "missing"}
              onClick={() => toggleFilter("missing")}
              className={`inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition-colors cursor-pointer ${
                albumFilter === "missing"
                  ? "border-danger bg-danger/15 text-danger"
                  : "border-border-subtle bg-surface text-ink-secondary hover:border-border-strong hover:text-ink-primary"
              }`}
              title="Show only albums or tracks missing Title, Artist, or Album tags"
            >
              <AlertOctagon
                className={`h-3.5 w-3.5 ${
                  albumFilter === "missing" || missingCount > 0
                    ? "text-danger"
                    : "text-ink-muted"
                }`}
              />
              <span>Major Metadata Missing</span>
              <span
                className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
                  albumFilter === "missing"
                    ? "bg-danger text-white font-semibold"
                    : missingCount > 0
                      ? "bg-danger/15 text-danger"
                      : "bg-surface-elevated text-ink-muted"
                }`}
              >
                {missingCount}
              </span>
            </button>

            {/* Amber Filter: Mismatches Only */}
            <button
              id="filter-mismatches-toggle"
              type="button"
              role="switch"
              aria-checked={albumFilter === "mismatches"}
              onClick={() => toggleFilter("mismatches")}
              className={`inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition-colors cursor-pointer ${
                albumFilter === "mismatches"
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-subtle bg-surface text-ink-secondary hover:border-border-strong hover:text-ink-primary"
              }`}
              title="Show only albums with Navidrome split-album tag, near-duplicate, or cover art mismatches"
            >
              <AlertTriangle
                className={`h-3.5 w-3.5 ${
                  albumFilter === "mismatches"
                    ? "text-accent"
                    : mismatchedCount > 0
                      ? "text-warn"
                      : "text-ink-muted"
                }`}
              />
              <span>Mismatches</span>
              <span
                className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
                  albumFilter === "mismatches"
                    ? "bg-accent text-[#14110c] font-semibold"
                    : mismatchedCount > 0
                      ? "bg-surface-elevated text-warn"
                      : "bg-surface-elevated text-ink-muted"
                }`}
              >
                {mismatchedCount}
              </span>
            </button>

            {/* Missing Specific Field Popover (Issue #1) */}
            <div ref={missingMenuRef} className="relative">
              <div className="inline-flex items-center">
                <button
                  id="filter-missing-field-btn"
                  type="button"
                  onClick={() => setMissingMenuOpen((o) => !o)}
                  aria-expanded={missingMenuOpen}
                  aria-haspopup="menu"
                  className={`inline-flex h-8 items-center gap-1.5 border px-2.5 text-xs font-medium transition-colors cursor-pointer ${
                    activeMissingOption
                      ? "rounded-l-lg border-accent bg-accent-soft text-accent"
                      : "rounded-lg border-border-subtle bg-surface text-ink-secondary hover:border-border-strong hover:text-ink-primary"
                  }`}
                  title="Filter albums missing a specific metadata field (e.g., Cover Art, Genre, Year)"
                >
                  <Filter className="h-3.5 w-3.5" />
                  <span>
                    {activeMissingOption
                      ? `Missing: ${activeMissingOption.label}`
                      : "Missing Field…"}
                  </span>
                  {activeMissingOption ? (
                    <span className="rounded-full bg-accent px-1.5 py-0.2 font-mono text-[10px] font-semibold text-[#14110c]">
                      {activeMissingCount}
                    </span>
                  ) : (
                    <ChevronDown className="h-3 w-3 opacity-70" />
                  )}
                </button>
                {activeMissingOption && (
                  <button
                    id="clear-missing-field-btn"
                    type="button"
                    onClick={() => onChangeMissingField(null)}
                    className="inline-flex h-8 items-center rounded-r-lg border border-l-0 border-accent bg-accent-soft px-1.5 text-accent hover:bg-accent hover:text-[#14110c] cursor-pointer"
                    title="Clear missing field filter"
                    aria-label="Clear missing field filter"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {missingMenuOpen && (
                <div
                  id="missing-field-popover"
                  role="menu"
                  className="absolute right-0 z-50 mt-1.5 w-64 rounded-xl border border-border-strong bg-surface p-2 shadow-2xl"
                >
                  {/* Scope Toggle: Any track vs Whole album */}
                  <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-canvas p-1 text-[10px]">
                    <button
                      type="button"
                      onClick={() => onChangeMissingScope("any")}
                      className={`flex-1 rounded-md py-1 font-medium transition-colors cursor-pointer ${
                        missingScope === "any"
                          ? "bg-surface-elevated text-ink-primary"
                          : "text-ink-muted hover:text-ink-secondary"
                      }`}
                    >
                      Any track missing
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeMissingScope("all")}
                      className={`flex-1 rounded-md py-1 font-medium transition-colors cursor-pointer ${
                        missingScope === "all"
                          ? "bg-surface-elevated text-ink-primary"
                          : "text-ink-muted hover:text-ink-secondary"
                      }`}
                    >
                      Whole album
                    </button>
                  </div>

                  <div className="space-y-0.5">
                    {primaryMissingOpts.map((opt) => {
                      const count = allAlbums.filter(({ album }) =>
                        albumMatchesMissingField(album, opt.key, missingScope)
                      ).length;
                      const isActive = missingField === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            onChangeMissingField(isActive ? null : opt.key);
                            setMissingMenuOpen(false);
                          }}
                          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors cursor-pointer ${
                            isActive
                              ? "bg-accent-soft font-medium text-accent"
                              : "text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary"
                          }`}
                        >
                          <span>{opt.label}</span>
                          <span
                            className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
                              isActive
                                ? "bg-accent text-[#14110c] font-semibold"
                                : count > 0
                                  ? "bg-surface-elevated text-ink-primary"
                                  : "text-ink-muted"
                            }`}
                          >
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="my-1.5 border-t border-border-subtle pt-1.5">
                    <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                      Advanced / Navidrome
                    </p>
                    <div className="space-y-0.5">
                      {advancedMissingOpts.map((opt) => {
                        const count = allAlbums.filter(({ album }) =>
                          albumMatchesMissingField(album, opt.key, missingScope)
                        ).length;
                        const isActive = missingField === opt.key;
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              onChangeMissingField(isActive ? null : opt.key);
                              setMissingMenuOpen(false);
                            }}
                            className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors cursor-pointer ${
                              isActive
                                ? "bg-accent-soft font-medium text-accent"
                                : "text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary"
                            }`}
                          >
                            <span>{opt.label}</span>
                            <span
                              className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
                                isActive
                                  ? "bg-accent text-[#14110c] font-semibold"
                                  : count > 0
                                    ? "bg-surface-elevated text-ink-primary"
                                    : "text-ink-muted"
                              }`}
                            >
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Folder Structure Drift Filter (visible when Folder Organization monitoring is enabled) */}
            {organizeEnabled && (
              <button
                id="filter-structure-toggle"
                type="button"
                role="switch"
                aria-checked={albumFilter === "structure"}
                onClick={() => toggleFilter("structure")}
                className={`inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition-colors cursor-pointer ${
                  albumFilter === "structure"
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border-subtle bg-surface text-ink-secondary hover:border-border-strong hover:text-ink-primary"
                }`}
                title="Show only albums whose files don't match your configured folder structure"
              >
                <FolderTree
                  className={`h-3.5 w-3.5 ${
                    albumFilter === "structure" || structureCount > 0
                      ? "text-accent"
                      : "text-ink-muted"
                  }`}
                />
                <span>Folder Drift</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] ${
                    albumFilter === "structure"
                      ? "bg-accent text-[#14110c] font-semibold"
                      : structureCount > 0
                        ? "bg-surface-elevated text-accent"
                        : "bg-surface-elevated text-ink-muted"
                  }`}
                >
                  {structureCount}
                </span>
              </button>
            )}

            {/* Multi-select Albums Toggle */}
            <button
              id="toggle-select-albums-btn"
              type="button"
              onClick={() => {
                if (albumSelectMode || checkedAlbumIds.length > 0) {
                  setAlbumSelectMode(false);
                  setCheckedAlbumIds([]);
                } else {
                  setAlbumSelectMode(true);
                }
              }}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors cursor-pointer ${
                albumSelectMode || checkedAlbumIds.length > 0
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-subtle bg-surface text-ink-secondary hover:border-border-strong hover:text-ink-primary"
              }`}
              title="Select multiple albums to merge or identify together"
            >
              <CheckSquare className="h-3.5 w-3.5" />
              <span>
                {albumSelectMode || checkedAlbumIds.length > 0
                  ? "Done Selecting"
                  : "Select"}
              </span>
            </button>

            <span className="ml-1 font-mono text-xs text-ink-muted">
              {visibleAlbums.length}{" "}
              {visibleAlbums.length === 1 ? "album" : "albums"}
            </span>
          </div>
        </div>

        {visibleAlbums.length === 0 && (albumFilter !== "all" || missingField !== null) ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-border-subtle bg-surface/60 px-6 py-14 text-center">
            <CheckCircle2 className="h-8 w-8 text-ok" />
            <h3 className="mt-3 text-sm font-semibold text-ink-primary">
              {activeMissingOption
                ? `No albums missing ${activeMissingOption.label}`
                : albumFilter === "missing"
                  ? "No tracks missing major metadata"
                  : albumFilter === "structure"
                    ? "Folder structure is fully organized"
                    : "All albums look clean"}
            </h3>
            <p className="mt-1 max-w-xs text-xs text-ink-secondary">
              {activeMissingOption
                ? `Every album matching your active filters has ${activeMissingOption.label} populated.`
                : albumFilter === "missing"
                  ? "Every track in your library has Title, Artist, and Album tags populated."
                  : albumFilter === "structure"
                    ? "All eligible albums match your configured library folder layout."
                    : "No Navidrome split-album tag mismatches or inconsistent album covers detected."}
            </p>
            <button
              type="button"
              onClick={() => {
                onChangeAlbumFilter("all");
                onChangeMissingField(null);
              }}
              className="m4-btn-secondary mt-4"
            >
              Show All Albums ({allAlbums.length})
            </button>
          </div>
        ) : (
          <div
            className={`grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 ${
              checkedAlbumIds.length > 0 ? "pb-20" : ""
            }`}
          >
            {visibleAlbums.map(({ artist, album }) => {
              const splitCount = album.navidrome_warnings.filter(
                (w) => w.severity === "split"
              ).length;
              const multiCovers = album.artwork_variants.length > 1;
              const isChecked = checkedAlbumIds.includes(album.id);
              const showCheckbox =
                albumSelectMode || checkedAlbumIds.length > 0;
              const fieldMissingCount = missingField
                ? countTracksMissingField(album, missingField)
                : 0;

              const toggleAlbumChecked = () => {
                setCheckedAlbumIds((prev) =>
                  prev.includes(album.id)
                    ? prev.filter((id) => id !== album.id)
                    : [...prev, album.id]
                );
              };

              return (
                <div
                  key={album.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (albumSelectMode || checkedAlbumIds.length > 0) {
                      toggleAlbumChecked();
                    } else {
                      onSelectAlbum(artist, album);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (albumSelectMode || checkedAlbumIds.length > 0) {
                        toggleAlbumChecked();
                      } else {
                        onSelectAlbum(artist, album);
                      }
                    }
                  }}
                  className={`group relative flex flex-col rounded-xl border bg-surface p-3 text-left transition-colors hover:bg-surface-elevated cursor-pointer ${
                    isChecked
                      ? "border-accent bg-accent-soft/40 ring-1 ring-accent/40"
                      : album.has_missing_metadata
                        ? "border-danger/45 hover:border-danger/70"
                        : "border-border-subtle hover:border-border-strong"
                  }`}
                >
                  <div className="relative aspect-square w-full overflow-hidden rounded-lg">
                    <AlbumCover
                      coverPath={album.cover_track_path}
                      alt={`${album.title} cover`}
                      revision={artworkRevision}
                      sizeClass="h-full w-full transition-transform duration-200 group-hover:scale-[1.02]"
                    />

                    {/* Top-left multi-select checkbox */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleAlbumChecked();
                      }}
                      aria-label={
                        isChecked
                          ? `Deselect ${album.title}`
                          : `Select ${album.title} for merging`
                      }
                      aria-pressed={isChecked}
                      className={`absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-md border transition-opacity cursor-pointer ${
                        isChecked
                          ? "border-accent bg-accent text-[#14110c] opacity-100 shadow-sm"
                          : showCheckbox
                            ? "border-border-strong bg-canvas/85 text-transparent opacity-100 hover:border-accent"
                            : "border-border-strong bg-canvas/85 text-transparent opacity-0 group-hover:opacity-100 focus:opacity-100 hover:border-accent"
                      }`}
                    >
                      <Check className="h-3.5 w-3.5 stroke-[3]" />
                    </button>

                    {/* Top-right status badges */}
                    <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
                      {activeMissingOption && fieldMissingCount > 0 && (
                        <div
                          className="flex items-center gap-1 rounded-md border border-accent/60 bg-canvas/92 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent shadow-sm backdrop-blur-xs"
                          title={`${fieldMissingCount} of ${album.track_count} tracks missing ${activeMissingOption.label}`}
                        >
                          {fieldMissingCount === album.track_count
                            ? activeMissingOption.shortBadge
                            : `${fieldMissingCount}/${album.track_count} ${activeMissingOption.shortBadge}`}
                        </div>
                      )}
                      {album.has_missing_metadata && (
                        <div
                          className="flex items-center gap-1 rounded-md border border-danger/60 bg-danger/90 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm"
                          title="Major metadata missing (Title, Artist, or Album)"
                        >
                          <AlertOctagon className="h-3 w-3" />
                          Missing
                        </div>
                      )}
                      {(splitCount > 0 || multiCovers) && (
                        <div
                          className="flex items-center gap-1 rounded-md border border-border-strong bg-canvas/90 px-1.5 py-0.5 text-[10px] font-medium text-warn backdrop-blur-xs"
                          title={
                            splitCount > 0
                              ? `${splitCount} Navidrome split-album tag mismatch(es)`
                              : `${album.artwork_variants.length} distinct cover images`
                          }
                        >
                          {splitCount > 0 ? (
                            <AlertTriangle className="h-3 w-3" />
                          ) : (
                            <Images className="h-3 w-3" />
                          )}
                          {splitCount > 0 ? splitCount : album.artwork_variants.length}
                        </div>
                      )}
                      {album.needs_reorganize && (
                        <div
                          className="flex items-center gap-1 rounded-md border border-border-strong bg-canvas/90 px-1.5 py-0.5 text-[10px] font-medium text-ink-primary backdrop-blur-xs"
                          title="Album folder path doesn't match your configured layout"
                        >
                          <FolderTree className="h-3 w-3 text-accent" />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 min-w-0">
                    <p className="truncate text-xs font-semibold text-ink-primary group-hover:text-accent transition-colors">
                      {album.title}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-secondary">
                      {album.artist}
                    </p>
                    <div className="mt-2 flex items-center justify-between gap-1 text-[10px] font-mono text-ink-muted">
                      <span>
                        {album.year ? album.year.slice(0, 4) : "—"} · {album.track_count}t
                      </span>
                      <span className="rounded border border-border-subtle bg-canvas px-1.5 py-0.5 text-[10px] uppercase text-ink-secondary">
                        {album.formats.join("/")}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Floating Multi-Album Action Bar */}
        {checkedAlbumIds.length > 0 && (() => {
          const selectedAlbums = allAlbums
            .map((entry) => entry.album)
            .filter((album) => checkedAlbumIds.includes(album.id));
          const totalSelectedTracks = selectedAlbums.reduce(
            (sum, a) => sum + a.track_count,
            0
          );
          return (
            <div
              id="multi-album-action-bar"
              className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 flex-wrap items-center gap-3 rounded-2xl border border-border-strong bg-surface/95 px-4 py-2.5 shadow-2xl backdrop-blur-sm"
            >
              <span className="text-xs font-medium text-ink-primary">
                <strong>{selectedAlbums.length}</strong>{" "}
                {selectedAlbums.length === 1 ? "album" : "albums"} selected{" "}
                <span className="font-mono text-[11px] text-ink-muted">
                  ({totalSelectedTracks}{" "}
                  {totalSelectedTracks === 1 ? "track" : "tracks"})
                </span>
              </span>

              <div className="flex items-center gap-2">
                <button
                  id="floating-merge-albums-btn"
                  type="button"
                  disabled={selectedAlbums.length < 2}
                  onClick={() => {
                    onMergeAlbums(selectedAlbums);
                    setAlbumSelectMode(false);
                    setCheckedAlbumIds([]);
                  }}
                  className="m4-btn-primary h-8 px-3 text-xs"
                  title={
                    selectedAlbums.length < 2
                      ? "Select at least 2 albums to merge"
                      : "Merge selected albums into one unified album"
                  }
                >
                  <GitMerge className="h-3.5 w-3.5" />
                  Merge Albums
                </button>

                <button
                  id="floating-identify-combined-btn"
                  type="button"
                  onClick={() => {
                    onIdentifyCombinedAlbums(selectedAlbums);
                    setAlbumSelectMode(false);
                    setCheckedAlbumIds([]);
                  }}
                  className="m4-btn-secondary h-8 px-3 text-xs"
                  title="Identify all selected tracks together via MusicBrainz"
                >
                  <Globe className="h-3.5 w-3.5 text-accent" />
                  Identify Combined
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setAlbumSelectMode(false);
                    setCheckedAlbumIds([]);
                  }}
                  className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
                  title="Clear album selection"
                  aria-label="Clear album selection"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })()}
      </main>
    );
  }

  const missingWarnings = selectedAlbum.navidrome_warnings.filter(
    (w) => w.severity === "missing"
  );
  const splitWarnings = selectedAlbum.navidrome_warnings.filter(
    (w) => w.severity === "split"
  );
  const artworkWarnings = selectedAlbum.navidrome_warnings.filter(
    (w) => w.severity === "artwork"
  );

  // Prev / Next navigation within the currently filtered album list (Issue #1)
  const navList = visibleAlbums.some((e) => e.album.id === selectedAlbum.id)
    ? visibleAlbums
    : allAlbums;
  const currentAlbumIdx = navList.findIndex(
    (e) => e.album.id === selectedAlbum.id
  );
  const prevAlbumEntry = currentAlbumIdx > 0 ? navList[currentAlbumIdx - 1] : null;
  const nextAlbumEntry =
    currentAlbumIdx >= 0 && currentAlbumIdx < navList.length - 1
      ? navList[currentAlbumIdx + 1]
      : null;

  // Issue #1 fast-fix: show quick "Find Cover" action when cover art is missing or filtered
  const albumMissingAnyArt =
    selectedAlbum.cover_track_path === null ||
    selectedAlbum.tracks.some((t) => !t.has_artwork) ||
    missingField === "artwork" ||
    missingField === "low_res_artwork";

  // Issue #2 fast-fix: resolve sibling split albums for one-click Merge
  const relatedSplitIds = Array.from(
    new Set(
      splitWarnings.flatMap((w) =>
        w.field === "duplicate_album" && w.related_album_ids
          ? w.related_album_ids
          : []
      )
    )
  );
  const relatedSiblingAlbums = relatedSplitIds
    .map((id) => allAlbums.find((e) => e.album.id === id)?.album)
    .filter((a): a is AlbumGroup => a !== undefined && a.id !== selectedAlbum.id);

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-canvas">
      {/* Album Header */}
      <section className="shrink-0 border-b border-border-subtle bg-surface/60 px-6 py-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <button
            id="back-to-albums-btn"
            type="button"
            onClick={onBackToAll}
            className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink-primary transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All Albums
          </button>

          {navList.length > 1 && currentAlbumIdx >= 0 && (
            <div
              id="album-prev-next-nav"
              className="inline-flex items-center gap-1 text-xs"
            >
              {activeMissingOption && (
                <span className="mr-1.5 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] text-accent">
                  Missing: {activeMissingOption.label}
                </span>
              )}
              <button
                id="prev-filtered-album-btn"
                type="button"
                disabled={!prevAlbumEntry}
                onClick={() =>
                  prevAlbumEntry &&
                  onSelectAlbum(prevAlbumEntry.artist, prevAlbumEntry.album)
                }
                className="m4-btn-secondary h-7 px-2 text-[11px] disabled:opacity-40"
                title={
                  prevAlbumEntry
                    ? `Previous: ${prevAlbumEntry.album.title}`
                    : "First album in list"
                }
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Prev
              </button>
              <span className="px-1.5 font-mono text-[10px] text-ink-muted">
                {currentAlbumIdx + 1} / {navList.length}
              </span>
              <button
                id="next-filtered-album-btn"
                type="button"
                disabled={!nextAlbumEntry}
                onClick={() =>
                  nextAlbumEntry &&
                  onSelectAlbum(nextAlbumEntry.artist, nextAlbumEntry.album)
                }
                className="m4-btn-secondary h-7 px-2 text-[11px] disabled:opacity-40"
                title={
                  nextAlbumEntry
                    ? `Next: ${nextAlbumEntry.album.title}`
                    : "Last album in list"
                }
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <AlbumCover
            coverPath={selectedAlbum.cover_track_path}
            alt={`${selectedAlbum.title} cover art`}
            revision={artworkRevision}
            sizeClass="h-24 w-24 shrink-0"
          />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {selectedAlbum.formats.map((fmt) => (
                <span
                  key={fmt}
                  className="rounded border border-border-subtle bg-canvas px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-secondary"
                >
                  {fmt}
                </span>
              ))}
              {selectedAlbum.year && (
                <span className="font-mono text-xs text-ink-muted">
                  {selectedAlbum.year}
                </span>
              )}
              {selectedAlbum.genre && (
                <span className="text-xs text-ink-muted">· {selectedAlbum.genre}</span>
              )}
            </div>
            <h2 className="mt-1 truncate text-xl font-semibold tracking-tight text-ink-primary">
              {selectedAlbum.title}
            </h2>
            <p className="mt-0.5 truncate text-sm text-ink-secondary">
              {selectedAlbum.artist}
              <span className="mx-2 text-ink-muted">·</span>
              <span className="font-mono text-xs text-ink-muted">
                {selectedAlbum.track_count}{" "}
                {selectedAlbum.track_count === 1 ? "track" : "tracks"} ·{" "}
                {formatDuration(selectedAlbum.total_duration)}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {albumMissingAnyArt && (
              <button
                id="header-find-cover-btn"
                type="button"
                onClick={() => onFindAlbumCover(selectedAlbum)}
                className="m4-btn-secondary"
                title="Search MusicBrainz Cover Art Archive for this album"
              >
                <ImagePlus className="h-3.5 w-3.5 text-accent" />
                Find Cover
              </button>
            )}
            <button
              id="header-identify-album-btn"
              type="button"
              onClick={() => onIdentifyAlbum(selectedAlbum)}
              className="m4-btn-secondary"
              title="Identify album and cover art via MusicBrainz"
            >
              <Globe className="h-3.5 w-3.5 text-accent" />
              Identify
            </button>
            <button
              id="bulk-edit-album-btn"
              type="button"
              onClick={() => onStartBulkEdit(selectedAlbum)}
              className={isBulkEditingAlbum ? "m4-btn-primary" : "m4-btn-secondary"}
            >
              <Layers className="h-3.5 w-3.5" />
              Edit Album ({selectedAlbum.track_count})
            </button>
          </div>
        </div>

        {/* Red Diagnostic Banner: Major Metadata Missing */}
        {missingWarnings.length > 0 && (
          <div
            id="missing-metadata-banner"
            className="mt-4 rounded-xl border border-danger/50 bg-danger/10 px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <div className="min-w-0 space-y-1">
                  <p className="text-xs font-semibold text-ink-primary">
                    Major Metadata Missing
                  </p>
                  <ul className="space-y-0.5 text-[11px] text-ink-secondary">
                    {missingWarnings.map((warning, idx) => (
                      <li key={`missing-${warning.field}-${idx}`}>
                        <span className="font-medium text-ink-primary">
                          {warning.label}:
                        </span>{" "}
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {selectedAlbum.tracks.length === 1 && (
                <button
                  type="button"
                  onClick={() => onIdentifyTrack(selectedAlbum.tracks[0])}
                  className="m4-btn-primary shrink-0 h-7 px-2.5 text-[11px]"
                >
                  <Globe className="h-3 w-3" />
                  Identify Track
                </button>
              )}
            </div>
          </div>
        )}

        {/* Amber Diagnostic Banner: Navidrome Split-Album Risk & Artwork Mismatches */}
        {(splitWarnings.length > 0 || artworkWarnings.length > 0) && (
          <div
            id="navidrome-diagnostics-banner"
            className="mt-3 rounded-xl border border-border-strong bg-canvas/80 px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                {splitWarnings.length > 0 ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                ) : (
                  <Images className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                )}
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs font-semibold text-ink-primary">
                    {splitWarnings.length > 0
                      ? `Navidrome Split-Album Risk (${splitWarnings.length} ${
                          splitWarnings.length === 1 ? "mismatch" : "mismatches"
                        })`
                      : "Inconsistent Album Artwork"}
                  </p>
                  <ul className="space-y-1 text-[11px] text-ink-secondary">
                    {[...splitWarnings, ...artworkWarnings].map((warning, idx) => (
                      <li key={`${warning.field}-${idx}`} className="leading-snug">
                        <span className="font-medium text-ink-primary">
                          {warning.label}:
                        </span>{" "}
                        {warning.message}
                        {warning.values.length > 0 && (
                          <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
                            {warning.values.map((val) => (
                              <code
                                key={val}
                                className="rounded bg-surface-elevated px-1.5 py-0.5 font-mono text-[10px] text-ink-primary"
                              >
                                {val}
                              </code>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {relatedSiblingAlbums.length > 0 && (
                  <button
                    id="merge-sibling-albums-btn"
                    type="button"
                    onClick={() =>
                      onMergeAlbums([selectedAlbum, ...relatedSiblingAlbums])
                    }
                    className="m4-btn-primary h-7 px-2.5 text-[11px]"
                    title={`Merge with ${relatedSiblingAlbums.map((a) => a.title).join(", ")}`}
                  >
                    <GitMerge className="h-3 w-3" />
                    Merge Split ({relatedSiblingAlbums.length + 1})
                  </button>
                )}

                {!isBulkEditingAlbum && (
                  <button
                    type="button"
                    onClick={() => onStartBulkEdit(selectedAlbum)}
                    className="m4-btn-secondary h-7 px-2.5 text-[11px]"
                  >
                    Fix in Bulk Edit
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Folder Structure Drift Notice */}
        {selectedAlbum.needs_reorganize && (
          <div
            id="folder-structure-banner"
            className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-canvas/70 px-4 py-2.5"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <FolderTree className="h-4 w-4 shrink-0 text-accent" />
              <p className="truncate text-xs text-ink-secondary">
                <span className="font-medium text-ink-primary">
                  Folder structure drift:
                </span>{" "}
                {selectedAlbum.navidrome_warnings.find((w) => w.severity === "structure")
                  ?.message || "Files in this album don't match your configured folder layout."}
              </p>
            </div>
            <button
              id="reorganize-album-btn"
              type="button"
              onClick={() => onOrganizeAlbum(selectedAlbum)}
              className="m4-btn-secondary shrink-0 h-7 px-2.5 text-[11px]"
            >
              Reorganize Album
            </button>
          </div>
        )}
      </section>

      {/* Track Table */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {checkedTrackPaths.length > 0 && (() => {
          const chosenTracks = selectedAlbum.tracks.filter((t) =>
            checkedTrackPaths.includes(t.path)
          );
          if (chosenTracks.length === 0) return null;
          return (
            <div
              id="selected-tracks-action-bar"
              className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/40 bg-accent-soft/50 px-3.5 py-2 text-xs"
            >
              <span className="font-medium text-ink-primary">
                {chosenTracks.length}{" "}
                {chosenTracks.length === 1 ? "track" : "tracks"} selected
              </span>
              <div className="flex items-center gap-2">
                <button
                  id="bulk-move-tracks-to-album-btn"
                  type="button"
                  onClick={() => {
                    onMoveTracksToAlbum(chosenTracks, selectedAlbum.id);
                    setCheckedTrackPaths([]);
                  }}
                  className="m4-btn-primary h-7 px-2.5 text-[11px]"
                >
                  <FolderInput className="h-3.5 w-3.5" />
                  Move to Album…
                </button>
                <button
                  type="button"
                  onClick={() => setCheckedTrackPaths([])}
                  className="m4-btn-secondary h-7 px-2 text-[11px]"
                >
                  Clear
                </button>
              </div>
            </div>
          );
        })()}

        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border-subtle text-[11px] font-medium uppercase tracking-wider text-ink-muted">
              <th className="w-8 py-2 pl-2 pr-1">
                <input
                  type="checkbox"
                  checked={
                    selectedAlbum.tracks.length > 0 &&
                    selectedAlbum.tracks.every((t) =>
                      checkedTrackPaths.includes(t.path)
                    )
                  }
                  onChange={(e) => {
                    if (e.target.checked) {
                      setCheckedTrackPaths(
                        selectedAlbum.tracks.map((t) => t.path)
                      );
                    } else {
                      setCheckedTrackPaths([]);
                    }
                  }}
                  aria-label="Select all tracks in album"
                  className="h-3.5 w-3.5 accent-amber-500 cursor-pointer"
                />
              </th>
              <th className="w-12 py-2 px-2 font-mono">#</th>
              <th className="py-2 px-2">Title</th>
              <th className="hidden md:table-cell py-2 px-2">Artist</th>
              <th className="hidden sm:table-cell w-24 py-2 px-2 text-right">Format</th>
              <th className="w-16 py-2 px-2 text-right">Time</th>
              <th className="w-16 py-2 pl-1 pr-2 text-right" aria-label="Track actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle/50 text-xs">
            {selectedAlbum.tracks.map((track) => {
              const isSelected =
                !isBulkEditingAlbum && selectedTrackPath === track.path;
              const isChecked = checkedTrackPaths.includes(track.path);
              const isMissingMajor = track.missing_fields.length > 0;
              const discPrefix =
                track.disc_number && track.disc_number !== "1" && track.disc_number !== "1/1"
                  ? `${track.disc_number.split("/")[0]}-`
                  : "";
              const trackNumLabel = track.track_number
                ? `${discPrefix}${track.track_number.split("/")[0]}`
                : "—";

              return (
                <tr
                  key={track.path}
                  onClick={() => onSelectTrack(track)}
                  className={`group cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-accent-soft/80 text-ink-primary"
                      : isChecked
                        ? "bg-accent-soft/40 text-ink-primary"
                        : "hover:bg-surface-elevated/70 text-ink-secondary"
                  }`}
                >
                  <td
                    className="py-2.5 pl-2 pr-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setCheckedTrackPaths((prev) => [...prev, track.path]);
                        } else {
                          setCheckedTrackPaths((prev) =>
                            prev.filter((p) => p !== track.path)
                          );
                        }
                      }}
                      aria-label={`Select ${track.title || track.filename}`}
                      className="h-3.5 w-3.5 accent-amber-500 cursor-pointer"
                    />
                  </td>
                  <td className="py-2.5 px-2 font-mono text-[11px] text-ink-muted">
                    {trackNumLabel}
                  </td>
                  <td className="py-2.5 px-2">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        {isMissingMajor ? (
                          <AlertOctagon
                            className="h-3.5 w-3.5 shrink-0 text-danger"
                            aria-label="Missing major metadata"
                          />
                        ) : (
                          <Music
                            className={`h-3.5 w-3.5 shrink-0 ${
                              isSelected ? "text-accent" : "text-ink-muted/60"
                            }`}
                          />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <p
                              className={`truncate font-medium ${
                                isSelected ? "text-accent" : "text-ink-primary"
                              }`}
                            >
                              {track.title || track.filename}
                            </p>
                            {activeMissingOption &&
                              missingField &&
                              isTrackMissingField(track, missingField) && (
                                <span
                                  className="shrink-0 rounded border border-accent/50 bg-accent-soft px-1.5 py-0.2 font-mono text-[9px] font-semibold text-accent"
                                  title={`This track is missing ${activeMissingOption.label}`}
                                >
                                  {activeMissingOption.shortBadge}
                                </span>
                              )}
                          </div>
                          {isMissingMajor && (
                            <p className="truncate font-mono text-[10px] text-danger">
                              Missing: {track.missing_fields.join(", ")}
                            </p>
                          )}
                        </div>
                      </div>

                      {isMissingMajor && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onIdentifyTrack(track);
                          }}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-strong bg-surface-elevated px-2 py-1 text-[10px] font-medium text-accent hover:border-accent/60 hover:bg-surface-hover cursor-pointer"
                          title="Identify this track via MusicBrainz"
                        >
                          <Globe className="h-3 w-3" />
                          Identify
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="hidden md:table-cell py-2.5 px-2 truncate max-w-[180px] text-ink-secondary">
                    {track.artist || "—"}
                  </td>
                  <td className="hidden sm:table-cell py-2.5 px-2 text-right">
                    <span
                      className="inline-block rounded border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary"
                      title={
                        track.bitrate
                          ? `${track.format} · ${Math.round(track.bitrate / 1000)} kbps`
                          : track.format
                      }
                    >
                      {track.format}
                    </span>
                  </td>
                  <td className="py-2.5 px-2 text-right font-mono text-[11px] text-ink-muted">
                    {formatDuration(track.duration)}
                  </td>
                  <td className="py-2.5 pl-1 pr-2 text-right">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onMoveTracksToAlbum([track], selectedAlbum.id);
                        }}
                        className={`rounded-md p-1 text-ink-muted transition-opacity hover:bg-surface-elevated hover:text-accent cursor-pointer ${
                          isSelected
                            ? "opacity-80 hover:opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                        }`}
                        title={`Move ${track.filename} to another album`}
                        aria-label={`Move ${track.title || track.filename} to another album`}
                      >
                        <FolderInput className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteTrack(track);
                        }}
                        className={`rounded-md p-1 text-ink-muted transition-opacity hover:bg-danger/15 hover:text-danger cursor-pointer ${
                          isSelected
                            ? "opacity-80 hover:opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                        }`}
                        title={`Delete ${track.filename} from disk`}
                        aria-label={`Delete ${track.title || track.filename}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
