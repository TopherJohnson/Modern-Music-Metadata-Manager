import type { AlbumGroup, TrackMetadata } from "../types/music";

export type MissingFieldKey =
  | "missing_tracks"
  | "artwork"
  | "year"
  | "genre"
  | "album_artist"
  | "track_number"
  | "title"
  | "artist"
  | "disc_number"
  | "composer"
  | "release_date"
  | "musicbrainz_album_id"
  | "low_res_artwork";

export type MissingScopeMode = "any" | "all";

export interface MissingFieldOption {
  key: MissingFieldKey;
  label: string;
  shortBadge: string;
  group: "album" | "primary" | "advanced";
}

export const MISSING_FIELD_OPTIONS: MissingFieldOption[] = [
  {
    key: "missing_tracks",
    label: "Track from Album",
    shortBadge: "Missing Tracks",
    group: "album",
  },
  { key: "artwork", label: "Cover Art", shortBadge: "No Art", group: "primary" },
  { key: "year", label: "Year / Date", shortBadge: "No Year", group: "primary" },
  { key: "genre", label: "Genre", shortBadge: "No Genre", group: "primary" },
  {
    key: "album_artist",
    label: "Album Artist",
    shortBadge: "No Album Artist",
    group: "primary",
  },
  {
    key: "track_number",
    label: "Track #",
    shortBadge: "No Track #",
    group: "primary",
  },
  { key: "title", label: "Track Title", shortBadge: "No Title", group: "primary" },
  { key: "artist", label: "Artist", shortBadge: "No Artist", group: "primary" },
  { key: "disc_number", label: "Disc #", shortBadge: "No Disc #", group: "advanced" },
  { key: "composer", label: "Composer", shortBadge: "No Composer", group: "advanced" },
  {
    key: "release_date",
    label: "Release Date",
    shortBadge: "No Rel. Date",
    group: "advanced",
  },
  {
    key: "musicbrainz_album_id",
    label: "MusicBrainz Album ID",
    shortBadge: "No MBID",
    group: "advanced",
  },
  {
    key: "low_res_artwork",
    label: "Tiny Cover (<15 KB)",
    shortBadge: "Low-Res Art",
    group: "advanced",
  },
];

export const LOW_RES_ARTWORK_BYTES = 15 * 1024;

export function getMissingFieldOption(
  key: MissingFieldKey | null
): MissingFieldOption | null {
  if (!key) return null;
  return MISSING_FIELD_OPTIONS.find((opt) => opt.key === key) ?? null;
}

export function isTrackMissingField(
  track: TrackMetadata,
  field: MissingFieldKey
): boolean {
  switch (field) {
    case "missing_tracks":
      return false;
    case "artwork":
      return !track.has_artwork;
    case "low_res_artwork":
      return (
        track.has_artwork &&
        track.artwork_size !== null &&
        track.artwork_size > 0 &&
        track.artwork_size < LOW_RES_ARTWORK_BYTES
      );
    case "artist":
      return !(track.artist || track.album_artist || "").trim();
    case "album_artist":
      return !(track.album_artist || "").trim();
    case "year":
      return !(track.year || "").trim();
    case "genre":
      return !(track.genre || "").trim();
    case "track_number":
      return !(track.track_number || "").trim();
    case "disc_number":
      return !(track.disc_number || "").trim();
    case "title":
      return !(track.title || "").trim();
    case "composer":
      return !(track.composer || "").trim();
    case "release_date":
      return !(track.release_date || "").trim();
    case "musicbrainz_album_id":
      return !(track.musicbrainz_album_id || "").trim();
  }
}

export function countTracksMissingField(
  album: AlbumGroup,
  field: MissingFieldKey
): number {
  if (field === "missing_tracks") {
    return album.missing_track_count;
  }
  let count = 0;
  for (const track of album.tracks) {
    if (isTrackMissingField(track, field)) count += 1;
  }
  return count;
}

export function albumMatchesMissingField(
  album: AlbumGroup,
  field: MissingFieldKey,
  scope: MissingScopeMode,
  showIgnoredMissing = false
): boolean {
  if (field === "missing_tracks") {
    if (album.missing_track_count > 0) return true;
    if (showIgnoredMissing) {
      return album.missing_tracks_ignored || album.missing_tracks.length > 0;
    }
    return false;
  }
  if (album.track_count === 0) return false;
  const missingCount = countTracksMissingField(album, field);
  return scope === "all" ? missingCount === album.track_count : missingCount > 0;
}
