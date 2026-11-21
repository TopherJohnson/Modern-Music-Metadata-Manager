import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyMusicBrainzRelease,
  copyArtwork,
  deleteArtwork,
  getHealth,
  getLibrary,
  getTrack,
  triggerLibraryScan,
  triggerNavidromeScan,
  updateTrack,
  updateTracksBulk,
  uploadArtwork,
} from "./api/client";
import { Header } from "./components/Header";
import { MetadataEditor } from "./components/MetadataEditor";
import {
  MusicBrainzModal,
  type MusicBrainzModalMode,
} from "./components/MusicBrainzModal";
import { Sidebar } from "./components/Sidebar";
import { Toast, type ToastMessage } from "./components/Toast";
import { TrackList } from "./components/TrackList";
import type {
  AlbumGroup,
  ArtistGroup,
  HealthResponse,
  LibraryResponse,
  MusicBrainzApplyPayload,
  NavidromeSyncResult,
  TrackMetadata,
  TrackTags,
} from "./types/music";

function findAlbumAndTrackByPath(
  artists: ArtistGroup[],
  trackPath: string
): { album: AlbumGroup; track: TrackMetadata } | null {
  for (const artist of artists) {
    for (const album of artist.albums) {
      const match = album.tracks.find((t) => t.path === trackPath);
      if (match) {
        return { album, track: match };
      }
    }
  }
  return null;
}

function formatNavidromeNote(sync: NavidromeSyncResult): string | undefined {
  if (!sync.configured) return undefined;
  if (sync.triggered && sync.ok) return "Navidrome rescan triggered.";
  if (sync.triggered && !sync.ok) return sync.detail ?? "Navidrome rescan failed.";
  return undefined;
}

