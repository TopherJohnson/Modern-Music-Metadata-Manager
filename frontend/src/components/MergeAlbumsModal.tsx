import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Disc3,
  FolderTree,
  GitMerge,
  Globe,
  Hash,
  Images,
  Loader2,
  Plus,
  Search,
  X,
} from "lucide-react";
import { formatDuration, formatFileSize, getArtworkUrl } from "../api/client";
import type {
  AlbumGroup,
  AlbumMergePayload,
  ArtworkVariant,
  OrganizeSettings,
  TrackMetadata,
  TrackPositionOverride,
} from "../types/music";

interface MergeAlbumsModalProps {
  open: boolean;
  initialAlbums: AlbumGroup[];
  allAlbums: AlbumGroup[];
  artworkRevision: number;
  organizeSettings: OrganizeSettings;
  merging: boolean;
  onClose: () => void;
  onMerge: (payload: AlbumMergePayload) => Promise<void>;
  onIdentifyCombinedMusicBrainz: (
    albumHint: string,
    artistHint: string,
    paths: string[]
  ) => void;
}

interface CanonicalForm {
  album: string;
  album_artist: string;
  year: string;
  release_date: string;
  genre: string;
  album_version: string;
  compilation: string;
  musicbrainz_album_id: string;
  musicbrainz_album_artist_id: string;
}

interface TrackPosDraft {
  disc: string;
  track: string;
}

function mostCommonNonEmpty(values: Array<string | null | undefined>): string {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const cleaned = (raw ?? "").trim();
    if (!cleaned) continue;
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [val, count] of counts.entries()) {
    if (count > bestCount) {
      best = val;
      bestCount = count;
    }
  }
  return best;
}

export function extractAlbumCanonical(album: AlbumGroup): CanonicalForm {
  const tracks = album.tracks;
  const fallbackAlbum = album.title === "Unknown Album" ? "" : album.title;
  const fallbackArtist = album.artist === "Unknown Artist" ? "" : album.artist;
  return {
    album: mostCommonNonEmpty(tracks.map((t) => t.album)) || fallbackAlbum,
    album_artist:
      mostCommonNonEmpty(tracks.map((t) => t.album_artist)) ||
      mostCommonNonEmpty(tracks.map((t) => t.artist)) ||
      fallbackArtist,
    year: mostCommonNonEmpty(tracks.map((t) => t.year)) || (album.year ?? ""),
    release_date: mostCommonNonEmpty(tracks.map((t) => t.release_date)),
    genre: mostCommonNonEmpty(tracks.map((t) => t.genre)) || (album.genre ?? ""),
    album_version: mostCommonNonEmpty(tracks.map((t) => t.album_version)),
    compilation: mostCommonNonEmpty(tracks.map((t) => t.compilation)),
    musicbrainz_album_id: mostCommonNonEmpty(
      tracks.map((t) => t.musicbrainz_album_id)
    ),
    musicbrainz_album_artist_id: mostCommonNonEmpty(
      tracks.map((t) => t.musicbrainz_album_artist_id)
    ),
  };
}

