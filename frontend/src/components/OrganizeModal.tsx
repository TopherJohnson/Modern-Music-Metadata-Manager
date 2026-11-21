import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  FolderTree,
  Info,
  Loader2,
  Save,
  X,
} from "lucide-react";
import { previewOrganize } from "../api/client";
import type {
  FolderTemplate,
  OrganizePreviewResponse,
  OrganizeSettings,
} from "../types/music";

interface OrganizeModalProps {
  open: boolean;
  savedSettings: OrganizeSettings;
  scopeLabel?: string | null;
  scopePaths?: string[] | null;
  savingSettings: boolean;
  applyingMoves: boolean;
  onClose: () => void;
  onSaveSettings: (settings: OrganizeSettings) => Promise<void>;
  onApplyMoves: (settings: OrganizeSettings, selectedPaths: string[]) => Promise<void>;
}

const TEMPLATES: Array<{
  id: FolderTemplate;
  name: string;
  description: string;
  exampleFolder: string;
  exampleFile: string;
}> = [
  {
    id: "artist_album",
    name: "Artist / Album",
    description: "Classic hierarchy grouped by Album Artist",
    exampleFolder: "The Black Keys/El Camino/",
    exampleFile: "01 - Lonely Boy.mp3",
  },
  {
    id: "artist_year_album",
    name: "Artist / Year - Album",
    description: "Chronological discography under each artist",
    exampleFolder: "The Black Keys/2011 - El Camino/",
    exampleFile: "01 - Lonely Boy.mp3",
  },
  {
    id: "album_only",
    name: "Album only",
    description: "Flat album folders — ideal for compilation-heavy libraries",
    exampleFolder: "El Camino/",
    exampleFile: "01 - Lonely Boy.mp3",
  },
  {
    id: "album_with_artist",
    name: "Album - Artist",
    description: "Flat album folders with artist suffix to avoid name collisions",
    exampleFolder: "El Camino - The Black Keys/",
    exampleFile: "01 - Lonely Boy.mp3",
  },
];

