import { useState } from "react";
import { ChevronDown, ChevronRight, Disc, Library, User } from "lucide-react";
import type { AlbumGroup, ArtistGroup, LibraryStats } from "../types/music";

interface SidebarProps {
  artists: ArtistGroup[];
  stats: LibraryStats | null;
  selectedAlbumId: string | null;
  onSelectAll: () => void;
  onSelectAlbum: (artist: ArtistGroup, album: AlbumGroup) => void;
}

export function Sidebar({
  artists,
  stats,
  selectedAlbumId,
  onSelectAll,
  onSelectAlbum,
}: SidebarProps) {
  const [collapsedArtists, setCollapsedArtists] = useState<Record<string, boolean>>({});

  function toggleArtist(artistId: string) {
    setCollapsedArtists((prev) => ({
      ...prev,
      [artistId]: !prev[artistId],
    }));
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border-subtle bg-surface overflow-hidden">
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

      <div className="flex items-center justify-between px-3.5 pt-3 pb-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
          Artists
        </span>
        {stats && (
          <span className="font-mono text-[11px] text-ink-muted">
            {stats.artist_count}
          </span>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4" aria-label="Artists and albums">
        {artists.length === 0 ? (
          <p className="px-2 py-4 text-xs text-ink-muted">No matching artists.</p>
        ) : (
          <ul className="space-y-0.5">
            {artists.map((artist) => {
              const isCollapsed = Boolean(collapsedArtists[artist.id]);
              return (
                <li key={artist.id}>
                  <button
                    type="button"
                    onClick={() => toggleArtist(artist.id)}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium text-ink-primary hover:bg-surface-elevated transition-colors cursor-pointer"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                    )}
                    <User className="h-3 w-3 shrink-0 text-ink-muted" />
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
                              <span className="truncate flex-1">{album.title}</span>
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
