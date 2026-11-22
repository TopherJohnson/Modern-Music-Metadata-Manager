import type {
  AlbumCompletenessResponse,
  AlbumMergePayload,
  AlbumMergeResponse,
  AuditEntry,
  AuthStatusResponse,
  BatchUndoResponse,
  BulkUpdatePayload,
  BulkUpdateResponse,
  HealthResponse,
  LibraryInfo,
  LibraryResponse,
  LibrarySearchMissingResponse,
  MusicBrainzApplyPayload,
  MusicBrainzApplyResponse,
  MusicBrainzApplyTrackPayload,
  MusicBrainzApplyTrackResponse,
  MusicBrainzPreviewResponse,
  MusicBrainzReleaseCandidate,
  MusicBrainzTrackCandidate,
  NavidromeSyncResult,
  OrganizeApplyResponse,
  OrganizePreviewResponse,
  OrganizeSettings,
  RawTagsResponse,
  SlskdDownloadsResponse,
  SlskdQueueDownloadResponse,
  SlskdSearchResponse,
  SlskdStatusResponse,
  StagingImportApplyResponse,
  StagingImportPreviewResponse,
  StagingStatusResponse,
  TrackDeleteResponse,
  TrackMetadata,
  TrackUpdatePayload,
  TrackUpdateResponse,
  UndoResponse,
} from "../types/music";

export const STAGING_LIBRARY_ID = "__staging__";

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

let activeLibraryId: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setActiveLibraryId(libraryId: string | null): void {
  activeLibraryId = libraryId;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (activeLibraryId) {
    headers.set("X-M4-Library", activeLibraryId);
  }

  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers,
  });

  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/auth/")) {
      unauthorizedHandler?.();
    }
    let detail = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (typeof data?.detail === "string") {
        detail = data.detail;
      }
    } catch {
      // ignore JSON parse failure
    }
    throw new ApiError(detail, response.status);
  }
  return (await response.json()) as T;
}

export function getAuthStatus(): Promise<AuthStatusResponse> {
  return requestJson<AuthStatusResponse>("/api/auth/status");
}

export function login(
  username: string,
  password: string
): Promise<AuthStatusResponse> {
  return requestJson<AuthStatusResponse>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<AuthStatusResponse> {
  return requestJson<AuthStatusResponse>("/api/auth/logout", {
    method: "POST",
  });
}

export function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/health");
}

export function getLibraries(): Promise<LibraryInfo[]> {
  return requestJson<LibraryInfo[]>("/api/libraries");
}

export function getLibrary(query?: string, rescan = false): Promise<LibraryResponse> {
  const params = new URLSearchParams();
  if (query && query.trim()) {
    params.set("q", query.trim());
  }
  if (rescan) {
    params.set("rescan", "true");
  }
  const qs = params.toString();
  return requestJson<LibraryResponse>(`/api/library${qs ? `?${qs}` : ""}`);
}

export function triggerLibraryScan(): Promise<LibraryResponse> {
  return requestJson<LibraryResponse>("/api/library/scan", { method: "POST" });
}

export function getTrack(path: string): Promise<TrackMetadata> {
  const params = new URLSearchParams({ path });
  return requestJson<TrackMetadata>(`/api/track?${params.toString()}`);
}

export function getRawTags(path: string): Promise<RawTagsResponse> {
  const params = new URLSearchParams({ path });
  return requestJson<RawTagsResponse>(`/api/track/raw?${params.toString()}`);
}

