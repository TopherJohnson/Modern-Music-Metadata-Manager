import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Disc,
  Library,
  Search,
  User,
  X,
} from "lucide-react";
import type { AlbumGroup, ArtistGroup, LibraryStats } from "../types/music";

interface SidebarProps {
  artists: ArtistGroup[];
  stats: LibraryStats | null;
  selectedAlbumId: string | null;
  width?: number;
  onSelectAll: () => void;
  onSelectAlbum: (artist: ArtistGroup, album: AlbumGroup) => void;
}

export function Sidebar({
  artists,
  stats,
  selectedAlbumId,
  width = 256,
  onSelectAll,
  onSelectAlbum,
}: SidebarProps) {
  const [collapsedArtists, setCollapsedArtists] = useState<
    Record<string, boolean>
  >({});
  const [artistFilter, setArtistFilter] = useState("");

  // Auto-expand the parent artist whenever an album is selected from the main grid or quick search
  useEffect(() => {
    if (!selectedAlbumId) return;
    const parentArtist = artists.find((a) =>
      a.albums.some((alb) => alb.id === selectedAlbumId)
    );
    if (parentArtist) {
      setCollapsedArtists((prev) => {
        if (!prev[parentArtist.id]) return prev;
        return { ...prev, [parentArtist.id]: false };
      });
    }
  }, [selectedAlbumId, artists]);

  const filteredArtists = useMemo(() => {
    const q = artistFilter.trim().toLowerCase();
    if (!q) return artists;
    return artists.filter((artist) => artist.name.toLowerCase().includes(q));
  }, [artists, artistFilter]);

  const allCollapsed =
    filteredArtists.length > 0 &&
    filteredArtists.every((artist) => Boolean(collapsedArtists[artist.id]));

  function toggleArtist(artistId: string) {
    setCollapsedArtists((prev) => ({
      ...prev,
      [artistId]: !prev[artistId],
    }));
  }

  function handleToggleCollapseAll() {
    setCollapsedArtists((prev) => {
      const next = { ...prev };
      const shouldCollapse = !allCollapsed;
      for (const artist of filteredArtists) {
        next[artist.id] = shouldCollapse;
      }
      return next;
    });
  }

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-border-subtle bg-surface overflow-hidden"
    >
      <div className="border-b border-border-subtle p-2.5">
        <button
          id="nav-all-albums-btn"
          type="button"
          onClick={onSelectAll}
          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs font-medium transition-colors cursor-pointer ${
            selectedAlbumId === null
              ? "bg-accent-soft text-accent"
              : "text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary"
          }`}
        >
          <span className="flex items-center gap-2">
            <Library className="h-3.5 w-3.5" />
            All Albums
          </span>
          {stats && (
            <span className="font-mono text-[11px] opacity-80">
              {stats.album_count}
            </span>
          )}
        </button>
      </div>

      {/* Artists Header with Collapse All / Expand All Toggle */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
            Artists
          </span>
          {stats && (
            <span className="font-mono text-[11px] text-ink-muted">
              {artistFilter.trim()
                ? `${filteredArtists.length}/${stats.artist_count}`
                : stats.artist_count}
            </span>
          )}
        </div>

        {filteredArtists.length > 0 && (
          <button
            id="sidebar-toggle-collapse-all-btn"
            type="button"
            onClick={handleToggleCollapseAll}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-ink-muted hover:bg-surface-elevated hover:text-ink-primary transition-colors cursor-pointer"
            title={
              allCollapsed
                ? "Expand all artists in sidebar"
                : "Collapse all artists in sidebar"
            }
            aria-label={allCollapsed ? "Expand all artists" : "Collapse all artists"}
          >
            {allCollapsed ? (
              <>
                <ChevronsUpDown className="h-3 w-3" />
                <span>Expand</span>
              </>
            ) : (
              <>
                <ChevronsDownUp className="h-3 w-3" />
                <span>Collapse</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* Dedicated Artist Filter Input */}
      <div className="px-2.5 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-muted" />
          <input
            id="sidebar-artist-filter-input"
            type="text"
            value={artistFilter}
            onChange={(e) => setArtistFilter(e.target.value)}
            placeholder="Filter artists..."
            aria-label="Filter sidebar artists"
            className="m4-input h-7 pl-7 pr-6 text-xs"
          />
          {artistFilter && (
            <button
              id="sidebar-clear-artist-filter-btn"
              type="button"
              onClick={() => setArtistFilter("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-muted hover:text-ink-primary cursor-pointer"
              aria-label="Clear artist filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <nav
        className="flex-1 overflow-y-auto px-2 pb-4"
        aria-label="Artists and albums"
      >
        {filteredArtists.length === 0 ? (
          <p className="px-2 py-4 text-xs text-ink-muted">
            {artistFilter.trim()
              ? `No artists matching “${artistFilter.trim()}”.`
              : "No matching artists."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filteredArtists.map((artist) => {
              const isCollapsed = Boolean(collapsedArtists[artist.id]);
              const containsSelectedAlbum =
                selectedAlbumId !== null &&
                artist.albums.some((alb) => alb.id === selectedAlbumId);

              return (
                <li key={artist.id}>
                  <button
                    type="button"
                    onClick={() => toggleArtist(artist.id)}
                    className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors cursor-pointer ${
                      isCollapsed && containsSelectedAlbum
                        ? "bg-accent-soft/60 text-accent"
                        : "text-ink-primary hover:bg-surface-elevated"
                    }`}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                    )}
                    <User
                      className={`h-3 w-3 shrink-0 ${
                        containsSelectedAlbum ? "text-accent" : "text-ink-muted"
                      }`}
                    />
                    <span className="truncate flex-1">{artist.name}</span>
                    <span className="font-mono text-[10px] text-ink-muted">
                      {artist.album_count}
                    </span>
                  </button>

                  {!isCollapsed && (
                    <ul className="ml-4 mt-0.5 space-y-0.5 border-l border-border-subtle pl-2">
                      {artist.albums.map((album) => {
                        const active = selectedAlbumId === album.id;
                        return (
                          <li key={album.id}>
                            <button
                              type="button"
                              onClick={() => onSelectAlbum(artist, album)}
                              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors cursor-pointer ${
                                active
                                  ? "bg-accent-soft text-accent font-medium"
                                  : "text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary"
                              }`}
                            >
                              <Disc className="h-3 w-3 shrink-0 opacity-70" />
                              <span className="truncate flex-1">
                                {album.title}
                              </span>
                              {album.year && (
                                <span className="font-mono text-[10px] text-ink-muted shrink-0">
                                  {album.year.slice(0, 4)}
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
