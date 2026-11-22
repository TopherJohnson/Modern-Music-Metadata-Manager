import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FolderInput,
  Inbox,
  Library,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import { previewStagingImport } from "../api/client";
import type {
  LibraryInfo,
  StagingImportPreviewResponse,
} from "../types/music";

interface StagingImportModalProps {
  open: boolean;
  scopeLabel: string | null;
  paths: string[] | null;
  libraries: LibraryInfo[];
  defaultTargetLibraryId: string;
  importing: boolean;
  onClose: () => void;
  onConfirmImport: (targetLibraryId: string, paths: string[] | null) => void;
}

export function StagingImportModal({
  open,
  scopeLabel,
  paths,
  libraries,
  defaultTargetLibraryId,
  importing,
  onClose,
  onConfirmImport,
}: StagingImportModalProps) {
  const [targetLibraryId, setTargetLibraryId] = useState(defaultTargetLibraryId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<StagingImportPreviewResponse | null>(
    null
  );

  useEffect(() => {
    if (!open) return;
    setTargetLibraryId(defaultTargetLibraryId || libraries[0]?.id || "default");
  }, [open, defaultTargetLibraryId, libraries]);

  useEffect(() => {
    if (!open || !targetLibraryId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void previewStagingImport({ targetLibraryId, paths })
      .then((res) => {
        if (!cancelled) setPreview(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : "Could not compute destination preview"
          );
          setPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, targetLibraryId, paths]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const readyPaths =
    preview?.items
      .filter((i) => i.status === "import")
      .map((i) => i.source_path) ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        id="staging-import-modal"
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-cyan-500/40 bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle bg-cyan-950/25 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Inbox className="h-4 w-4 text-cyan-400" />
              <h2 className="text-sm font-semibold text-ink-primary">
                Import from Staging to Library
              </h2>
              {scopeLabel && (
                <span className="truncate rounded-md border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300">
                  {scopeLabel}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-ink-secondary">
              Files and companion sidecars will be moved cleanly out of Staging
              into your music library (cross-mount safe, with batch undo in
              History).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Target Library Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle bg-canvas/40 px-5 py-3">
          <div className="flex items-center gap-2">
            <Library className="h-3.5 w-3.5 text-accent" />
            <span className="text-xs font-medium text-ink-secondary">
              Target Library:
            </span>
            {libraries.length > 1 ? (
              <select
                id="staging-target-library-select"
                value={targetLibraryId}
                onChange={(e) => setTargetLibraryId(e.target.value)}
                className="m4-input h-8 w-auto min-w-[160px] py-0 text-xs"
              >
                {libraries.map((lib) => (
                  <option key={lib.id} value={lib.id}>
                    {lib.name} ({lib.path})
                  </option>
                ))}
              </select>
            ) : (
              <span className="font-mono text-xs text-ink-primary">
                {preview?.target_library_name || libraries[0]?.name || "Music"}{" "}
                <span className="text-ink-muted">
                  ({preview?.target_library_path || libraries[0]?.path || "/music"})
                </span>
              </span>
            )}
          </div>

          {preview && (
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
                {preview.import_count} ready
              </span>
              {preview.drop_in_count > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-cyan-300">
                  <Sparkles className="h-2.5 w-2.5" />
                  {preview.drop_in_count} drop-in
                </span>
              )}
              {preview.sidecar_moves_count > 0 && (
                <span className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-ink-secondary">
                  +{preview.sidecar_moves_count} sidecar
                  {preview.sidecar_moves_count === 1 ? "" : "s"}
                </span>
              )}
              {preview.conflict_count > 0 && (
                <span className="rounded-full border border-danger/45 bg-danger/15 px-2 py-0.5 text-danger">
                  {preview.conflict_count} conflict
                  {preview.conflict_count === 1 ? "" : "s"}
                </span>
              )}
              {preview.skipped_count > 0 && (
                <span className="rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-ink-muted">
                  {preview.skipped_count} skipped
                </span>
              )}
            </div>
          )}
        </div>

        {/* Preview List */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-xs text-ink-secondary">
              <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
              <span>Computing library destination paths...</span>
            </div>
          ) : !preview || preview.items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-strong bg-canvas/30 px-5 py-10 text-center text-xs text-ink-secondary">
              No staged audio files selected for import.
            </div>
          ) : (
            <div className="space-y-2">
              {preview.items.map((item) => (
                <div
                  key={item.source_path}
                  className={`rounded-xl border px-3.5 py-2.5 text-xs ${
                    item.status === "conflict"
                      ? "border-danger/45 bg-danger/10"
                      : item.status === "skipped"
                        ? "border-border-subtle bg-canvas/30 opacity-75"
                        : item.drop_in
                          ? "border-cyan-500/35 bg-cyan-950/20"
                          : "border-border-subtle bg-canvas/50"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {item.status === "import" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-ok" />
                      ) : (
                        <AlertTriangle
                          className={`h-3.5 w-3.5 shrink-0 ${
                            item.status === "conflict"
                              ? "text-danger"
                              : "text-warn"
                          }`}
                        />
                      )}
                      <span className="truncate font-medium text-ink-primary">
                        {item.artist} — {item.album}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {item.drop_in && item.status === "import" && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-300"
                          title={`Matches existing album "${item.existing_album_title}" in target library`}
                        >
                          <Sparkles className="h-2.5 w-2.5" />
                          Drop-in to existing album
                        </span>
                      )}
                      <span
                        className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${
                          item.status === "import"
                            ? "bg-emerald-500/15 text-emerald-300"
                            : item.status === "conflict"
                              ? "bg-danger/20 text-danger"
                              : "bg-surface-elevated text-ink-muted"
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>
                  </div>

                  <div className="mt-1.5 flex flex-col gap-1 font-mono text-[11px] sm:flex-row sm:items-center sm:gap-2">
                    <span className="truncate text-ink-muted" title={item.source_path}>
                      staging/{item.source_path}
                    </span>
                    <ArrowRight className="hidden h-3 w-3 shrink-0 text-cyan-400 sm:inline" />
                    <span
                      className="truncate text-ink-primary"
                      title={item.target_path}
                    >
                      {preview.target_library_name}/{item.target_path}
                    </span>
                  </div>

                  {item.reason && (
                    <p
                      className={`mt-1 text-[11px] ${
                        item.status === "conflict"
                          ? "text-danger"
                          : "text-ink-muted"
                      }`}
                    >
                      {item.reason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border-subtle bg-canvas/40 px-5 py-3">
          <p className="text-[11px] text-ink-muted">
            Navidrome will be notified once after import completes.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={importing}
              className="m4-btn-secondary text-xs"
            >
              Cancel
            </button>
            <button
              id="confirm-staging-import-btn"
              type="button"
              disabled={importing || loading || readyPaths.length === 0}
              onClick={() => onConfirmImport(targetLibraryId, readyPaths)}
              className="m4-btn-primary text-xs"
            >
              {importing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FolderInput className="h-3.5 w-3.5" />
              )}
              Import {readyPaths.length}{" "}
              {readyPaths.length === 1 ? "Track" : "Tracks"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
