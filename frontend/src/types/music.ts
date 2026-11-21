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
  severity: "split" | "artwork" | string;
  message: string;
  values: string[];
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
}

export interface TrackUpdatePayload extends Partial<TrackTags> {
  path: string;
  trigger_navidrome_scan?: boolean;
}

export interface TrackUpdateResponse {
  track: TrackMetadata;
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