export function App() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [selectedTrackPath, setSelectedTrackPath] = useState<string | null>(null);
  const [liveTrack, setLiveTrack] = useState<TrackMetadata | null>(null);
  const [isBulkMode, setIsBulkMode] = useState(false);

  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingArtwork, setUploadingArtwork] = useState(false);
  const [syncingNavidrome, setSyncingNavidrome] = useState(false);
  const [artworkRevision, setArtworkRevision] = useState(1);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [applyingMb, setApplyingMb] = useState(false);
  const [mbModal, setMbModal] = useState<{
    open: boolean;
    mode: MusicBrainzModalMode;
    album: string;
    artist: string;
    targetPaths: string[];
    localTrackCount: number;
  }>({
    open: false,
    mode: "identify",
    album: "",
    artist: "",
    targetPaths: [],
    localTrackCount: 0,
  });

  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback(
    (kind: ToastMessage["kind"], title: string, detail?: string) => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      setToast({ id: Date.now(), kind, title, detail });
      toastTimerRef.current = window.setTimeout(() => {
        setToast(null);
      }, 4500);
    },
    []
  );

  // Debounce search query
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const refreshHealth = useCallback(async () => {
    try {
      const data = await getHealth();
      setHealth(data);
    } catch {
      setHealth(null);
    }
  }, []);

  const fetchLibrary = useCallback(
    async (searchText: string, { silent = false } = {}) => {
      if (!silent) setLoading(true);
      try {
        const data = await getLibrary(searchText);
        setLibrary(data);
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load library";
        showToast("error", "Could not load library", msg);
        return null;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    void fetchLibrary(debouncedQuery);
  }, [debouncedQuery, fetchLibrary]);

  const artists = library?.artists ?? [];

  const selectedAlbum = useMemo<AlbumGroup | null>(() => {
    if (!selectedAlbumId) return null;
    for (const artist of artists) {
      const found = artist.albums.find((a) => a.id === selectedAlbumId);
      if (found) return found;
    }
    return null;
  }, [artists, selectedAlbumId]);

  const activeTrack = useMemo<TrackMetadata | null>(() => {
    if (isBulkMode || !selectedTrackPath) return null;
    if (liveTrack && liveTrack.path === selectedTrackPath) {
      return liveTrack;
    }
    const found = findAlbumAndTrackByPath(artists, selectedTrackPath);
    return found?.track ?? null;
  }, [artists, isBulkMode, liveTrack, selectedTrackPath]);

  const handleSelectAll = () => {
    setSelectedAlbumId(null);
    setSelectedTrackPath(null);
    setLiveTrack(null);
    setIsBulkMode(false);
  };

  const handleSelectAlbum = (_artist: ArtistGroup, album: AlbumGroup) => {
    setSelectedAlbumId(album.id);
    setIsBulkMode(false);
    // Keep track selection only if it belongs to this album
    if (selectedTrackPath && !album.tracks.some((t) => t.path === selectedTrackPath)) {
      setSelectedTrackPath(null);
      setLiveTrack(null);
    }
  };

  const handleSelectTrack = async (track: TrackMetadata) => {
    setIsBulkMode(false);
    setSelectedTrackPath(track.path);
    setLiveTrack(track);
    try {
      const fresh = await getTrack(track.path);
      setLiveTrack(fresh);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not read track metadata";
      showToast("error", "Track read error", msg);
    }
  };

  const handleStartBulkEdit = (album: AlbumGroup) => {
    setSelectedAlbumId(album.id);
    setIsBulkMode(true);
  };

  const handleRescan = async () => {
    setScanning(true);
    try {
      const data = await triggerLibraryScan();
      setLibrary(data);
      setArtworkRevision((r) => r + 1);
      await refreshHealth();
      showToast(
        "success",
        "Library rescanned",
        `Indexed ${data.stats.track_count} tracks across ${data.stats.album_count} albums.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Scan failed";
      showToast("error", "Rescan failed", msg);
    } finally {
      setScanning(false);
    }
  };

  const handleNavidromeSync = async () => {
    setSyncingNavidrome(true);
    try {
      const result = await triggerNavidromeScan();
      showToast(
        result.ok ? "success" : "error",
        result.ok ? "Navidrome scan started" : "Navidrome scan failed",
        result.detail ?? undefined
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Request failed";
      showToast("error", "Navidrome sync failed", msg);
    } finally {
      setSyncingNavidrome(false);
    }
  };

  const handleSaveTrack = async (path: string, updates: Partial<TrackTags>) => {
    setSaving(true);
    try {
      const response = await updateTrack({ path, ...updates });
      setLiveTrack(response.track);
      const updatedLib = await fetchLibrary(debouncedQuery, { silent: true });
      if (updatedLib) {
        const relocated = findAlbumAndTrackByPath(updatedLib.artists, response.track.path);
        if (relocated) {
          setSelectedAlbumId(relocated.album.id);
        }
      }
      showToast(
        "success",
        `Saved "${response.track.title || response.track.filename}"`,
        formatNavidromeNote(response.navidrome_sync)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save tags";
      showToast("error", "Save failed", msg);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveBulk = async (paths: string[], updates: Partial<TrackTags>) => {
    setSaving(true);
    try {
      const response = await updateTracksBulk({ paths, ...updates });
      const updatedLib = await fetchLibrary(debouncedQuery, { silent: true });
      if (updatedLib && response.updated.length > 0) {
        const relocated = findAlbumAndTrackByPath(
          updatedLib.artists,
          response.updated[0].path
        );
        if (relocated) {
          setSelectedAlbumId(relocated.album.id);
        }
      }
      if (response.errors.length > 0) {
        showToast(
          "error",
          `Updated ${response.updated.length} tracks (${response.errors.length} failed)`,
          response.errors[0].error
        );
      } else {
        showToast(
          "success",
          `Updated ${response.updated.length} tracks`,
          formatNavidromeNote(response.navidrome_sync)
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bulk update failed";
      showToast("error", "Bulk update failed", msg);
    } finally {
      setSaving(false);
    }
  };

  const handleUploadArtwork = async (paths: string[], file: File) => {
    setUploadingArtwork(true);
    try {
      const response = await uploadArtwork(paths, file);
      if (response.updated.length === 1 && liveTrack?.path === response.updated[0].path) {
        setLiveTrack(response.updated[0]);
      }
      setArtworkRevision((r) => r + 1);
      await fetchLibrary(debouncedQuery, { silent: true });
      if (response.errors.length > 0) {
        showToast(
          "error",
          `Artwork updated on ${response.updated.length} file(s), ${response.errors.length} failed`,
          response.errors[0].error
        );
      } else {
        showToast(
          "success",
          `Embedded artwork on ${response.updated.length} ${
            response.updated.length === 1 ? "track" : "tracks"
          }`,
          formatNavidromeNote(response.navidrome_sync)
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Artwork upload failed";
      showToast("error", "Artwork upload failed", msg);
    } finally {
      setUploadingArtwork(false);
    }
  };

  const handleCopyArtwork = async (sourcePath: string, targetPaths: string[]) => {
    setUploadingArtwork(true);
    try {
      const response = await copyArtwork(sourcePath, targetPaths);
      if (
        response.updated.length === 1 &&
        liveTrack?.path === response.updated[0].path
      ) {
        setLiveTrack(response.updated[0]);
      } else if (liveTrack) {
        const refreshed = response.updated.find((t) => t.path === liveTrack.path);
        if (refreshed) setLiveTrack(refreshed);
      }
      setArtworkRevision((r) => r + 1);
      await fetchLibrary(debouncedQuery, { silent: true });
      if (response.errors.length > 0) {
        showToast(
          "error",
          `Applied cover to ${response.updated.length} file(s), ${response.errors.length} failed`,
          response.errors[0].error
        );
      } else {
        showToast(
          "success",
          `Applied cover art to ${response.updated.length} ${
            response.updated.length === 1 ? "track" : "tracks"
          }`,
          formatNavidromeNote(response.navidrome_sync)
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not copy artwork";
      showToast("error", "Artwork update failed", msg);
    } finally {
      setUploadingArtwork(false);
    }
  };

  const handleDeleteArtwork = async (path: string) => {
    setUploadingArtwork(true);
    try {
      const response = await deleteArtwork(path);
      setLiveTrack(response.track);
      setArtworkRevision((r) => r + 1);
      await fetchLibrary(debouncedQuery, { silent: true });
      showToast(
        "success",
        "Removed embedded artwork",
        formatNavidromeNote(response.navidrome_sync)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not remove artwork";
      showToast("error", "Artwork removal failed", msg);
    } finally {
      setUploadingArtwork(false);
    }
  };

  const handleOpenMusicBrainz = (
    mode: MusicBrainzModalMode,
    targetPaths: string[]
  ) => {
    const albumTitle =
      selectedAlbum?.title || activeTrack?.album || "";
    const artistName =
      selectedAlbum?.artist ||
      activeTrack?.album_artist ||
      activeTrack?.artist ||
      "";
    setMbModal({
      open: true,
      mode,
      album: albumTitle === "Unknown Album" ? "" : albumTitle,
      artist: artistName === "Unknown Artist" ? "" : artistName,
      targetPaths,
      localTrackCount: selectedAlbum?.track_count ?? targetPaths.length,
    });
  };

  const handleIdentifyAlbum = (album: AlbumGroup) => {
    setSelectedAlbumId(album.id);
    setMbModal({
      open: true,
      mode: "identify",
      album: album.title === "Unknown Album" ? "" : album.title,
      artist: album.artist === "Unknown Artist" ? "" : album.artist,
      targetPaths: album.tracks.map((t) => t.path),
      localTrackCount: album.track_count,
    });
  };

  const handleApplyMusicBrainz = async (payload: MusicBrainzApplyPayload) => {
    setApplyingMb(true);
    try {
      const response = await applyMusicBrainzRelease(payload);
      if (liveTrack) {
        const refreshed = response.updated.find((t) => t.path === liveTrack.path);
        if (refreshed) setLiveTrack(refreshed);
      }
      setArtworkRevision((r) => r + 1);
      const updatedLib = await fetchLibrary(debouncedQuery, { silent: true });
      if (updatedLib && response.updated.length > 0) {
        const relocated = findAlbumAndTrackByPath(
          updatedLib.artists,
          response.updated[0].path
        );
        if (relocated) {
          setSelectedAlbumId(relocated.album.id);
        }
      }
      setMbModal((prev) => ({ ...prev, open: false }));

      const details = [
        response.artwork_note,
        formatNavidromeNote(response.navidrome_sync),
      ]
        .filter(Boolean)
        .join(" ");

      if (response.errors.length > 0) {
        showToast(
          "error",
          `Updated ${response.updated.length} tracks (${response.errors.length} failed)`,
          response.errors[0].error
        );
      } else {
        showToast(
          "success",
          `Applied MusicBrainz match to ${response.updated.length} ${
            response.updated.length === 1 ? "track" : "tracks"
          }`,
          details || undefined
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not apply MusicBrainz release";
      showToast("error", "MusicBrainz apply failed", msg);
    } finally {
      setApplyingMb(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-canvas text-ink-primary">
      <Header
        query={query}
        onQueryChange={setQuery}
        onRescan={handleRescan}
        scanning={scanning}
        onNavidromeSync={handleNavidromeSync}
        syncingNavidrome={syncingNavidrome}
        health={health}
        trackCount={library?.stats.track_count ?? health?.cached_tracks ?? 0}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar
          artists={artists}
          stats={library?.stats ?? null}
          selectedAlbumId={selectedAlbum?.id ?? null}
          onSelectAll={handleSelectAll}
          onSelectAlbum={handleSelectAlbum}
        />

        <TrackList
          artists={artists}
          selectedAlbum={selectedAlbum}
          selectedTrackPath={selectedTrackPath}
          isBulkEditingAlbum={isBulkMode}
          artworkRevision={artworkRevision}
          loading={loading}
          musicDir={health?.music_dir ?? "/music"}
          onSelectAlbum={handleSelectAlbum}
          onBackToAll={handleSelectAll}
          onSelectTrack={handleSelectTrack}
          onStartBulkEdit={handleStartBulkEdit}
          onIdentifyAlbum={handleIdentifyAlbum}
          onRescan={handleRescan}
        />

        <MetadataEditor
          selectedTrack={activeTrack}
          activeAlbum={selectedAlbum}
          bulkAlbum={isBulkMode ? selectedAlbum : null}
          artworkRevision={artworkRevision}
          saving={saving}
          uploadingArtwork={uploadingArtwork}
          onSaveTrack={handleSaveTrack}
          onSaveBulk={handleSaveBulk}
          onUploadArtwork={handleUploadArtwork}
          onCopyArtwork={handleCopyArtwork}
          onDeleteArtwork={handleDeleteArtwork}
          onOpenMusicBrainz={handleOpenMusicBrainz}
        />
      </div>

      <MusicBrainzModal
        open={mbModal.open}
        mode={mbModal.mode}
        initialAlbum={mbModal.album}
        initialArtist={mbModal.artist}
        targetPaths={mbModal.targetPaths}
        localTrackCount={mbModal.localTrackCount}
        applying={applyingMb}
        onClose={() => setMbModal((prev) => ({ ...prev, open: false }))}
        onApply={handleApplyMusicBrainz}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

export default App;
