import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FolderInput,
  Loader2,
  Music,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { formatDuration, searchLibraryForMissingTrack } from "../api/client";
import type {
  AlbumGroup,
  MissingTrackCandidate,
  MissingTrackItem,
} from "../types/music";

interface MissingTrackSearchModalProps {
  album: AlbumGroup | null;
  missingItem: MissingTrackItem | null;
  movingPath: string | null;
  onClose: () => void;
  onMoveCandidate: (
    album: AlbumGroup,
    missingItem: MissingTrackItem,
    candidate: MissingTrackCandidate
  ) => void;
}

export function MissingTrackSearchModal({
  album,
  missingItem,
  movingPath,
  onClose,
  onMoveCandidate,
}: MissingTrackSearchModalProps) {
  const [query, setQuery] = useState("");
  const [artistFilter, setArtistFilter] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<MissingTrackCandidate[]>([]);

  const runSearch = useCallback(
    async (
      targetAlbum: AlbumGroup,
      item: MissingTrackItem,
      qText: string,
      useArtist: boolean
    ) => {
      setLoading(true);
      setError(null);
      try {
        const res = await searchLibraryForMissingTrack({
          albumId: targetAlbum.id,
          query: qText.trim() || null,
          artist: useArtist ? item.artist || targetAlbum.artist : null,
          lengthMs: item.length_ms,
          limit: 25,
        });
        setCandidates(res.candidates);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not search local library"
        );
        setCandidates([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!album || !missingItem) return;
    const initialQuery = missingItem.title ?? "";
    setQuery(initialQuery);
    setArtistFilter(true);
    void runSearch(album, missingItem, initialQuery, true);
  }, [album, missingItem, runSearch]);

  useEffect(() => {
    if (!album || !missingItem) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [album, missingItem, onClose]);

  if (!album || !missingItem) return null;

  const slotLabel =
    missingItem.track_number === 0
      ? `Disc ${missingItem.disc_number} (Entire Disc)`
      : `Disc ${missingItem.disc_number} · Track #${missingItem.track_number}`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runSearch(album, missingItem, query, artistFilter);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        id="missing-track-search-modal"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink-primary">
                Search My Library for Missing Track
              </h2>
            </div>
            <p className="mt-1 truncate text-xs text-ink-secondary">
              Target:{" "}
              <span className="font-medium text-ink-primary">{album.title}</span>{" "}
              · <span className="font-mono text-[11px]">{slotLabel}</span>
              {missingItem.title ? (
                <>
                  {" "}
                  — <span className="text-accent">“{missingItem.title}”</span>
                </>
              ) : null}
              {missingItem.length_ms ? (
                <span className="ml-1.5 font-mono text-[11px] text-ink-muted">
                  ({formatDuration(missingItem.length_ms / 1000)})
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-ink-muted transition-colors hover:bg-surface-elevated hover:text-ink-primary"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search Controls */}
        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-canvas/40 px-5 py-3"
        >
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search track title or filename in your library..."
              className="m4-input pl-8 text-xs"
              autoFocus
            />
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-[11px] text-ink-secondary hover:text-ink-primary">
            <input
              type="checkbox"
              checked={artistFilter}
              onChange={(e) => {
                const next = e.target.checked;
                setArtistFilter(next);
                void runSearch(album, missingItem, query, next);
              }}
              className="h-3.5 w-3.5 rounded border-border-strong accent-[#d99026]"
            />
            <span>Same artist ({album.artist})</span>
          </label>
          <button
            type="submit"
            disabled={loading}
            className="m4-btn-primary text-xs"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Search
          </button>
        </form>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-xs text-ink-secondary">
              <Loader2 className="h-5 w-5 animate-spin text-accent" />
              <span>Searching your cached library...</span>
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-strong bg-canvas/30 px-5 py-10 text-center">
              <Music className="mx-auto mb-2.5 h-6 w-6 text-ink-muted opacity-50" />
              <p className="text-xs font-medium text-ink-primary">
                No matching tracks found elsewhere in this library
              </p>
              <p className="mt-1 text-[11px] text-ink-secondary">
                {artistFilter
                  ? "Try unchecking “Same artist” or searching with a shorter keyword."
                  : "This track may genuinely be missing from disk."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-ink-muted">
                Found {candidates.length} candidate{" "}
                {candidates.length === 1 ? "track" : "tracks"} outside{" "}
                <span className="text-ink-secondary">“{album.title}”</span>. Moving
                adopts this album’s tags, artwork, and track # (fully undoable in
                History).
              </p>
              {candidates.map((cand) => {
                const isStray =
                  cand.album_track_count <= 2 ||
                  cand.album === "Unknown Album";
                const isMovingThis = movingPath === cand.path;
                return (
                  <div
                    key={cand.path}
                    className={`flex items-center justify-between gap-3 rounded-xl border p-3 transition-colors ${
                      isStray
                        ? "border-accent/35 bg-accent/5"
                        : "border-border-subtle bg-canvas/40"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-xs font-semibold text-ink-primary">
                          {cand.title || cand.filename}
                        </p>
                        {cand.duration > 0 && (
                          <span className="font-mono text-[11px] text-ink-muted">
                            {formatDuration(cand.duration)}
                          </span>
                        )}
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                            isStray
                              ? "border-accent/40 bg-accent/15 text-accent"
                              : "border-border-subtle bg-surface text-ink-secondary"
                          }`}
                        >
                          {isStray && <Sparkles className="h-2.5 w-2.5" />}
                          Found in “{cand.album || "Unknown Album"}” (
                          {cand.album_track_count}{" "}
                          {cand.album_track_count === 1 ? "track" : "tracks"})
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-ink-secondary">
                        {cand.artist || "Unknown Artist"} ·{" "}
                        <span className="font-mono text-[10px] text-ink-muted">
                          {cand.path}
                        </span>
                      </p>
                      {cand.reason && (
                        <p className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-muted">
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                          <span>
                            {cand.reason} ({cand.score}%)
                          </span>
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={movingPath !== null}
                      onClick={() => onMoveCandidate(album, missingItem, cand)}
                      className="m4-btn-primary shrink-0 text-[11px]"
                    >
                      {isMovingThis ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FolderInput className="h-3.5 w-3.5" />
                      )}
                      Move to this album
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