export function OrganizeModal({
  open,
  savedSettings,
  scopeLabel,
  scopePaths,
  savingSettings,
  applyingMoves,
  onClose,
  onSaveSettings,
  onApplyMoves,
}: OrganizeModalProps) {
  const [draft, setDraft] = useState<OrganizeSettings>(savedSettings);
  const [preview, setPreview] = useState<OrganizePreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [excludedPaths, setExcludedPaths] = useState<Set<string>>(new Set());
  const [confirmingMove, setConfirmingMove] = useState(false);

  const settingsDirty =
    draft.enabled !== savedSettings.enabled ||
    draft.template !== savedSettings.template ||
    draft.rename_files !== savedSettings.rename_files ||
    draft.compilation_folder !== savedSettings.compilation_folder ||
    draft.cleanup_empty_dirs !== savedSettings.cleanup_empty_dirs ||
    draft.skip_missing_metadata !== savedSettings.skip_missing_metadata;

  useEffect(() => {
    if (open) {
      setDraft(savedSettings);
      setExcludedPaths(new Set());
      setConfirmingMove(false);
    }
  }, [open, savedSettings]);

  const loadPreview = useCallback(
    async (settingsToPreview: OrganizeSettings) => {
      setLoadingPreview(true);
      setPreviewError(null);
      setConfirmingMove(false);
      try {
        const res = await previewOrganize(
          settingsToPreview,
          scopePaths ?? undefined
        );
        setPreview(res);
        setExcludedPaths(new Set());
      } catch (err) {
        setPreviewError(
          err instanceof Error ? err.message : "Could not generate move preview."
        );
        setPreview(null);
      } finally {
        setLoadingPreview(false);
      }
    },
    [scopePaths]
  );

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void loadPreview(draft);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open, draft, loadPreview]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !applyingMoves && !savingSettings) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, applyingMoves, savingSettings, onClose]);

  if (!open) return null;

  const moveItems = (preview?.items ?? []).filter((i) => i.status === "move");
  const conflictItems = (preview?.items ?? []).filter((i) => i.status === "conflict");
  const skippedItems = (preview?.items ?? []).filter((i) => i.status === "skipped");

  const selectedMovePaths = moveItems
    .map((i) => i.source_path)
    .filter((p) => !excludedPaths.has(p));

  function togglePath(path: string) {
    setConfirmingMove(false);
    setExcludedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function handleSaveOnly() {
    await onSaveSettings(draft);
  }

  async function handleExecuteMoves() {
    if (selectedMovePaths.length === 0 || applyingMoves) return;
    if (!confirmingMove) {
      setConfirmingMove(true);
      return;
    }
    // Persist settings first if modified so drift checks align with the move
    if (settingsDirty) {
      await onSaveSettings(draft);
    }
    await onApplyMoves(draft, selectedMovePaths);
    setConfirmingMove(false);
  }

  return (
    <div
      id="organize-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="organize-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget && !applyingMoves && !savingSettings) {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-accent">
              <FolderTree className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2
                id="organize-modal-title"
                className="text-sm font-semibold text-ink-primary"
              >
                {scopeLabel
                  ? `Reorganize Album: ${scopeLabel}`
                  : "Library Folder Organization"}
              </h2>
              <p className="truncate text-xs text-ink-muted">
                Configure your preferred folder layout, monitor drift, and preview moves safely before touching disk
              </p>
            </div>
          </div>

          <button
            id="close-organize-modal-btn"
            type="button"
            disabled={applyingMoves || savingSettings}
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-muted hover:bg-surface-elevated hover:text-ink-primary cursor-pointer"
            aria-label="Close organizer modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Master Enable Toggle */}
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border-subtle bg-canvas/60 px-4 py-3">
            <div>
              <p className="text-xs font-semibold text-ink-primary">
                Monitor library folder structure
              </p>
              <p className="mt-0.5 text-[11px] text-ink-secondary">
                Flag albums in the UI when their files don&apos;t match your chosen folder layout below.
              </p>
            </div>
            <button
              id="organize-enabled-switch"
              type="button"
              role="switch"
              aria-checked={draft.enabled}
              onClick={() =>
                setDraft((prev) => ({ ...prev, enabled: !prev.enabled }))
              }
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors cursor-pointer ${
                draft.enabled
                  ? "border-accent bg-accent"
                  : "border-border-strong bg-surface-elevated"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-canvas transition-transform ${
                  draft.enabled ? "translate-x-5.5" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Folder Layout Presets */}
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-muted">
              Folder Structure
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {TEMPLATES.map((tpl) => {
                const active = draft.template === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({ ...prev, template: tpl.id }))
                    }
                    className={`flex flex-col rounded-xl border p-3 text-left transition-colors cursor-pointer ${
                      active
                        ? "border-accent bg-accent-soft/50"
                        : "border-border-subtle bg-canvas/50 hover:border-border-strong hover:bg-surface-elevated"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-ink-primary">
                        {tpl.name}
                      </span>
                      {active && (
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[#14110c]">
                          <Check className="h-2.5 w-2.5 stroke-[3]" />
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-secondary">
                      {tpl.description}
                    </p>
                    <p className="mt-2 truncate rounded bg-surface px-2 py-1 font-mono text-[10px] text-ink-muted">
                      /music/
                      <span className="text-ink-primary">{tpl.exampleFolder}</span>
                      {draft.rename_files ? tpl.exampleFile : "<original-filename>"}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Options Row */}
          <div className="grid grid-cols-1 gap-2.5 rounded-xl border border-border-subtle bg-canvas/40 p-3.5 sm:grid-cols-3 text-xs">
            <label className="inline-flex items-start gap-2 text-ink-primary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={draft.rename_files}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, rename_files: e.target.checked }))
                }
                className="mt-0.5 h-3.5 w-3.5 accent-amber-500"
              />
              <span>
                <span className="font-medium">Standardize filenames</span>
                <span className="block text-[10px] text-ink-muted">
                  Rename to 01 - Track Title.ext
                </span>
              </span>
            </label>

            <label className="inline-flex items-start gap-2 text-ink-primary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={draft.cleanup_empty_dirs}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    cleanup_empty_dirs: e.target.checked,
                  }))
                }
                className="mt-0.5 h-3.5 w-3.5 accent-amber-500"
              />
              <span>
                <span className="font-medium">Remove empty folders</span>
                <span className="block text-[10px] text-ink-muted">
                  Clean up leftover empty directories
                </span>
              </span>
            </label>

            <label className="inline-flex items-start gap-2 text-ink-primary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={draft.skip_missing_metadata}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    skip_missing_metadata: e.target.checked,
                  }))
                }
                className="mt-0.5 h-3.5 w-3.5 accent-amber-500"
              />
              <span>
                <span className="font-medium">Skip untagged files</span>
                <span className="block text-[10px] text-ink-muted">
                  Don&apos;t move Unknown Artist / Album
                </span>
              </span>
            </label>
          </div>

          {/* Navidrome Best-Practice Tip */}
          <div className="flex items-start gap-2.5 rounded-xl border border-border-subtle bg-surface-elevated/60 px-3.5 py-2.5 text-[11px] text-ink-secondary">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            <p>
              <span className="font-medium text-ink-primary">Navidrome tip:</span>{" "}
              If you just edited tags, let Navidrome finish a scan before moving files so it can track the moved paths cleanly without losing play counts or playlists.
            </p>
          </div>

          {/* Dry-Run Preview */}
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                Dry-Run Move Preview
              </p>

              {preview && (
                <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
                  <span className="rounded-md bg-accent-soft px-2 py-0.5 text-accent">
                    {preview.moves_count} to move
                  </span>
                  <span className="rounded-md bg-surface-elevated px-2 py-0.5 text-ok">
                    {preview.unchanged_count} organized
                  </span>
                  {preview.skipped_count > 0 && (
                    <span className="rounded-md bg-surface-elevated px-2 py-0.5 text-ink-muted">
                      {preview.skipped_count} skipped
                    </span>
                  )}
                  {preview.conflict_count > 0 && (
                    <span className="rounded-md bg-danger/15 px-2 py-0.5 text-danger">
                      {preview.conflict_count} conflict{preview.conflict_count === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              )}
            </div>

            {loadingPreview ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-border-subtle bg-canvas/50 py-10 text-xs text-ink-secondary">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                Computing folder plan...
              </div>
            ) : previewError ? (
              <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3.5 text-xs text-ink-primary">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <span>{previewError}</span>
              </div>
            ) : preview &&
              moveItems.length === 0 &&
              conflictItems.length === 0 &&
              skippedItems.length === 0 ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-border-subtle bg-canvas/50 py-8 text-xs text-ok">
                <CheckCircle2 className="h-4 w-4" />
                Every track already matches this folder structure!
              </div>
            ) : (
              <div className="max-h-60 overflow-y-auto rounded-xl border border-border-subtle bg-canvas/60 divide-y divide-border-subtle/60">
                {moveItems.map((item) => {
                  const checked = !excludedPaths.has(item.source_path);
                  return (
                    <label
                      key={item.source_path}
                      className="flex items-start gap-2.5 px-3 py-2 text-[11px] hover:bg-surface-elevated/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePath(item.source_path)}
                        className="mt-1 h-3.5 w-3.5 shrink-0 accent-amber-500"
                      />
                      <div className="min-w-0 flex-1 font-mono leading-relaxed">
                        <p className="break-all text-ink-muted">{item.source_path}</p>
                        <p className="flex items-start gap-1 break-all text-ink-primary">
                          <ArrowRight className="mt-1 h-3 w-3 shrink-0 text-accent" />
                          <span>{item.target_path}</span>
                        </p>
                      </div>
                    </label>
                  );
                })}

                {conflictItems.map((item) => (
                  <div
                    key={`conflict-${item.source_path}`}
                    className="flex items-start gap-2.5 bg-danger/5 px-3 py-2 text-[11px]"
                  >
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
                    <div className="min-w-0 flex-1">
                      <p className="break-all font-mono text-ink-primary">
                        {item.source_path}
                      </p>
                      <p className="text-[10px] text-danger">
                        Conflict: {item.reason} ({item.target_path})
                      </p>
                    </div>
                  </div>
                ))}

                {skippedItems.map((item) => (
                  <div
                    key={`skipped-${item.source_path}`}
                    className="flex items-start gap-2.5 px-3 py-2 text-[11px] opacity-75"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                    <div className="min-w-0 flex-1">
                      <p className="break-all font-mono text-ink-secondary">
                        {item.source_path}
                      </p>
                      <p className="text-[10px] text-ink-muted">
                        Skipped: {item.reason}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-surface px-5 py-3.5">
          <button
            id="save-organize-settings-btn"
            type="button"
            disabled={!settingsDirty || savingSettings || applyingMoves}
            onClick={handleSaveOnly}
            className="m4-btn-secondary"
          >
            <Save className="h-3.5 w-3.5" />
            {savingSettings ? "Saving..." : "Save Preferences"}
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={applyingMoves || savingSettings}
              onClick={onClose}
              className="m4-btn-secondary"
            >
              Close
            </button>

            <button
              id="execute-organize-moves-btn"
              type="button"
              disabled={selectedMovePaths.length === 0 || applyingMoves || loadingPreview}
              onClick={handleExecuteMoves}
              className="m4-btn-primary"
            >
              {applyingMoves ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Moving Files...
                </>
              ) : confirmingMove ? (
                `Confirm: Move ${selectedMovePaths.length} ${
                  selectedMovePaths.length === 1 ? "File" : "Files"
                }`
              ) : (
                `Move ${selectedMovePaths.length} ${
                  selectedMovePaths.length === 1 ? "File" : "Files"
                }`
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
