import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CloudDownload,
  Inbox,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  clearCompletedSlskdDownloads,
  formatFileSize,
  getSlskdDownloads,
  removeSlskdDownload,
} from "../api/client";
import type { SlskdDownloadsResponse } from "../types/music";

interface SlskdDownloadsDrawerProps {
  open: boolean;
  stagingConfigured: boolean;
  onClose: () => void;
  onOpenStaging: () => void;
  onSummaryChange?: (summary: {
    active: number;
    completed: number;
    failed: number;
  }) => void;
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return "";
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

function classifyState(state: string): "completed" | "failed" | "active" {
  const low = state.toLowerCase();
  if (
    low.includes("succeeded") ||
    (low.includes("completed") &&
      !low.includes("errored") &&
      !low.includes("cancelled") &&
      !low.includes("rejected") &&
      !low.includes("timedout") &&
      !low.includes("aborted"))
  ) {
    return "completed";
  }
  if (
    low.includes("errored") ||
    low.includes("rejected") ||
    low.includes("cancelled") ||
    low.includes("timedout") ||
    low.includes("aborted") ||
    low.includes("failed")
  ) {
    return "failed";
  }
  return "active";
}

export function SlskdDownloadsDrawer({
  open,
  stagingConfigured,
  onClose,
  onOpenStaging,
  onSummaryChange,
}: SlskdDownloadsDrawerProps) {
  const [data, setData] = useState<SlskdDownloadsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchDownloads = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await getSlskdDownloads();
        setData(res);
        setError(null);
        onSummaryChange?.({
          active: res.active_count,
          completed: res.completed_count,
          failed: res.failed_count,
        });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not load slskd downloads"
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [onSummaryChange]
  );

  useEffect(() => {
    if (!open) return;
    void fetchDownloads(false);
    const timer = window.setInterval(() => {
      void fetchDownloads(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [open, fetchDownloads]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleClearCompleted = async () => {
    setClearing(true);
    try {
      await clearCompletedSlskdDownloads();
      await fetchDownloads(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not clear completed downloads"
      );
    } finally {
      setClearing(false);
    }
  };

  const handleRemove = async (username: string, id: string) => {
    setRemovingId(id);
    try {
      await removeSlskdDownload(username, id);
      await fetchDownloads(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove transfer");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        id="slskd-downloads-drawer"
        className="flex h-full w-full max-w-md flex-col border-l border-border-strong bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2">
            <CloudDownload className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-ink-primary">
              slskd Downloads
            </h2>
            {data && (
              <span className="rounded-full bg-surface-elevated px-2 py-0.5 font-mono text-[10px] text-ink-secondary">
                {data.active_count} active · {data.completed_count} done
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void fetchDownloads(false)}
              className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
              title="Refresh downloads"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
              aria-label="Close drawer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Action Strip */}
        {(stagingConfigured || (data && data.completed_count > 0)) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-canvas/40 px-5 py-2.5">
            {stagingConfigured ? (
              <button
                id="downloads-open-staging-btn"
                type="button"
                onClick={() => {
                  onClose();
                  onOpenStaging();
                }}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 text-[11px] font-medium text-cyan-300 hover:bg-cyan-500/20 cursor-pointer"
              >
                <Inbox className="h-3.5 w-3.5" />
                Open Staging / Inbox
              </button>
            ) : (
              <span className="text-[11px] text-ink-muted">
                Live transfers from slskd
              </span>
            )}
            {data && data.completed_count > 0 && (
              <button
                type="button"
                disabled={clearing}
                onClick={handleClearCompleted}
                className="m4-btn-secondary h-7 px-2.5 text-[11px]"
              >
                {clearing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                Clear Completed
              </button>
            )}
          </div>
        )}

        {/* Transfer List */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading && !data ? (
            <div className="flex flex-col items-center justify-center gap-2 py-12 text-xs text-ink-secondary">
              <Loader2 className="h-5 w-5 animate-spin text-accent" />
              <span>Loading slskd transfers...</span>
            </div>
          ) : !data || data.transfers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-strong bg-canvas/30 px-5 py-12 text-center">
              <CloudDownload className="mx-auto mb-2.5 h-6 w-6 text-ink-muted opacity-50" />
              <p className="text-xs font-medium text-ink-primary">
                No downloads in slskd
              </p>
              <p className="mt-1 text-[11px] text-ink-secondary">
                Queue a missing track from any incomplete album’s ghost row to
                watch its progress here.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {data.transfers.map((tr) => {
                const bucket = classifyState(tr.state);
                const pct = Math.max(0, Math.min(100, tr.percent_complete));
                return (
                  <div
                    key={`${tr.username}:${tr.id}`}
                    className="rounded-xl border border-border-subtle bg-canvas/50 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p
                          className="truncate text-xs font-medium text-ink-primary"
                          title={tr.filename}
                        >
                          {tr.basename}
                        </p>
                        <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                          {tr.username} · {formatFileSize(tr.size)}
                          {tr.average_speed > 0 && bucket === "active"
                            ? ` · ${formatSpeed(tr.average_speed)}`
                            : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={removingId === tr.id}
                        onClick={() => handleRemove(tr.username, tr.id)}
                        className="rounded p-1 text-ink-muted hover:bg-surface-elevated hover:text-danger cursor-pointer"
                        title="Remove / cancel transfer"
                        aria-label="Remove transfer"
                      >
                        {removingId === tr.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <X className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>

                    {/* Progress Bar */}
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
                      <div
                        className={`h-full transition-all duration-300 ${
                          bucket === "completed"
                            ? "bg-ok"
                            : bucket === "failed"
                              ? "bg-danger"
                              : "bg-accent"
                        }`}
                        style={{ width: `${bucket === "completed" ? 100 : pct}%` }}
                      />
                    </div>

                    <div className="mt-1.5 flex items-center justify-between text-[10px]">
                      <span
                        className={`inline-flex items-center gap-1 font-mono ${
                          bucket === "completed"
                            ? "text-ok"
                            : bucket === "failed"
                              ? "text-danger"
                              : "text-accent"
                        }`}
                      >
                        {bucket === "completed" && (
                          <CheckCircle2 className="h-3 w-3" />
                        )}
                        {tr.state}
                      </span>
                      <span className="font-mono text-ink-muted">
                        {Math.round(pct)}%
                      </span>
                    </div>

                    {tr.exception && (
                      <p className="mt-1 text-[10px] text-danger">
                        {tr.exception}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
