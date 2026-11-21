import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Disc3,
  FileAudio,
  Globe,
  Images,
  Layers,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { formatFileSize, getArtworkUrl, getRawTags } from "../api/client";
import type { MusicBrainzModalMode } from "./MusicBrainzModal";
import type {
  AlbumGroup,
  ArtworkVariant,
  EditableTagField,
  RawTagsResponse,
  TrackMetadata,
  TrackTags,
} from "../types/music";

interface MetadataEditorProps {
  selectedTrack: TrackMetadata | null;
  activeAlbum: AlbumGroup | null;
  bulkAlbum: AlbumGroup | null;
  artworkRevision: number;
  saving: boolean;
  uploadingArtwork: boolean;
  onSaveTrack: (path: string, updates: Partial<TrackTags>) => Promise<void>;
  onSaveBulk: (paths: string[], updates: Partial<TrackTags>) => Promise<void>;
  onUploadArtwork: (paths: string[], file: File) => Promise<void>;
  onCopyArtwork: (sourcePath: string, targetPaths: string[]) => Promise<void>;
  onDeleteArtwork: (path: string) => Promise<void>;
  onOpenMusicBrainz: (mode: MusicBrainzModalMode, targetPaths: string[]) => void;
}

interface FieldSpec {
  key: EditableTagField;
  label: string;
  placeholder: string;
  half?: boolean;
  mono?: boolean;
}

const SINGLE_FIELDS: FieldSpec[] = [
  { key: "title", label: "Title", placeholder: "Track title" },
  { key: "artist", label: "Artist", placeholder: "Performing artist" },
  { key: "album_artist", label: "Album Artist", placeholder: "Album artist (Navidrome grouping)" },
  { key: "album", label: "Album", placeholder: "Album title" },
  { key: "year", label: "Year / Date", placeholder: "e.g. 2024", half: true },
  { key: "genre", label: "Genre", placeholder: "e.g. Post-Rock", half: true },
  { key: "track_number", label: "Track #", placeholder: "e.g. 3 or 3/12", half: true },
  { key: "disc_number", label: "Disc #", placeholder: "e.g. 1 or 1/2", half: true },
  { key: "composer", label: "Composer", placeholder: "Composer or songwriter" },
];

const BULK_FIELDS: FieldSpec[] = [
  { key: "album", label: "Album", placeholder: "Shared album title" },
  { key: "album_artist", label: "Album Artist", placeholder: "Shared album artist" },
  { key: "artist", label: "Track Artist", placeholder: "Set artist on all tracks" },
  { key: "year", label: "Year / Date", placeholder: "e.g. 2024", half: true },
  { key: "genre", label: "Genre", placeholder: "e.g. Ambient", half: true },
  { key: "disc_number", label: "Disc #", placeholder: "e.g. 1/2", half: true },
  { key: "composer", label: "Composer", placeholder: "Composer across album" },
];

const NAVIDROME_FIELDS: FieldSpec[] = [
  {
    key: "release_date",
    label: "Release Date",
    placeholder: "TDRL / RELEASEDATE (e.g. 2011-12-06)",
    half: true,
  },
  {
    key: "compilation",
    label: "Compilation",
    placeholder: "1 or 0 (blank to clear)",
    half: true,
  },
  {
    key: "album_version",
    label: "Album Version",
    placeholder: "Edition / comment (blank if standard)",
  },
  {
    key: "musicbrainz_album_id",
    label: "MusicBrainz Album ID",
    placeholder: "UUID (clear across album if mismatched)",
    mono: true,
  },
  {
    key: "musicbrainz_album_artist_id",
    label: "MusicBrainz Album Artist ID",
    placeholder: "UUID (clear across album if mismatched)",
    mono: true,
  },
];

const ALL_BULK_FIELDS = [...BULK_FIELDS, ...NAVIDROME_FIELDS];
const ALL_SINGLE_FIELDS = [...SINGLE_FIELDS, ...NAVIDROME_FIELDS];

