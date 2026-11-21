import type {
  AuditEntry,
  BulkUpdatePayload,
  BulkUpdateResponse,
  HealthResponse,
  LibraryResponse,
  MusicBrainzApplyPayload,
  MusicBrainzApplyResponse,
  MusicBrainzApplyTrackPayload,
  MusicBrainzApplyTrackResponse,
  MusicBrainzReleaseCandidate,
  MusicBrainzTrackCandidate,
  NavidromeSyncResult,
  OrganizeApplyResponse,
  OrganizePreviewResponse,
  OrganizeSettings,
  RawTagsResponse,
  TrackMetadata,
  TrackUpdatePayload,
  TrackUpdateResponse,
  UndoResponse,
} from "../types/music";

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
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

export function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/health");
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

export function updateTracksBulk(
  payload: BulkUpdatePayload
): Promise<BulkUpdateResponse> {
  return requestJson<BulkUpdateResponse>("/api/tracks/bulk", {
    method: "PUT",
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

export function getHistory(limit = 100): Promise<AuditEntry[]> {
  return requestJson<AuditEntry[]>(`/api/history?limit=${limit}`);
}

export function undoHistoryEntry(entryId: number): Promise<UndoResponse> {
  return requestJson<UndoResponse>(`/api/history/${entryId}/undo`, {
    method: "POST",
  });
}

export function getArtworkUrl(path: string, version?: number): string {
  const params = new URLSearchParams({ path });
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
