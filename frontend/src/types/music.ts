export type EditableTagField =
  | "title"
  | "artist"
  | "album_artist"
  | "album"
  | "year"
  | "track_number"
  | "disc_number"
  | "genre"
  | "composer"
  | "release_date"
  | "album_version"
  | "compilation"
  | "musicbrainz_album_id"
  | "musicbrainz_album_artist_id";

export interface TrackTags {
  title: string | null;
  artist: string | null;
  album_artist: string | null;
  album: string | null;
  year: string | null;
  track_number: string | null;
  disc_number: string | null;
  genre: string | null;
  composer: string | null;
  release_date: string | null;
  album_version: string | null;
  compilation: string | null;
  musicbrainz_album_id: string | null;
  musicbrainz_album_artist_id: string | null;
}

export interface TrackMetadata extends TrackTags {
  path: string;
  filename: string;
  format: string;
  duration: number;
  bitrate: number | null;
  sample_rate: number | null;
  file_size: number;
  mtime: number;
  has_artwork: boolean;
  artwork_mime: string | null;
  artwork_hash: string | null;
  artwork_size: number | null;
  missing_fields: string[];
}

export interface RawTagsResponse {
  path: string;
  format: string;
  tags: Record<string, string[]>;
}

export interface ArtworkVariant {
  hash: string;
  sample_track_path: string;
  mime: string | null;
  size: number;
  track_count: number;
  track_paths: string[];
}

export interface NavidromeSplitWarning {
  field: string;
  label: string;
  severity: "missing" | "split" | "artwork" | "structure" | string;
  message: string;
  values: string[];
  related_album_ids?: string[];
}

export interface MissingTrackCandidate {
  path: string;
  filename: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  album_id: string;
  album_track_count: number;
  duration: number;
  score: number;
  reason: string;
}

export interface MissingTrackItem {
  disc_number: number;
  track_number: number; // 0 indicates an entire missing disc
  title: string | null;
  artist: string | null;
  length_ms: number | null;
  source: "local_gap" | "local_total" | "local_disc" | "musicbrainz";
  ignored: boolean;
  candidates: MissingTrackCandidate[];
}

export interface AlbumCompletenessResponse {
  album_id: string;
  mbid: string;
  release_title: string;
  release_artist: string;
  release_track_count: number;
  cached: boolean;
  missing_tracks: MissingTrackItem[];
  missing_track_count: number;
}

export interface LibrarySearchMissingResponse {
  candidates: MissingTrackCandidate[];
}

export interface AlbumGroup {
  id: string;
  title: string;
  artist: string;
  year: string | null;
  genre: string | null;
  cover_track_path: string | null;
  track_count: number;
  total_duration: number;
  formats: string[];
  artwork_variants: ArtworkVariant[];
  navidrome_warnings: NavidromeSplitWarning[];
  has_missing_metadata: boolean;
  needs_reorganize: boolean;
  missing_tracks: MissingTrackItem[];
  missing_track_count: number;
  missing_tracks_ignored: boolean;
  completeness_source: "local" | "musicbrainz" | null;
  completeness_mbid: string | null;
  completeness_mb_title: string | null;
  tracks: TrackMetadata[];
}

export interface ArtistGroup {
  id: string;
  name: string;
  album_count: number;
  track_count: number;
  albums: AlbumGroup[];
}

export interface LibraryStats {
  artist_count: number;
  album_count: number;
  track_count: number;
  total_duration: number;
}

export interface LibraryResponse {
  stats: LibraryStats;
  artists: ArtistGroup[];
  scanned_at: number;
}

export interface NavidromeSyncResult {
  triggered: boolean;
  configured: boolean;
  ok: boolean;
  detail: string | null;
}

export interface HealthResponse {
  status: string;
  version: string;
  music_dir: string;
  music_dir_exists: boolean;
  music_dir_readable: boolean;
  music_dir_writable: boolean;
  config_dir: string;
  config_dir_writable: boolean;
  navidrome_configured: boolean;
  cached_tracks: number;
  auth_enabled?: boolean;
  libraries_count?: number;
  staging_configured?: boolean;
  staging_dir?: string | null;
  staging_dir_exists?: boolean;
  staging_dir_readable?: boolean;
  staging_dir_writable?: boolean;
  staging_tracks?: number;
  slskd_configured?: boolean;
}

export interface LibraryInfo {
  id: string;
  name: string;
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  cached_tracks: number;
}

export interface AuthStatusResponse {
  enabled: boolean;
  authenticated: boolean;
  username: string | null;
}

export interface TrackUpdatePayload extends Partial<TrackTags> {
  path: string;
  trigger_navidrome_scan?: boolean;
}

export interface TrackUpdateResponse {
  track: TrackMetadata;
  navidrome_sync: NavidromeSyncResult;
}

export interface TrackDeleteResponse {
  deleted_path: string;
  deleted_sidecars: string[];
  removed_empty_dirs: number;
  navidrome_sync: NavidromeSyncResult;
}