const NAVIDROME_FIELD_KEYS = new Set<EditableTagField>(
  NAVIDROME_FIELDS.map((f) => f.key)
);

type FormValues = Record<EditableTagField, string>;

const EMPTY_FORM: FormValues = {
  title: "",
  artist: "",
  album_artist: "",
  album: "",
  year: "",
  track_number: "",
  disc_number: "",
  genre: "",
  composer: "",
  release_date: "",
  album_version: "",
  compilation: "",
  musicbrainz_album_id: "",
  musicbrainz_album_artist_id: "",
};

function computeBulkInitial(album: AlbumGroup): {
  values: FormValues;
  mixed: Set<EditableTagField>;
} {
  const values: FormValues = { ...EMPTY_FORM };
  const mixed = new Set<EditableTagField>();

  for (const field of ALL_BULK_FIELDS) {
    const distinct = new Set(album.tracks.map((t) => (t[field.key] ?? "").trim()));
    if (distinct.size === 1) {
      values[field.key] = Array.from(distinct)[0];
    } else if (distinct.size > 1) {
      values[field.key] = "";
      mixed.add(field.key);
    }
  }
  return { values, mixed };
}

export function MetadataEditor({
  selectedTrack,
  activeAlbum,
  bulkAlbum,
  artworkRevision,
  saving,
  uploadingArtwork,
  onSaveTrack,
  onSaveBulk,
  onUploadArtwork,
  onCopyArtwork,
  onDeleteArtwork,
  onOpenMusicBrainz,
}: MetadataEditorProps) {
  const isBulk = bulkAlbum !== null;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [touched, setTouched] = useState<Set<EditableTagField>>(new Set());
  const [mixedFields, setMixedFields] = useState<Set<EditableTagField>>(new Set());

  const [showCoverPicker, setShowCoverPicker] = useState(false);
  const [showNavidromeTags, setShowNavidromeTags] = useState(false);

  const [showRawTags, setShowRawTags] = useState(false);
  const [rawTags, setRawTags] = useState<RawTagsResponse | null>(null);
  const [loadingRawTags, setLoadingRawTags] = useState(false);

  const albumForArtwork = bulkAlbum ?? activeAlbum;
  const artworkVariants: ArtworkVariant[] = albumForArtwork?.artwork_variants ?? [];

  // Sync form state when active track or bulk album changes
  useEffect(() => {
    setShowRawTags(false);
    setRawTags(null);

    if (bulkAlbum) {
      const { values, mixed } = computeBulkInitial(bulkAlbum);
      setForm(values);
      setMixedFields(mixed);
      setTouched(new Set());
      // Auto-open cover picker when album has multiple distinct cover images
      setShowCoverPicker(bulkAlbum.artwork_variants.length > 1);
      // Auto-open Navidrome tags if any Navidrome-specific field has a mismatch warning
      const hasNavidromeMismatch = bulkAlbum.navidrome_warnings.some((w) =>
        NAVIDROME_FIELD_KEYS.has(w.field as EditableTagField)
      );
      setShowNavidromeTags(hasNavidromeMismatch);
    } else if (selectedTrack) {
      setForm({
        title: selectedTrack.title ?? "",
        artist: selectedTrack.artist ?? "",
        album_artist: selectedTrack.album_artist ?? "",
        album: selectedTrack.album ?? "",
        year: selectedTrack.year ?? "",
        track_number: selectedTrack.track_number ?? "",
        disc_number: selectedTrack.disc_number ?? "",
        genre: selectedTrack.genre ?? "",
        composer: selectedTrack.composer ?? "",
        release_date: selectedTrack.release_date ?? "",
        album_version: selectedTrack.album_version ?? "",
        compilation: selectedTrack.compilation ?? "",
        musicbrainz_album_id: selectedTrack.musicbrainz_album_id ?? "",
        musicbrainz_album_artist_id: selectedTrack.musicbrainz_album_artist_id ?? "",
      });
      setMixedFields(new Set());
      setTouched(new Set());
      setShowCoverPicker(false);
    } else {
      setForm(EMPTY_FORM);
      setMixedFields(new Set());
      setTouched(new Set());
      setShowCoverPicker(false);
    }
  }, [selectedTrack, bulkAlbum]);

  // Fetch raw file tags on demand when expanded
  useEffect(() => {
    if (!showRawTags || !selectedTrack || isBulk) return;
    let cancelled = false;
    setLoadingRawTags(true);
    void getRawTags(selectedTrack.path)
      .then((res) => {
        if (!cancelled) setRawTags(res);
      })
      .catch(() => {
        if (!cancelled) setRawTags(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingRawTags(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showRawTags, selectedTrack, isBulk]);

  const dirtyFields = useMemo(() => {
    const dirty = new Set<EditableTagField>();
    if (isBulk) {
      for (const field of touched) {
        dirty.add(field);
      }
      return dirty;
    }
    if (!selectedTrack) return dirty;
    for (const field of ALL_SINGLE_FIELDS) {
      const currentVal = form[field.key].trim();
      const origVal = (selectedTrack[field.key] ?? "").trim();
      if (currentVal !== origVal) {
        dirty.add(field.key);
      }
    }
    return dirty;
  }, [form, isBulk, selectedTrack, touched]);

  const hasChanges = dirtyFields.size > 0;

  async function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    if (!hasChanges || saving) return;

    const updates: Partial<TrackTags> = {};
    for (const key of dirtyFields) {
      const trimmed = form[key].trim();
      updates[key] = trimmed === "" ? null : trimmed;
    }

    if (bulkAlbum) {
      await onSaveBulk(
        bulkAlbum.tracks.map((t) => t.path),
        updates
      );
      setTouched(new Set());
    } else if (selectedTrack) {
      await onSaveTrack(selectedTrack.path, updates);
      setTouched(new Set());
    }
  }

  // Cmd/Ctrl+S keyboard shortcut to save active editor
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        if (hasChanges && (selectedTrack || bulkAlbum)) {
          event.preventDefault();
          void handleSubmit();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function handleReset() {
    if (bulkAlbum) {
      const { values, mixed } = computeBulkInitial(bulkAlbum);
      setForm(values);
      setMixedFields(mixed);
      setTouched(new Set());
    } else if (selectedTrack) {
      setForm({
        title: selectedTrack.title ?? "",
        artist: selectedTrack.artist ?? "",
        album_artist: selectedTrack.album_artist ?? "",
        album: selectedTrack.album ?? "",
        year: selectedTrack.year ?? "",
        track_number: selectedTrack.track_number ?? "",
        disc_number: selectedTrack.disc_number ?? "",
        genre: selectedTrack.genre ?? "",
        composer: selectedTrack.composer ?? "",
        release_date: selectedTrack.release_date ?? "",
        album_version: selectedTrack.album_version ?? "",
        compilation: selectedTrack.compilation ?? "",
        musicbrainz_album_id: selectedTrack.musicbrainz_album_id ?? "",
        musicbrainz_album_artist_id: selectedTrack.musicbrainz_album_artist_id ?? "",
      });
      setTouched(new Set());
    }
  }

  function handleFieldChange(key: EditableTagField, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTouched((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  function handleClearField(key: EditableTagField) {
    setForm((prev) => ({ ...prev, [key]: "" }));
    setTouched((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (bulkAlbum) {
      await onUploadArtwork(
        bulkAlbum.tracks.map((t) => t.path),
        file
      );
    } else if (selectedTrack) {
      await onUploadArtwork([selectedTrack.path], file);
    }
    setShowCoverPicker(false);
  }

  async function handlePickExistingVariant(variant: ArtworkVariant) {
    if (uploadingArtwork) return;
    if (bulkAlbum) {
      await onCopyArtwork(
        variant.sample_track_path,
        bulkAlbum.tracks.map((t) => t.path)
      );
    } else if (selectedTrack) {
      await onCopyArtwork(variant.sample_track_path, [selectedTrack.path]);
    }
  }

  if (!selectedTrack && !bulkAlbum) {
    return (
      <aside className="hidden lg:flex w-96 shrink-0 flex-col items-center justify-center border-l border-border-subtle bg-surface p-8 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border-subtle bg-canvas text-ink-muted">
          <FileAudio className="h-5 w-5" />
        </div>
        <h3 className="mt-3 text-sm font-medium text-ink-primary">
          Metadata Inspector
        </h3>
        <p className="mt-1 max-w-[230px] text-xs leading-relaxed text-ink-muted">
          Select a track or click{" "}
          <span className="text-ink-secondary">Edit Album</span> to inspect and
          update tags directly on disk.
        </p>
      </aside>
    );
  }

  const coverPath = bulkAlbum
    ? bulkAlbum.cover_track_path
    : selectedTrack?.has_artwork
      ? selectedTrack.path
      : null;

  const primaryFields = isBulk ? BULK_FIELDS : SINGLE_FIELDS;

  const navidromeWarningFields = new Set(
    (albumForArtwork?.navidrome_warnings ?? [])
      .filter((w) => w.severity === "split")
      .map((w) => w.field)
  );

  function renderField(field: FieldSpec) {
    const isDirty = dirtyFields.has(field.key);
    const isMixed =
      isBulk && mixedFields.has(field.key) && !touched.has(field.key);
    const hasSplitWarning = navidromeWarningFields.has(field.key);

    return (
      <div
        key={field.key}
        className={field.half ? "col-span-1" : "col-span-2"}
      >
        <label
          htmlFor={`tag-input-${field.key}`}
          className="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-ink-secondary"
        >
          <span className="flex items-center gap-1.5 truncate">
            {field.label}
            {hasSplitWarning && (
              <span
                className="rounded bg-accent-soft px-1 py-0.2 text-[9px] font-semibold uppercase text-warn"
                title="Inconsistent across album — causes Navidrome to split this album"
              >
                split
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            {isBulk && (isMixed || form[field.key]) && (
              <button
                type="button"
                onClick={() => handleClearField(field.key)}
                className="text-[10px] text-ink-muted hover:text-danger transition-colors cursor-pointer"
                title={`Clear ${field.label} on all tracks in this album`}
              >
                Clear
              </button>
            )}
            {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
          </span>
        </label>
        <input
          id={`tag-input-${field.key}`}
          type="text"
          value={form[field.key]}
          onChange={(e) => handleFieldChange(field.key, e.target.value)}
          placeholder={isMixed ? "Multiple values" : field.placeholder}
          className={`m4-input ${field.mono ? "font-mono text-xs" : ""} ${
            isDirty ? "m4-input-dirty" : ""
          }`}
        />
      </div>
    );
  }

  return (
    <aside className="flex w-full lg:w-[400px] shrink-0 flex-col border-l border-border-subtle bg-surface overflow-hidden">
      {/* Inspector Header */}
      <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-accent">
            {isBulk ? (
              <>
                <Layers className="h-3.5 w-3.5" />
                Bulk Album Edit ({bulkAlbum.track_count} tracks)
              </>
            ) : (
              <>
                <FileAudio className="h-3.5 w-3.5" />
                Track Inspector
              </>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs font-semibold text-ink-primary">
            {isBulk ? bulkAlbum.title : selectedTrack?.title || selectedTrack?.filename}
          </p>
        </div>

        {hasChanges && (
          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-medium text-accent">
            {dirtyFields.size} modified
          </span>
        )}
      </div>

      {/* Scrollable Form Body */}
      <form
        id="metadata-editor-form"
        onSubmit={handleSubmit}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Jellyfin-style Identify Album via MusicBrainz (Bulk Mode) */}
          {isBulk && bulkAlbum && (
            <button
              id="identify-album-musicbrainz-btn"
              type="button"
              disabled={saving || uploadingArtwork}
              onClick={() =>
                onOpenMusicBrainz(
                  "identify",
                  bulkAlbum.tracks.map((t) => t.path)
                )
              }
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border-strong bg-surface-elevated px-3.5 py-2.5 text-left transition-colors hover:border-accent/60 hover:bg-surface-hover cursor-pointer"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Globe className="h-4 w-4 shrink-0 text-accent" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-ink-primary">
                    Identify Album via MusicBrainz
                  </p>
                  <p className="truncate text-[11px] text-ink-muted">
                    Match release metadata, MBIDs &amp; cover art
                  </p>
                </div>
              </div>
              <span className="shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
                Search
              </span>
            </button>
          )}

          {/* Embedded Cover Art Section */}
          <div className="rounded-xl border border-border-subtle bg-canvas/70 p-3 space-y-3">
            <div className="flex items-center gap-3.5">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border-subtle bg-surface-elevated">
                {coverPath ? (
                  <img
                    src={getArtworkUrl(coverPath, artworkRevision)}
                    alt="Embedded cover art"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-ink-muted">
                    <Disc3 className="h-7 w-7 opacity-40" />
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-ink-primary">
                    Embedded Cover Art
                  </p>
                  {!isBulk && selectedTrack?.has_artwork && (
                    <button
                      id="remove-artwork-btn"
                      type="button"
                      disabled={uploadingArtwork}
                      onClick={() => onDeleteArtwork(selectedTrack.path)}
                      className="inline-flex h-6 items-center justify-center rounded-md border border-border-subtle px-1.5 text-ink-muted hover:border-danger/60 hover:text-danger transition-colors cursor-pointer"
                      title="Remove embedded artwork"
                      aria-label="Remove embedded artwork"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  {isBulk
                    ? artworkVariants.length > 1
                      ? `${artworkVariants.length} distinct images across album`
                      : artworkVariants.length === 1
                        ? `1 shared image (${formatFileSize(artworkVariants[0].size)})`
                        : "No embedded images on album"
                    : selectedTrack?.has_artwork
                      ? `${selectedTrack.artwork_mime || "image"} · ${formatFileSize(
                          selectedTrack.artwork_size ?? 0
                        )}`
                      : "No embedded image"}
                </p>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileSelected}
                  className="hidden"
                />
              </div>
            </div>

            {/* 3 Clear Artwork Replacement Actions: Pick Existing, Search MusicBrainz, Upload Image */}
            <div className="grid grid-cols-3 gap-1.5">
              <button
                id="pick-existing-artwork-btn"
                type="button"
                disabled={uploadingArtwork || artworkVariants.length === 0}
                onClick={() => setShowCoverPicker((open) => !open)}
                title={
                  artworkVariants.length === 0
                    ? "No embedded images exist on this album yet"
                    : "Choose from images already embedded on this album"
                }
                className={`inline-flex h-8 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  showCoverPicker
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border-subtle bg-surface-elevated text-ink-primary hover:bg-surface-hover hover:border-border-strong"
                }`}
              >
                <Images className="h-3 w-3 shrink-0" />
                <span className="truncate">Pick Existing</span>
              </button>

              <button
                id="search-musicbrainz-artwork-btn"
                type="button"
                disabled={uploadingArtwork}
                onClick={() => {
                  const targets = bulkAlbum
                    ? bulkAlbum.tracks.map((t) => t.path)
                    : selectedTrack
                      ? [selectedTrack.path]
                      : [];
                  if (targets.length > 0) {
                    onOpenMusicBrainz("artwork", targets);
                  }
                }}
                className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-border-subtle bg-surface-elevated px-2 text-[11px] font-medium text-ink-primary transition-colors hover:bg-surface-hover hover:border-border-strong cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title="Search MusicBrainz / Cover Art Archive for album artwork"
              >
                <Globe className="h-3 w-3 shrink-0 text-accent" />
                <span className="truncate">MusicBrainz</span>
              </button>

              <button
                id="upload-artwork-btn"
                type="button"
                disabled={uploadingArtwork}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-border-subtle bg-surface-elevated px-2 text-[11px] font-medium text-ink-primary transition-colors hover:bg-surface-hover hover:border-border-strong cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title="Upload a JPEG, PNG, or WebP cover image from your computer"
              >
                <Upload className="h-3 w-3 shrink-0" />
                <span className="truncate">Upload</span>
              </button>
            </div>

            {/* Existing Album Cover Picker */}
            {showCoverPicker && artworkVariants.length > 0 && (
              <div
                id="existing-artwork-picker"
                className="border-t border-border-subtle pt-3 space-y-2"
              >
                <p className="text-[11px] font-medium text-ink-secondary">
                  {isBulk
                    ? "Click an existing album image to apply it to all tracks:"
                    : "Click an existing album image to apply it to this track:"}
                </p>

                <div className="grid grid-cols-3 gap-2">
                  {artworkVariants.map((variant, index) => {
                    const isCurrentSingle =
                      !isBulk && selectedTrack?.artwork_hash === variant.hash;
                    const isAllAlbum =
                      isBulk &&
                      bulkAlbum !== null &&
                      variant.track_count === bulkAlbum.track_count;
                    const isActive = isCurrentSingle || isAllAlbum;

                    return (
                      <button
                        key={variant.hash}
                        id={`existing-cover-option-${index}`}
                        type="button"
                        disabled={uploadingArtwork}
                        onClick={() => handlePickExistingVariant(variant)}
                        title={
                          isBulk
                            ? `Apply this cover to all ${bulkAlbum.track_count} tracks`
                            : "Apply this cover to selected track"
                        }
                        className={`group relative flex flex-col overflow-hidden rounded-lg border p-1 text-left transition-colors cursor-pointer ${
                          isActive
                            ? "border-accent bg-accent-soft/50"
                            : "border-border-subtle bg-surface hover:border-accent/70 hover:bg-surface-elevated"
                        }`}
                      >
                        <div className="relative aspect-square w-full overflow-hidden rounded bg-surface-elevated">
                          <img
                            src={getArtworkUrl(
                              variant.sample_track_path,
                              artworkRevision
                            )}
                            alt={`Existing album cover ${index + 1}`}
                            className="h-full w-full object-cover"
                          />
                          {isActive && (
                            <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[#14110c]">
                              <Check className="h-2.5 w-2.5 stroke-[3]" />
                            </span>
                          )}
                        </div>
                        <div className="mt-1 px-0.5 leading-tight">
                          <p className="truncate font-mono text-[10px] font-medium text-ink-primary">
                            {variant.track_count}{" "}
                            {variant.track_count === 1 ? "track" : "tracks"}
                          </p>
                          <p className="truncate font-mono text-[9px] text-ink-muted">
                            {formatFileSize(variant.size)}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {isBulk && (
            <p className="text-[11px] leading-relaxed text-ink-muted">
              Only fields you edit or clear below will be written to disk.
              Untouched fields retain each track&apos;s existing tags.
            </p>
          )}

          {/* Primary Tag Fields Grid */}
          <div className="grid grid-cols-2 gap-3">
            {primaryFields.map(renderField)}
          </div>

          {/* Collapsible Navidrome & Release Grouping Tags */}
          <div className="rounded-xl border border-border-subtle bg-canvas/40">
            <button
              id="toggle-navidrome-tags-btn"
              type="button"
              onClick={() => setShowNavidromeTags((v) => !v)}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-ink-secondary hover:text-ink-primary cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                {showNavidromeTags ? (
                  <ChevronDown className="h-3.5 w-3.5 text-ink-muted" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-ink-muted" />
                )}
                Navidrome &amp; Release Tags
              </span>
              {NAVIDROME_FIELDS.some((f) => navidromeWarningFields.has(f.key)) && (
                <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-warn">
                  mismatch
                </span>
              )}
            </button>

            {showNavidromeTags && (
              <div className="border-t border-border-subtle px-3.5 py-3 space-y-3">
                <p className="text-[11px] leading-relaxed text-ink-muted">
                  Navidrome groups albums by{" "}
                  <code className="font-mono text-[10px] text-ink-secondary">
                    musicbrainz_albumid
                  </code>{" "}
                  first, then{" "}
                  <code className="font-mono text-[10px] text-ink-secondary">
                    albumartist + album + version + releasedate
                  </code>
                  .
                </p>
                <div className="grid grid-cols-2 gap-3">
                  {NAVIDROME_FIELDS.map(renderField)}
                </div>
              </div>
            )}
          </div>

          {/* Technical File Info + On-Demand Raw Tags (Single Track) */}
          {!isBulk && selectedTrack && (
            <div className="rounded-xl border border-border-subtle bg-canvas/50 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                  File Details
                </p>
                <button
                  id="toggle-raw-tags-btn"
                  type="button"
                  onClick={() => setShowRawTags((v) => !v)}
                  className="inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-accent transition-colors cursor-pointer"
                >
                  <Code2 className="h-3 w-3" />
                  {showRawTags ? "Hide Raw Tags" : "Raw Tags"}
                </button>
              </div>
              <p
                className="break-all font-mono text-[11px] text-ink-secondary"
                title={selectedTrack.path}
              >
                {selectedTrack.path}
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-ink-muted">
                <span>{selectedTrack.format}</span>
                {selectedTrack.bitrate && (
                  <span>{Math.round(selectedTrack.bitrate / 1000)} kbps</span>
                )}
                {selectedTrack.sample_rate && (
                  <span>{(selectedTrack.sample_rate / 1000).toFixed(1)} kHz</span>
                )}
                <span>{formatFileSize(selectedTrack.file_size)}</span>
              </div>

              {showRawTags && (
                <div className="mt-2 border-t border-border-subtle pt-2.5">
                  {loadingRawTags ? (
                    <p className="text-[11px] text-ink-muted">Reading raw frames...</p>
                  ) : rawTags && Object.keys(rawTags.tags).length > 0 ? (
                    <dl className="max-h-52 space-y-1 overflow-y-auto pr-1 font-mono text-[10px]">
                      {Object.entries(rawTags.tags).map(([key, vals]) => (
                        <div key={key} className="grid grid-cols-[minmax(90px,auto)_1fr] gap-2">
                          <dt className="truncate text-ink-muted" title={key}>
                            {key}
                          </dt>
                          <dd className="break-all text-ink-secondary">
                            {vals.join(" ; ")}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="text-[11px] text-ink-muted">No raw tags found.</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sticky Action Bar */}
        <div className="flex items-center justify-between gap-2 border-t border-border-subtle bg-surface px-5 py-3">
          <button
            id="reset-tags-btn"
            type="button"
            disabled={!hasChanges || saving}
            onClick={handleReset}
            className="m4-btn-secondary"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>

          <button
            id="save-tags-btn"
            type="submit"
            disabled={!hasChanges || saving}
            className="m4-btn-primary flex-1"
          >
            <Save className="h-3.5 w-3.5" />
            {saving
              ? "Writing to Disk..."
              : isBulk
                ? `Apply to ${bulkAlbum.track_count} Tracks`
                : "Save Tags"}
          </button>
        </div>
      </form>
    </aside>
  );
}