function parseLeadingNum(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = raw.trim().match(/^(\d+)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cleanOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function MergeAlbumsModal({
  open,
  initialAlbums,
  allAlbums,
  artworkRevision,
  organizeSettings,
  merging,
  onClose,
  onMerge,
  onIdentifyCombinedMusicBrainz,
}: MergeAlbumsModalProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [templateAlbumId, setTemplateAlbumId] = useState<string | null>(null);
  const [form, setForm] = useState<CanonicalForm>({
    album: "",
    album_artist: "",
    year: "",
    release_date: "",
    genre: "",
    album_version: "",
    compilation: "",
    musicbrainz_album_id: "",
    musicbrainz_album_artist_id: "",
  });
  const [showPidTags, setShowPidTags] = useState(false);
  const [selectedArtSource, setSelectedArtSource] = useState<string | null>(null);
  const [posDrafts, setPosDrafts] = useState<Record<string, TrackPosDraft>>({});
  const [reorganize, setReorganize] = useState(false);

  const [showAddPicker, setShowAddPicker] = useState(false);
  const [addSearch, setAddSearch] = useState("");

  // Initialize state whenever modal opens
  useEffect(() => {
    if (!open || initialAlbums.length === 0) return;

    const sortedInit = [...initialAlbums].sort(
      (a, b) => b.track_count - a.track_count
    );
    const primary = sortedInit[0];
    setSelectedIds(initialAlbums.map((a) => a.id));
    setTemplateAlbumId(primary.id);
    setForm(extractAlbumCanonical(primary));
    setReorganize(organizeSettings.enabled);
    setShowAddPicker(false);
    setAddSearch("");

    // Pre-populate per-track disc/track draft map
    const drafts: Record<string, TrackPosDraft> = {};
    for (const album of initialAlbums) {
      for (const track of album.tracks) {
        drafts[track.path] = {
          disc: track.disc_number ?? "",
          track: track.track_number ?? "",
        };
      }
    }
    setPosDrafts(drafts);

    // Check if PID fields differ across selected albums to auto-open PID section
    const allInitTracks = initialAlbums.flatMap((a) => a.tracks);
    const pidDiffers = (
      [
        "release_date",
        "album_version",
        "compilation",
        "musicbrainz_album_id",
        "musicbrainz_album_artist_id",
      ] as const
    ).some((key) => {
      const vals = new Set(allInitTracks.map((t) => (t[key] ?? "").trim()));
      return vals.size > 1;
    });
    setShowPidTags(pidDiffers);

    // Default to the most common embedded cover if any tracks have art
    const coverBuckets = new Map<string, { samplePath: string; count: number }>();
    for (const a of initialAlbums) {
      for (const v of a.artwork_variants) {
        const prev = coverBuckets.get(v.hash);
        if (prev) {
          prev.count += v.track_count;
        } else {
          coverBuckets.set(v.hash, {
            samplePath: v.sample_track_path,
            count: v.track_count,
          });
        }
      }
    }
    const sortedCovers = Array.from(coverBuckets.values()).sort(
      (a, b) => b.count - a.count
    );
    setSelectedArtSource(sortedCovers[0]?.samplePath ?? null);
  }, [open, initialAlbums, organizeSettings.enabled]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !merging) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, merging, onClose]);

  const includedAlbums = useMemo(() => {
    const byId = new Map(allAlbums.map((a) => [a.id, a]));
    return selectedIds
      .map((id) => byId.get(id))
      .filter((a): a is AlbumGroup => a !== undefined);
  }, [allAlbums, selectedIds]);

  // Deduplicated artwork variants across all included albums
  const mergedArtworkVariants = useMemo<ArtworkVariant[]>(() => {
    const map = new Map<string, ArtworkVariant>();
    for (const album of includedAlbums) {
      for (const v of album.artwork_variants) {
        const existing = map.get(v.hash);
        if (existing) {
          existing.track_count += v.track_count;
          existing.track_paths = [...existing.track_paths, ...v.track_paths];
        } else {
          map.set(v.hash, { ...v, track_paths: [...v.track_paths] });
        }
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => b.track_count - a.track_count || b.size - a.size
    );
  }, [includedAlbums]);

  // Combined tracks sorted by current draft (disc, track, filename)
  const combinedTracks = useMemo(() => {
    const items: Array<{ track: TrackMetadata; sourceAlbum: AlbumGroup }> = [];
    const seen = new Set<string>();
    for (const album of includedAlbums) {
      for (const track of album.tracks) {
        if (seen.has(track.path)) continue;
        seen.add(track.path);
        items.push({ track, sourceAlbum: album });
      }
    }
    items.sort((a, b) => {
      const da = posDrafts[a.track.path];
      const db = posDrafts[b.track.path];
      const discA = parseLeadingNum(da?.disc ?? a.track.disc_number) ?? 1;
      const discB = parseLeadingNum(db?.disc ?? b.track.disc_number) ?? 1;
      if (discA !== discB) return discA - discB;
      const trkA = parseLeadingNum(da?.track ?? a.track.track_number) ?? 999999;
      const trkB = parseLeadingNum(db?.track ?? b.track.track_number) ?? 999999;
      if (trkA !== trkB) return trkA - trkB;
      return a.track.filename.localeCompare(b.track.filename);
    });
    return items;
  }, [includedAlbums, posDrafts]);

  // Collision & gap detection across the combined tracklist
  const trackDiagnostics = useMemo(() => {
    const keyCounts = new Map<string, number>();
    const numsByDisc = new Map<number, Set<number>>();

    for (const { track } of combinedTracks) {
      const draft = posDrafts[track.path];
      const discNum = parseLeadingNum(draft?.disc ?? track.disc_number) ?? 1;
      const trackNum = parseLeadingNum(draft?.track ?? track.track_number);
      if (trackNum !== null) {
        const key = `${discNum}:${trackNum}`;
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
        const set = numsByDisc.get(discNum) ?? new Set<number>();
        set.add(trackNum);
        numsByDisc.set(discNum, set);
      }
    }

    const collidingKeys = new Set<string>();
    for (const [key, count] of keyCounts.entries()) {
      if (count > 1) collidingKeys.add(key);
    }

    const gaps: string[] = [];
    const multiDisc = numsByDisc.size > 1;
    for (const [disc, numSet] of Array.from(numsByDisc.entries()).sort(
      (a, b) => a[0] - b[0]
    )) {
      const maxNum = Math.max(...numSet);
      for (let n = 1; n <= maxNum; n += 1) {
        if (!numSet.has(n)) {
          gaps.push(multiDisc ? `${disc}-${n}` : String(n));
        }
      }
    }

    return {
      collidingKeys,
      collisionCount: collidingKeys.size,
      gaps,
    };
  }, [combinedTracks, posDrafts]);

  const addableAlbums = useMemo(() => {
    const selectedSet = new Set(selectedIds);
    const q = addSearch.trim().toLowerCase();
    return allAlbums
      .filter((a) => !selectedSet.has(a.id))
      .filter(
        (a) =>
          !q ||
          a.title.toLowerCase().includes(q) ||
          a.artist.toLowerCase().includes(q)
      )
      .slice(0, 30);
  }, [allAlbums, selectedIds, addSearch]);

  if (!open) return null;

  function handleSelectTemplate(album: AlbumGroup) {
    setTemplateAlbumId(album.id);
    setForm(extractAlbumCanonical(album));
  }

  function handleAddAlbum(album: AlbumGroup) {
    setSelectedIds((prev) => [...prev, album.id]);
    setPosDrafts((prev) => {
      const next = { ...prev };
      for (const track of album.tracks) {
        if (!next[track.path]) {
          next[track.path] = {
            disc: track.disc_number ?? "",
            track: track.track_number ?? "",
          };
        }
      }
      return next;
    });
    setShowAddPicker(false);
    setAddSearch("");
  }

  function handleRemoveAlbum(albumId: string) {
    if (selectedIds.length <= 1) return;
    setSelectedIds((prev) => prev.filter((id) => id !== albumId));
    if (templateAlbumId === albumId) {
      const remaining = includedAlbums.find((a) => a.id !== albumId);
      if (remaining) {
        setTemplateAlbumId(remaining.id);
      }
    }
  }

  function handlePosChange(path: string, field: "disc" | "track", value: string) {
    setPosDrafts((prev) => ({
      ...prev,
      [path]: {
        disc: prev[path]?.disc ?? "",
        track: prev[path]?.track ?? "",
        [field]: value,
      },
    }));
  }

  function handleAutoNumber() {
    const total = combinedTracks.length;
    setPosDrafts((prev) => {
      const next = { ...prev };
      combinedTracks.forEach(({ track }, idx) => {
        next[track.path] = {
          disc: "1/1",
          track: `${idx + 1}/${total}`,
        };
      });
      return next;
    });
  }

  async function handleConfirmMerge() {
    if (merging || !form.album.trim() || combinedTracks.length === 0) return;

    const trackOverrides: TrackPositionOverride[] = [];
    for (const { track } of combinedTracks) {
      const draft = posDrafts[track.path];
      if (!draft) continue;
      const nextTrack = cleanOrNull(draft.track);
      const nextDisc = cleanOrNull(draft.disc);
      const origTrack = cleanOrNull(track.track_number ?? "");
      const origDisc = cleanOrNull(track.disc_number ?? "");
      if (nextTrack !== origTrack || nextDisc !== origDisc) {
        const ov: TrackPositionOverride = { path: track.path };
        if (nextTrack !== origTrack) ov.track_number = nextTrack;
        if (nextDisc !== origDisc) ov.disc_number = nextDisc;
        trackOverrides.push(ov);
      }
    }

    await onMerge({
      paths: combinedTracks.map((item) => item.track.path),
      album: form.album.trim(),
      album_artist: cleanOrNull(form.album_artist),
      year: cleanOrNull(form.year),
      release_date: cleanOrNull(form.release_date),
      genre: cleanOrNull(form.genre),
      album_version: cleanOrNull(form.album_version),
      compilation: cleanOrNull(form.compilation),
      musicbrainz_album_id: cleanOrNull(form.musicbrainz_album_id),
      musicbrainz_album_artist_id: cleanOrNull(form.musicbrainz_album_artist_id),
      track_overrides: trackOverrides,
      artwork_source_path: selectedArtSource,
      reorganize: organizeSettings.enabled && reorganize,
      trigger_navidrome_scan: true,
    });
  }

  const canSubmit = !merging && form.album.trim().length > 0 && combinedTracks.length > 0;

  return (
    <div
      id="merge-albums-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="merge-albums-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !merging) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-accent">
              <GitMerge className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="merge-albums-modal-title"
                className="text-sm font-semibold text-ink-primary"
              >
                Merge Albums ({includedAlbums.length} albums · {combinedTracks.length}{" "}
                {combinedTracks.length === 1 ? "track" : "tracks"})
              </h2>
              <p className="truncate text-xs text-ink-muted">
                Unify album tags, Navidrome grouping IDs, cover art, and track numbering in one undoable batch
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              id="merge-identify-mb-btn"
              type="button"
              disabled={merging || combinedTracks.length === 0}
              onClick={() =>
                onIdentifyCombinedMusicBrainz(
                  form.album,
                  form.album_artist,
                  combinedTracks.map((c) => c.track.path)
                )
              }
              className="m4-btn-secondary h-8 px-2.5 text-xs"
              title="Identify the combined tracks via MusicBrainz with smart track matching"
            >
              <Globe className="h-3.5 w-3.5 text-accent" />
              <span className="hidden sm:inline">Identify via MusicBrainz</span>
            </button>
            <button
              id="close-merge-albums-modal-btn"
              type="button"
              disabled={merging}
              onClick={onClose}
              className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
              aria-label="Close merge modal"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* 1. Included Albums + Add Album Picker */}
          <section className="space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                1. Albums Included &amp; Template Source
              </h3>
              <button
                id="merge-add-album-toggle-btn"
                type="button"
                onClick={() => setShowAddPicker((prev) => !prev)}
                className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-canvas px-2 py-1 text-[11px] font-medium text-ink-secondary hover:border-border-strong hover:text-ink-primary cursor-pointer"
              >
                <Plus className="h-3 w-3 text-accent" />
                Add Album
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {includedAlbums.map((album) => {
                const isTemplate = album.id === templateAlbumId;
                return (
                  <div
                    key={album.id}
                    className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                      isTemplate
                        ? "border-accent bg-accent-soft/70 text-ink-primary"
                        : "border-border-subtle bg-canvas text-ink-secondary"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectTemplate(album)}
                      className="flex items-center gap-1.5 text-left cursor-pointer"
                      title="Use this album's tags as the canonical template"
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full border ${
                          isTemplate
                            ? "border-accent bg-accent"
                            : "border-ink-muted"
                        }`}
                      />
                      <span className="max-w-[200px] truncate font-medium">
                        {album.title}
                      </span>
                      <span className="font-mono text-[10px] text-ink-muted">
                        ({album.track_count}t)
                      </span>
                    </button>
                    {includedAlbums.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveAlbum(album.id)}
                        className="rounded p-0.5 text-ink-muted hover:text-danger cursor-pointer"
                        title="Remove album from merge"
                        aria-label={`Remove ${album.title}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {showAddPicker && (
              <div className="rounded-xl border border-border-strong bg-canvas p-3 space-y-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
                  <input
                    id="merge-add-album-search"
                    type="text"
                    value={addSearch}
                    onChange={(e) => setAddSearch(e.target.value)}
                    placeholder="Search any album or artist to pull into this merge..."
                    className="m4-input h-8 pl-8 text-xs"
                    autoFocus
                  />
                </div>
                <div className="max-h-36 overflow-y-auto divide-y divide-border-subtle/50">
                  {addableAlbums.length === 0 ? (
                    <p className="py-3 text-center text-xs text-ink-muted">
                      No matching albums available to add.
                    </p>
                  ) : (
                    addableAlbums.map((album) => (
                      <button
                        key={album.id}
                        type="button"
                        onClick={() => handleAddAlbum(album)}
                        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs hover:bg-surface-elevated cursor-pointer"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink-primary">
                            {album.title}
                          </p>
                          <p className="truncate text-[11px] text-ink-muted">
                            {album.artist}
                            {album.year ? ` · ${album.year}` : ""}
                          </p>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] text-accent">
                          + {album.track_count}t
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </section>

          {/* 2. Canonical Metadata Form */}
          <section className="rounded-xl border border-border-subtle bg-canvas/60 p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
              2. Canonical Album Metadata
            </h3>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-secondary">
                  Album Title <span className="text-danger">*</span>
                </label>
                <input
                  id="merge-canonical-album"
                  type="text"
                  value={form.album}
                  onChange={(e) => setForm((p) => ({ ...p, album: e.target.value }))}
                  className="m4-input h-8 text-xs"
                  placeholder="Canonical album title"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-secondary">
                  Album Artist
                </label>
                <input
                  id="merge-canonical-album-artist"
                  type="text"
                  value={form.album_artist}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, album_artist: e.target.value }))
                  }
                  className="m4-input h-8 text-xs"
                  placeholder="Album Artist (unifies Navidrome grouping)"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-secondary">
                  Year / Date
                </label>
                <input
                  type="text"
                  value={form.year}
                  onChange={(e) => setForm((p) => ({ ...p, year: e.target.value }))}
                  className="m4-input h-8 text-xs font-mono"
                  placeholder="e.g. 1996"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-secondary">
                  Genre
                </label>
                <input
                  type="text"
                  value={form.genre}
                  onChange={(e) => setForm((p) => ({ ...p, genre: e.target.value }))}
                  className="m4-input h-8 text-xs"
                  placeholder="e.g. Soul"
                />
              </div>
            </div>

            <div className="border-t border-border-subtle pt-2.5">
              <button
                type="button"
                onClick={() => setShowPidTags((prev) => !prev)}
                className="flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary hover:text-ink-primary cursor-pointer"
              >
                {showPidTags ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Navidrome Grouping / PID Tags (blank fields are cleared to prevent re-splitting)
              </button>

              {showPidTags && (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-[11px] text-ink-muted">
                      Release Date (TDRL / RELEASEDATE)
                    </label>
                    <input
                      type="text"
                      value={form.release_date}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, release_date: e.target.value }))
                      }
                      className="m4-input h-8 text-xs font-mono"
                      placeholder="YYYY-MM-DD (or blank)"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-ink-muted">
                      Album Version / Edition
                    </label>
                    <input
                      type="text"
                      value={form.album_version}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, album_version: e.target.value }))
                      }
                      className="m4-input h-8 text-xs"
                      placeholder="e.g. Deluxe Edition (or blank)"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-ink-muted">
                      Compilation Flag
                    </label>
                    <input
                      type="text"
                      value={form.compilation}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, compilation: e.target.value }))
                      }
                      className="m4-input h-8 text-xs font-mono"
                      placeholder="1 or blank"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-ink-muted">
                      MusicBrainz Album ID
                    </label>
                    <input
                      type="text"
                      value={form.musicbrainz_album_id}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          musicbrainz_album_id: e.target.value,
                        }))
                      }
                      className="m4-input h-8 text-xs font-mono"
                      placeholder="UUID or blank"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-[11px] text-ink-muted">
                      MusicBrainz Album Artist ID
                    </label>
                    <input
                      type="text"
                      value={form.musicbrainz_album_artist_id}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          musicbrainz_album_artist_id: e.target.value,
                        }))
                      }
                      className="m4-input h-8 text-xs font-mono"
                      placeholder="UUID or blank"
                    />
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 3. Cover Art Unification */}
          {mergedArtworkVariants.length > 0 && (
            <section className="rounded-xl border border-border-subtle bg-canvas/60 p-4 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                  <Images className="h-3.5 w-3.5 text-accent" />
                  3. Cover Art Unification ({mergedArtworkVariants.length}{" "}
                  {mergedArtworkVariants.length === 1 ? "cover" : "distinct covers"})
                </h3>
                <button
                  type="button"
                  onClick={() => setSelectedArtSource(null)}
                  className={`rounded-md border px-2 py-0.5 text-[11px] cursor-pointer ${
                    selectedArtSource === null
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border-subtle text-ink-muted hover:text-ink-primary"
                  }`}
                >
                  Keep per-track covers
                </button>
              </div>

              <div className="flex flex-wrap gap-2.5">
                {mergedArtworkVariants.map((variant) => {
                  const isPicked = selectedArtSource === variant.sample_track_path;
                  return (
                    <button
                      key={variant.hash}
                      type="button"
                      onClick={() =>
                        setSelectedArtSource(variant.sample_track_path)
                      }
                      className={`relative flex items-center gap-2.5 rounded-lg border p-2 text-left transition-colors cursor-pointer ${
                        isPicked
                          ? "border-accent bg-accent-soft/60"
                          : "border-border-subtle bg-surface hover:border-border-strong"
                      }`}
                    >
                      <img
                        src={getArtworkUrl(
                          variant.sample_track_path,
                          artworkRevision
                        )}
                        alt="Cover option"
                        className="h-12 w-12 rounded object-cover border border-border-subtle bg-surface-elevated"
                      />
                      <div className="text-[11px]">
                        <p className="font-medium text-ink-primary">
                          {variant.track_count}{" "}
                          {variant.track_count === 1 ? "track" : "tracks"}
                        </p>
                        <p className="font-mono text-[10px] text-ink-muted">
                          {formatFileSize(variant.size)}
                        </p>
                      </div>
                      {isPicked && (
                        <span className="ml-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[#14110c]">
                          <Check className="h-2.5 w-2.5 stroke-[3]" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 4. Combined Tracklist Preview (Collisions, Gaps & Inline Track/Disc Editing) */}
          <section className="rounded-xl border border-border-subtle bg-canvas/60 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                  4. Combined Tracklist ({combinedTracks.length} tracks)
                </h3>
                {trackDiagnostics.collisionCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded border border-danger/50 bg-danger/10 px-2 py-0.5 font-mono text-[10px] text-danger">
                    <AlertTriangle className="h-3 w-3" />
                    {trackDiagnostics.collisionCount} duplicate track #
                  </span>
                )}
                {trackDiagnostics.gaps.length > 0 && (
                  <span className="rounded border border-warn/40 bg-warn/10 px-2 py-0.5 font-mono text-[10px] text-warn">
                    Missing #: {trackDiagnostics.gaps.slice(0, 8).join(", ")}
                    {trackDiagnostics.gaps.length > 8 ? "…" : ""}
                  </span>
                )}
              </div>

              <button
                id="merge-autonumber-btn"
                type="button"
                onClick={handleAutoNumber}
                className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] text-ink-secondary hover:border-border-strong hover:text-ink-primary cursor-pointer"
                title="Sequentially number tracks 1..N in current order"
              >
                <Hash className="h-3 w-3 text-accent" />
                Auto-number 1..{combinedTracks.length}
              </button>
            </div>

            <div className="max-h-60 overflow-y-auto rounded-lg border border-border-subtle bg-surface/70">
              <table className="w-full border-collapse text-left text-[11px]">
                <thead className="sticky top-0 bg-surface border-b border-border-subtle text-[10px] uppercase tracking-wider text-ink-muted">
                  <tr>
                    <th className="w-16 py-1.5 pl-3 pr-1">Disc</th>
                    <th className="w-20 py-1.5 px-1">Track #</th>
                    <th className="py-1.5 px-2">Track</th>
                    <th className="hidden sm:table-cell py-1.5 px-2">From Album</th>
                    <th className="w-16 py-1.5 pl-2 pr-3 text-right">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle/50">
                  {combinedTracks.map(({ track, sourceAlbum }) => {
                    const draft = posDrafts[track.path] ?? {
                      disc: track.disc_number ?? "",
                      track: track.track_number ?? "",
                    };
                    const discNum = parseLeadingNum(draft.disc) ?? 1;
                    const trackNum = parseLeadingNum(draft.track);
                    const isCollision =
                      trackNum !== null &&
                      trackDiagnostics.collidingKeys.has(`${discNum}:${trackNum}`);

                    return (
                      <tr
                        key={track.path}
                        className={isCollision ? "bg-danger/10" : ""}
                      >
                        <td className="py-1.5 pl-3 pr-1">
                          <input
                            type="text"
                            value={draft.disc}
                            onChange={(e) =>
                              handlePosChange(track.path, "disc", e.target.value)
                            }
                            placeholder="1"
                            aria-label={`Disc number for ${track.title || track.filename}`}
                            className="m4-input h-6 w-12 px-1.5 font-mono text-[10px]"
                          />
                        </td>
                        <td className="py-1.5 px-1">
                          <input
                            type="text"
                            value={draft.track}
                            onChange={(e) =>
                              handlePosChange(track.path, "track", e.target.value)
                            }
                            placeholder="—"
                            aria-label={`Track number for ${track.title || track.filename}`}
                            className={`m4-input h-6 w-16 px-1.5 font-mono text-[10px] ${
                              isCollision ? "border-danger text-danger" : ""
                            }`}
                          />
                        </td>
                        <td className="py-1.5 px-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate font-medium text-ink-primary">
                              {track.title || track.filename}
                            </span>
                            {isCollision && (
                              <span className="shrink-0 rounded bg-danger/20 px-1 py-0.5 font-mono text-[9px] font-semibold text-danger">
                                Duplicate #
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="hidden sm:table-cell py-1.5 px-2 text-ink-muted">
                          <span className="block max-w-[160px] truncate">
                            {sourceAlbum.title}
                          </span>
                        </td>
                        <td className="py-1.5 pl-2 pr-3 text-right font-mono text-[10px] text-ink-muted">
                          {formatDuration(track.duration)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* 5. Optional Folder Consolidation */}
          {organizeSettings.enabled && (
            <label className="flex items-start gap-2.5 rounded-xl border border-border-subtle bg-canvas/60 px-4 py-3 text-xs text-ink-secondary cursor-pointer select-none">
              <input
                id="merge-reorganize-checkbox"
                type="checkbox"
                checked={reorganize}
                onChange={(e) => setReorganize(e.target.checked)}
                disabled={merging}
                className="mt-0.5 h-3.5 w-3.5 accent-amber-500 cursor-pointer"
              />
              <div className="space-y-0.5">
                <span className="flex items-center gap-1.5 font-medium text-ink-primary">
                  <FolderTree className="h-3.5 w-3.5 text-accent" />
                  Also consolidate files into the unified album folder
                </span>
                <p className="text-[11px] text-ink-muted">
                  Uses your active folder organization layout ({organizeSettings.template}) and cleans up empty leftover folders.
                </p>
              </div>
            </label>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border-subtle bg-surface px-5 py-3.5">
          <p className="hidden sm:flex items-center gap-1.5 text-[11px] text-ink-muted">
            <Disc3 className="h-3.5 w-3.5 text-accent" />
            All tag changes are grouped into one undoable batch in History
          </p>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              disabled={merging}
              onClick={onClose}
              className="m4-btn-secondary"
            >
              Cancel
            </button>
            <button
              id="confirm-merge-albums-btn"
              type="button"
              disabled={!canSubmit}
              onClick={() => void handleConfirmMerge()}
              className="m4-btn-primary"
            >
              {merging ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Merging...
                </>
              ) : (
                <>
                  <GitMerge className="h-3.5 w-3.5" />
                  Merge {combinedTracks.length}{" "}
                  {combinedTracks.length === 1 ? "Track" : "Tracks"}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
