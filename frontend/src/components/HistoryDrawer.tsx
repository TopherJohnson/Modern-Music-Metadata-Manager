import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FolderTree,
  Globe,
  History,
  Image,
  Layers,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { getHistory } from "../api/client";
import type { AuditEntry } from "../types/music";

interface HistoryDrawerProps {
  open: boolean;
  undoingId: number | null;
  undoingBatchId: string | null;
  activeLibraryName?: string;
  onClose: () => void;
  onUndo: (entry: AuditEntry) => Promise<void>;
  onUndoBatch: (batchId: string, entries: AuditEntry[]) => Promise<void>;
}

const ACTION_META: Record<
  string,
  {
    label: string;
    batchLabel?: string;
    kind: "tag" | "move" | "art" | "mb" | "undo" | "delete";
  }
> = {
  update_track: { label: "Tag Edit", kind: "tag" },
  bulk_update: { label: "Bulk Edit", batchLabel: "Bulk Tag Edit", kind: "tag" },
  musicbrainz_apply: {
    label: "MusicBrainz Album",
    batchLabel: "MusicBrainz Album Match",
    kind: "mb",
  },
  musicbrainz_apply_track: { label: "MusicBrainz Track", kind: "mb" },
  move_track: {
    label: "File Move",
    batchLabel: "Batch File Move",
    kind: "move",
  },
  delete_track: { label: "File Deleted", kind: "delete" },
  update_artwork: {
    label: "Cover Upload",
    batchLabel: "Album Cover Upload",
    kind: "art",
  },
  copy_artwork: {
    label: "Cover Unified",
    batchLabel: "Album Cover Unified",
    kind: "art",
  },
  delete_artwork: { label: "Cover Removed", kind: "art" },
  musicbrainz_artwork: {
    label: "MusicBrainz Cover",
    batchLabel: "MusicBrainz Album Cover",
    kind: "art",
  },
  undo_tags: { label: "Undo Tags", batchLabel: "Batch Undo Tags", kind: "undo" },
  undo_move: { label: "Undo Move", batchLabel: "Batch Undo Move", kind: "undo" },
};

type HistoryRowItem =
  | { type: "single"; entry: AuditEntry }
  | {
      type: "batch";
      batchId: string;
      action: string;
      timestamp: string;
      entries: AuditEntry[];
      undoableCount: number;
      allUndone: boolean;
      totalSidecars: number;
      distinctFields: string[];
    };

function groupHistoryEntries(entries: AuditEntry[]): HistoryRowItem[] {
  const byBatch = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    if (entry.batch_id) {
      const list = byBatch.get(entry.batch_id) ?? [];
      list.push(entry);
      byBatch.set(entry.batch_id, list);
    }
  }

  const emittedBatches = new Set<string>();
  const items: HistoryRowItem[] = [];

  for (const entry of entries) {
    const bid = entry.batch_id;
    if (!bid) {
      items.push({ type: "single", entry });
      continue;
    }
    const group = byBatch.get(bid) ?? [entry];
    if (group.length <= 1) {
      items.push({ type: "single", entry });
      continue;
    }
    if (emittedBatches.has(bid)) {
      continue;
    }
    emittedBatches.add(bid);

    let totalSidecars = 0;
    const fieldsSet = new Set<string>();
    for (const e of group) {
      if (Array.isArray(e.after_tags.sidecars)) {
        totalSidecars += e.after_tags.sidecars.length;
      }
      for (const f of e.changed_fields) {
        fieldsSet.add(f);
      }
    }

    items.push({
      type: "batch",
      batchId: bid,
      action: group[0].action,
      timestamp: group[0].timestamp,
      entries: group,
      undoableCount: group.filter((e) => e.can_undo).length,
      allUndone: group.every((e) => e.undone),
      totalSidecars,
      distinctFields: Array.from(fieldsSet).sort(),
    });
  }

  return items;
}

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

function renderActionIcon(
  kind: "tag" | "move" | "art" | "mb" | "undo" | "delete"
) {
  switch (kind) {
    case "move":
      return <FolderTree className="h-3.5 w-3.5 text-accent" />;
    case "art":
      return <Image className="h-3.5 w-3.5 text-ink-secondary" />;
    case "mb":
      return <Globe className="h-3.5 w-3.5 text-accent" />;
    case "undo":
      return <RotateCcw className="h-3.5 w-3.5 text-ok" />;
    case "delete":
      return <Trash2 className="h-3.5 w-3.5 text-danger" />;
    default:
      return <Pencil className="h-3.5 w-3.5 text-ink-secondary" />;
  }
}