export interface BulkUpdatePayload extends Partial<TrackTags> {
  paths: string[];
  trigger_navidrome_scan?: boolean;
}

export interface BulkUpdateError {
  path: string;
  error: string;
}

export interface BulkUpdateResponse {
  updated: TrackMetadata[];
  errors: BulkUpdateError[];
  navidrome_sync: NavidromeSyncResult;
}

export interface TrackPositionOverride {
  path: string;
  track_number?: string | null;
  disc_number?: string | null;
}

export interface AlbumMergePayload {
  paths: string[];
  album: string;
  album_artist?: string | null;
  year?: string | null;
  release_date?: string | null;
  genre?: string | null;
  album_version?: string | null;
  compilation?: string | null;
  musicbrainz_album_id?: string | null;
  musicbrainz_album_artist_id?: string | null;
  track_overrides?: TrackPositionOverride[];
  artwork_source_path?: string | null;
  reorganize?: boolean;
  trigger_navidrome_scan?: boolean;
}

export interface AlbumMergeResponse extends BulkUpdateResponse {
  batch_id: string | null;
  artwork_applied: boolean;
  moved: OrganizeMoveResult[];
  moved_sidecars: OrganizeMoveResult[];
  removed_empty_dirs: number;
}

export interface MusicBrainzReleaseCandidate {
  mbid: string;
  title: string;
  artist: string;
  artist_mbid: string | null;
  date: string | null;
  year: string | null;
  country: string | null;
  status: string | null;
  disambiguation: string | null;
  track_count: number;
  disc_count: number;
  format: string | null;
  label: string | null;
  score: number;
  cover_art_url: string;
}

export interface MusicBrainzTrackInfo {
  disc_number: number;
  disc_total: number;
  track_number: number;
  track_total: number;
  title: string;
  artist: string | null;
  length_ms: number | null;
}

export interface MusicBrainzReleaseDetail extends MusicBrainzReleaseCandidate {
  genre: string | null;
  compilation: boolean;
  tracks: MusicBrainzTrackInfo[];
}

export interface MusicBrainzTrackMatch {
  local_path: string;
  local_filename: string;
  local_title: string | null;
  local_artist: string | null;
  local_track_number: string | null;
  local_disc_number: string | null;
  local_duration: number;
  matched: boolean;
  match_method: "disc_track" | "title_duration" | "title" | "duration" | "unmatched" | string;
  confidence: "high" | "medium" | "low" | "none" | string;
  reason: string | null;
  mb_disc_number: number | null;
  mb_disc_total: number | null;
  mb_track_number: number | null;
  mb_track_total: number | null;
  mb_title: string | null;
  mb_artist: string | null;
  mb_length_ms: number | null;
}

export interface MusicBrainzPreviewResponse {
  release: MusicBrainzReleaseDetail;
  local_track_count: number;
  release_track_count: number;
  matched_count: number;
  unmatched_count: number;
  matches: MusicBrainzTrackMatch[];
}

export interface MusicBrainzApplyPayload {
  mbid: string;
  paths: string[];
  apply_metadata: boolean;
  apply_artwork: boolean;
  apply_track_titles: boolean;
  trigger_navidrome_scan?: boolean;
}

export interface MusicBrainzApplyResponse extends BulkUpdateResponse {
  artwork_applied: boolean;
  artwork_note: string | null;
  matched_tracks: number;
  unmatched_paths: string[];
}

export interface MusicBrainzTrackCandidate {
  recording_mbid: string;
  release_mbid: string | null;
  title: string;
  artist: string;
  artist_mbid: string | null;
  album: string | null;
  album_artist: string | null;
  date: string | null;
  year: string | null;
  country: string | null;
  release_type: string | null;
  track_number: string | null;
  disc_number: string | null;
  length_ms: number | null;
  score: number;
  cover_art_url: string | null;
}

export interface MusicBrainzApplyTrackPayload {
  path: string;
  title: string;
  artist: string;
  album_artist?: string | null;
  album?: string | null;
  year?: string | null;
  release_date?: string | null;
  track_number?: string | null;
  disc_number?: string | null;
  release_mbid?: string | null;
  artist_mbid?: string | null;
  apply_artwork: boolean;
  trigger_navidrome_scan?: boolean;
}

export interface MusicBrainzApplyTrackResponse extends TrackUpdateResponse {
  artwork_applied: boolean;
  artwork_note: string | null;
}

export type FolderTemplate =
  | "artist_album"
  | "artist_year_album"
  | "album_only"
  | "album_with_artist";

export interface OrganizeSettings {
  enabled: boolean;
  template: FolderTemplate;
  rename_files: boolean;
  compilation_folder: string;
  cleanup_empty_dirs: boolean;
  skip_missing_metadata: boolean;
  move_sidecars: boolean;
}

