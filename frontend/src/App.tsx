import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  applyMusicBrainzRelease,
  applyMusicBrainzTrack,
  applyOrganize,
  copyArtwork,
  deleteArtwork,
  getAuthStatus,
  getHealth,
  getLibraries,
  getLibrary,
  getOrganizeSettings,
  getTrack,
  logout,
  saveOrganizeSettings,
  setActiveLibraryId as setApiLibraryId,
  setUnauthorizedHandler,
  triggerLibraryScan,
  triggerNavidromeScan,
  undoHistoryBatch,
  undoHistoryEntry,
  updateTrack,
  updateTracksBulk,
  uploadArtwork,
} from "./api/client";
import { Header } from "./components/Header";
import { HistoryDrawer } from "./components/HistoryDrawer";
import { LoginScreen } from "./components/LoginScreen";
import { MetadataEditor } from "./components/MetadataEditor";
import {
  MusicBrainzModal,
  type MusicBrainzModalMode,
} from "./components/MusicBrainzModal";
import { MusicBrainzTrackModal } from "./components/MusicBrainzTrackModal";
import { OrganizeModal } from "./components/OrganizeModal";
import { Sidebar } from "./components/Sidebar";
import { Toast, type ToastMessage } from "./components/Toast";
import { TrackList, type AlbumFilterMode } from "./components/TrackList";
import type {
  AlbumGroup,
  ArtistGroup,
  AuditEntry,
  AuthStatusResponse,
  HealthResponse,
  LibraryInfo,
  LibraryResponse,
  MusicBrainzApplyPayload,
  MusicBrainzApplyTrackPayload,
  NavidromeSyncResult,
  OrganizeSettings,
  TrackMetadata,
  TrackTags,
} from "./types/music";

const LIBRARY_STORAGE_KEY = "m4_active_library";

