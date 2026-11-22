import { useEffect, useState } from "react";
import { AlertTriangle, FileAudio, Loader2, Trash2, X } from "lucide-react";
import { formatDuration, formatFileSize } from "../api/client";
import type { TrackMetadata } from "../types/music";

interface DeleteTrackModalProps {
  tracks: TrackMetadata[];
  deleting: boolean;
  onClose: () => void;
  onConfirm: (
    tracks: TrackMetadata[],
    options: { deleteSidecars: boolean; cleanupEmptyDirs: boolean }
  ) => Promise<void>;
}

export function DeleteTrackModal({
  tracks,
  deleting,
  onClose,
  onConfirm,
}: DeleteTrackModalProps) {
  const [cleanupExtras, setCleanupExtras] = useState(true);

  useEffect(() => {
    if (tracks.length > 0) {
      setCleanupExtras(true);
    }
  }, [tracks]);

  useEffect(() => {
    if (tracks.length === 0) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !deleting) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tracks, deleting, onClose]);

  if (tracks.length === 0) return null;

  const isMulti = tracks.length > 1;
  const single = tracks[0];
  const totalSize = tracks.reduce((sum, t) => sum + (t.file_size || 0), 0);
  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

  return (
    <div
      id="delete-track-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-track-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !deleting) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-border-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-danger/40 bg-danger/15 text-danger">
              <Trash2 className="h-4 w-4" />
            </div>
            <div>
              <h2
                id="delete-track-modal-title"
                className="text-sm font-semibold text-ink-primary"
              >
                {isMulti
                  ? `Delete ${tracks.length} Track Files`
                  : "Delete Track File"}
              </h2>
              <p className="text-xs text-ink-muted">
                Permanently remove {isMulti ? "these audio files" : "this audio file"} from disk
              </p>
            </div>
          </div>

          <button
            id="close-delete-track-modal-btn"
            type="button"
            disabled={deleting}
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
            aria-label="Close delete confirmation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 px-5 py-4">
          {!isMulti ? (
            <div className="rounded-xl border border-border-subtle bg-canvas p-3.5 space-y-2">
              <div className="flex items-start gap-2.5">
                <FileAudio className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-ink-primary">
                    {single.title || single.filename}
                  </p>
                  <p className="truncate text-xs text-ink-secondary">
                    {single.artist || single.album_artist || "Unknown Artist"} —{" "}
                    {single.album || "Unknown Album"}
                  </p>
                </div>
              </div>

              <p className="break-all rounded-lg bg-surface px-2.5 py-1.5 font-mono text-[11px] text-ink-secondary">
                {single.path}
              </p>

              <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-ink-muted">
                <span className="rounded border border-border-subtle bg-surface px-1.5 py-0.5 text-[10px] text-ink-secondary">
                  {single.format}
                </span>
                {single.bitrate && (
                  <span>{Math.round(single.bitrate / 1000)} kbps</span>
                )}
                {single.sample_rate && (
                  <span>{(single.sample_rate / 1000).toFixed(1)} kHz</span>
                )}
                <span>{formatDuration(single.duration)}</span>
                <span>{formatFileSize(single.file_size)}</span>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-border-subtle bg-canvas p-3 space-y-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-ink-primary">
                  {tracks.length} selected audio files
                </span>
                <span className="font-mono text-[11px] text-ink-muted">
                  {formatDuration(totalDuration)} · {formatFileSize(totalSize)}
                </span>
              </div>

              <ul className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                {tracks.map((t) => (
                  <li
                    key={t.path}
                    className="flex items-start gap-2 rounded-lg border border-border-subtle/70 bg-surface px-2.5 py-1.5 text-xs"
                  >
                    <FileAudio className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate font-medium text-ink-primary">
                          {t.title || t.filename}
                        </p>
                        <span className="shrink-0 font-mono text-[10px] text-ink-muted">
                          {t.format} · {formatFileSize(t.file_size)}
                        </span>
                      </div>
                      <p className="truncate font-mono text-[10px] text-ink-muted">
                        {t.path}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="flex items-start gap-2.5 text-xs text-ink-secondary cursor-pointer select-none">
            <input
              id="delete-track-cleanup-extras"
              type="checkbox"
              checked={cleanupExtras}
              onChange={(e) => setCleanupExtras(e.target.checked)}
              disabled={deleting}
              className="mt-0.5 h-3.5 w-3.5 accent-accent cursor-pointer"
            />
            <span>
              Also remove matching track sidecar files (<code>.lrc</code>,{" "}
              <code>.txt</code>) and prune empty parent folders
            </span>
          </label>

          <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3 py-2.5 text-xs text-ink-primary">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
            <span>
              This deletes {isMulti ? `all ${tracks.length} files` : "the file"} directly from your music library and{" "}
              <strong>cannot be undone</strong>.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3.5">
          <button
            id="cancel-delete-track-btn"
            type="button"
            disabled={deleting}
            onClick={onClose}
            className="m4-btn-secondary h-8 px-3 text-xs"
          >
            Cancel
          </button>
          <button
            id="confirm-delete-track-btn"
            type="button"
            disabled={deleting}
            onClick={() =>
              void onConfirm(tracks, {
                deleteSidecars: cleanupExtras,
                cleanupEmptyDirs: cleanupExtras,
              })
            }
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-danger px-3.5 text-xs font-semibold text-white transition-colors hover:bg-danger/90 disabled:opacity-50 cursor-pointer"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {deleting
              ? "Deleting..."
              : isMulti
                ? `Delete ${tracks.length} Files`
                : "Delete File"}
          </button>
        </div>
      </div>
    </div>
  );
}