export function updateTrack(payload: TrackUpdatePayload): Promise<TrackUpdateResponse> {
  return requestJson<TrackUpdateResponse>("/api/track", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function deleteTrack(
  path: string,
  options?: { deleteSidecars?: boolean; cleanupEmptyDirs?: boolean }
): Promise<TrackDeleteResponse> {
  const params = new URLSearchParams({ path });
  if (options?.deleteSidecars !== undefined) {
    params.set("delete_sidecars", String(options.deleteSidecars));
  }
  if (options?.cleanupEmptyDirs !== undefined) {
    params.set("cleanup_empty_dirs", String(options.cleanupEmptyDirs));
  }
  return requestJson<TrackDeleteResponse>(`/api/track?${params.toString()}`, {
    method: "DELETE",
  });
}

export function updateTracksBulk(
  payload: BulkUpdatePayload
): Promise<BulkUpdateResponse> {
  return requestJson<BulkUpdateResponse>("/api/tracks/bulk", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function mergeAlbums(
  payload: AlbumMergePayload
): Promise<AlbumMergeResponse> {
  return requestJson<AlbumMergeResponse>("/api/albums/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function uploadArtwork(
  paths: string[],
  file: File
): Promise<BulkUpdateResponse> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("paths", JSON.stringify(paths));
  return requestJson<BulkUpdateResponse>("/api/track/artwork", {
    method: "PUT",
    body: formData,
  });
}

export function copyArtwork(
  sourcePath: string,
  targetPaths: string[]
): Promise<BulkUpdateResponse> {
  return requestJson<BulkUpdateResponse>("/api/track/artwork/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_path: sourcePath,
      target_paths: targetPaths,
    }),
  });
}

export function deleteArtwork(path: string): Promise<TrackUpdateResponse> {
  const params = new URLSearchParams({ path });
  return requestJson<TrackUpdateResponse>(`/api/track/artwork?${params.toString()}`, {
    method: "DELETE",
  });
}

export function triggerNavidromeScan(): Promise<NavidromeSyncResult> {
  return requestJson<NavidromeSyncResult>("/api/navidrome/scan", {
    method: "POST",
  });
}

export function searchMusicBrainz(
  album: string,
  artist?: string
): Promise<MusicBrainzReleaseCandidate[]> {
  const params = new URLSearchParams({ album: album.trim() });
  if (artist && artist.trim()) {
    params.set("artist", artist.trim());
  }
  return requestJson<MusicBrainzReleaseCandidate[]>(
    `/api/musicbrainz/search?${params.toString()}`
  );
}

export function previewMusicBrainzRelease(
  mbid: string,
  paths: string[]
): Promise<MusicBrainzPreviewResponse> {
  return requestJson<MusicBrainzPreviewResponse>("/api/musicbrainz/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mbid, paths }),
  });
}

export function applyMusicBrainzRelease(
  payload: MusicBrainzApplyPayload
): Promise<MusicBrainzApplyResponse> {
  return requestJson<MusicBrainzApplyResponse>("/api/musicbrainz/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function searchMusicBrainzTrack(
  title: string,
  artist?: string,
  album?: string,
  duration?: number
): Promise<MusicBrainzTrackCandidate[]> {
  const params = new URLSearchParams();
  if (title.trim()) params.set("title", title.trim());
  if (artist && artist.trim()) params.set("artist", artist.trim());
  if (album && album.trim()) params.set("album", album.trim());
  if (duration && duration > 0) params.set("duration", String(Math.round(duration)));
  return requestJson<MusicBrainzTrackCandidate[]>(
    `/api/musicbrainz/search/track?${params.toString()}`
  );
}

export function applyMusicBrainzTrack(
  payload: MusicBrainzApplyTrackPayload
): Promise<MusicBrainzApplyTrackResponse> {
  return requestJson<MusicBrainzApplyTrackResponse>("/api/musicbrainz/apply/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function getOrganizeSettings(): Promise<OrganizeSettings> {
  return requestJson<OrganizeSettings>("/api/settings/organize");
}

export function saveOrganizeSettings(
  settings: OrganizeSettings
): Promise<OrganizeSettings> {
  return requestJson<OrganizeSettings>("/api/settings/organize", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
}

export function previewOrganize(
  settings?: OrganizeSettings,
  paths?: string[]
): Promise<OrganizePreviewResponse> {
  return requestJson<OrganizePreviewResponse>("/api/organize/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: settings ?? null,
      paths: paths ?? null,
    }),
  });
}

export function applyOrganize(
  settings?: OrganizeSettings,
  paths?: string[]
): Promise<OrganizeApplyResponse> {
  return requestJson<OrganizeApplyResponse>("/api/organize/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      settings: settings ?? null,
      paths: paths ?? null,
      trigger_navidrome_scan: true,
    }),
  });
}

export function getHistory(limit = 200): Promise<AuditEntry[]> {
  return requestJson<AuditEntry[]>(`/api/history?limit=${limit}`);
}

export function undoHistoryEntry(entryId: number): Promise<UndoResponse> {
  return requestJson<UndoResponse>(`/api/history/${entryId}/undo`, {
    method: "POST",
  });
}

export function undoHistoryBatch(batchId: string): Promise<BatchUndoResponse> {
  return requestJson<BatchUndoResponse>(`/api/history/batch/${encodeURIComponent(batchId)}/undo`, {
    method: "POST",
  });
}

export function checkAlbumCompleteness(
  albumId: string,
  options: { mbid?: string | null; forceRefresh?: boolean } = {}
): Promise<AlbumCompletenessResponse> {
  return requestJson<AlbumCompletenessResponse>("/api/albums/completeness/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      album_id: albumId,
      mbid: options.mbid ?? null,
      force_refresh: options.forceRefresh ?? false,
    }),
  });
}