export interface MovePlanItem {
  source_path: string;
  target_path: string;
  album: string;
  artist: string;
  status: "move" | "unchanged" | "skipped" | "conflict";
  reason: string | null;
}

export interface OrganizeMoveResult {
  source_path: string;
  target_path: string;
}

export interface OrganizePreviewResponse {
  settings: OrganizeSettings;
  total_tracks: number;
  moves_count: number;
  unchanged_count: number;
  skipped_count: number;
  conflict_count: number;
  sidecar_moves_count: number;
  items: MovePlanItem[];
  sidecars: OrganizeMoveResult[];
}

export interface OrganizeApplyResponse {
  moved: OrganizeMoveResult[];
  moved_sidecars: OrganizeMoveResult[];
  skipped: number;
  errors: BulkUpdateError[];
  removed_empty_dirs: number;
  navidrome_sync: NavidromeSyncResult;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  library_id: string;
  batch_id: string | null;
  path: string;
  action: string;
  before_tags: Record<string, string | Array<{ source: string; target: string }> | null>;
  after_tags: Record<string, string | Array<{ source: string; target: string }> | null>;
  undone: boolean;
  can_undo: boolean;
  changed_fields: string[];
}

export interface UndoResponse {
  entry_id: number;
  action: string;
  restored_path: string;
  restored_sidecars: number;
  track: TrackMetadata | null;
  navidrome_sync: NavidromeSyncResult;
}

export interface BatchUndoResponse {
  batch_id: string;
  undone_count: number;
  restored_sidecars: number;
  errors: BulkUpdateError[];
  navidrome_sync: NavidromeSyncResult;
}

export interface StagingStatusResponse {
  configured: boolean;
  path: string | null;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  track_count: number;
  album_count: number;
}

export interface StagingImportPlanItem {
  source_path: string;
  target_path: string;
  album: string;
  artist: string;
  status: "import" | "skipped" | "conflict";
  drop_in: boolean;
  existing_album_title: string | null;
  reason: string | null;
}

export interface StagingImportPreviewResponse {
  target_library_id: string;
  target_library_name: string;
  target_library_path: string;
  template: string;
  rename_files: boolean;
  total_tracks: number;
  import_count: number;
  drop_in_count: number;
  skipped_count: number;
  conflict_count: number;
  sidecar_moves_count: number;
  items: StagingImportPlanItem[];
  sidecars: OrganizeMoveResult[];
}

export interface StagingImportApplyResponse {
  target_library_id: string;
  batch_id: string | null;
  imported: OrganizeMoveResult[];
  moved_sidecars: OrganizeMoveResult[];
  skipped: number;
  errors: BulkUpdateError[];
  removed_empty_dirs: number;
  navidrome_sync: NavidromeSyncResult;
}

export interface SlskdStatusResponse {
  configured: boolean;
  connected: boolean;
  detail: string | null;
}

export interface SlskdCandidate {
  username: string;
  filename: string;
  basename: string;
  directory: string;
  extension: string;
  format: string;
  size: number;
  bit_rate: number | null;
  sample_rate: number | null;
  bit_depth: number | null;
  length_sec: number | null;
  duration_diff_sec: number | null;
  has_free_upload_slot: boolean;
  upload_speed: number;
  queue_length: number;
  score: number;
  reasons: string[];
}

export interface SlskdSearchResponse {
  search_id: string;
  query: string;
  state: string;
  is_complete: boolean;
  response_count: number;
  file_count: number;
  candidates: SlskdCandidate[];
}

export interface SlskdQueueDownloadResponse {
  ok: boolean;
  username: string;
  queued_count: number;
  detail: string | null;
}

export interface SlskdTransferItem {
  id: string;
  username: string;
  filename: string;
  basename: string;
  size: number;
  bytes_transferred: number;
  percent_complete: number;
  state: string;
  average_speed: number;
  bytes_remaining: number;
  requested_at: string | null;
  ended_at: string | null;
  exception: string | null;
}

export interface SlskdDownloadsResponse {
  active_count: number;
  completed_count: number;
  failed_count: number;
  transfers: SlskdTransferItem[];
}

export interface IntegrationSettingsResponse {
  slskd_enabled: boolean;
  slskd_url: string | null;
  slskd_api_key_set: boolean;
  slskd_from_env: boolean;
  navidrome_enabled: boolean;
  navidrome_url: string | null;
  navidrome_user: string | null;
  navidrome_pass_set: boolean;
  navidrome_auto_scan: boolean;
  navidrome_from_env: boolean;
}

export interface IntegrationSettingsUpdatePayload {
  slskd_enabled?: boolean;
  slskd_url?: string;
  slskd_api_key?: string | null;
  clear_slskd_api_key?: boolean;
  navidrome_enabled?: boolean;
  navidrome_url?: string;
  navidrome_user?: string;
  navidrome_pass?: string | null;
  clear_navidrome_pass?: boolean;
  navidrome_auto_scan?: boolean;
}


