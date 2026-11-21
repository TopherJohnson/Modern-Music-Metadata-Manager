import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  Disc3,
  Globe,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { searchMusicBrainz } from "../api/client";
import type {
  MusicBrainzApplyPayload,
  MusicBrainzReleaseCandidate,
} from "../types/music";

export type MusicBrainzModalMode = "identify" | "artwork";

interface MusicBrainzModalProps {
  open: boolean;
  mode: MusicBrainzModalMode;
  initialAlbum: string;
  initialArtist: string;
  targetPaths: string[];
  localTrackCount: number;
  applying: boolean;
  onClose: () => void;
  onApply: (payload: MusicBrainzApplyPayload) => Promise<void>;
}

function CandidateCover({ url, title }: { url: string; title: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-elevated text-ink-muted">
        <Disc3 className="h-7 w-7 opacity-40" />
        <span className="text-[9px] uppercase tracking-wider opacity-60">No Art</span>
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={`${title} cover`}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover bg-surface-elevated"
    />
  );
}

export function MusicBrainzModal({
  open,
  mode,
  initialAlbum,
  initialArtist,
  targetPaths,
  localTrackCount,
  applying,
  onClose,
  onApply,
}: MusicBrainzModalProps) {
  const [albumQuery, setAlbumQuery] = useState(initialAlbum);
  const [artistQuery, setArtistQuery] = useState(initialArtist);
  const [results, setResults] = useState<MusicBrainzReleaseCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMbid, setSelectedMbid] = useState<string | null>(null);

  const [applyMetadata, setApplyMetadata] = useState(mode === "identify");
  const [applyArtwork, setApplyArtwork] = useState(true);
  const [applyTrackTitles, setApplyTrackTitles] = useState(false);

  const runSearch = useCallback(async (album: string, artist: string) => {
    if (!album.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const items = await searchMusicBrainz(album, artist);
      setResults(items);
      if (items.length > 0) {
        // Prefer the highest-scoring release matching local track count if available
        const exactCount = items.find((r) => r.track_count === localTrackCount);
        setSelectedMbid((exactCount ?? items[0]).mbid);
      } else {
        setSelectedMbid(null);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not reach MusicBrainz."
      );
      setResults([]);
      setSelectedMbid(null);
    } finally {
      setLoading(false);
    }
  }, [localTrackCount]);

  // Reset form & auto-search whenever modal opens
  useEffect(() => {
    if (!open) return;
    setAlbumQuery(initialAlbum);
    setArtistQuery(initialArtist);
    setApplyMetadata(mode === "identify");
    setApplyArtwork(true);
    setApplyTrackTitles(false);
    void runSearch(initialAlbum, initialArtist);
  }, [open, mode, initialAlbum, initialArtist, runSearch]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !applying) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, applying, onClose]);

  if (!open) return null;

  const selectedRelease = results.find((r) => r.mbid === selectedMbid) ?? null;
  const trackCountMatches =
    selectedRelease !== null &&
    targetPaths.length > 1 &&
    selectedRelease.track_count === targetPaths.length;

  const canApply =
    selectedRelease !== null &&
    !applying &&
    (applyMetadata || applyArtwork || applyTrackTitles);

  async function handleSearchSubmit(event: React.FormEvent) {
    event.preventDefault();
    await runSearch(albumQuery, artistQuery);
  }

  async function handleConfirmApply() {
    if (!selectedRelease || !canApply) return;
    await onApply({
      mbid: selectedRelease.mbid,
      paths: targetPaths,
      apply_metadata: applyMetadata,
      apply_artwork: applyArtwork,
      apply_track_titles: applyTrackTitles,
      trigger_navidrome_scan: true,
    });
  }

  return (
    <div
      id="musicbrainz-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="musicbrainz-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !applying) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-accent">
              <Globe className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="musicbrainz-modal-title"
                className="text-sm font-semibold text-ink-primary"
              >
                {mode === "artwork"
                  ? "Search MusicBrainz Cover Art"
                  : "Identify Album via MusicBrainz"}
              </h2>
              <p className="truncate text-xs text-ink-muted">
                {targetPaths.length === 1
                  ? "Applying to 1 selected track"
                  : `Select a release match to unify metadata & cover art across ${targetPaths.length} tracks`}
              </p>
            </div>
          </div>

          <button
            id="close-musicbrainz-modal-btn"
            type="button"
            disabled={applying}
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
            aria-label="Close MusicBrainz modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search Bar */}
        <form
          onSubmit={handleSearchSubmit}
          className="grid grid-cols-1 gap-2.5 border-b border-border-subtle bg-canvas/50 px-5 py-3.5 sm:grid-cols-[1fr_1fr_auto]"
        >
          <input
            id="mb-album-query-input"
            type="text"
            value={albumQuery}
            onChange={(e) => setAlbumQuery(e.target.value)}
            placeholder="Album title..."
            className="m4-input h-9 text-xs"
            aria-label="Album title"
          />
          <input
            id="mb-artist-query-input"
            type="text"
            value={artistQuery}
            onChange={(e) => setArtistQuery(e.target.value)}
            placeholder="Artist (optional)..."
            className="m4-input h-9 text-xs"
            aria-label="Artist name"
          />
          <button
            id="mb-search-submit-btn"
            type="submit"
            disabled={loading || !albumQuery.trim()}
            className="m4-btn-primary h-9 px-4"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Search
          </button>
        </form>

        {/* Results Grid */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-ink-secondary">
              <Loader2 className="h-5 w-5 animate-spin text-accent" />
              <p className="text-xs">Searching MusicBrainz &amp; Cover Art Archive...</p>
            </div>
          ) : error ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-danger/40 bg-danger/10 p-4 text-xs text-ink-primary">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <div>
                <p className="font-semibold">MusicBrainz search failed</p>
                <p className="mt-0.5 text-ink-secondary">{error}</p>
              </div>
            </div>
          ) : results.length === 0 ? (
            <div className="py-14 text-center text-xs text-ink-muted">
              No matching releases found. Try shortening the album title or removing edition suffixes.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {results.map((release) => {
                const isSelected = release.mbid === selectedMbid;
                const matchesCount =
                  localTrackCount > 0 && release.track_count === localTrackCount;

                return (
                  <button
                    key={release.mbid}
                    type="button"
                    onClick={() => setSelectedMbid(release.mbid)}
                    className={`group flex gap-3.5 rounded-xl border p-3 text-left transition-colors cursor-pointer ${
                      isSelected
                        ? "border-accent bg-accent-soft/60"
                        : "border-border-subtle bg-canvas/60 hover:border-border-strong hover:bg-surface-elevated"
                    }`}
                  >
                    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border-subtle">
                      <CandidateCover
                        url={release.cover_art_url}
                        title={release.title}
                      />
                      {isSelected && (
                        <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[#14110c]">
                          <Check className="h-3 w-3 stroke-[3]" />
                        </span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-ink-primary">
                        {release.title}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-ink-secondary">
                        {release.artist}
                      </p>

                      {release.disambiguation && (
                        <p className="mt-0.5 truncate text-[11px] italic text-ink-muted">
                          {release.disambiguation}
                        </p>
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                        {release.date && (
                          <span className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-ink-secondary">
                            {release.date}
                          </span>
                        )}
                        {release.country && (
                          <span className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-ink-muted">
                            {release.country}
                          </span>
                        )}
                        {release.track_count > 0 && (
                          <span
                            className={`rounded border px-1.5 py-0.5 ${
                              matchesCount
                                ? "border-ok/40 bg-ok/10 text-ok"
                                : "border-border-subtle bg-surface text-ink-muted"
                            }`}
                          >
                            {release.track_count} tracks
                          </span>
                        )}
                        {release.format && (
                          <span className="truncate text-ink-muted">
                            {release.format}
                          </span>
                        )}
                      </div>

                      {release.label && (
                        <p className="mt-1 truncate text-[10px] text-ink-muted">
                          {release.label}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Apply Options Footer */}
        <div className="border-t border-border-subtle bg-surface px-5 py-3.5 space-y-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <label className="inline-flex items-center gap-2 text-ink-primary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={applyArtwork}
                onChange={(e) => setApplyArtwork(e.target.checked)}
                className="h-3.5 w-3.5 accent-amber-500"
              />
              Replace embedded cover art
            </label>

            <label className="inline-flex items-center gap-2 text-ink-primary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={applyMetadata}
                onChange={(e) => setApplyMetadata(e.target.checked)}
                className="h-3.5 w-3.5 accent-amber-500"
              />
              Replace album tags &amp; MusicBrainz IDs
            </label>

            {targetPaths.length > 1 && (
              <label
                className={`inline-flex items-center gap-2 select-none ${
                  trackCountMatches
                    ? "text-ink-primary cursor-pointer"
                    : "text-ink-muted cursor-pointer"
                }`}
                title={
                  trackCountMatches
                    ? "Match track titles and numbers in order"
                    : "Track count differs from this MusicBrainz release — verify before enabling"
                }
              >
                <input
                  type="checkbox"
                  checked={applyTrackTitles}
                  onChange={(e) => setApplyTrackTitles(e.target.checked)}
                  className="h-3.5 w-3.5 accent-amber-500"
                />
                Also overwrite track titles &amp; numbers
              </label>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="truncate font-mono text-[10px] text-ink-muted">
              {selectedRelease
                ? `MBID: ${selectedRelease.mbid}`
                : "Select a release match above"}
            </p>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={applying}
                onClick={onClose}
                className="m4-btn-secondary"
              >
                Cancel
              </button>
              <button
                id="mb-apply-release-btn"
                type="button"
                disabled={!canApply}
                onClick={handleConfirmApply}
                className="m4-btn-primary"
              >
                {applying ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Applying...
                  </>
                ) : (
                  <>
                    Apply to {targetPaths.length}{" "}
                    {targetPaths.length === 1 ? "Track" : "Tracks"}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
