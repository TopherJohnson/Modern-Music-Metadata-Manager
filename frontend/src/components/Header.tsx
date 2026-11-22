import { useEffect, useMemo, useRef, useState } from "react";
import {
  CloudDownload,
  CornerDownLeft,
  Disc,
  Disc3,
  FolderTree,
  HardDrive,
  History,
  Inbox,
  Library,
  LogOut,
  Music,
  Radio,
  RefreshCw,
  Search,
  Settings,
  User,
  X,
} from "lucide-react";
import type {
  AlbumGroup,
  ArtistGroup,
  AuthStatusResponse,
  HealthResponse,
  LibraryInfo,
  TrackMetadata,
} from "../types/music";

export type WorkspaceMode = "library" | "staging";

interface HeaderProps {
  workspaceMode: WorkspaceMode;
  onChangeWorkspaceMode: (mode: WorkspaceMode) => void;
  stagingTrackCount: number;
  slskdSummary: { active: number; completed: number; failed: number };
  onOpenDownloads: () => void;
  query: string;
  appliedQuery: string;
  onQueryChange: (value: string) => void;
  onSubmitSearch: (value: string) => void;
  onClearSearch: () => void;
  allArtists: ArtistGroup[];
  onQuickSelectArtist: (artist: ArtistGroup) => void;
  onQuickSelectAlbum: (artist: ArtistGroup, album: AlbumGroup) => void;
  onQuickSelectTrack: (
    artist: ArtistGroup,
    album: AlbumGroup,
    track: TrackMetadata
  ) => void;
  onRescan: () => void;
  scanning: boolean;
  onNavidromeSync: () => void;
  syncingNavidrome: boolean;
  onOpenOrganize: () => void;
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  structureDriftCount: number;
  health: HealthResponse | null;
  libraries: LibraryInfo[];
  activeLibrary: LibraryInfo | null;
  onSelectLibrary: (libraryId: string) => void;
  authStatus: AuthStatusResponse | null;
  onLogout: () => void;
  trackCount: number;
}

type QuickMatchItem =
  | {
      kind: "artist";
      key: string;
      title: string;
      subtitle: string;
      artist: ArtistGroup;
      score: number;
    }
  | {
      kind: "album";
      key: string;
      title: string;
      subtitle: string;
      artist: ArtistGroup;
      album: AlbumGroup;
      score: number;
    }
  | {
      kind: "track";
      key: string;
      title: string;
      subtitle: string;
      artist: ArtistGroup;
      album: AlbumGroup;
      track: TrackMetadata;
      score: number;
    };

function scoreTextMatch(target: string, tokens: string[], fullQuery: string): number {
  const low = target.toLowerCase();
  if (!tokens.every((tok) => low.includes(tok))) return 0;
  if (low === fullQuery) return 100;
  if (low.startsWith(fullQuery)) return 88;
  if (tokens.some((tok) => low.startsWith(tok))) return 75;
  return 60;
}

