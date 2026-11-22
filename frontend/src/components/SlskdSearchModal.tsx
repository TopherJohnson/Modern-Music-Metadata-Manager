import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  CloudDownload,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Wifi,
  X,
} from "lucide-react";
import {
  formatDuration,
  formatFileSize,
  queueSlskdDownload,
  refreshSlskdSearch,
  searchSlskd,
} from "../api/client";
import type {
  AlbumGroup,
  MissingTrackItem,
  SlskdCandidate,
  SlskdSearchResponse,
} from "../types/music";

interface SlskdSearchModalProps {
  album: AlbumGroup | null;
  missingItem: MissingTrackItem | null;
  allMissingItems?: MissingTrackItem[];
  onClose: () => void;
  onSelectMissingItem?: (item: MissingTrackItem) => void;
  onQueued: (username: string, basename: string) => void;
  onOpenDownloads: () => void;
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "—";
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

export function SlskdSearchModal({
  album,
  missingItem,
  allMissingItems = [],
  onClose,
  onSelectMissingItem,
  onQueued,
  onOpenDownloads,
}: SlskdSearchModalProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SlskdSearchResponse | null>(null);
  const [queueingKey, setQueueingKey] = useState<string | null>(null);
  const [queuedKeys, setQueuedKeys] = useState<Set<string>>(new Set());

  const runSearch = useCallback(
    async (
      qText: string,
      targetAlbum: AlbumGroup,
      item: MissingTrackItem | null
    ) => {
      if (!qText.trim()) return;
      setSearching(true);
      setError(null);
      try {
        const res = await searchSlskd({
          query: qText.trim(),
          trackTitle: item?.title ?? null,
          artist: item?.artist || targetAlbum.artist,
          preferredFormats: targetAlbum.formats,
          expectedLengthMs: item?.length_ms ?? null,
          timeoutSec: 5.0,
        });
        setResult(res);
      } catch (err) {
        setError(err instanceof Error ? err.message : "slskd search failed");
        setResult(null);
      } finally {
        setSearching(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!album) return;
    const artist = album.artist === "Unknown Artist" ? "" : album.artist;
    const initialQuery = missingItem?.title
      ? `${artist} ${missingItem.title}`.trim()
      : `${artist} ${album.title === "Unknown Album" ? "" : album.title}`.trim();
    setQuery(initialQuery);
    setResult(null);
    setError(null);
    if (initialQuery) {
      void runSearch(initialQuery, album, missingItem);
    }
  }, [album, missingItem, runSearch]);

  useEffect(() => {
    if (!album) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [album, onClose]);

  if (!album) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void runSearch(query, album, missingItem);
  };

  const handleRefreshPeers = async () => {
    if (!result?.search_id) return;
    setRefreshing(true);
    setError(null);
    try {
      const updated = await refreshSlskdSearch(result.search_id);
      setResult(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh peers");
    } finally {
      setRefreshing(false);
    }
  };

  const handleQueue = async (cand: SlskdCandidate) => {
    const key = `${cand.username}:${cand.filename}`;
    setQueueingKey(key);
    setError(null);
    try {
      await queueSlskdDownload(cand.username, [
        { filename: cand.filename, size: cand.size },
      ]);
      setQueuedKeys((prev) => new Set(prev).add(key));
      onQueued(cand.username, cand.basename);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not queue download");
    } finally {
      setQueueingKey(null);
    }
  };

  const activeMissingChoices = allMissingItems.filter((m) => !m.ignored);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        id="slskd-search-modal"
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CloudDownload className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink-primary">
                Search in slskd (Soulseek)
              </h2>
              {album.formats.length > 0 && (
                <span className="rounded-md border border-accent/40 bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-medium text-accent">
                  Prefers {album.formats.join(" / ")}
                </span>
              )}
              {missingItem?.length_ms && (
                <span className="rounded-md border border-border-subtle bg-canvas px-2 py-0.5 font-mono text-[10px] text-ink-secondary">
                  Expected {formatDuration(missingItem.length_ms / 1000)}
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-xs text-ink-secondary">
              {album.artist} — <span className="text-ink-primary">{album.title}</span>
              {missingItem && (
                <>
                  {" "}
                  ·{" "}
                  <span className="font-mono text-[11px] text-accent">
                    {missingItem.track_number > 0
                      ? `#${missingItem.track_number}`
                      : `Disc ${missingItem.disc_number}`}
                    {missingItem.title ? ` “${missingItem.title}”` : ""}
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenDownloads}
              className="m4-btn-secondary h-7 px-2.5 text-[11px]"
            >
              <Download className="h-3 w-3 text-accent" />
              Downloads
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
              aria-label="Close modal"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Multi-missing-track selector bar when launched from album header */}
        {activeMissingChoices.length > 1 && onSelectMissingItem && (
          <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border-subtle bg-canvas/30 px-5 py-2">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
              Missing:
            </span>
            {activeMissingChoices.map((item) => {
              const isSelected =
                missingItem?.disc_number === item.disc_number &&
                missingItem?.track_number === item.track_number;
              return (
                <button
                  key={`${item.disc_number}-${item.track_number}`}
                  type="button"
                  onClick={() => onSelectMissingItem(item)}
                  className={`shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors cursor-pointer ${
                    isSelected
                      ? "border-accent bg-accent-soft font-medium text-accent"
                      : "border-border-subtle bg-surface text-ink-secondary hover:border-border-strong hover:text-ink-primary"
                  }`}
                >
                  #{item.track_number}
                  {item.title ? ` ${item.title}` : ""}
                </button>
              );
            })}
          </div>
        )}

        {/* Search Input */}
        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-canvas/40 px-5 py-3"
        >
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Artist + Track title (e.g. Stevie Wonder Isn't She Lovely)..."
              className="m4-input pl-8 text-xs"
              autoFocus
            />
          </div>
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="m4-btn-primary text-xs"
          >
            {searching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Search
          </button>
          {result && (
            <button
              type="button"
              disabled={refreshing || searching}
              onClick={handleRefreshPeers}
              className="m4-btn-secondary text-xs"
              title="Re-fetch late-arriving peer responses for this search"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              Refresh Peers
            </button>
          )}
        </form>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {searching ? (
            <div className="flex flex-col items-center justify-center gap-2 py-14 text-xs text-ink-secondary">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
              <span>Querying Soulseek peers via slskd...</span>
              <span className="text-[11px] text-ink-muted">
                Ranking results by format match, duration closeness, and free upload slots
              </span>
            </div>
          ) : !result || result.candidates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-strong bg-canvas/30 px-5 py-12 text-center">
              <CloudDownload className="mx-auto mb-2.5 h-6 w-6 text-ink-muted opacity-50" />
              <p className="text-xs font-medium text-ink-primary">
                {result
                  ? "No unlocked audio files returned yet"
                  : "Enter a query to search Soulseek peers"}
              </p>
              <p className="mt-1 text-[11px] text-ink-secondary">
                {result
                  ? "Try clicking Refresh Peers in a moment or shortening the search query."
                  : "Tip: Artist + Track Title usually yields the cleanest results."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[11px] text-ink-muted">
                <span>
                  Showing top {result.candidates.length} ranked audio files from{" "}
                  {result.response_count} peer
                  {result.response_count === 1 ? "" : "s"} ({result.file_count} total files)
                </span>
                <span className="font-mono text-[10px]">
                  {result.is_complete ? "Search complete" : "Peers still responding"}
                </span>
              </div>

              {result.candidates.map((cand) => {
                const key = `${cand.username}:${cand.filename}`;
                const isQueued = queuedKeys.has(key);
                const isQueueing = queueingKey === key;
                const matchesAlbumFormat = album.formats
                  .map((f) => f.toUpperCase())
                  .includes(cand.format.toUpperCase());

                return (
                  <div
                    key={key}
                    className={`flex items-center justify-between gap-3 rounded-xl border p-3 transition-colors ${
                      cand.score >= 78
                        ? "border-accent/35 bg-accent-soft/20"
                        : "border-border-subtle bg-canvas/45"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                            matchesAlbumFormat
                              ? "border-accent/50 bg-accent-soft text-accent"
                              : "border-border-subtle bg-surface text-ink-secondary"
                          }`}
                        >
                          {cand.format}
                          {cand.bit_rate ? ` ${cand.bit_rate}k` : ""}
                        </span>
                        <p
                          className="truncate text-xs font-semibold text-ink-primary"
                          title={cand.filename}
                        >
                          {cand.basename}
                        </p>
                        {cand.length_sec !== null && (
                          <span className="font-mono text-[11px] text-ink-secondary">
                            {formatDuration(cand.length_sec)}
                          </span>
                        )}
                        {cand.duration_diff_sec !== null && (
                          <span
                            className={`rounded px-1.5 py-0.2 font-mono text-[10px] ${
                              cand.duration_diff_sec <= 5
                                ? "bg-emerald-500/15 text-emerald-300"
                                : cand.duration_diff_sec <= 18
                                  ? "bg-surface-elevated text-ink-secondary"
                                  : "bg-danger/15 text-danger"
                            }`}
                          >
                            ±{Math.round(cand.duration_diff_sec)}s
                          </span>
                        )}
                        <span className="font-mono text-[10px] text-ink-muted">
                          {formatFileSize(cand.size)}
                        </span>
                      </div>

                      {cand.directory && (
                        <p className="mt-0.5 truncate font-mono text-[10px] text-ink-muted">
                          {cand.directory}
                        </p>
                      )}

                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-ink-secondary">
                        <span className="inline-flex items-center gap-1">
                          <Wifi className="h-3 w-3 text-ink-muted" />
                          <span className="font-medium text-ink-primary">
                            {cand.username}
                          </span>
                        </span>
                        <span
                          className={`rounded-full px-1.5 py-0.2 font-mono ${
                            cand.has_free_upload_slot
                              ? "bg-emerald-500/15 text-emerald-300"
                              : "bg-surface-elevated text-ink-muted"
                          }`}
                        >
                          {cand.has_free_upload_slot
                            ? "Free slot"
                            : `Queue: ${cand.queue_length}`}
                        </span>
                        <span className="font-mono text-ink-muted">
                          {formatSpeed(cand.upload_speed)}
                        </span>
                        {cand.reasons.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-accent/90">
                            <Sparkles className="h-2.5 w-2.5" />
                            {cand.reasons.join(" · ")}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="font-mono text-[10px] text-ink-muted">
                        Score {cand.score}
                      </span>
                      <button
                        type="button"
                        disabled={isQueued || queueingKey !== null}
                        onClick={() => handleQueue(cand)}
                        className={
                          isQueued
                            ? "m4-btn-secondary h-7 px-2.5 text-[11px] text-ok border-ok/40"
                            : "m4-btn-primary h-7 px-2.5 text-[11px]"
                        }
                      >
                        {isQueueing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : isQueued ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <Download className="h-3 w-3" />
                        )}
                        {isQueued ? "Queued" : "Download"}
                      </button>
                    </div>
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
