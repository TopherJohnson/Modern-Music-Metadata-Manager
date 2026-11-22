import {
  AlertOctagon,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Disc3,
  FolderOpen,
  FolderTree,
  Globe,
  Images,
  Layers,
  Music,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { formatDuration, getArtworkUrl } from "../api/client";
import type { AlbumGroup, ArtistGroup, TrackMetadata } from "../types/music";

export type AlbumFilterMode = "all" | "mismatches" | "missing" | "structure";

interface TrackListProps {
  artists: ArtistGroup[];
  selectedAlbum: AlbumGroup | null;
  selectedTrackPath: string | null;
  isBulkEditingAlbum: boolean;
  albumFilter: AlbumFilterMode;
  organizeEnabled: boolean;
  artworkRevision: number;
  loading: boolean;
  musicDir: string;
  onSelectAlbum: (artist: ArtistGroup, album: AlbumGroup) => void;
  onBackToAll: () => void;
  onSelectTrack: (track: TrackMetadata) => void;
  onStartBulkEdit: (album: AlbumGroup) => void;
  onIdentifyAlbum: (album: AlbumGroup) => void;
  onIdentifyTrack: (track: TrackMetadata) => void;
  onDeleteTrack: (track: TrackMetadata) => void;
  onOrganizeAlbum: (album: AlbumGroup) => void;
  onChangeAlbumFilter: (filter: AlbumFilterMode) => void;
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
  organizeEnabled,
  artworkRevision,
  loading,
  musicDir,
  onSelectAlbum,
  onBackToAll,
  onSelectTrack,
  onStartBulkEdit,
  onIdentifyAlbum,
  onIdentifyTrack,
  onDeleteTrack,
  onOrganizeAlbum,
  onChangeAlbumFilter,
  onRescan,
}: TrackListProps) {
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

    const visibleAlbums =
      albumFilter === "missing"
        ? allAlbums.filter(({ album }) => album.has_missing_metadata)
        : albumFilter === "mismatches"
          ? allAlbums.filter(({ album }) => hasMismatchWarning(album))
          : albumFilter === "structure"
            ? allAlbums.filter(({ album }) => album.needs_reorganize)
            : allAlbums;

    const toggleFilter = (target: Exclude<AlbumFilterMode, "all">) => {
      onChangeAlbumFilter(albumFilter === target ? "all" : target);
    };

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
              title="Show only albums with Navidrome split-album tag or cover art mismatches"
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

            <span className="ml-1 font-mono text-xs text-ink-muted">
              {visibleAlbums.length}{" "}
              {visibleAlbums.length === 1 ? "album" : "albums"}
            </span>
          </div>
        </div>

        {visibleAlbums.length === 0 && albumFilter !== "all" ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-border-subtle bg-surface/60 px-6 py-14 text-center">
            <CheckCircle2 className="h-8 w-8 text-ok" />
            <h3 className="mt-3 text-sm font-semibold text-ink-primary">
              {albumFilter === "missing"
                ? "No tracks missing major metadata"
                : albumFilter === "structure"
                  ? "Folder structure is fully organized"
                  : "All albums look clean"}
            </h3>
            <p className="mt-1 max-w-xs text-xs text-ink-secondary">
              {albumFilter === "missing"
                ? "Every track in your library has Title, Artist, and Album tags populated."
                : albumFilter === "structure"
                  ? "All eligible albums match your configured library folder layout."
                  : "No Navidrome split-album tag mismatches or inconsistent album covers detected."}
            </p>
            <button
              type="button"
              onClick={() => onChangeAlbumFilter("all")}
              className="m4-btn-secondary mt-4"
            >
              Show All Albums ({allAlbums.length})
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {visibleAlbums.map(({ artist, album }) => {
              const splitCount = album.navidrome_warnings.filter(
                (w) => w.severity === "split"
              ).length;
              const multiCovers = album.artwork_variants.length > 1;
              return (
                <button
                  key={album.id}
                  type="button"
                  onClick={() => onSelectAlbum(artist, album)}
                  className={`group relative flex flex-col rounded-xl border bg-surface p-3 text-left transition-colors hover:bg-surface-elevated cursor-pointer ${
                    album.has_missing_metadata
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

                    {/* Top-right status badges */}
                    <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
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
                </button>
              );
            })}
          </div>
        )}
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

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-canvas">
      {/* Album Header */}
      <section className="shrink-0 border-b border-border-subtle bg-surface/60 px-6 py-5">
        <button
          id="back-to-albums-btn"
          type="button"
          onClick={onBackToAll}
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink-primary transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All Albums
        </button>

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

          <div className="flex items-center gap-2 shrink-0">
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
                      ? `Navidrome Split-Album Risk (${splitWarnings.length} tag ${
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

              {!isBulkEditingAlbum && (
                <button
                  type="button"
                  onClick={() => onStartBulkEdit(selectedAlbum)}
                  className="m4-btn-secondary shrink-0 h-7 px-2.5 text-[11px]"
                >
                  Fix in Bulk Edit
                </button>
              )}
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
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border-subtle text-[11px] font-medium uppercase tracking-wider text-ink-muted">
              <th className="w-14 py-2 pl-3 pr-2 font-mono">#</th>
              <th className="py-2 px-2">Title</th>
              <th className="hidden md:table-cell py-2 px-2">Artist</th>
              <th className="hidden sm:table-cell w-24 py-2 px-2 text-right">Format</th>
              <th className="w-16 py-2 px-2 text-right">Time</th>
              <th className="w-9 py-2 pl-1 pr-2 text-right" aria-label="Track actions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle/50 text-xs">
            {selectedAlbum.tracks.map((track) => {
              const isSelected =
                !isBulkEditingAlbum && selectedTrackPath === track.path;
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
                      : "hover:bg-surface-elevated/70 text-ink-secondary"
                  }`}
                >
                  <td className="py-2.5 pl-3 pr-2 font-mono text-[11px] text-ink-muted">
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
                          <p
                            className={`truncate font-medium ${
                              isSelected ? "text-accent" : "text-ink-primary"
                            }`}
                          >
                            {track.title || track.filename}
                          </p>
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
