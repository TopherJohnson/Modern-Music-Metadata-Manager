import { ArrowLeft, Disc3, FolderOpen, Layers, Music, RefreshCw } from "lucide-react";
import { formatDuration, getArtworkUrl } from "../api/client";
import type { AlbumGroup, ArtistGroup, TrackMetadata } from "../types/music";

interface TrackListProps {
  artists: ArtistGroup[];
  selectedAlbum: AlbumGroup | null;
  selectedTrackPath: string | null;
  isBulkEditingAlbum: boolean;
  artworkRevision: number;
  loading: boolean;
  musicDir: string;
  onSelectAlbum: (artist: ArtistGroup, album: AlbumGroup) => void;
  onBackToAll: () => void;
  onSelectTrack: (track: TrackMetadata) => void;
  onStartBulkEdit: (album: AlbumGroup) => void;
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

export function TrackList({
  artists,
  selectedAlbum,
  selectedTrackPath,
  isBulkEditingAlbum,
  artworkRevision,
  loading,
  musicDir,
  onSelectAlbum,
  onBackToAll,
  onSelectTrack,
  onStartBulkEdit,
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
    return (
      <main className="flex-1 overflow-y-auto bg-canvas p-6">
        <div className="mb-5 flex items-baseline justify-between">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-ink-primary">
              Library Albums
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              Select an album to inspect tracks or batch-edit tags
            </p>
          </div>
          <span className="font-mono text-xs text-ink-muted">
            {allAlbums.length} {allAlbums.length === 1 ? "album" : "albums"}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {allAlbums.map(({ artist, album }) => (
            <button
              key={album.id}
              type="button"
              onClick={() => onSelectAlbum(artist, album)}
              className="group flex flex-col rounded-xl border border-border-subtle bg-surface p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-elevated cursor-pointer"
            >
              <div className="aspect-square w-full overflow-hidden rounded-lg">
                <AlbumCover
                  coverPath={album.cover_track_path}
                  alt={`${album.title} cover`}
                  revision={artworkRevision}
                  sizeClass="h-full w-full transition-transform duration-200 group-hover:scale-[1.02]"
                />
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
          ))}
        </div>
      </main>
    );
  }

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

          <div className="shrink-0">
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
              <th className="w-16 py-2 pl-2 pr-3 text-right">Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle/50 text-xs">
            {selectedAlbum.tracks.map((track) => {
              const isSelected =
                !isBulkEditingAlbum && selectedTrackPath === track.path;
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
                  className={`cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-accent-soft/80 text-ink-primary"
                      : "hover:bg-surface-elevated/70 text-ink-secondary"
                  }`}
                >
                  <td className="py-2.5 pl-3 pr-2 font-mono text-[11px] text-ink-muted">
                    {trackNumLabel}
                  </td>
                  <td className="py-2.5 px-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Music
                        className={`h-3.5 w-3.5 shrink-0 ${
                          isSelected ? "text-accent" : "text-ink-muted/60"
                        }`}
                      />
                      <div className="min-w-0">
                        <p
                          className={`truncate font-medium ${
                            isSelected ? "text-accent" : "text-ink-primary"
                          }`}
                        >
                          {track.title || track.filename}
                        </p>
                        {!track.title && (
                          <p className="truncate font-mono text-[10px] text-ink-muted">
                            (untagged filename)
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="hidden md:table-cell py-2.5 px-2 truncate max-w-[180px] text-ink-secondary">
                    {track.artist || "—"}
                  </td>
                  <td className="hidden sm:table-cell py-2.5 px-2 text-right">
                    <span className="inline-block rounded border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
                      {track.format}
                    </span>
                  </td>
                  <td className="py-2.5 pl-2 pr-3 text-right font-mono text-[11px] text-ink-muted">
                    {formatDuration(track.duration)}
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
