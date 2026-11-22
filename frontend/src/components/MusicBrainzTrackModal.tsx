import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  Clock,
  Disc3,
  ExternalLink,
  FileAudio,
  Globe,
  Loader2,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { formatDuration, searchMusicBrainzTrack } from "../api/client";
import type {
  MusicBrainzApplyTrackPayload,
  MusicBrainzTrackCandidate,
  TrackMetadata,
} from "../types/music";

interface MusicBrainzTrackModalProps {
  track: TrackMetadata | null;
  applying: boolean;
  onClose: () => void;
  onApply: (payload: MusicBrainzApplyTrackPayload) => Promise<void>;
}

const GENERIC_FOLDERS = new Set([
  "music",
  "unknown",
  "unknown artist",
  "unknown album",
  "misc",
  "downloads",
  "singles",
  "unsorted",
  "various",
  "temp",
]);

function guessSearchFromTrack(track: TrackMetadata): {
  title: string;
  artist: string;
  album: string;
  guessedFromFilename: boolean;
} {
  let title = (track.title ?? "").trim();
  let artist = (track.artist ?? track.album_artist ?? "").trim();
  let album = (track.album ?? "").trim();
  let guessedFromFilename = false;

  // Strip extension and replace underscores with spaces
  const stem = track.filename
    .replace(/\.[^/.]+$/, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip leading track numbers like "01 - ", "1-04 ", "03. "
  const cleanedStem = stem
    .replace(/^(?:\d{1,2}[-.])?\d{1,3}\s*[-._)]?\s+/, "")
    .trim();

  if (!title && cleanedStem) {
    const parts = cleanedStem.split(/\s+[-–—]\s+/);
    if (parts.length >= 2 && !artist) {
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
      guessedFromFilename = true;
    } else if (parts.length >= 2 && artist) {
      // If artist already known, take the non-artist segment as title
      const second = parts.slice(1).join(" - ").trim();
      title = second || cleanedStem;
      guessedFromFilename = true;
    } else {
      // Avoid useless generic filenames like "Track 01" or "Audio 1"
      if (!/^(track|audio|song|untitled)\s*\d*$/i.test(cleanedStem)) {
        title = cleanedStem;
        guessedFromFilename = true;
      }
    }
  }

  // Fallback to parent folders (Artist/Album/track.mp3) if artist or album are missing
  const segments = track.path.split("/").slice(0, -1).filter(Boolean);
  if (segments.length >= 2) {
    const parentAlbum = segments[segments.length - 1].trim();
    const parentArtist = segments[segments.length - 2].trim();
    if (!album && !GENERIC_FOLDERS.has(parentAlbum.toLowerCase())) {
      album = parentAlbum;
      guessedFromFilename = true;
    }
    if (!artist && !GENERIC_FOLDERS.has(parentArtist.toLowerCase())) {
      artist = parentArtist;
      guessedFromFilename = true;
    }
  } else if (segments.length === 1 && !artist) {
    const folder = segments[0].trim();
    if (!GENERIC_FOLDERS.has(folder.toLowerCase())) {
      artist = folder;
      guessedFromFilename = true;
    }
  }

  return { title, artist, album, guessedFromFilename };
}

