import { useEffect, useRef } from "react";
import {
  CloudDownload,
  Disc3,
  FolderTree,
  HardDrive,
  History,
  Inbox,
  Library,
  LogOut,
  Radio,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  AuthStatusResponse,
  HealthResponse,
  LibraryInfo,
} from "../types/music";

export type WorkspaceMode = "library" | "staging";

interface HeaderProps {
  workspaceMode: WorkspaceMode;
  onChangeWorkspaceMode: (mode: WorkspaceMode) => void;
  stagingTrackCount: number;
  slskdSummary: { active: number; completed: number; failed: number };
  onOpenDownloads: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  onRescan: () => void;
  scanning: boolean;
  onNavidromeSync: () => void;
  syncingNavidrome: boolean;
  onOpenOrganize: () => void;
  onOpenHistory: () => void;
  structureDriftCount: number;
  health: HealthResponse | null;
  libraries: LibraryInfo[];
  activeLibrary: LibraryInfo | null;
  onSelectLibrary: (libraryId: string) => void;
  authStatus: AuthStatusResponse | null;
  onLogout: () => void;
  trackCount: number;
}

export function Header({
  workspaceMode,
  onChangeWorkspaceMode,
  stagingTrackCount,
  slskdSummary,
  onOpenDownloads,
  query,
  onQueryChange,
  onRescan,
  scanning,
  onNavidromeSync,
  syncingNavidrome,
  onOpenOrganize,
  onOpenHistory,
  structureDriftCount,
  health,
  libraries,
  activeLibrary,
  onSelectLibrary,
  authStatus,
  onLogout,
  trackCount,
}: HeaderProps) {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const isStaging = workspaceMode === "staging";
  const stagingConfigured = Boolean(health?.staging_configured);
  const slskdConfigured = Boolean(health?.slskd_configured);

  const mountExists = isStaging
    ? Boolean(health?.staging_dir_exists)
    : activeLibrary
      ? activeLibrary.exists
      : (health?.music_dir_exists ?? false);
  const mountReadable = isStaging
    ? Boolean(health?.staging_dir_readable)
    : activeLibrary
      ? activeLibrary.readable
      : (health?.music_dir_readable ?? false);
  const mountWritable = isStaging
    ? Boolean(health?.staging_dir_writable)
    : activeLibrary
      ? activeLibrary.writable
      : (health?.music_dir_writable ?? false);
  const mountPath = isStaging
    ? (health?.staging_dir ?? "/downloads")
    : (activeLibrary?.path ?? health?.music_dir ?? "/music");
  const mountKnown = activeLibrary !== null || health !== null;
  const mountOk = mountKnown && mountExists && mountReadable && mountWritable;

  const mountTooltip = mountKnown
    ? `${mountPath} — ${
        mountOk
          ? "read/write ready"
          : !mountExists
            ? "directory missing"
            : !mountWritable
              ? "read-only mount"
              : "unreadable"
      }`
    : "Checking container health...";

  return (
    <header
      className={`flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 transition-colors ${
        isStaging
          ? "border-cyan-500/40 bg-[#11191d]"
          : "border-border-subtle bg-surface"
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
            isStaging
              ? "border-cyan-500/50 bg-cyan-950/60 text-cyan-300"
              : "border-border-strong bg-surface-elevated text-accent"
          }`}
        >
          {isStaging ? (
            <Inbox className="h-4 w-4" />
          ) : (
            <Disc3 className="h-4.5 w-4.5" />
          )}
        </div>
        <div className="flex items-baseline gap-2 truncate">
          <h1 className="text-sm font-semibold tracking-tight text-ink-primary">
            M
            <sup
              className={`text-[10px] font-bold ml-0.5 ${
                isStaging ? "text-cyan-400" : "text-accent"
              }`}
            >
              4
            </sup>
          </h1>
          {!stagingConfigured && libraries.length <= 1 && (
            <span className="hidden sm:inline text-xs text-ink-muted truncate">
              Modern Music Metadata Manager
            </span>
          )}
        </div>

        {/* Workspace Switcher (visible only when Staging is configured) */}
        {stagingConfigured && (
          <div
            id="workspace-switcher"
            role="tablist"
            aria-label="Workspace mode"
            className="inline-flex h-8 items-center rounded-lg border border-border-subtle bg-canvas p-0.5 text-xs"
          >
            <button
              id="workspace-library-tab"
              type="button"
              role="tab"
              aria-selected={!isStaging}
              onClick={() => onChangeWorkspaceMode("library")}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors cursor-pointer ${
                !isStaging
                  ? "bg-surface-elevated text-accent shadow-xs"
                  : "text-ink-secondary hover:text-ink-primary"
              }`}
            >
              <Library className="h-3.5 w-3.5" />
              <span>Library</span>
            </button>
            <button
              id="workspace-staging-tab"
              type="button"
              role="tab"
              aria-selected={isStaging}
              onClick={() => onChangeWorkspaceMode("staging")}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors cursor-pointer ${
                isStaging
                  ? "bg-cyan-500/20 text-cyan-300 shadow-xs"
                  : "text-ink-secondary hover:text-ink-primary"
              }`}
            >
              <Inbox className="h-3.5 w-3.5" />
              <span>Staging</span>
              {stagingTrackCount > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] font-semibold ${
                    isStaging
                      ? "bg-cyan-400 text-[#0b161b]"
                      : "bg-cyan-500/20 text-cyan-300"
                  }`}
                >
                  {stagingTrackCount}
                </span>
              )}
            </button>
          </div>
        )}

        {!isStaging && libraries.length > 1 && activeLibrary && (
          <div className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-canvas px-2 h-8">
            <Library className="h-3.5 w-3.5 shrink-0 text-accent" />
            <select
              id="library-switcher"
              value={activeLibrary.id}
              onChange={(e) => onSelectLibrary(e.target.value)}
              aria-label="Select music library"
              title={`Active library: ${activeLibrary.name} (${activeLibrary.path})`}
              className="bg-transparent text-xs font-medium text-ink-primary focus:outline-none cursor-pointer pr-1 max-w-[160px]"
            >
              {libraries.map((lib) => (
                <option
                  key={lib.id}
                  value={lib.id}
                  className="bg-surface text-ink-primary"
                >
                  {lib.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="relative flex-1 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
        <input
          id="library-search-input"
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={
            isStaging
              ? "Filter staged downloads..."
              : "Search artists, albums, tracks, genres, formats..."
          }
          className="m4-input pl-9 pr-14 h-9 text-xs"
          aria-label={isStaging ? "Filter staging directory" : "Filter music library"}
        />
        {query ? (
          <button
            id="clear-search-btn"
            type="button"
            onClick={() => onQueryChange("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-muted hover:text-ink-primary"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center rounded border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
            ⌘K
          </kbd>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {slskdConfigured && (
          <button
            id="open-slskd-downloads-btn"
            type="button"
            onClick={onOpenDownloads}
            className="m4-btn-secondary h-8 px-2.5 text-xs"
            title="View live slskd (Soulseek) download progress"
          >
            <CloudDownload
              className={`h-3.5 w-3.5 ${
                slskdSummary.active > 0
                  ? "text-accent animate-pulse"
                  : slskdSummary.completed > 0
                    ? "text-ok"
                    : "text-ink-secondary"
              }`}
            />
            <span className="hidden md:inline">Downloads</span>
            {(slskdSummary.active > 0 || slskdSummary.completed > 0) && (
              <span
                className={`rounded-full px-1.5 py-0.2 font-mono text-[10px] font-semibold ${
                  slskdSummary.active > 0
                    ? "bg-accent text-[#14110c]"
                    : "bg-emerald-500/20 text-emerald-300"
                }`}
              >
                {slskdSummary.active > 0
                  ? slskdSummary.active
                  : slskdSummary.completed}
              </span>
            )}
          </button>
        )}

        {!isStaging && health?.navidrome_configured && (
          <button
            id="navidrome-sync-btn"
            type="button"
            onClick={onNavidromeSync}
            disabled={syncingNavidrome}
            className="m4-btn-secondary h-8 px-2.5 text-xs"
            title="Trigger Navidrome Subsonic library scan"
          >
            <Radio
              className={`h-3.5 w-3.5 text-ok ${syncingNavidrome ? "animate-pulse" : ""}`}
            />
            <span className="hidden md:inline">Navidrome</span>
          </button>
        )}

        {!isStaging && (
          <button
            id="open-organize-btn"
            type="button"
            onClick={onOpenOrganize}
            className="m4-btn-secondary h-8 px-2.5 text-xs"
            title="Library folder structure settings & mass organizer"
          >
            <FolderTree
              className={`h-3.5 w-3.5 ${
                structureDriftCount > 0 ? "text-accent" : "text-ink-secondary"
              }`}
            />
            <span className="hidden md:inline">Organize</span>
            {structureDriftCount > 0 && (
              <span className="rounded-full bg-accent-soft px-1.5 py-0.2 font-mono text-[10px] font-semibold text-accent">
                {structureDriftCount}
              </span>
            )}
          </button>
        )}

        <button
          id="open-history-btn"
          type="button"
          onClick={onOpenHistory}
          className="m4-btn-secondary h-8 px-2.5 text-xs"
          title="View activity history and undo recent edits or moves"
        >
          <History className="h-3.5 w-3.5 text-ink-secondary" />
          <span className="hidden xl:inline">History</span>
        </button>

        <button
          id="rescan-library-btn"
          type="button"
          onClick={onRescan}
          disabled={scanning}
          className="m4-btn-secondary h-8 px-2.5 text-xs"
          title={`Rescan ${mountPath}`}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">{scanning ? "Scanning" : "Rescan"}</span>
        </button>

        <div
          id="mount-health-indicator"
          title={mountTooltip}
          className={`hidden lg:flex items-center gap-2 rounded-lg border px-2.5 h-8 text-xs text-ink-secondary ${
            isStaging
              ? "border-cyan-500/35 bg-cyan-950/35"
              : "border-border-subtle bg-canvas"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              !mountKnown ? "bg-ink-muted" : mountOk ? "bg-ok" : "bg-danger"
            }`}
          />
          <HardDrive className="h-3.5 w-3.5 text-ink-muted" />
          <span className="font-mono text-[11px]">{trackCount}</span>
        </div>

        {authStatus?.enabled && authStatus.authenticated && (
          <button
            id="logout-btn"
            type="button"
            onClick={onLogout}
            className="m4-btn-secondary h-8 px-2 text-xs"
            title={`Sign out (${authStatus.username ?? "user"})`}
            aria-label="Sign out"
          >
            <LogOut className="h-3.5 w-3.5 text-ink-secondary" />
          </button>
        )}
      </div>
    </header>
  );
}
