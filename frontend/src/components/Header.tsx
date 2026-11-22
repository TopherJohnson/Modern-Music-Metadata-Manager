import { useEffect, useRef } from "react";
import {
  Disc3,
  FolderTree,
  HardDrive,
  History,
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

interface HeaderProps {
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

  const mountExists = activeLibrary
    ? activeLibrary.exists
    : (health?.music_dir_exists ?? false);
  const mountReadable = activeLibrary
    ? activeLibrary.readable
    : (health?.music_dir_readable ?? false);
  const mountWritable = activeLibrary
    ? activeLibrary.writable
    : (health?.music_dir_writable ?? false);
  const mountPath = activeLibrary?.path ?? health?.music_dir ?? "/music";
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
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle bg-surface px-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-elevated text-accent">
          <Disc3 className="h-4.5 w-4.5" />
        </div>
        <div className="flex items-baseline gap-2 truncate">
          <h1 className="text-sm font-semibold tracking-tight text-ink-primary">
            M<sup className="text-[10px] font-bold text-accent ml-0.5">4</sup>
          </h1>
          {libraries.length <= 1 && (
            <span className="hidden sm:inline text-xs text-ink-muted truncate">
              Modern Music Metadata Manager
            </span>
          )}
        </div>

        {libraries.length > 1 && activeLibrary && (
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
          placeholder="Search artists, albums, tracks, genres, formats..."
          className="m4-input pl-9 pr-14 h-9 text-xs"
          aria-label="Filter music library"
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
        {health?.navidrome_configured && (
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
          className="hidden lg:flex items-center gap-2 rounded-lg border border-border-subtle bg-canvas px-2.5 h-8 text-xs text-ink-secondary"
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
