import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Disc3,
  Globe,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { searchMusicBrainz } from "../api/client";
import type { AlbumGroup, MusicBrainzReleaseCandidate } from "../types/music";

interface CompletenessCheckModalProps {
  album: AlbumGroup | null;
  checkingMbid: string | null;
  onClose: () => void;
  onSelectRelease: (album: AlbumGroup, mbid: string) => void;
}

export function CompletenessCheckModal({
  album,
  checkingMbid,
  onClose,
  onSelectRelease,
}: CompletenessCheckModalProps) {
  const [albumQuery, setAlbumQuery] = useState("");
  const [artistQuery, setArtistQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MusicBrainzReleaseCandidate[]>([]);

  const runSearch = useCallback(async (alb: string, art: string) => {
    if (!alb.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const releases = await searchMusicBrainz(alb.trim(), art.trim() || undefined);
      setResults(releases);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "MusicBrainz search failed"
      );
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!album) return;
    const initAlbum = album.title === "Unknown Album" ? "" : album.title;
    const initArtist = album.artist === "Unknown Artist" ? "" : album.artist;
    setAlbumQuery(initAlbum);
    setArtistQuery(initArtist);
    setResults([]);
    setError(null);
    if (initAlbum) {
      void runSearch(initAlbum, initArtist);
    }
  }, [album, runSearch]);

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
    void runSearch(albumQuery, artistQuery);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        id="completeness-check-modal"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-ink-primary">
                Check Completeness via MusicBrainz
              </h2>
            </div>
            <p className="mt-1 text-xs text-ink-secondary">
              Pick the official MusicBrainz release to diff{" "}
              <span className="font-medium text-ink-primary">{album.title}</span>{" "}
              ({album.track_count} local{" "}
              {album.track_count === 1 ? "track" : "tracks"}) against. Tracklists
              are cached in <code className="font-mono text-[11px]">m4.db</code>{" "}
              and no audio files are modified.
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

        {/* Search Form */}
        <form
          onSubmit={handleSubmit}
          className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-canvas/40 px-5 py-3"
        >
          <input
            type="text"
            value={albumQuery}
            onChange={(e) => setAlbumQuery(e.target.value)}
            placeholder="Album title..."
            className="m4-input flex-1 min-w-[160px] text-xs"
            autoFocus
          />
          <input
            type="text"
            value={artistQuery}
            onChange={(e) => setArtistQuery(e.target.value)}
            placeholder="Artist (optional)..."
            className="m4-input flex-1 min-w-[140px] text-xs"
          />
          <button
            type="submit"
            disabled={searching || !albumQuery.trim()}
            className="m4-btn-primary text-xs"
          >
            {searching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Search
          </button>
        </form>

        {/* Release Candidates */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          {searching ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-xs text-ink-secondary">
              <Loader2 className="h-5 w-5 animate-spin text-accent" />
              <span>Searching MusicBrainz releases...</span>
            </div>
          ) : results.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-strong bg-canvas/30 px-5 py-10 text-center">
              <Disc3 className="mx-auto mb-2.5 h-6 w-6 text-ink-muted opacity-50" />
              <p className="text-xs font-medium text-ink-primary">
                No releases found
              </p>
              <p className="mt-1 text-[11px] text-ink-secondary">
                Adjust the album or artist name and search again.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {results.map((rel) => {
                const isChecking = checkingMbid === rel.mbid;
                const countMatches = rel.track_count === album.track_count;
                const hasMore = rel.track_count > album.track_count;
                return (
                  <div
                    key={rel.mbid}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-canvas/40 p-3 transition-colors hover:border-border-strong hover:bg-surface-elevated/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-xs font-semibold text-ink-primary">
                          {rel.title}
                        </p>
                        {rel.disambiguation && (
                          <span className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-ink-secondary">
                            {rel.disambiguation}
                          </span>
                        )}
                        <span
                          className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                            countMatches
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                              : hasMore
                                ? "border-accent/35 bg-accent/10 text-accent"
                                : "border-border-subtle bg-surface text-ink-muted"
                          }`}
                        >
                          {rel.track_count} tracks
                          {rel.disc_count > 1 ? ` · ${rel.disc_count} discs` : ""}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-ink-secondary">
                        {rel.artist}
                        {rel.year ? ` · ${rel.year}` : ""}
                        {rel.country ? ` · ${rel.country}` : ""}
                        {rel.format ? ` · ${rel.format}` : ""}
                        {rel.label ? ` · ${rel.label}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={checkingMbid !== null}
                      onClick={() => onSelectRelease(album, rel.mbid)}
                      className="m4-btn-primary shrink-0 text-[11px]"
                    >
                      {isChecking ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      Check Release
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