export function Header({
  workspaceMode,
  onChangeWorkspaceMode,
  stagingTrackCount,
  slskdSummary,
  onOpenDownloads,
  query,
  appliedQuery,
  onQueryChange,
  onSubmitSearch,
  onClearSearch,
  allArtists,
  onQuickSelectArtist,
  onQuickSelectAlbum,
  onQuickSelectTrack,
  onRescan,
  scanning,
  onNavidromeSync,
  syncingNavidrome,
  onOpenOrganize,
  onOpenHistory,
  onOpenSettings,
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(0);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        setDropdownOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!dropdownOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [dropdownOpen]);

  // Compute top 5 matches across Artists, Albums, and Tracks
  const quickMatches = useMemo<QuickMatchItem[]>(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    const matches: QuickMatchItem[] = [];

    for (const artist of allArtists) {
      const artistScore = scoreTextMatch(artist.name, tokens, trimmed);
      if (artistScore > 0) {
        matches.push({
          kind: "artist",
          key: `artist:${artist.id}`,
          title: artist.name,
          subtitle: `${artist.album_count} ${
            artist.album_count === 1 ? "album" : "albums"
          } · ${artist.track_count} ${
            artist.track_count === 1 ? "track" : "tracks"
          }`,
          artist,
          score: artistScore + 6,
        });
      }

      for (const album of artist.albums) {
        const albumComposite = `${album.title} ${album.artist} ${album.year ?? ""} ${album.genre ?? ""}`;
        const titleScore = scoreTextMatch(album.title, tokens, trimmed);
        const compositeScore =
          titleScore > 0
            ? titleScore
            : scoreTextMatch(albumComposite, tokens, trimmed) * 0.85;
        if (compositeScore > 0) {
          matches.push({
            kind: "album",
            key: `album:${album.id}`,
            title: album.title,
            subtitle: `${album.artist}${album.year ? ` · ${album.year.slice(0, 4)}` : ""} (${
              album.track_count
            }t)`,
            artist,
            album,
            score: compositeScore + 4,
          });
        }

        for (const track of album.tracks) {
          const trackTitle = track.title || track.filename;
          const trackComposite = `${trackTitle} ${track.artist ?? ""} ${album.title} ${track.filename}`;
          const tScore = scoreTextMatch(trackTitle, tokens, trimmed);
          const cScore =
            tScore > 0
              ? tScore
              : scoreTextMatch(trackComposite, tokens, trimmed) * 0.8;
          if (cScore > 0) {
            matches.push({
              kind: "track",
              key: `track:${track.path}`,
              title: trackTitle,
              subtitle: `${track.artist || album.artist} — ${album.title}`,
              artist,
              album,
              track,
              score: cScore,
            });
          }
        }
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 5);
  }, [allArtists, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

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

  // Total selectable rows in dropdown: quickMatches + 1 ("Search library for ...")
  const totalMenuRows = query.trim() ? quickMatches.length + 1 : 0;

  function executeMatchSelection(item: QuickMatchItem) {
    setDropdownOpen(false);
    if (item.kind === "artist") {
      onQuickSelectArtist(item.artist);
    } else if (item.kind === "album") {
      onQuickSelectAlbum(item.artist, item.album);
    } else {
      onQuickSelectTrack(item.artist, item.album, item.track);
    }
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (dropdownOpen) {
        e.preventDefault();
        setDropdownOpen(false);
      } else if (query || appliedQuery) {
        e.preventDefault();
        onClearSearch();
      }
      return;
    }

    if (!query.trim()) {
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmitSearch("");
        setDropdownOpen(false);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setDropdownOpen(true);
      if (totalMenuRows > 0) {
        setActiveIndex((prev) => (prev + 1) % totalMenuRows);
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setDropdownOpen(true);
      if (totalMenuRows > 0) {
        setActiveIndex((prev) => (prev - 1 + totalMenuRows) % totalMenuRows);
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (dropdownOpen && activeIndex >= 0 && activeIndex < quickMatches.length) {
        executeMatchSelection(quickMatches[activeIndex]);
      } else {
        setDropdownOpen(false);
        onSubmitSearch(query.trim());
      }
    }
  }

  const showQuickDropdown = dropdownOpen && query.trim().length > 0;

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

      {/* Global Quick-Search Dropdown + Explicit Library Filter */}
      <div ref={containerRef} className="relative flex-1 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
        <input
          id="library-search-input"
          ref={searchRef}
          type="text"
          value={query}
          onFocus={() => {
            if (query.trim()) setDropdownOpen(true);
          }}
          onChange={(e) => {
            const val = e.target.value;
            onQueryChange(val);
            setDropdownOpen(Boolean(val.trim()));
          }}
          onKeyDown={handleSearchKeyDown}
          placeholder={
            isStaging
              ? "Quick jump or press Enter to filter staged downloads..."
              : "Quick jump to artist, album, track (⌘K)..."
          }
          className={`m4-input pl-9 pr-20 h-9 text-xs ${
            appliedQuery ? "border-accent/60" : ""
          }`}
          aria-label={isStaging ? "Search staging directory" : "Search music library"}
          aria-expanded={showQuickDropdown}
          aria-controls="global-quick-search-dropdown"
        />
        {query || appliedQuery ? (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {query.trim() && query.trim() !== appliedQuery && (
              <button
                id="header-search-submit-btn"
                type="button"
                onClick={() => {
                  setDropdownOpen(false);
                  onSubmitSearch(query.trim());
                }}
                className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent hover:text-[#14110c] transition-colors cursor-pointer"
                title="Filter main album grid by this query"
              >
                Search
              </button>
            )}
            <button
              id="clear-search-btn"
              type="button"
              onClick={() => {
                setDropdownOpen(false);
                onClearSearch();
              }}
              className="rounded p-0.5 text-ink-muted hover:text-ink-primary cursor-pointer"
              aria-label="Clear search"
              title="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center rounded border border-border-subtle bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
            ⌘K
          </kbd>
        )}

        {/* Top 5 Quick-Search Results Floating Popover */}
        {showQuickDropdown && (
          <div
            id="global-quick-search-dropdown"
            role="listbox"
            className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border-subtle bg-canvas/50 px-3 py-1.5 text-[10px] text-ink-muted">
              <span className="font-semibold uppercase tracking-wider">
                Top Matches
              </span>
              <span className="font-mono">↑↓ navigate · ↵ select</span>
            </div>

            {quickMatches.length === 0 ? (
              <div className="px-3.5 py-3 text-xs text-ink-muted">
                No direct artist, album, or track matches for “{query.trim()}”.
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle/50">
                {quickMatches.map((item, idx) => {
                  const isActive = idx === activeIndex;
                  const badgeLabel =
                    item.kind === "artist"
                      ? "Artist"
                      : item.kind === "album"
                        ? "Album"
                        : "Track";
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => executeMatchSelection(item)}
                        className={`flex w-full items-center justify-between gap-2.5 px-3.5 py-2 text-left text-xs transition-colors cursor-pointer ${
                          isActive
                            ? "bg-accent-soft/80 text-ink-primary"
                            : "hover:bg-surface-elevated text-ink-secondary"
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border ${
                              isActive
                                ? "border-accent/50 bg-accent/15 text-accent"
                                : "border-border-subtle bg-canvas text-ink-muted"
                            }`}
                          >
                            {item.kind === "artist" ? (
                              <User className="h-3.5 w-3.5" />
                            ) : item.kind === "album" ? (
                              <Disc className="h-3.5 w-3.5" />
                            ) : (
                              <Music className="h-3.5 w-3.5" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-ink-primary">
                              {item.title}
                            </p>
                            <p className="truncate text-[11px] text-ink-muted">
                              {item.subtitle}
                            </p>
                          </div>
                        </div>

                        <span
                          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                            item.kind === "artist"
                              ? "border-border-subtle bg-canvas text-ink-secondary"
                              : item.kind === "album"
                                ? "border-accent/40 bg-accent-soft text-accent"
                                : "border-border-subtle bg-surface-elevated text-ink-muted"
                          }`}
                        >
                          {badgeLabel}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Footer action: Filter entire album grid */}
            <div className="border-t border-border-subtle bg-canvas/60 p-1.5">
              <button
                id="quick-search-filter-grid-btn"
                type="button"
                onMouseEnter={() => setActiveIndex(quickMatches.length)}
                onClick={() => {
                  setDropdownOpen(false);
                  onSubmitSearch(query.trim());
                }}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                  activeIndex === quickMatches.length
                    ? "bg-accent text-[#14110c]"
                    : "text-accent hover:bg-accent-soft"
                }`}
              >
                <span className="flex items-center gap-1.5 truncate">
                  <Search className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    Filter album grid for “{query.trim()}”
                  </span>
                </span>
                <CornerDownLeft className="h-3.5 w-3.5 shrink-0 opacity-80" />
              </button>
            </div>
          </div>
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
          id="open-settings-btn"
          type="button"
          onClick={onOpenSettings}
          className="m4-btn-secondary h-8 px-2.5 text-xs"
          title="Configure optional integrations (slskd, Navidrome) and inspect mounts"
          aria-label="Open Settings"
        >
          <Settings className="h-3.5 w-3.5 text-ink-secondary" />
          <span className="hidden xl:inline">Settings</span>
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