function CandidateThumb({ url, alt }: { url: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (!url || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-surface-elevated text-ink-muted">
        <Disc3 className="h-6 w-6 opacity-40" />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover bg-surface-elevated"
    />
  );
}

export function MusicBrainzTrackModal({
  track,
  applying,
  onClose,
  onApply,
}: MusicBrainzTrackModalProps) {
  const [titleQuery, setTitleQuery] = useState("");
  const [artistQuery, setArtistQuery] = useState("");
  const [albumQuery, setAlbumQuery] = useState("");
  const [guessedHint, setGuessedHint] = useState(false);

  const [results, setResults] = useState<MusicBrainzTrackCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [applyArtwork, setApplyArtwork] = useState(true);

  const runSearch = useCallback(
    async (title: string, artist: string, album: string, duration?: number) => {
      if (!title.trim() && !artist.trim() && !album.trim()) {
        setResults([]);
        setSelectedIdx(null);
        return;
      }
      setLoading(true);
      setError(null);
      setHasSearched(true);
      try {
        const items = await searchMusicBrainzTrack(title, artist, album, duration);
        setResults(items);
        setSelectedIdx(items.length > 0 ? 0 : null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not reach MusicBrainz."
        );
        setResults([]);
        setSelectedIdx(null);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Pre-fill from tags or filename heuristics and auto-search when opened
  useEffect(() => {
    if (!track) return;
    const guessed = guessSearchFromTrack(track);
    setTitleQuery(guessed.title);
    setArtistQuery(guessed.artist);
    setAlbumQuery(guessed.album);
    setGuessedHint(guessed.guessedFromFilename);
    setApplyArtwork(true);
    setResults([]);
    setSelectedIdx(null);
    setError(null);
    setHasSearched(false);

    if (guessed.title || guessed.artist) {
      void runSearch(guessed.title, guessed.artist, guessed.album, track.duration);
    }
  }, [track, runSearch]);

  useEffect(() => {
    if (!track) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !applying) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [track, applying, onClose]);

  if (!track) return null;

  const selected =
    selectedIdx !== null && selectedIdx >= 0 && selectedIdx < results.length
      ? results[selectedIdx]
      : null;

  const canSearch =
    Boolean(titleQuery.trim() || artistQuery.trim() || albumQuery.trim()) &&
    !loading;

  async function handleSearchSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!track || !canSearch) return;
    await runSearch(titleQuery, artistQuery, albumQuery, track.duration);
  }

  async function handleConfirmApply() {
    if (!track || !selected || applying) return;
    await onApply({
      path: track.path,
      title: selected.title,
      artist: selected.artist,
      album_artist: selected.album_artist ?? selected.artist,
      album: selected.album,
      year: selected.year,
      release_date: selected.date,
      track_number: selected.track_number,
      disc_number: selected.disc_number,
      release_mbid: selected.release_mbid,
      artist_mbid: selected.artist_mbid,
      apply_artwork: applyArtwork && Boolean(selected.release_mbid),
      trigger_navidrome_scan: true,
    });
  }

  return (
    <div
      id="musicbrainz-track-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="musicbrainz-track-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !applying) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-accent">
              <Globe className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2
                  id="musicbrainz-track-modal-title"
                  className="text-sm font-semibold text-ink-primary"
                >
                  Identify Single Track via MusicBrainz
                </h2>
                {guessedHint && (
                  <span className="inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    <Sparkles className="h-2.5 w-2.5" />
                    Pre-filled from filename
                  </span>
                )}
              </div>
              <p className="mt-0.5 flex items-center gap-2 truncate font-mono text-[11px] text-ink-muted">
                <FileAudio className="h-3 w-3 shrink-0" />
                <span className="truncate">{track.path}</span>
                {track.duration > 0 && (
                  <span className="shrink-0 text-ink-secondary">
                    · {formatDuration(track.duration)}
                  </span>
                )}
              </p>
            </div>
          </div>

          <button
            id="close-track-mb-modal-btn"
            type="button"
            disabled={applying}
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
            aria-label="Close track identification modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search Form */}
        <form
          onSubmit={handleSearchSubmit}
          className="grid grid-cols-1 gap-2 border-b border-border-subtle bg-canvas/50 px-5 py-3.5 sm:grid-cols-[1.2fr_1fr_1fr_auto]"
        >
          <input
            id="mb-track-title-input"
            type="text"
            value={titleQuery}
            onChange={(e) => setTitleQuery(e.target.value)}
            placeholder="Track title..."
            className="m4-input h-9 text-xs"
            aria-label="Track title"
          />
          <input
            id="mb-track-artist-input"
            type="text"
            value={artistQuery}
            onChange={(e) => setArtistQuery(e.target.value)}
            placeholder="Artist (optional)..."
            className="m4-input h-9 text-xs"
            aria-label="Artist name"
          />
          <input
            id="mb-track-album-input"
            type="text"
            value={albumQuery}
            onChange={(e) => setAlbumQuery(e.target.value)}
            placeholder="Album (optional)..."
            className="m4-input h-9 text-xs"
            aria-label="Album name"
          />
          <button
            id="mb-track-search-btn"
            type="submit"
            disabled={!canSearch}
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

        {/* Results List */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-ink-secondary">
              <Loader2 className="h-5 w-5 animate-spin text-accent" />
              <p className="text-xs">Searching MusicBrainz recordings...</p>
            </div>
          ) : error ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-danger/40 bg-danger/10 p-4 text-xs text-ink-primary">
              <div className="flex items-start gap-2.5 min-w-0">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <div>
                  <p className="font-semibold">MusicBrainz search failed</p>
                  <p className="mt-0.5 text-ink-secondary">{error}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  void runSearch(titleQuery, artistQuery, albumQuery, track.duration)
                }
                className="m4-btn-secondary shrink-0 h-7 px-2.5 text-[11px]"
              >
                Retry
              </button>
            </div>
          ) : !hasSearched ? (
            <div className="py-14 text-center text-xs text-ink-muted">
              Enter a track title or artist above to search MusicBrainz for matching recordings and album info.
            </div>
          ) : results.length === 0 ? (
            <div className="py-14 text-center text-xs text-ink-muted">
              No matching recordings found. Try searching with just the song title or artist name.
            </div>
          ) : (
            <div className="space-y-2.5">
              {results.map((item, idx) => {
                const isSelected = idx === selectedIdx;
                const candSec = item.length_ms ? item.length_ms / 1000 : null;
                const durationMatches =
                  candSec !== null &&
                  track.duration > 0 &&
                  Math.abs(candSec - track.duration) <= 5.0;

                return (
                  <button
                    key={`${item.recording_mbid}-${item.release_mbid ?? idx}`}
                    type="button"
                    onClick={() => setSelectedIdx(idx)}
                    className={`flex w-full items-center gap-3.5 rounded-xl border p-3 text-left transition-colors cursor-pointer ${
                      isSelected
                        ? "border-accent bg-accent-soft/60"
                        : "border-border-subtle bg-canvas/60 hover:border-border-strong hover:bg-surface-elevated"
                    }`}
                  >
                    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border-subtle">
                      <CandidateThumb
                        url={item.cover_art_url}
                        alt={item.album ?? item.title}
                      />
                      {isSelected && (
                        <span className="absolute right-1 top-1 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-accent text-[#14110c]">
                          <Check className="h-2.5 w-2.5 stroke-[3]" />
                        </span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-xs font-semibold text-ink-primary">
                          {item.title}
                        </p>
                        {candSec !== null && (
                          <span
                            className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                              durationMatches
                                ? "border-ok/40 bg-ok/10 text-ok"
                                : "border-border-subtle bg-surface text-ink-muted"
                            }`}
                            title={
                              durationMatches
                                ? "Duration matches your local audio file"
                                : "Recording duration"
                            }
                          >
                            <Clock className="h-2.5 w-2.5" />
                            {formatDuration(candSec)}
                          </span>
                        )}
                      </div>

                      <p className="mt-0.5 truncate text-xs text-ink-secondary">
                        {item.artist}
                        {item.album && (
                          <>
                            <span className="mx-1.5 text-ink-muted">·</span>
                            <span className="text-ink-primary">{item.album}</span>
                          </>
                        )}
                      </p>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
                        {item.date && (
                          <span className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-ink-secondary">
                            {item.date}
                          </span>
                        )}
                        {item.track_number && (
                          <span className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-ink-muted">
                            Track {item.track_number}
                          </span>
                        )}
                        {item.release_type && (
                          <span className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-ink-muted">
                            {item.release_type}
                          </span>
                        )}
                        {item.country && (
                          <span className="text-ink-muted">{item.country}</span>
                        )}
                        <a
                          href={`https://musicbrainz.org/recording/${item.recording_mbid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-ink-muted hover:border-accent/50 hover:text-accent transition-colors"
                          title={`Open recording ${item.recording_mbid} on MusicBrainz`}
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          <span>Recording</span>
                        </a>
                        {item.release_mbid && (
                          <a
                            href={`https://musicbrainz.org/release/${item.release_mbid}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-ink-muted hover:border-accent/50 hover:text-accent transition-colors"
                            title={`Open release ${item.release_mbid} on MusicBrainz`}
                          >
                            <ExternalLink className="h-2.5 w-2.5" />
                            <span>Release</span>
                          </a>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle bg-surface px-5 py-3.5">
          <label className="inline-flex items-center gap-2 text-xs text-ink-primary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={applyArtwork}
              disabled={!selected?.release_mbid}
              onChange={(e) => setApplyArtwork(e.target.checked)}
              className="h-3.5 w-3.5 accent-amber-500"
            />
            Embed album cover art from Cover Art Archive
          </label>

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
              id="mb-apply-track-btn"
              type="button"
              disabled={!selected || applying}
              onClick={handleConfirmApply}
              className="m4-btn-primary"
            >
              {applying ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Writing Tags...
                </>
              ) : (
                "Apply to Track"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