export function HistoryDrawer({
  open,
  undoingId,
  undoingBatchId,
  activeLibraryName,
  onClose,
  onUndo,
  onUndoBatch,
}: HistoryDrawerProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedBatches, setExpandedBatches] = useState<Record<string, boolean>>({});

  const busy = undoingId !== null || undoingBatchId !== null;

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getHistory(200);
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
      if (event.key === "Escape" && !busy) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onClose]);

  const groupedItems = useMemo(() => groupHistoryEntries(entries), [entries]);

  if (!open) return null;

  async function handleUndoClick(entry: AuditEntry) {
    await onUndo(entry);
    await loadHistory();
  }

  async function handleUndoBatchClick(batchId: string, batchEntries: AuditEntry[]) {
    await onUndoBatch(batchId, batchEntries);
    await loadHistory();
  }

  function toggleBatch(batchId: string) {
    setExpandedBatches((prev) => ({ ...prev, [batchId]: !prev[batchId] }));
  }

  function renderEntryBody(entry: AuditEntry, compact = false) {
    const isMove = entry.action === "move_track" || entry.action === "undo_move";
    const sidecars = Array.isArray(entry.after_tags.sidecars)
      ? entry.after_tags.sidecars
      : [];

    if (isMove) {
      return (
        <div className={`${compact ? "mt-1" : "mt-2"} space-y-1 font-mono text-[10px]`}>
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
      );
    }

    return (
      <>
        <p className={`${compact ? "mt-1" : "mt-1.5"} break-all font-mono text-[10px] text-ink-muted`}>
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
    );
  }

  return (
    <div
      id="history-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-drawer-title"
      className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
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
                {activeLibraryName
                  ? `${activeLibraryName} — grouped edits & moves stored in /config/m4.db`
                  : "Grouped tag edits, MusicBrainz matches, and file moves in /config/m4.db"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              disabled={loading || busy}
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
              disabled={busy}
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
          ) : groupedItems.length === 0 ? (
            <div className="py-16 text-center text-xs text-ink-muted">
              No edits recorded yet. Changes to tags, cover art, and file locations will appear here.
            </div>
          ) : (
            groupedItems.map((item) => {
              if (item.type === "batch") {
                const meta = ACTION_META[item.action] ?? {
                  label: item.action,
                  kind: "tag" as const,
                };
                const expanded = !!expandedBatches[item.batchId];
                const isUndoingBatch = undoingBatchId === item.batchId;
                const isMoveBatch =
                  item.action === "move_track" || item.action === "undo_move";

                return (
                  <div
                    key={`batch-${item.batchId}`}
                    className={`rounded-xl border p-3.5 transition-colors ${
                      item.allUndone
                        ? "border-border-subtle/60 bg-canvas/40 opacity-65"
                        : "border-border-strong/80 bg-canvas/80"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                        {renderActionIcon(meta.kind)}
                        <span className="text-xs font-semibold text-ink-primary">
                          {meta.batchLabel ?? meta.label}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-surface-elevated px-2 py-0.5 font-mono text-[10px] font-medium text-ink-secondary">
                          <Layers className="h-2.5 w-2.5 text-accent" />
                          {item.entries.length} files
                        </span>
                        <span
                          className="font-mono text-[10px] text-ink-muted"
                          title={new Date(item.timestamp).toLocaleString()}
                        >
                          {formatRelativeTime(item.timestamp)}
                        </span>
                        {item.allUndone && (
                          <span className="rounded bg-surface-elevated px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
                            Undone
                          </span>
                        )}
                      </div>

                      {item.undoableCount > 0 && (
                        <button
                          id={`undo-batch-${item.batchId}-btn`}
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void handleUndoBatchClick(item.batchId, item.entries)
                          }
                          className="m4-btn-secondary h-7 px-2.5 text-[11px] shrink-0"
                          title={`Revert all ${item.undoableCount} files in this batch`}
                        >
                          {isUndoingBatch ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3 w-3" />
                          )}
                          Undo All ({item.undoableCount})
                        </button>
                      )}
                    </div>

                    {/* Batch Summary */}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-muted">
                      <div className="min-w-0 truncate">
                        {isMoveBatch ? (
                          <span>
                            Moved {item.entries.length} audio files
                            {item.totalSidecars > 0
                              ? ` + ${item.totalSidecars} companion sidecar ${
                                  item.totalSidecars === 1 ? "file" : "files"
                                }`
                              : ""}
                          </span>
                        ) : item.distinctFields.length > 0 ? (
                          <span className="font-mono text-[10px]">
                            Fields: {item.distinctFields.join(", ")}
                          </span>
                        ) : (
                          <span>Applied across {item.entries.length} tracks</span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => toggleBatch(item.batchId)}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary cursor-pointer shrink-0"
                      >
                        {expanded ? (
                          <>
                            <ChevronDown className="h-3 w-3" />
                            Hide files
                          </>
                        ) : (
                          <>
                            <ChevronRight className="h-3 w-3" />
                            Inspect {item.entries.length} files
                          </>
                        )}
                      </button>
                    </div>

                    {/* Expanded per-file list */}
                    {expanded && (
                      <div className="mt-2.5 max-h-72 overflow-y-auto space-y-2 border-t border-border-subtle pt-2.5 pr-1">
                        {item.entries.map((entry) => {
                          const isUndoing = undoingId === entry.id;
                          return (
                            <div
                              key={entry.id}
                              className={`rounded-lg border p-2.5 ${
                                entry.undone
                                  ? "border-border-subtle/50 bg-surface/40 opacity-60"
                                  : "border-border-subtle bg-surface/70"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-mono text-[10px] text-ink-secondary">
                                  #{entry.id}
                                  {entry.undone ? " · Undone" : ""}
                                </span>
                                {entry.can_undo && (
                                  <button
                                    id={`undo-entry-${entry.id}-btn`}
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleUndoClick(entry)}
                                    className="m4-btn-secondary h-6 px-2 text-[10px] shrink-0"
                                    title="Revert just this single file"
                                  >
                                    {isUndoing ? (
                                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                    ) : (
                                      <RotateCcw className="h-2.5 w-2.5" />
                                    )}
                                    Undo
                                  </button>
                                )}
                              </div>
                              {renderEntryBody(entry, true)}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              // Single (non-batched) entry
              const { entry } = item;
              const meta = ACTION_META[entry.action] ?? {
                label: entry.action,
                kind: "tag" as const,
              };
              const isUndoing = undoingId === entry.id;

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
                        disabled={busy}
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

                  {renderEntryBody(entry)}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
