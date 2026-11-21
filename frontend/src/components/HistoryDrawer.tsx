import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  FolderTree,
  Globe,
  History,
  Image,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react";
import { getHistory } from "../api/client";
import type { AuditEntry } from "../types/music";

interface HistoryDrawerProps {
  open: boolean;
  undoingId: number | null;
  onClose: () => void;
  onUndo: (entry: AuditEntry) => Promise<void>;
}

const ACTION_META: Record<
  string,
  { label: string; kind: "tag" | "move" | "art" | "mb" | "undo" }
> = {
  update_track: { label: "Tag Edit", kind: "tag" },
  bulk_update: { label: "Bulk Edit", kind: "tag" },
  musicbrainz_apply: { label: "MusicBrainz Album", kind: "mb" },
  musicbrainz_apply_track: { label: "MusicBrainz Track", kind: "mb" },
  move_track: { label: "File Move", kind: "move" },
  update_artwork: { label: "Cover Upload", kind: "art" },
  copy_artwork: { label: "Cover Unified", kind: "art" },
  delete_artwork: { label: "Cover Removed", kind: "art" },
  musicbrainz_artwork: { label: "MusicBrainz Cover", kind: "art" },
  undo_tags: { label: "Undo Tags", kind: "undo" },
  undo_move: { label: "Undo Move", kind: "undo" },
};

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderActionIcon(kind: "tag" | "move" | "art" | "mb" | "undo") {
  switch (kind) {
    case "move":
      return <FolderTree className="h-3.5 w-3.5 text-accent" />;
    case "art":
      return <Image className="h-3.5 w-3.5 text-ink-secondary" />;
    case "mb":
      return <Globe className="h-3.5 w-3.5 text-accent" />;
    case "undo":
      return <RotateCcw className="h-3.5 w-3.5 text-ok" />;
    default:
      return <Pencil className="h-3.5 w-3.5 text-ink-secondary" />;
  }
}

export function HistoryDrawer({
  open,
  undoingId,
  onClose,
  onUndo,
}: HistoryDrawerProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getHistory(100);
      setEntries(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadHistory();
    }
  }, [open, loadHistory]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && undoingId === null) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, undoingId, onClose]);

  if (!open) return null;

  async function handleUndoClick(entry: AuditEntry) {
    await onUndo(entry);
    await loadHistory();
  }

  return (
    <div
      id="history-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-drawer-title"
      className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && undoingId === null) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-lg flex-col border-l border-border-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-accent">
              <History className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="history-drawer-title"
                className="text-sm font-semibold text-ink-primary"
              >
                Activity History &amp; Undo
              </h2>
              <p className="truncate text-xs text-ink-muted">
                Recent tag edits, MusicBrainz matches, and file moves stored in /config/m4.db
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadHistory()}
              className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
              title="Refresh history"
              aria-label="Refresh history"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button
              id="close-history-drawer-btn"
              type="button"
              disabled={undoingId !== null}
              onClick={onClose}
              className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
              aria-label="Close history drawer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Entries List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {loading && entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-xs text-ink-secondary">
              <Loader2 className="h-5 w-5 animate-spin text-accent" />
              Loading audit history...
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3.5 text-xs text-ink-primary">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <span>{error}</span>
            </div>
          ) : entries.length === 0 ? (
            <div className="py-16 text-center text-xs text-ink-muted">
              No edits recorded yet. Changes to tags, cover art, and file locations will appear here.
            </div>
          ) : (
            entries.map((entry) => {
              const meta = ACTION_META[entry.action] ?? {
                label: entry.action,
                kind: "tag" as const,
              };
              const isUndoing = undoingId === entry.id;
              const isMove = entry.action === "move_track" || entry.action === "undo_move";
              const sidecars = Array.isArray(entry.after_tags.sidecars)
                ? entry.after_tags.sidecars
                : [];

              return (
                <div
                  key={entry.id}
                  className={`rounded-xl border p-3.5 transition-colors ${
                    entry.undone
                      ? "border-border-subtle/60 bg-canvas/40 opacity-65"
                      : "border-border-subtle bg-canvas/70"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {renderActionIcon(meta.kind)}
                      <span className="text-xs font-semibold text-ink-primary">
                        {meta.label}
                      </span>
                      <span
                        className="font-mono text-[10px] text-ink-muted"
                        title={new Date(entry.timestamp).toLocaleString()}
                      >
                        {formatRelativeTime(entry.timestamp)}
                      </span>
                      {entry.undone && (
                        <span className="rounded bg-surface-elevated px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
                          Undone
                        </span>
                      )}
                    </div>

                    {entry.can_undo && (
                      <button
                        id={`undo-entry-${entry.id}-btn`}
                        type="button"
                        disabled={undoingId !== null}
                        onClick={() => void handleUndoClick(entry)}
                        className="m4-btn-secondary h-7 px-2 text-[11px] shrink-0"
                        title="Revert this change on disk"
                      >
                        {isUndoing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3 w-3" />
                        )}
                        Undo
                      </button>
                    )}
                  </div>

                  {isMove ? (
                    <div className="mt-2 space-y-1 font-mono text-[10px]">
                      <p className="break-all text-ink-muted">
                        {String(entry.before_tags.path ?? "")}
                      </p>
                      <p className="flex items-start gap-1 break-all text-ink-primary">
                        <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                        <span>{String(entry.after_tags.path ?? entry.path)}</span>
                      </p>
                      {sidecars.length > 0 && (
                        <p className="text-[10px] text-ink-muted">
                          + {sidecars.length} companion sidecar{" "}
                          {sidecars.length === 1 ? "file" : "files"}
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      <p className="mt-1.5 break-all font-mono text-[10px] text-ink-muted">
                        {entry.path}
                      </p>

                      {entry.changed_fields.length > 0 && (
                        <ul className="mt-2 space-y-1 border-t border-border-subtle/70 pt-2 text-[11px]">
                          {entry.changed_fields.map((field) => {
                            const beforeVal = entry.before_tags[field];
                            const afterVal = entry.after_tags[field];
                            const beforeStr =
                              typeof beforeVal === "string" && beforeVal
                                ? beforeVal
                                : "(empty)";
                            const afterStr =
                              typeof afterVal === "string" && afterVal
                                ? afterVal
                                : "(empty)";
                            return (
                              <li
                                key={field}
                                className="flex flex-wrap items-baseline gap-1.5"
                              >
                                <span className="font-mono text-[10px] text-ink-muted">
                                  {field}:
                                </span>
                                <span className="rounded bg-surface-elevated px-1.5 py-0.5 text-[10px] text-ink-muted line-through">
                                  {beforeStr}
                                </span>
                                <ArrowRight className="h-2.5 w-2.5 text-ink-muted" />
                                <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-ink-primary">
                                  {afterStr}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