export function setMissingTrackIgnore(payload: {
  albumId: string;
  discNumber?: number;
  trackNumber?: number;
  ignore: boolean;
  clearAll?: boolean;
}): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>("/api/albums/completeness/ignore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      album_id: payload.albumId,
      disc_number: payload.discNumber ?? 0,
      track_number: payload.trackNumber ?? 0,
      ignore: payload.ignore,
      clear_all: payload.clearAll ?? false,
    }),
  });
}

export function bulkSetMissingTrackIgnore(
  albumIds: string[],
  ignore: boolean
): Promise<{ ok: boolean; updated_count: number }> {
  return requestJson<{ ok: boolean; updated_count: number }>(
    "/api/albums/completeness/ignore/bulk",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        album_ids: albumIds,
        ignore,
      }),
    }
  );
}

export function searchLibraryForMissingTrack(params: {
  albumId: string;
  query?: string | null;
  artist?: string | null;
  lengthMs?: number | null;
  limit?: number;
}): Promise<LibrarySearchMissingResponse> {
  const qs = new URLSearchParams({ album_id: params.albumId });
  if (params.query && params.query.trim()) {
    qs.set("q", params.query.trim());
  }
  if (params.artist && params.artist.trim()) {
    qs.set("artist", params.artist.trim());
  }
  if (params.lengthMs && params.lengthMs > 0) {
    qs.set("length_ms", String(Math.round(params.lengthMs)));
  }
  if (params.limit) {
    qs.set("limit", String(params.limit));
  }
  return requestJson<LibrarySearchMissingResponse>(
    `/api/albums/completeness/search-library?${qs.toString()}`
  );
}

export function getStagingStatus(rescan = false): Promise<StagingStatusResponse> {
  const qs = rescan ? "?rescan=true" : "";
  return requestJson<StagingStatusResponse>(`/api/staging/status${qs}`);
}

export function previewStagingImport(params: {
  targetLibraryId?: string | null;
  paths?: string[] | null;
}): Promise<StagingImportPreviewResponse> {
  return requestJson<StagingImportPreviewResponse>("/api/staging/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target_library_id: params.targetLibraryId ?? null,
      paths: params.paths ?? null,
    }),
  });
}

export function applyStagingImport(params: {
  targetLibraryId?: string | null;
  paths?: string[] | null;
  triggerNavidromeScan?: boolean;
}): Promise<StagingImportApplyResponse> {
  return requestJson<StagingImportApplyResponse>("/api/staging/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target_library_id: params.targetLibraryId ?? null,
      paths: params.paths ?? null,
      trigger_navidrome_scan: params.triggerNavidromeScan ?? true,
    }),
  });
}

export function getSlskdStatus(): Promise<SlskdStatusResponse> {
  return requestJson<SlskdStatusResponse>("/api/slskd/status");
}

export function searchSlskd(payload: {
  query: string;
  trackTitle?: string | null;
  artist?: string | null;
  preferredFormats?: string[];
  expectedLengthMs?: number | null;
  timeoutSec?: number;
}): Promise<SlskdSearchResponse> {
  return requestJson<SlskdSearchResponse>("/api/slskd/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: payload.query,
      track_title: payload.trackTitle ?? null,
      artist: payload.artist ?? null,
      preferred_formats: payload.preferredFormats ?? [],
      expected_length_ms: payload.expectedLengthMs ?? null,
      timeout_sec: payload.timeoutSec ?? 5.0,
    }),
  });
}

export function refreshSlskdSearch(searchId: string): Promise<SlskdSearchResponse> {
  return requestJson<SlskdSearchResponse>(
    `/api/slskd/search/${encodeURIComponent(searchId)}`
  );
}

export function queueSlskdDownload(
  username: string,
  files: Array<{ filename: string; size: number }>
): Promise<SlskdQueueDownloadResponse> {
  return requestJson<SlskdQueueDownloadResponse>("/api/slskd/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, files }),
  });
}

export function getSlskdDownloads(): Promise<SlskdDownloadsResponse> {
  return requestJson<SlskdDownloadsResponse>("/api/slskd/downloads");
}

export function clearCompletedSlskdDownloads(): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>("/api/slskd/downloads/completed", {
    method: "DELETE",
  });
}

export function removeSlskdDownload(
  username: string,
  transferId: string
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/slskd/downloads/${encodeURIComponent(username)}/${encodeURIComponent(transferId)}`,
    { method: "DELETE" }
  );
}

export function getArtworkUrl(path: string, version?: number): string {
  const params = new URLSearchParams({ path });
  if (activeLibraryId) {
    params.set("library", activeLibraryId);
  }
  if (version !== undefined) {
    params.set("v", String(Math.floor(version)));
  }
  return `/api/track/artwork?${params.toString()}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}