const DEFAULT_ORGANIZE_SETTINGS: OrganizeSettings = {
  enabled: false,
  template: "artist_album",
  rename_files: false,
  compilation_folder: "Various Artists",
  cleanup_empty_dirs: true,
  skip_missing_metadata: true,
  move_sidecars: true,
};

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
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);

  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [selectedTrackPath, setSelectedTrackPath] = useState<string | null>(null);
  const [liveTrack, setLiveTrack] = useState<TrackMetadata | null>(null);
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [albumFilter, setAlbumFilter] = useState<AlbumFilterMode>("all");

  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingArtwork, setUploadingArtwork] = useState(false);
  const [syncingNavidrome, setSyncingNavidrome] = useState(false);
  const [artworkRevision, setArtworkRevision] = useState(1);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [applyingMb, setApplyingMb] = useState(false);
  const [trackMbTarget, setTrackMbTarget] = useState<TrackMetadata | null>(null);
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
  const [organizeSettings, setOrganizeSettings] = useState<OrganizeSettings>(
    DEFAULT_ORGANIZE_SETTINGS
  );
  const [savingOrganize, setSavingOrganize] = useState(false);
  const [applyingOrganize, setApplyingOrganize] = useState(false);
  const [organizeModal, setOrganizeModal] = useState<{
    open: boolean;
    scopeLabel: string | null;
    scopePaths: string[] | null;
  }>({
    open: false,
    scopeLabel: null,
    scopePaths: null,
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [undoingId, setUndoingId] = useState<number | null>(null);
  const [undoingBatchId, setUndoingBatchId] = useState<string | null>(null);

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

  // Check authentication status on startup & register global 401 handler
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthStatus((prev) =>
        prev?.enabled ? { enabled: true, authenticated: false, username: null } : prev
      );
    });
    void getAuthStatus()
      .then((status) => setAuthStatus(status))
      .catch(() => {
        setAuthStatus({ enabled: false, authenticated: true, username: null });
      });
    return () => setUnauthorizedHandler(null);
  }, []);

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

  const refreshLibraries = useCallback(async () => {
    try {
      const libs = await getLibraries();
      setLibraries(libs);
      return libs;
    } catch {
      return [];
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

  const isAuthenticated = authStatus?.authenticated ?? false;

  // Initialize libraries & health once authenticated
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void refreshHealth();
    void refreshLibraries().then((libs) => {
      if (cancelled) return;
      const savedId = window.localStorage.getItem(LIBRARY_STORAGE_KEY);
      const matched = libs.find((l) => l.id === savedId) ?? libs[0] ?? null;
      const nextId = matched?.id ?? "default";
      setApiLibraryId(nextId);
      setActiveLibraryId(nextId);
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, refreshHealth, refreshLibraries]);

  // Load organize settings whenever active library changes
  useEffect(() => {
    if (!isAuthenticated || !activeLibraryId) return;
    setApiLibraryId(activeLibraryId);
    void getOrganizeSettings()
      .then((s) => setOrganizeSettings(s))
      .catch(() => {
        setOrganizeSettings(DEFAULT_ORGANIZE_SETTINGS);
      });
  }, [isAuthenticated, activeLibraryId]);

  // Fetch active library tracks whenever active library or search query changes
  useEffect(() => {
    if (!isAuthenticated || !activeLibraryId) return;
    setApiLibraryId(activeLibraryId);
    void fetchLibrary(debouncedQuery);
  }, [isAuthenticated, activeLibraryId, debouncedQuery, fetchLibrary]);

  const activeLibrary = useMemo<LibraryInfo | null>(() => {
    if (!activeLibraryId) return libraries[0] ?? null;
    return libraries.find((l) => l.id === activeLibraryId) ?? libraries[0] ?? null;
  }, [libraries, activeLibraryId]);

  const handleSelectLibrary = (nextId: string) => {
    if (nextId === activeLibraryId) return;
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, nextId);
    setApiLibraryId(nextId);
    setActiveLibraryId(nextId);
    setLibrary(null);
    setSelectedAlbumId(null);
    setSelectedTrackPath(null);
    setLiveTrack(null);
    setIsBulkMode(false);
    setAlbumFilter("all");
    setHistoryOpen(false);
    setTrackMbTarget(null);
    setMbModal((prev) => ({ ...prev, open: false }));
    setOrganizeModal({ open: false, scopeLabel: null, scopePaths: null });
    setArtworkRevision((r) => r + 1);
  };

  const handleLogout = async () => {
    try {
      const nextStatus = await logout();
      setAuthStatus(nextStatus);
      setLibrary(null);
      setLibraries([]);
      setActiveLibraryId(null);
      setApiLibraryId(null);
      setHistoryOpen(false);
    } catch {
      setAuthStatus({ enabled: true, authenticated: false, username: null });
    }
  };

  const artists = library?.artists ?? [];

  const structureDriftCount = useMemo(() => {
    if (!organizeSettings.enabled) return 0;
    let count = 0;
    for (const artist of artists) {
      for (const album of artist.albums) {
        if (album.needs_reorganize) count += 1;
      }
    }
    return count;
  }, [artists, organizeSettings.enabled]);

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
      await Promise.all([refreshHealth(), refreshLibraries()]);
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
    const albumTitle = selectedAlbum?.title || activeTrack?.album || "";
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

  const handleIdentifyTrack = (track: TrackMetadata) => {
    setSelectedTrackPath(track.path);
    setLiveTrack(track);
    setIsBulkMode(false);
    setTrackMbTarget(track);
  };

  const handleApplyMusicBrainzTrack = async (
    payload: MusicBrainzApplyTrackPayload
  ) => {
    setApplyingMb(true);
    try {
      const response = await applyMusicBrainzTrack(payload);
      setLiveTrack(response.track);
      setSelectedTrackPath(response.track.path);
      setArtworkRevision((r) => r + 1);
      const updatedLib = await fetchLibrary(debouncedQuery, { silent: true });
      if (updatedLib) {
        const relocated = findAlbumAndTrackByPath(
          updatedLib.artists,
          response.track.path
        );
        if (relocated) {
          setSelectedAlbumId(relocated.album.id);
        }
      }
      setTrackMbTarget(null);

      const details = [
        response.artwork_note,
        formatNavidromeNote(response.navidrome_sync),
      ]
        .filter(Boolean)
        .join(" ");

      showToast(
        "success",
        `Identified "${response.track.title || response.track.filename}"`,
        details || undefined
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not apply MusicBrainz track match";
      showToast("error", "Track identification failed", msg);
    } finally {
      setApplyingMb(false);
    }
  };

  const handleOpenOrganizeLibrary = () => {
    setOrganizeModal({
      open: true,
      scopeLabel: null,
      scopePaths: null,
    });
  };

  const handleOrganizeAlbum = (album: AlbumGroup) => {
    setOrganizeModal({
      open: true,
      scopeLabel: `${album.artist} — ${album.title}`,
      scopePaths: album.tracks.map((t) => t.path),
    });
  };

  const handleSaveOrganizeSettings = async (next: OrganizeSettings) => {
    setSavingOrganize(true);
    try {
      const saved = await saveOrganizeSettings(next);
      setOrganizeSettings(saved);
      if (!saved.enabled && albumFilter === "structure") {
        setAlbumFilter("all");
      }
      await fetchLibrary(debouncedQuery, { silent: true });
      showToast(
        "success",
        "Saved folder organization preferences",
        saved.enabled
          ? "Drift notifications are active across this library."
          : "Drift notifications are turned off."
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not save organization settings";
      showToast("error", "Save failed", msg);
    } finally {
      setSavingOrganize(false);
    }
  };

  const handleApplyOrganize = async (
    activeSettings: OrganizeSettings,
    selectedPaths: string[]
  ) => {
    setApplyingOrganize(true);
    try {
      const response = await applyOrganize(activeSettings, selectedPaths);
      if (selectedTrackPath) {
        const movedMatch = response.moved.find(
          (m) => m.source_path === selectedTrackPath
        );
        if (movedMatch) {
          setSelectedTrackPath(movedMatch.target_path);
          setLiveTrack(null);
        }
      }
      await fetchLibrary(debouncedQuery, { silent: true });
      setOrganizeModal({ open: false, scopeLabel: null, scopePaths: null });

      const notes = [
        response.moved_sidecars.length > 0
          ? `Moved ${response.moved_sidecars.length} sidecar ${
              response.moved_sidecars.length === 1 ? "file" : "files"
            }.`
          : null,
        response.removed_empty_dirs > 0
          ? `Removed ${response.removed_empty_dirs} empty ${
              response.removed_empty_dirs === 1 ? "folder" : "folders"
            }.`
          : null,
        formatNavidromeNote(response.navidrome_sync),
      ]
        .filter(Boolean)
        .join(" ");

      if (response.errors.length > 0) {
        showToast(
          "error",
          `Moved ${response.moved.length} file(s), ${response.errors.length} failed`,
          response.errors[0].error
        );
      } else {
        showToast(
          "success",
          `Moved ${response.moved.length} ${
            response.moved.length === 1 ? "file" : "files"
          }`,
          notes || undefined
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Library reorganization failed";
      showToast("error", "Reorganization failed", msg);
    } finally {
      setApplyingOrganize(false);
    }
  };

  const handleUndoHistory = async (entry: AuditEntry) => {
    setUndoingId(entry.id);
    try {
      const res = await undoHistoryEntry(entry.id);
      if (res.track) {
        if (
          selectedTrackPath === entry.path ||
          selectedTrackPath === res.restored_path
        ) {
          setSelectedTrackPath(res.track.path);
          setLiveTrack(res.track);
        }
      }
      const updatedLib = await fetchLibrary(debouncedQuery, { silent: true });
      if (updatedLib && res.track) {
        const relocated = findAlbumAndTrackByPath(
          updatedLib.artists,
          res.track.path
        );
        if (relocated && selectedAlbumId) {
          setSelectedAlbumId(relocated.album.id);
        }
      }
      const details = [
        res.restored_sidecars > 0
          ? `Restored ${res.restored_sidecars} sidecar ${
              res.restored_sidecars === 1 ? "file" : "files"
            }.`
          : null,
        formatNavidromeNote(res.navidrome_sync),
      ]
        .filter(Boolean)
        .join(" ");

      showToast(
        "success",
        entry.action === "move_track"
          ? "Restored file location"
          : "Reverted tag changes",
        details || res.restored_path
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Undo failed";
      showToast("error", "Could not undo change", msg);
    } finally {
      setUndoingId(null);
    }
  };

  const handleUndoBatch = async (batchId: string, batchEntries: AuditEntry[]) => {
    setUndoingBatchId(batchId);
    try {
      const res = await undoHistoryBatch(batchId);
      // Clear stale selected track path if any reverted entry touched it
      if (selectedTrackPath) {
        const touched = batchEntries.find(
          (e) => e.path === selectedTrackPath || e.after_tags.path === selectedTrackPath
        );
        if (touched) {
          const origPath =
            touched.action === "move_track" && typeof touched.before_tags.path === "string"
              ? touched.before_tags.path
              : selectedTrackPath;
          setSelectedTrackPath(origPath);
          setLiveTrack(null);
        }
      }
      await fetchLibrary(debouncedQuery, { silent: true });
      const details = [
        res.restored_sidecars > 0
          ? `Restored ${res.restored_sidecars} sidecar ${
              res.restored_sidecars === 1 ? "file" : "files"
            }.`
          : null,
        formatNavidromeNote(res.navidrome_sync),
      ]
        .filter(Boolean)
        .join(" ");

      if (res.errors.length > 0) {
        showToast(
          "error",
          `Reverted ${res.undone_count} file(s), ${res.errors.length} failed`,
          res.errors[0].error
        );
      } else {
        showToast(
          "success",
          `Reverted ${res.undone_count} ${res.undone_count === 1 ? "file" : "files"}`,
          details || undefined
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Batch undo failed";
      showToast("error", "Could not undo batch", msg);
    } finally {
      setUndoingBatchId(null);
    }
  };

  if (authStatus === null) {
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-canvas text-xs text-ink-secondary">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <span>Starting M⁴...</span>
        </div>
      </div>
    );
  }

  if (authStatus.enabled && !authStatus.authenticated) {
    return <LoginScreen onLoggedIn={(status) => setAuthStatus(status)} />;
  }

  return (
    <div className="flex h-full flex-col bg-canvas text-ink-primary">
      <Header
        query={query}
        onQueryChange={setQuery}
        onRescan={handleRescan}
        scanning={scanning}
        onNavidromeSync={handleNavidromeSync}
        syncingNavidrome={syncingNavidrome}
        onOpenOrganize={handleOpenOrganizeLibrary}
        onOpenHistory={() => setHistoryOpen(true)}
        structureDriftCount={structureDriftCount}
        health={health}
        libraries={libraries}
        activeLibrary={activeLibrary}
        onSelectLibrary={handleSelectLibrary}
        authStatus={authStatus}
        onLogout={handleLogout}
        trackCount={
          library?.stats.track_count ??
          activeLibrary?.cached_tracks ??
          health?.cached_tracks ??
          0
        }
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
          albumFilter={albumFilter}
          organizeEnabled={organizeSettings.enabled}
          artworkRevision={artworkRevision}
          loading={loading}
          musicDir={activeLibrary?.path ?? health?.music_dir ?? "/music"}
          onSelectAlbum={handleSelectAlbum}
          onBackToAll={handleSelectAll}
          onSelectTrack={handleSelectTrack}
          onStartBulkEdit={handleStartBulkEdit}
          onIdentifyAlbum={handleIdentifyAlbum}
          onIdentifyTrack={handleIdentifyTrack}
          onOrganizeAlbum={handleOrganizeAlbum}
          onChangeAlbumFilter={setAlbumFilter}
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
          onIdentifyTrack={handleIdentifyTrack}
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

      <MusicBrainzTrackModal
        track={trackMbTarget}
        applying={applyingMb}
        onClose={() => setTrackMbTarget(null)}
        onApply={handleApplyMusicBrainzTrack}
      />

      <OrganizeModal
        open={organizeModal.open}
        savedSettings={organizeSettings}
        scopeLabel={organizeModal.scopeLabel}
        scopePaths={organizeModal.scopePaths}
        savingSettings={savingOrganize}
        applyingMoves={applyingOrganize}
        onClose={() =>
          setOrganizeModal({ open: false, scopeLabel: null, scopePaths: null })
        }
        onSaveSettings={handleSaveOrganizeSettings}
        onApplyMoves={handleApplyOrganize}
      />

      <HistoryDrawer
        open={historyOpen}
        undoingId={undoingId}
        undoingBatchId={undoingBatchId}
        activeLibraryName={libraries.length > 1 ? activeLibrary?.name : undefined}
        onClose={() => setHistoryOpen(false)}
        onUndo={handleUndoHistory}
        onUndoBatch={handleUndoBatch}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

export default App;
