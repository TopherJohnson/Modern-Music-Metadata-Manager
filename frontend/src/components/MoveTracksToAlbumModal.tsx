import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Disc3,
  FolderInput,
  FolderTree,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { getArtworkUrl } from "../api/client";
import { extractAlbumCanonical } from "./MergeAlbumsModal";
import type {
  AlbumGroup,
  AlbumMergePayload,
  OrganizeSettings,
  TrackMetadata,
  TrackPositionOverride,
} from "../types/music";

interface MoveTracksToAlbumModalProps {
  tracks: TrackMetadata[];
  sourceAlbumId: string | null;
  allAlbums: AlbumGroup[];
  artworkRevision: number;
  organizeSettings: OrganizeSettings;
  moving: boolean;
  onClose: () => void;
  onConfirmMove: (payload: AlbumMergePayload) => Promise<void>;
}

function parseLeadingNum(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d+)/);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function MoveTracksToAlbumModal({
  tracks,
  sourceAlbumId,
  allAlbums,
  artworkRevision,
  organizeSettings,
  moving,
  onClose,
  onConfirmMove,
}: MoveTracksToAlbumModalProps) {
  const open = tracks.length > 0;
  const [search, setSearch] = useState("");
  const [targetAlbumId, setTargetAlbumId] = useState<string | null>(null);
  const [copyArtwork, setCopyArtwork] = useState(true);
  const [reorganize, setReorganize] = useState(false);
  const [posDrafts, setPosDrafts] = useState<
    Record<string, { disc: string; track: string }>
  >({});

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setTargetAlbumId(null);
    setCopyArtwork(true);
    setReorganize(organizeSettings.enabled);
    const drafts: Record<string, { disc: string; track: string }> = {};
    for (const t of tracks) {
      drafts[t.path] = {
        disc: t.disc_number ?? "",
        track: t.track_number ?? "",
      };
    }
    setPosDrafts(drafts);
  }, [open, tracks, organizeSettings.enabled]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !moving) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, moving, onClose]);

  const candidateAlbums = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Prefer albums by the same artist at the top when search is empty
    const trackArtists = new Set(
      tracks
        .map((t) => (t.album_artist || t.artist || "").trim().toLowerCase())
        .filter(Boolean)
    );
    return allAlbums
      .filter((a) => a.id !== sourceAlbumId)
      .filter(
        (a) =>
          !q ||
          a.title.toLowerCase().includes(q) ||
          a.artist.toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const aSame = trackArtists.has(a.artist.toLowerCase()) ? 0 : 1;
        const bSame = trackArtists.has(b.artist.toLowerCase()) ? 0 : 1;
        if (aSame !== bSame) return aSame - bSame;
        return a.title.localeCompare(b.title);
      });
  }, [allAlbums, sourceAlbumId, search, tracks]);

  const targetAlbum = useMemo(
    () => allAlbums.find((a) => a.id === targetAlbumId) ?? null,
    [allAlbums, targetAlbumId]
  );

  const targetCanonical = useMemo(
    () => (targetAlbum ? extractAlbumCanonical(targetAlbum) : null),
    [targetAlbum]
  );

  // Detect collisions between moved tracks' draft disc/track # and existing tracks in targetAlbum
  const existingTargetKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!targetAlbum) return keys;
    for (const t of targetAlbum.tracks) {
      const d = parseLeadingNum(t.disc_number) ?? 1;
      const n = parseLeadingNum(t.track_number);
      if (n !== null) keys.add(`${d}:${n}`);
    }
    return keys;
  }, [targetAlbum]);

  if (!open) return null;

  async function handleSubmit() {
    if (!targetAlbum || !targetCanonical || moving) return;

    const overrides: TrackPositionOverride[] = [];
    for (const t of tracks) {
      const draft = posDrafts[t.path];
      if (!draft) continue;
      const nextTrack = cleanOrNull(draft.track);
      const nextDisc = cleanOrNull(draft.disc);
      const origTrack = cleanOrNull(t.track_number ?? "");
      const origDisc = cleanOrNull(t.disc_number ?? "");
      if (nextTrack !== origTrack || nextDisc !== origDisc) {
        const ov: TrackPositionOverride = { path: t.path };
        if (nextTrack !== origTrack) ov.track_number = nextTrack;
        if (nextDisc !== origDisc) ov.disc_number = nextDisc;
        overrides.push(ov);
      }
    }

    await onConfirmMove({
      paths: tracks.map((t) => t.path),
      album: targetCanonical.album || targetAlbum.title,
      album_artist: cleanOrNull(targetCanonical.album_artist),
      year: cleanOrNull(targetCanonical.year),
      release_date: cleanOrNull(targetCanonical.release_date),
      genre: cleanOrNull(targetCanonical.genre),
      album_version: cleanOrNull(targetCanonical.album_version),
      compilation: cleanOrNull(targetCanonical.compilation),
      musicbrainz_album_id: cleanOrNull(targetCanonical.musicbrainz_album_id),
      musicbrainz_album_artist_id: cleanOrNull(
        targetCanonical.musicbrainz_album_artist_id
      ),
      track_overrides: overrides,
      artwork_source_path:
        copyArtwork && targetAlbum.cover_track_path
          ? targetAlbum.cover_track_path
          : null,
      reorganize: organizeSettings.enabled && reorganize,
      trigger_navidrome_scan: true,
    });
  }

  return (
    <div
      id="move-tracks-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-tracks-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !moving) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-accent">
              <FolderInput className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="move-tracks-modal-title"
                className="text-sm font-semibold text-ink-primary"
              >
                Move {tracks.length}{" "}
                {tracks.length === 1 ? "Track" : "Tracks"} to Another Album
              </h2>
              <p className="truncate text-xs text-ink-muted">
                Copies the target album&apos;s tags &amp; Navidrome PID fields onto the selected track{tracks.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <button
            id="close-move-tracks-modal-btn"
            type="button"
            disabled={moving}
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
            aria-label="Close move tracks modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Tracks being moved (with optional inline disc/track # edit) */}
          <div className="rounded-xl border border-border-subtle bg-canvas/60 p-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
              Tracks to Move
            </p>
            <div className="max-h-32 overflow-y-auto space-y-1.5">
              {tracks.map((t) => {
                const draft = posDrafts[t.path] ?? {
                  disc: t.disc_number ?? "",
                  track: t.track_number ?? "",
                };
                const dNum = parseLeadingNum(draft.disc) ?? 1;
                const tNum = parseLeadingNum(draft.track);
                const collides =
                  targetAlbum !== null &&
                  tNum !== null &&
                  existingTargetKeys.has(`${dNum}:${tNum}`);

                return (
                  <div
                    key={t.path}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate text-ink-primary font-medium">
                      {t.title || t.filename}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {collides && (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-warn/15 px-1.5 py-0.5 font-mono text-[10px] text-warn"
                          title="Target album already has a track with this number"
                        >
                          <AlertTriangle className="h-2.5 w-2.5" /># exists
                        </span>
                      )}
                      <input
                        type="text"
                        value={draft.disc}
                        onChange={(e) =>
                          setPosDrafts((p) => ({
                            ...p,
                            [t.path]: { ...draft, disc: e.target.value },
                          }))
                        }
                        placeholder="Disc"
                        aria-label={`Disc number for ${t.title || t.filename}`}
                        className="m4-input h-6 w-12 px-1.5 font-mono text-[10px]"
                      />
                      <input
                        type="text"
                        value={draft.track}
                        onChange={(e) =>
                          setPosDrafts((p) => ({
                            ...p,
                            [t.path]: { ...draft, track: e.target.value },
                          }))
                        }
                        placeholder="Track #"
                        aria-label={`Track number for ${t.title || t.filename}`}
                        className={`m4-input h-6 w-16 px-1.5 font-mono text-[10px] ${
                          collides ? "border-warn text-warn" : ""
                        }`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Target Album Search & List */}
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
              <input
                id="move-target-album-search"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search target album or artist..."
                className="m4-input h-9 pl-9 text-xs"
                autoFocus
              />
            </div>

            <div className="max-h-56 overflow-y-auto rounded-xl border border-border-subtle bg-canvas/60 divide-y divide-border-subtle/50">
              {candidateAlbums.length === 0 ? (
                <div className="py-10 text-center text-xs text-ink-muted">
                  No matching albums found.
                </div>
              ) : (
                candidateAlbums.map((album) => {
                  const isSelected = album.id === targetAlbumId;
                  return (
                    <button
                      key={album.id}
                      type="button"
                      onClick={() => setTargetAlbumId(album.id)}
                      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-accent-soft/70"
                          : "hover:bg-surface-elevated"
                      }`}
                    >
                      {album.cover_track_path ? (
                        <img
                          src={getArtworkUrl(
                            album.cover_track_path,
                            artworkRevision
                          )}
                          alt=""
                          loading="lazy"
                          className="h-10 w-10 shrink-0 rounded-md object-cover border border-border-subtle bg-surface-elevated"
                        />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-surface-elevated text-ink-muted">
                          <Disc3 className="h-4 w-4 opacity-50" />
                        </div>
                      )}

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-ink-primary">
                          {album.title}
                        </p>
                        <p className="truncate text-[11px] text-ink-secondary">
                          {album.artist}
                          {album.year ? ` · ${album.year}` : ""}
                        </p>
                      </div>

                      <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                        {album.track_count}t
                      </span>

                      {isSelected && (
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[#14110c]">
                          <Check className="h-3 w-3 stroke-[3]" />
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Options when target selected */}
          {targetAlbum && targetCanonical && (
            <div className="rounded-xl border border-border-subtle bg-canvas/60 p-3.5 space-y-2.5 text-xs">
              <p className="text-[11px] text-ink-secondary">
                Will apply{" "}
                <strong className="text-ink-primary">
                  {targetCanonical.album || targetAlbum.title}
                </strong>{" "}
                by{" "}
                <strong className="text-ink-primary">
                  {targetCanonical.album_artist || targetAlbum.artist}
                </strong>
                {targetCanonical.year ? ` (${targetCanonical.year})` : ""} and
                unify Navidrome grouping tags.
              </p>

              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {targetAlbum.cover_track_path && (
                  <label className="inline-flex items-center gap-2 text-ink-primary cursor-pointer select-none">
                    <input
                      id="move-copy-artwork-checkbox"
                      type="checkbox"
                      checked={copyArtwork}
                      onChange={(e) => setCopyArtwork(e.target.checked)}
                      className="h-3.5 w-3.5 accent-amber-500"
                    />
                    Copy target album&apos;s cover art
                  </label>
                )}

                {organizeSettings.enabled && (
                  <label className="inline-flex items-center gap-2 text-ink-primary cursor-pointer select-none">
                    <input
                      id="move-reorganize-checkbox"
                      type="checkbox"
                      checked={reorganize}
                      onChange={(e) => setReorganize(e.target.checked)}
                      className="h-3.5 w-3.5 accent-amber-500"
                    />
                    <FolderTree className="h-3.5 w-3.5 text-accent" />
                    Move file{tracks.length === 1 ? "" : "s"} into target folder
                  </label>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface px-5 py-3.5">
          <button
            type="button"
            disabled={moving}
            onClick={onClose}
            className="m4-btn-secondary"
          >
            Cancel
          </button>
          <button
            id="confirm-move-tracks-btn"
            type="button"
            disabled={!targetAlbum || moving}
            onClick={() => void handleSubmit()}
            className="m4-btn-primary"
          >
            {moving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Moving...
              </>
            ) : (
              <>
                <FolderInput className="h-3.5 w-3.5" />
                Move {tracks.length}{" "}
                {tracks.length === 1 ? "Track" : "Tracks"}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
