import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderInput, Inbox, Library, Loader2 } from "lucide-react";
import {
  STAGING_LIBRARY_ID,
  applyMusicBrainzRelease,
  applyMusicBrainzTrack,
  applyOrganize,
  applyStagingImport,
  bulkSetMissingTrackIgnore,
  checkAlbumCompleteness,
  copyArtwork,
  deleteArtwork,
  deleteTrack,
  getAuthStatus,
  getHealth,
  getLibraries,
  getLibrary,
  getOrganizeSettings,
  getSlskdDownloads,
  getStagingStatus,
  getTrack,
  logout,
  mergeAlbums,
  previewStagingImport,
  saveOrganizeSettings,
  setActiveLibraryId as setApiLibraryId,
  setMissingTrackIgnore,
  setUnauthorizedHandler,
  triggerLibraryScan,
  triggerNavidromeScan,
  undoHistoryBatch,
  undoHistoryEntry,
  updateTrack,
  updateTracksBulk,
  uploadArtwork,
} from "./api/client";
import { CompletenessCheckModal } from "./components/CompletenessCheckModal";
import { DeleteTrackModal } from "./components/DeleteTrackModal";
import { Header, type WorkspaceMode } from "./components/Header";
import { HistoryDrawer } from "./components/HistoryDrawer";
import { LoginScreen } from "./components/LoginScreen";
import { MergeAlbumsModal } from "./components/MergeAlbumsModal";
import { MetadataEditor } from "./components/MetadataEditor";
import { MissingTrackSearchModal } from "./components/MissingTrackSearchModal";
import { MoveTracksToAlbumModal } from "./components/MoveTracksToAlbumModal";
import {
  MusicBrainzModal,
  type MusicBrainzModalMode,
} from "./components/MusicBrainzModal";
import { MusicBrainzTrackModal } from "./components/MusicBrainzTrackModal";
import { OrganizeModal } from "./components/OrganizeModal";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { SlskdDownloadsDrawer } from "./components/SlskdDownloadsDrawer";
import { SlskdSearchModal } from "./components/SlskdSearchModal";
import { StagingImportModal } from "./components/StagingImportModal";
import { Toast, type ToastMessage } from "./components/Toast";
import { TrackList, type AlbumFilterMode } from "./components/TrackList";
import type {
  AlbumGroup,
  AlbumMergePayload,
  ArtistGroup,
  AuditEntry,
  AuthStatusResponse,
  HealthResponse,
  LibraryInfo,
  LibraryResponse,
  MissingTrackCandidate,
  MissingTrackItem,
  MusicBrainzApplyPayload,
  MusicBrainzApplyTrackPayload,
  NavidromeSyncResult,
  OrganizeSettings,
  StagingImportPreviewResponse,
  StagingStatusResponse,
  TrackMetadata,
  TrackTags,
} from "./types/music";
import type { MissingFieldKey, MissingScopeMode } from "./utils/missingFields";

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
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("library");
  const [stagingStatus, setStagingStatus] = useState<StagingStatusResponse | null>(
    null
  );
  const [stagingAlbumPreview, setStagingAlbumPreview] =
    useState<StagingImportPreviewResponse | null>(null);
  const [stagingPreviewLoading, setStagingPreviewLoading] = useState(false);
  const [stagingImportModal, setStagingImportModal] = useState<{
    open: boolean;
    scopeLabel: string | null;
    paths: string[] | null;
  }>({ open: false, scopeLabel: null, paths: null });
  const [importingStaging, setImportingStaging] = useState(false);
  const [slskdSummary, setSlskdSummary] = useState<{
    active: number;
    completed: number;
    failed: number;
  }>({ active: 0, completed: 0, failed: 0 });
  const [downloadsDrawerOpen, setDownloadsDrawerOpen] = useState(false);
  const [slskdSearchTarget, setSlskdSearchTarget] = useState<{
    album: AlbumGroup;
    item: MissingTrackItem | null;
  } | null>(null);

  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [selectedTrackPath, setSelectedTrackPath] = useState<string | null>(null);
  const [liveTrack, setLiveTrack] = useState<TrackMetadata | null>(null);
  const [isBulkMode, setIsBulkMode] = useState(false);
  const [albumFilter, setAlbumFilter] = useState<AlbumFilterMode>("all");
  const [missingField, setMissingField] = useState<MissingFieldKey | null>(null);
  const [missingScope, setMissingScope] = useState<MissingScopeMode>("any");
  const [showIgnoredMissing, setShowIgnoredMissing] = useState(false);

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [undoingId, setUndoingId] = useState<number | null>(null);
  const [undoingBatchId, setUndoingBatchId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TrackMetadata | null>(null);
  const [deletingTrack, setDeletingTrack] = useState(false);
  const [mergeAlbumsTarget, setMergeAlbumsTarget] = useState<AlbumGroup[]>([]);
  const [moveTracksTarget, setMoveTracksTarget] = useState<{
    tracks: TrackMetadata[];
    sourceAlbumId: string | null;
  }>({ tracks: [], sourceAlbumId: null });
  const [mergingAlbums, setMergingAlbums] = useState(false);
  const [checkingCompletenessAlbumId, setCheckingCompletenessAlbumId] =
    useState<string | null>(null);
  const [completenessModalAlbum, setCompletenessModalAlbum] =
    useState<AlbumGroup | null>(null);
  const [checkingModalMbid, setCheckingModalMbid] = useState<string | null>(null);
  const [missingSearchTarget, setMissingSearchTarget] = useState<{
    album: AlbumGroup;
    item: MissingTrackItem;
  } | null>(null);
  const [movingMissingPath, setMovingMissingPath] = useState<string | null>(null);

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
      return data;
    } catch {
      setHealth(null);
      return null;
    }
  }, []);

  const refreshStagingStatus = useCallback(async (rescan = false) => {
    try {
      const status = await getStagingStatus(rescan);
      setStagingStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  const refreshSlskdSummary = useCallback(async () => {
    try {
      const res = await getSlskdDownloads();
      setSlskdSummary({
        active: res.active_count,
        completed: res.completed_count,
        failed: res.failed_count,
      });
    } catch {
      // Ignore transient slskd offline errors in background badge poll
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

  const isStagingMode = workspaceMode === "staging";
  const effectiveLibraryId = isStagingMode ? STAGING_LIBRARY_ID : activeLibraryId;

  const fetchLibrary = useCallback(
    async (searchText: string, { silent = false } = {}) => {
      if (!silent) setLoading(true);
      try {
        const data = await getLibrary(searchText);
        setLibrary(data);
        if (workspaceMode === "staging" && !searchText.trim()) {
          setStagingStatus((prev) =>
            prev
              ? {
                  ...prev,
                  track_count: data.stats.track_count,
                  album_count: data.stats.album_count,
                }
              : prev
          );
        }
        return data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load library";
        showToast("error", "Could not load library", msg);
        return null;
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [showToast, workspaceMode]
  );

  const isAuthenticated = authStatus?.authenticated ?? false;

  // Initialize libraries, health, staging status, and slskd badge once authenticated
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void refreshHealth().then((h) => {
      if (cancelled || !h) return;
      if (h.staging_configured) {
        void refreshStagingStatus(false);
      }
      if (h.slskd_configured) {
        void refreshSlskdSummary();
      }
    });
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
  }, [
    isAuthenticated,
    refreshHealth,
    refreshLibraries,
    refreshStagingStatus,
    refreshSlskdSummary,
  ]);

  // Lightly poll slskd downloads badge only while active transfers exist
  useEffect(() => {
    if (!isAuthenticated || !health?.slskd_configured || slskdSummary.active <= 0) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshSlskdSummary();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [
    isAuthenticated,
    health?.slskd_configured,
    slskdSummary.active,
    refreshSlskdSummary,
  ]);

  // Load organize settings for the active real library (not staging)
  useEffect(() => {
    if (!isAuthenticated || !activeLibraryId || isStagingMode) return;
    setApiLibraryId(activeLibraryId);
    void getOrganizeSettings()
      .then((s) => setOrganizeSettings(s))
      .catch(() => {
        setOrganizeSettings(DEFAULT_ORGANIZE_SETTINGS);
      });
  }, [isAuthenticated, activeLibraryId, isStagingMode]);

  // Fetch active workspace tracks (real library OR staging) whenever workspace/library/query changes
  useEffect(() => {
    if (!isAuthenticated || !effectiveLibraryId) return;
    setApiLibraryId(effectiveLibraryId);
    void fetchLibrary(debouncedQuery);
  }, [isAuthenticated, effectiveLibraryId, debouncedQuery, fetchLibrary]);

  const activeLibrary = useMemo<LibraryInfo | null>(() => {
    if (!activeLibraryId) return libraries[0] ?? null;
    return libraries.find((l) => l.id === activeLibraryId) ?? libraries[0] ?? null;
  }, [libraries, activeLibraryId]);

  const resetViewSelection = () => {
    setLibrary(null);
    setSelectedAlbumId(null);
    setSelectedTrackPath(null);
    setLiveTrack(null);
    setIsBulkMode(false);
    setAlbumFilter("all");
    setMissingField(null);
    setShowIgnoredMissing(false);
    setCompletenessModalAlbum(null);
    setMissingSearchTarget(null);
    setStagingAlbumPreview(null);
    setHistoryOpen(false);
    setTrackMbTarget(null);
    setMbModal((prev) => ({ ...prev, open: false }));
    setOrganizeModal({ open: false, scopeLabel: null, scopePaths: null });
    setArtworkRevision((r) => r + 1);
  };

  const handleSelectLibrary = (nextId: string) => {
    if (nextId === activeLibraryId && workspaceMode === "library") return;
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, nextId);
    setWorkspaceMode("library");
    setApiLibraryId(nextId);
    setActiveLibraryId(nextId);
    resetViewSelection();
  };

  const handleChangeWorkspaceMode = (nextMode: WorkspaceMode) => {
    if (nextMode === workspaceMode) return;
    const nextEffectiveId =
      nextMode === "staging" ? STAGING_LIBRARY_ID : activeLibraryId || "default";
    setApiLibraryId(nextEffectiveId);
    setWorkspaceMode(nextMode);
    resetViewSelection();
    if (nextMode === "staging") {
      void refreshStagingStatus(true);
    }
  };

  const handleLogout = async () => {
    try {
      const nextStatus = await logout();
      setAuthStatus(nextStatus);
      setLibrary(null);
      setLibraries([]);
      setActiveLibraryId(null);
      setApiLibraryId(null);
      setWorkspaceMode("library");
      setHistoryOpen(false);
      setDownloadsDrawerOpen(false);
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

  const handleFindAlbumCover = (album: AlbumGroup) => {
    setSelectedAlbumId(album.id);
    setMbModal({
      open: true,
      mode: "artwork",
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
        payload.apply_track_titles && response.unmatched_paths.length > 0
          ? `${response.unmatched_paths.length} unmatched ${
              response.unmatched_paths.length === 1 ? "track" : "tracks"
            } left with original title & track #.`
          : null,
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

  const handleConfirmDeleteTrack = async (
    track: TrackMetadata,
    options: { deleteSidecars: boolean; cleanupEmptyDirs: boolean }
  ) => {
    setDeletingTrack(true);
    try {
      const res = await deleteTrack(track.path, options);
      if (selectedTrackPath === track.path) {
        setSelectedTrackPath(null);
        setLiveTrack(null);
      }
      setDeleteTarget(null);
      const updatedLib = await fetchLibrary(debouncedQuery, { silent: true });
      // If the currently viewed album now has 0 tracks left, return cleanly to All Albums
      if (updatedLib && selectedAlbumId) {
        const stillExists = updatedLib.artists.some((artist) =>
          artist.albums.some((album) => album.id === selectedAlbumId)
        );
        if (!stillExists) {
          setSelectedAlbumId(null);
          setIsBulkMode(false);
        }
      }
      const details = [
        res.deleted_sidecars.length > 0
          ? `Removed ${res.deleted_sidecars.length} sidecar ${
              res.deleted_sidecars.length === 1 ? "file" : "files"
            }.`
          : null,
        res.removed_empty_dirs > 0
          ? `Removed ${res.removed_empty_dirs} empty ${
              res.removed_empty_dirs === 1 ? "folder" : "folders"
            }.`
          : null,
        formatNavidromeNote(res.navidrome_sync),
      ]
        .filter(Boolean)
        .join(" ");

      showToast(
        "success",
        `Deleted "${track.title || track.filename}"`,
        details || res.deleted_path
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not delete track";
      showToast("error", "Delete failed", msg);
    } finally {
      setDeletingTrack(false);
    }
  };

  const allFlatAlbums = useMemo<AlbumGroup[]>(
    () => artists.flatMap((artist) => artist.albums),
    [artists]
  );

  const handleIdentifyCombinedAlbums = (albums: AlbumGroup[]) => {
    if (albums.length === 0) return;
    const sorted = [...albums].sort((a, b) => b.track_count - a.track_count);
    const primary = sorted[0];
    const combinedPaths = Array.from(
      new Set(albums.flatMap((a) => a.tracks.map((t) => t.path)))
    );
    setMergeAlbumsTarget([]);
    setMbModal({
      open: true,
      mode: "identify",
      album: primary.title === "Unknown Album" ? "" : primary.title,
      artist: primary.artist === "Unknown Artist" ? "" : primary.artist,
      targetPaths: combinedPaths,
      localTrackCount: combinedPaths.length,
    });
  };

  const handleIdentifyCombinedFromMerge = (
    albumHint: string,
    artistHint: string,
    paths: string[]
  ) => {
    setMergeAlbumsTarget([]);
    setMbModal({
      open: true,
      mode: "identify",
      album: albumHint === "Unknown Album" ? "" : albumHint,
      artist: artistHint === "Unknown Artist" ? "" : artistHint,
      targetPaths: paths,
      localTrackCount: paths.length,
    });
  };

  const handleConfirmMergeOrMove = async (
    payload: AlbumMergePayload,
    mode: "merge" | "move"
  ) => {
    setMergingAlbums(true);
    try {
      const response = await mergeAlbums(payload);
      setMergeAlbumsTarget([]);
      setMoveTracksTarget({ tracks: [], sourceAlbumId: null });
      setArtworkRevision((r) => r + 1);
      setIsBulkMode(false);

      const updatedLib = await fetchLibrary(debouncedQuery, { silent: true });
      if (updatedLib && response.updated.length > 0) {
        const relocated = findAlbumAndTrackByPath(
          updatedLib.artists,
          response.updated[0].path
        );
        if (relocated) {
          setSelectedAlbumId(relocated.album.id);
          if (selectedTrackPath) {
            const movedTrack = response.updated.find(
              (t) => t.path === selectedTrackPath
            );
            if (movedTrack) {
              setLiveTrack(movedTrack);
            } else {
              setSelectedTrackPath(null);
              setLiveTrack(null);
            }
          }
        }
      }

      const details = [
        response.artwork_applied ? "Unified cover art." : null,
        response.moved.length > 0
          ? `Moved ${response.moved.length} ${
              response.moved.length === 1 ? "file" : "files"
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
          `${mode === "merge" ? "Merged" : "Moved"} ${response.updated.length} tracks (${response.errors.length} failed)`,
          response.errors[0].error
        );
      } else {
        showToast(
          "success",
          mode === "merge"
            ? `Merged ${response.updated.length} tracks into "${payload.album}"`
            : `Moved ${response.updated.length} ${
                response.updated.length === 1 ? "track" : "tracks"
              } into "${payload.album}"`,
          details || undefined
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : mode === "merge"
            ? "Album merge failed"
            : "Move to album failed";
      showToast(
        "error",
        mode === "merge" ? "Merge failed" : "Move failed",
        msg
      );
    } finally {
      setMergingAlbums(false);
    }
  };

  const handleCheckCompleteness = async (
    album: AlbumGroup,
    options?: { pickRelease?: boolean; forceRefresh?: boolean }
  ) => {
    if (options?.pickRelease || !album.completeness_mbid) {
      setCompletenessModalAlbum(album);
      return;
    }
    setCheckingCompletenessAlbumId(album.id);
    try {
      const res = await checkAlbumCompleteness(album.id, {
        mbid: album.completeness_mbid,
        forceRefresh: options?.forceRefresh ?? false,
      });
      await fetchLibrary(debouncedQuery, { silent: true });
      showToast(
        "success",
        res.missing_track_count === 0
          ? `"${album.title}" is complete`
          : `Found ${res.missing_track_count} missing ${
              res.missing_track_count === 1 ? "track" : "tracks"
            } on "${album.title}"`,
        `Compared against MusicBrainz "${res.release_title}" (${res.release_track_count} tracks${
          res.cached ? ", cached" : ""
        }).`
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not check completeness";
      showToast("error", "Completeness check failed", msg);
    } finally {
      setCheckingCompletenessAlbumId(null);
    }
  };

  const handleSelectCompletenessRelease = async (
    album: AlbumGroup,
    mbid: string
  ) => {
    setCheckingModalMbid(mbid);
    setCheckingCompletenessAlbumId(album.id);
    try {
      const res = await checkAlbumCompleteness(album.id, { mbid });
      setCompletenessModalAlbum(null);
      await fetchLibrary(debouncedQuery, { silent: true });
      showToast(
        "success",
        res.missing_track_count === 0
          ? `"${album.title}" is complete`
          : `Found ${res.missing_track_count} missing ${
              res.missing_track_count === 1 ? "track" : "tracks"
            } on "${album.title}"`,
        `Matched against MusicBrainz "${res.release_title}" (${res.release_track_count} tracks).`
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not check completeness";
      showToast("error", "Completeness check failed", msg);
    } finally {
      setCheckingModalMbid(null);
      setCheckingCompletenessAlbumId(null);
    }
  };

  const handleIgnoreMissingTrack = async (
    album: AlbumGroup,
    options: {
      discNumber?: number;
      trackNumber?: number;
      ignore: boolean;
      clearAll?: boolean;
    }
  ) => {
    try {
      await setMissingTrackIgnore({
        albumId: album.id,
        discNumber: options.discNumber ?? 0,
        trackNumber: options.trackNumber ?? 0,
        ignore: options.ignore,
        clearAll: options.clearAll ?? false,
      });
      await fetchLibrary(debouncedQuery, { silent: true });
      const isWholeAlbum =
        (options.discNumber ?? 0) === 0 && (options.trackNumber ?? 0) === 0;
      showToast(
        "success",
        options.ignore
          ? isWholeAlbum
            ? `Ignored missing tracks for "${album.title}"`
            : `Ignored missing track #${options.trackNumber}`
          : isWholeAlbum
            ? `Re-enabled missing-track checks for "${album.title}"`
            : `Restored missing track #${options.trackNumber}`
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not update ignore status";
      showToast("error", "Update failed", msg);
    }
  };

  const handleBulkIgnoreMissingAlbums = async (
    albums: AlbumGroup[],
    ignore: boolean
  ) => {
    if (albums.length === 0) return;
    try {
      const res = await bulkSetMissingTrackIgnore(
        albums.map((a) => a.id),
        ignore
      );
      await fetchLibrary(debouncedQuery, { silent: true });
      showToast(
        "success",
        ignore
          ? `Ignored missing tracks on ${res.updated_count} ${
              res.updated_count === 1 ? "album" : "albums"
            }`
          : `Re-enabled missing-track checks on ${res.updated_count} ${
              res.updated_count === 1 ? "album" : "albums"
            }`
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not update ignore status";
      showToast("error", "Bulk update failed", msg);
    }
  };

  const handleMoveMissingCandidate = async (
    album: AlbumGroup,
    missingItem: MissingTrackItem,
    candidate: MissingTrackCandidate
  ) => {
    setMovingMissingPath(candidate.path);
    try {
      const sample = album.tracks[0];
      const existingTrackTotal = album.tracks
        .map((t) => t.track_number?.split("/")[1])
        .find((tot) => tot && /^\d+$/.test(tot));
      const existingDiscTotal = album.tracks
        .map((t) => t.disc_number?.split("/")[1])
        .find((tot) => tot && /^\d+$/.test(tot));

      const trackNumberOverride =
        missingItem.track_number > 0
          ? existingTrackTotal
            ? `${missingItem.track_number}/${existingTrackTotal}`
            : String(missingItem.track_number)
          : undefined;
      const discNumberOverride =
        missingItem.disc_number > 0
          ? existingDiscTotal
            ? `${missingItem.disc_number}/${existingDiscTotal}`
            : missingItem.disc_number > 1
              ? String(missingItem.disc_number)
              : sample?.disc_number ?? undefined
          : undefined;

      const payload: AlbumMergePayload = {
        paths: [candidate.path],
        album: album.title,
        album_artist: sample?.album_artist ?? album.artist,
        year: album.year ?? sample?.year ?? null,
        release_date: sample?.release_date ?? null,
        genre: album.genre ?? sample?.genre ?? null,
        album_version: sample?.album_version ?? null,
        compilation: sample?.compilation ?? null,
        musicbrainz_album_id:
          sample?.musicbrainz_album_id ?? album.completeness_mbid ?? null,
        musicbrainz_album_artist_id: sample?.musicbrainz_album_artist_id ?? null,
        track_overrides:
          trackNumberOverride || discNumberOverride
            ? [
                {
                  path: candidate.path,
                  track_number: trackNumberOverride ?? null,
                  disc_number: discNumberOverride ?? null,
                },
              ]
            : [],
        artwork_source_path: album.cover_track_path,
        reorganize: organizeSettings.enabled,
        trigger_navidrome_scan: true,
      };

      const response = await mergeAlbums(payload);
      setMissingSearchTarget(null);
      setArtworkRevision((r) => r + 1);
      await fetchLibrary(debouncedQuery, { silent: true });

      if (response.errors.length > 0) {
        showToast("error", "Could not move track", response.errors[0].error);
      } else {
        const details = [
          response.artwork_applied ? "Adopted album artwork." : null,
          response.moved.length > 0 ? "Moved file into album folder." : null,
          formatNavidromeNote(response.navidrome_sync),
        ]
          .filter(Boolean)
          .join(" ");
        showToast(
          "success",
          `Moved "${candidate.title || candidate.filename}" into "${album.title}"`,
          details || undefined
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not move track into album";
      showToast("error", "Move failed", msg);
    } finally {
      setMovingMissingPath(null);
    }
  };

  // Live destination path preview when viewing an album inside Staging (Issue #8)
  const selectedAlbumTrackPathsKey = selectedAlbum
    ? selectedAlbum.tracks.map((t) => t.path).join("|")
    : "";
  useEffect(() => {
    if (!isStagingMode || !selectedAlbum || !selectedAlbumTrackPathsKey) {
      setStagingAlbumPreview(null);
      return;
    }
    let cancelled = false;
    setStagingPreviewLoading(true);
    void previewStagingImport({
      targetLibraryId: activeLibraryId || libraries[0]?.id || "default",
      paths: selectedAlbum.tracks.map((t) => t.path),
    })
      .then((res) => {
        if (!cancelled) setStagingAlbumPreview(res);
      })
      .catch(() => {
        if (!cancelled) setStagingAlbumPreview(null);
      })
      .finally(() => {
        if (!cancelled) setStagingPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isStagingMode,
    selectedAlbum,
    selectedAlbumTrackPathsKey,
    library?.scanned_at,
    activeLibraryId,
    libraries,
  ]);

  const handleConfirmStagingImport = async (
    targetLibraryId: string,
    paths: string[] | null
  ) => {
    setImportingStaging(true);
    try {
      const response = await applyStagingImport({
        targetLibraryId,
        paths,
        triggerNavidromeScan: true,
      });
      setStagingImportModal({ open: false, scopeLabel: null, paths: null });
      setArtworkRevision((r) => r + 1);

      const updatedStaging = await fetchLibrary(debouncedQuery, { silent: true });
      if (updatedStaging && selectedAlbumId) {
        const stillExists = updatedStaging.artists.some((artist) =>
          artist.albums.some((album) => album.id === selectedAlbumId)
        );
        if (!stillExists) {
          setSelectedAlbumId(null);
          setSelectedTrackPath(null);
          setLiveTrack(null);
          setIsBulkMode(false);
        }
      }
      await Promise.all([
        refreshStagingStatus(false),
        refreshLibraries(),
        refreshHealth(),
      ]);

      const targetLibName =
        libraries.find((l) => l.id === targetLibraryId)?.name ?? "Library";
      const notes = [
        response.moved_sidecars.length > 0
          ? `Moved ${response.moved_sidecars.length} sidecar ${
              response.moved_sidecars.length === 1 ? "file" : "files"
            }.`
          : null,
        response.removed_empty_dirs > 0
          ? `Cleaned ${response.removed_empty_dirs} empty staging ${
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
          `Imported ${response.imported.length} track(s) (${response.errors.length} failed)`,
          response.errors[0].error
        );
      } else {
        showToast(
          "success",
          `Imported ${response.imported.length} ${
            response.imported.length === 1 ? "track" : "tracks"
          } into ${targetLibName}`,
          notes || undefined
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Staging import failed";
      showToast("error", "Import failed", msg);
    } finally {
      setImportingStaging(false);
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

  const stagingTrackCount =
    stagingStatus?.track_count ?? health?.staging_tracks ?? 0;

  return (
    <div className="flex h-full flex-col bg-canvas text-ink-primary">
      <Header
        workspaceMode={workspaceMode}
        onChangeWorkspaceMode={handleChangeWorkspaceMode}
        stagingTrackCount={stagingTrackCount}
        slskdSummary={slskdSummary}
        onOpenDownloads={() => setDownloadsDrawerOpen(true)}
        query={query}
        onQueryChange={setQuery}
        onRescan={handleRescan}
        scanning={scanning}
        onNavidromeSync={handleNavidromeSync}
        syncingNavidrome={syncingNavidrome}
        onOpenOrganize={handleOpenOrganizeLibrary}
        onOpenHistory={() => setHistoryOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        structureDriftCount={structureDriftCount}
        health={health}
        libraries={libraries}
        activeLibrary={activeLibrary}
        onSelectLibrary={handleSelectLibrary}
        authStatus={authStatus}
        onLogout={handleLogout}
        trackCount={
          isStagingMode
            ? (library?.stats.track_count ?? stagingTrackCount)
            : (library?.stats.track_count ??
              activeLibrary?.cached_tracks ??
              health?.cached_tracks ??
              0)
        }
      />

      {/* Unmistakable Staging / Inbox Workspace Banner (Issue #8) */}
      {isStagingMode && (
        <div
          id="staging-workspace-banner"
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cyan-500/35 bg-cyan-950/35 px-4 py-2 text-xs"
        >
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-cyan-400/50 bg-cyan-500/20 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-cyan-200">
              <Inbox className="h-3 w-3" />
              Staging / Inbox
            </span>
            <span className="font-mono text-[11px] text-cyan-300/90">
              {health?.staging_dir ?? "/downloads"}
            </span>
            <span className="hidden md:inline text-ink-secondary">
              · Outside your music library — edits here will not trigger
              Navidrome until imported.
            </span>
          </div>

          <div className="flex items-center gap-2">
            {(library?.stats.track_count ?? 0) > 0 && (
              <button
                id="staging-import-all-btn"
                type="button"
                onClick={() =>
                  setStagingImportModal({
                    open: true,
                    scopeLabel: `All Staged (${library?.stats.track_count ?? 0} tracks)`,
                    paths: null,
                  })
                }
                className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-cyan-400/60 bg-cyan-500/20 px-2.5 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-500/30 cursor-pointer transition-colors"
              >
                <FolderInput className="h-3.5 w-3.5" />
                Import All to Library ({library?.stats.track_count ?? 0})
              </button>
            )}
            <button
              type="button"
              onClick={() => handleChangeWorkspaceMode("library")}
              className="m4-btn-secondary h-7 px-2.5 text-[11px]"
            >
              <Library className="h-3 w-3 text-accent" />
              Back to Library
            </button>
          </div>
        </div>
      )}

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
          isStagingMode={isStagingMode}
          stagingAlbumPreview={stagingAlbumPreview}
          stagingPreviewLoading={stagingPreviewLoading}
          onImportFromStaging={(scopeLabel, paths) =>
            setStagingImportModal({ open: true, scopeLabel, paths })
          }
          slskdConfigured={Boolean(health?.slskd_configured)}
          onSearchSlskd={(album, item) => setSlskdSearchTarget({ album, item })}
          albumFilter={albumFilter}
          missingField={missingField}
          missingScope={missingScope}
          showIgnoredMissing={showIgnoredMissing}
          checkingCompletenessAlbumId={checkingCompletenessAlbumId}
          organizeEnabled={!isStagingMode && organizeSettings.enabled}
          artworkRevision={artworkRevision}
          loading={loading}
          musicDir={
            isStagingMode
              ? (health?.staging_dir ?? "/downloads")
              : (activeLibrary?.path ?? health?.music_dir ?? "/music")
          }
          onSelectAlbum={handleSelectAlbum}
          onBackToAll={handleSelectAll}
          onSelectTrack={handleSelectTrack}
          onStartBulkEdit={handleStartBulkEdit}
          onIdentifyAlbum={handleIdentifyAlbum}
          onFindAlbumCover={handleFindAlbumCover}
          onCheckCompleteness={handleCheckCompleteness}
          onIgnoreMissingTrack={handleIgnoreMissingTrack}
          onBulkIgnoreMissingAlbums={handleBulkIgnoreMissingAlbums}
          onSearchLibraryForMissing={(album, item) =>
            setMissingSearchTarget({ album, item })
          }
          onQuickMoveMissingCandidate={handleMoveMissingCandidate}
          onIdentifyTrack={handleIdentifyTrack}
          onDeleteTrack={(track) => setDeleteTarget(track)}
          onMergeAlbums={(albums) => setMergeAlbumsTarget(albums)}
          onIdentifyCombinedAlbums={handleIdentifyCombinedAlbums}
          onMoveTracksToAlbum={(tracks, sourceAlbumId) =>
            setMoveTracksTarget({ tracks, sourceAlbumId })
          }
          onOrganizeAlbum={handleOrganizeAlbum}
          onChangeAlbumFilter={setAlbumFilter}
          onChangeMissingField={setMissingField}
          onChangeMissingScope={setMissingScope}
          onChangeShowIgnoredMissing={setShowIgnoredMissing}
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
          onDeleteTrack={(track) => setDeleteTarget(track)}
          onMoveTrackToAlbum={(track) =>
            setMoveTracksTarget({
              tracks: [track],
              sourceAlbumId: selectedAlbum?.id ?? null,
            })
          }
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
        activeLibraryName={
          isStagingMode
            ? "Staging / Inbox"
            : libraries.length > 1
              ? activeLibrary?.name
              : undefined
        }
        onClose={() => setHistoryOpen(false)}
        onUndo={handleUndoHistory}
        onUndoBatch={handleUndoBatch}
      />

      <DeleteTrackModal
        track={deleteTarget}
        deleting={deletingTrack}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDeleteTrack}
      />

      <MergeAlbumsModal
        open={mergeAlbumsTarget.length > 0}
        initialAlbums={mergeAlbumsTarget}
        allAlbums={allFlatAlbums}
        artworkRevision={artworkRevision}
        organizeSettings={organizeSettings}
        merging={mergingAlbums}
        onClose={() => setMergeAlbumsTarget([])}
        onMerge={(payload) => handleConfirmMergeOrMove(payload, "merge")}
        onIdentifyCombinedMusicBrainz={handleIdentifyCombinedFromMerge}
      />

      <MoveTracksToAlbumModal
        tracks={moveTracksTarget.tracks}
        sourceAlbumId={moveTracksTarget.sourceAlbumId}
        allAlbums={allFlatAlbums}
        artworkRevision={artworkRevision}
        organizeSettings={organizeSettings}
        moving={mergingAlbums}
        onClose={() => setMoveTracksTarget({ tracks: [], sourceAlbumId: null })}
        onConfirmMove={(payload) => handleConfirmMergeOrMove(payload, "move")}
      />

      <MissingTrackSearchModal
        album={missingSearchTarget?.album ?? null}
        missingItem={missingSearchTarget?.item ?? null}
        movingPath={movingMissingPath}
        onClose={() => setMissingSearchTarget(null)}
        onMoveCandidate={handleMoveMissingCandidate}
      />

      <CompletenessCheckModal
        album={completenessModalAlbum}
        checkingMbid={checkingModalMbid}
        onClose={() => setCompletenessModalAlbum(null)}
        onSelectRelease={handleSelectCompletenessRelease}
      />

      <StagingImportModal
        open={stagingImportModal.open}
        scopeLabel={stagingImportModal.scopeLabel}
        paths={stagingImportModal.paths}
        libraries={libraries}
        defaultTargetLibraryId={activeLibraryId || libraries[0]?.id || "default"}
        importing={importingStaging}
        onClose={() =>
          setStagingImportModal({ open: false, scopeLabel: null, paths: null })
        }
        onConfirmImport={handleConfirmStagingImport}
      />

      <SlskdSearchModal
        album={slskdSearchTarget?.album ?? null}
        missingItem={slskdSearchTarget?.item ?? null}
        allMissingItems={slskdSearchTarget?.album.missing_tracks ?? []}
        onClose={() => setSlskdSearchTarget(null)}
        onSelectMissingItem={(item) =>
          setSlskdSearchTarget((prev) => (prev ? { ...prev, item } : null))
        }
        onQueued={(username, basename) => {
          showToast(
            "success",
            `Queued download in slskd`,
            `${basename} from ${username}`
          );
          void refreshSlskdSummary();
        }}
        onOpenDownloads={() => {
          setSlskdSearchTarget(null);
          setDownloadsDrawerOpen(true);
        }}
      />

      <SlskdDownloadsDrawer
        open={downloadsDrawerOpen}
        stagingConfigured={Boolean(health?.staging_configured)}
        onClose={() => setDownloadsDrawerOpen(false)}
        onOpenStaging={() => handleChangeWorkspaceMode("staging")}
        onSummaryChange={setSlskdSummary}
      />

      <SettingsModal
        open={settingsOpen}
        health={health}
        libraries={libraries}
        onClose={() => setSettingsOpen(false)}
        onSaved={(saved) => {
          setSettingsOpen(false);
          void refreshHealth().then((h) => {
            if (h?.slskd_configured) {
              void refreshSlskdSummary();
            } else {
              setSlskdSummary({ active: 0, completed: 0, failed: 0 });
            }
          });
          const activeList = [
            saved.slskd_enabled && saved.slskd_url && saved.slskd_api_key_set
              ? "slskd"
              : null,
            saved.navidrome_enabled &&
            saved.navidrome_url &&
            saved.navidrome_user &&
            saved.navidrome_pass_set
              ? "Navidrome"
              : null,
          ].filter(Boolean);
          showToast(
            "success",
            "Integration settings saved",
            activeList.length > 0
              ? `Active: ${activeList.join(", ")}.`
              : "Optional integrations are currently disabled."
          );
        }}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

export default App;
