import { useEffect, useMemo, useRef, useState } from "react";
import {
  Disc3,
  FileAudio,
  ImagePlus,
  Layers,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { formatFileSize, getArtworkUrl } from "../api/client";
import type {
  AlbumGroup,
  EditableTagField,
  TrackMetadata,
  TrackTags,
} from "../types/music";

interface MetadataEditorProps {
  selectedTrack: TrackMetadata | null;
  bulkAlbum: AlbumGroup | null;
  artworkRevision: number;
  saving: boolean;
  uploadingArtwork: boolean;
  onSaveTrack: (path: string, updates: Partial<TrackTags>) => Promise<void>;
  onSaveBulk: (paths: string[], updates: Partial<TrackTags>) => Promise<void>;
  onUploadArtwork: (paths: string[], file: File) => Promise<void>;
  onDeleteArtwork: (path: string) => Promise<void>;
}

const SINGLE_FIELDS: Array<{
  key: EditableTagField;
  label: string;
  placeholder: string;
  half?: boolean;
}> = [
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

const BULK_FIELDS: Array<{
  key: EditableTagField;
  label: string;
  placeholder: string;
  half?: boolean;
}> = [
  { key: "album", label: "Album", placeholder: "Shared album title" },
  { key: "album_artist", label: "Album Artist", placeholder: "Shared album artist" },
  { key: "artist", label: "Track Artist", placeholder: "Set artist on all tracks" },
  { key: "year", label: "Year / Date", placeholder: "e.g. 2024", half: true },
  { key: "genre", label: "Genre", placeholder: "e.g. Ambient", half: true },
  { key: "disc_number", label: "Disc #", placeholder: "e.g. 1/2", half: true },
  { key: "composer", label: "Composer", placeholder: "Composer across album" },
];

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
};

function computeBulkInitial(album: AlbumGroup): {
  values: FormValues;
  mixed: Set<EditableTagField>;
} {
  const values: FormValues = { ...EMPTY_FORM };
  const mixed = new Set<EditableTagField>();

  for (const field of BULK_FIELDS) {
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
  bulkAlbum,
  artworkRevision,
  saving,
  uploadingArtwork,
  onSaveTrack,
  onSaveBulk,
  onUploadArtwork,
  onDeleteArtwork,
}: MetadataEditorProps) {
  const isBulk = bulkAlbum !== null;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<FormValues>(EMPTY_FORM);
  const [touched, setTouched] = useState<Set<EditableTagField>>(new Set());
  const [mixedFields, setMixedFields] = useState<Set<EditableTagField>>(new Set());

  // Sync form state when the active track or bulk album changes
  useEffect(() => {
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
      });
      setMixedFields(new Set());
      setTouched(new Set());
    } else {
      setForm(EMPTY_FORM);
      setMixedFields(new Set());
      setTouched(new Set());
    }
  }, [selectedTrack, bulkAlbum]);

  const dirtyFields = useMemo(() => {
    const dirty = new Set<EditableTagField>();
    if (isBulk) {
      for (const field of touched) {
        dirty.add(field);
      }
      return dirty;
    }
    if (!selectedTrack) return dirty;
    for (const field of SINGLE_FIELDS) {
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

  const fieldsToRender = isBulk ? BULK_FIELDS : SINGLE_FIELDS;

  return (
    <aside className="flex w-full lg:w-96 shrink-0 flex-col border-l border-border-subtle bg-surface overflow-hidden">
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
          {/* Embedded Cover Art Section */}
          <div className="flex items-center gap-4 rounded-xl border border-border-subtle bg-canvas/70 p-3">
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
              <p className="text-xs font-medium text-ink-primary">
                Embedded Cover Art
              </p>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                {isBulk
                  ? "Replaces artwork across all tracks in album"
                  : selectedTrack?.has_artwork
                    ? selectedTrack.artwork_mime || "Embedded image"
                    : "No embedded image"}
              </p>

              <div className="mt-2.5 flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleFileSelected}
                  className="hidden"
                />
                <button
                  id="upload-artwork-btn"
                  type="button"
                  disabled={uploadingArtwork}
                  onClick={() => fileInputRef.current?.click()}
                  className="m4-btn-secondary h-7 px-2.5 text-[11px]"
                >
                  <ImagePlus className="h-3 w-3" />
                  {uploadingArtwork
                    ? "Embedding..."
                    : coverPath
                      ? "Replace"
                      : "Embed Art"}
                </button>

                {!isBulk && selectedTrack?.has_artwork && (
                  <button
                    id="remove-artwork-btn"
                    type="button"
                    disabled={uploadingArtwork}
                    onClick={() => onDeleteArtwork(selectedTrack.path)}
                    className="inline-flex h-7 items-center justify-center rounded-lg border border-border-subtle px-2 text-ink-muted hover:border-danger/60 hover:text-danger transition-colors cursor-pointer"
                    title="Remove embedded artwork"
                    aria-label="Remove embedded artwork"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {isBulk && (
            <p className="text-[11px] leading-relaxed text-ink-muted">
              Only fields you edit below will be written to disk. Untouched fields
              retain each track&apos;s existing tags.
            </p>
          )}

          {/* Tag Fields Grid */}
          <div className="grid grid-cols-2 gap-3">
            {fieldsToRender.map((field) => {
              const isDirty = dirtyFields.has(field.key);
              const isMixed = isBulk && mixedFields.has(field.key) && !touched.has(field.key);
              return (
                <div
                  key={field.key}
                  className={field.half ? "col-span-1" : "col-span-2"}
                >
                  <label
                    htmlFor={`tag-input-${field.key}`}
                    className="mb-1 flex items-center justify-between text-[11px] font-medium text-ink-secondary"
                  >
                    <span>{field.label}</span>
                    {isDirty && (
                      <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    )}
                  </label>
                  <input
                    id={`tag-input-${field.key}`}
                    type="text"
                    value={form[field.key]}
                    onChange={(e) => handleFieldChange(field.key, e.target.value)}
                    placeholder={isMixed ? "Multiple values" : field.placeholder}
                    className={`m4-input ${isDirty ? "m4-input-dirty" : ""}`}
                  />
                </div>
              );
            })}
          </div>

          {/* Technical File Info (Single Track) */}
          {!isBulk && selectedTrack && (
            <div className="rounded-xl border border-border-subtle bg-canvas/50 p-3 space-y-1.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-ink-muted">
                File Details
              </p>
              <p
                className="break-all font-mono text-[11px] text-ink-secondary"
                title={selectedTrack.path}
              >
                {selectedTrack.path}
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 font-mono text-[11px] text-ink-muted">
                <span>{selectedTrack.format}</span>
                {selectedTrack.bitrate && (
                  <span>{Math.round(selectedTrack.bitrate / 1000)} kbps</span>
                )}
                {selectedTrack.sample_rate && (
                  <span>{(selectedTrack.sample_rate / 1000).toFixed(1)} kHz</span>
                )}
                <span>{formatFileSize(selectedTrack.file_size)}</span>
              </div>
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
