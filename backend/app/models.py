"""Pydantic request and response schemas for the M⁴ REST API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class NavidromeSyncResult(BaseModel):
    """Outcome of triggering a Navidrome Subsonic library scan."""

    triggered: bool = False
    configured: bool = False
    ok: bool = False
    detail: str | None = None


class HealthResponse(BaseModel):
    """Response model for GET /api/health."""

    status: str
    version: str
    music_dir: str
    music_dir_exists: bool
    music_dir_readable: bool
    music_dir_writable: bool
    config_dir: str
    config_dir_writable: bool
    navidrome_configured: bool
    cached_tracks: int


class TrackTags(BaseModel):
    """Editable metadata tags shared across ID3v2, Vorbis, and MP4.

    Includes standard display tags plus Navidrome album-grouping (PID) tags.
    """

    title: str | None = None
    artist: str | None = None
    album_artist: str | None = None
    album: str | None = None
    year: str | None = None
    track_number: str | None = None
    disc_number: str | None = None
    genre: str | None = None
    composer: str | None = None
    # Navidrome album-grouping / release disambiguation tags
    release_date: str | None = None
    album_version: str | None = None
    compilation: str | None = None
    musicbrainz_album_id: str | None = None
    musicbrainz_album_artist_id: str | None = None


class TrackMetadata(TrackTags):
    """Full track record returned by library and track endpoints."""

    path: str = Field(..., description="POSIX path relative to the /music root")
    filename: str
    format: str
    duration: float = 0.0
    bitrate: int | None = None
    sample_rate: int | None = None
    file_size: int = 0
    mtime: float = 0.0
    has_artwork: bool = False
    artwork_mime: str | None = None
    artwork_hash: str | None = None
    artwork_size: int | None = None


class RawTagsResponse(BaseModel):
    """All raw metadata frames/atoms read directly from an audio file."""

    path: str
    format: str
    tags: dict[str, list[str]]


class TrackUpdateRequest(BaseModel):
    """Payload for PUT /api/track to update metadata on a single file.

    Fields omitted from the JSON payload are left untouched on disk.
    Fields explicitly set to `""` or `null` clear that tag.
    """

    path: str
    title: str | None = None
    artist: str | None = None
    album_artist: str | None = None
    album: str | None = None
    year: str | None = None
    track_number: str | None = None
    disc_number: str | None = None
    genre: str | None = None
    composer: str | None = None
    release_date: str | None = None
    album_version: str | None = None
    compilation: str | None = None
    musicbrainz_album_id: str | None = None
    musicbrainz_album_artist_id: str | None = None
    trigger_navidrome_scan: bool = True


class TrackUpdateResponse(BaseModel):
    """Response returned after updating a single track."""

    track: TrackMetadata
    navidrome_sync: NavidromeSyncResult


class BulkUpdateRequest(BaseModel):
    """Payload for PUT /api/tracks/bulk to apply shared edits across multiple tracks."""

    paths: list[str] = Field(..., min_length=1)
    title: str | None = None
    artist: str | None = None
    album_artist: str | None = None
    album: str | None = None
    year: str | None = None
    track_number: str | None = None
    disc_number: str | None = None
    genre: str | None = None
    composer: str | None = None
    release_date: str | None = None
    album_version: str | None = None
    compilation: str | None = None
    musicbrainz_album_id: str | None = None
    musicbrainz_album_artist_id: str | None = None
    trigger_navidrome_scan: bool = True


class CopyArtworkRequest(BaseModel):
    """Payload for POST /api/track/artwork/copy to copy an existing track's artwork onto target tracks."""

    source_path: str
    target_paths: list[str] = Field(..., min_length=1)
    trigger_navidrome_scan: bool = True


class BulkUpdateError(BaseModel):
    """Per-file failure detail during a bulk update."""

    path: str
    error: str


class BulkUpdateResponse(BaseModel):
    """Response returned after a bulk metadata or artwork update."""

    updated: list[TrackMetadata]
    errors: list[BulkUpdateError] = Field(default_factory=list)
    navidrome_sync: NavidromeSyncResult


class ArtworkVariant(BaseModel):
    """Distinct embedded cover image found across one or more tracks in an album."""

    hash: str
    sample_track_path: str
    mime: str | None = None
    size: int = 0
    track_count: int
    track_paths: list[str] = Field(default_factory=list)


class NavidromeSplitWarning(BaseModel):
    """Diagnostic warning for tag inconsistencies that can split albums or cover art in Navidrome."""

    field: str
    label: str
    severity: str = "split"  # "split" (breaks PID.Album) or "artwork" (inconsistent covers)
    message: str
    values: list[str] = Field(default_factory=list)


class AlbumGroup(BaseModel):
    """Album entry containing its sorted tracks, distinct artwork variants, and Navidrome diagnostics."""

    id: str
    title: str
    artist: str
    year: str | None = None
    genre: str | None = None
    cover_track_path: str | None = None
    track_count: int
    total_duration: float
    formats: list[str] = Field(default_factory=list)
    artwork_variants: list[ArtworkVariant] = Field(default_factory=list)
    navidrome_warnings: list[NavidromeSplitWarning] = Field(default_factory=list)
    tracks: list[TrackMetadata] = Field(default_factory=list)


class ArtistGroup(BaseModel):
    """Artist entry grouping one or more albums."""

    id: str
    name: str
    album_count: int
    track_count: int
    albums: list[AlbumGroup] = Field(default_factory=list)


class LibraryStats(BaseModel):
    """Summary counts for the scanned music library."""

    artist_count: int
    album_count: int
    track_count: int
    total_duration: float


class LibraryResponse(BaseModel):
    """Response model for GET /api/library."""

    stats: LibraryStats
    artists: list[ArtistGroup]
    scanned_at: float


class AuditEntry(BaseModel):
    """Recorded metadata modification entry stored in /config/m4.db."""

    id: int
    timestamp: str
    path: str
    action: str
    before_tags: dict[str, str | None]
    after_tags: dict[str, str | None]


class MusicBrainzReleaseCandidate(BaseModel):
    """Search result card representing a MusicBrainz release match."""

    mbid: str
    title: str
    artist: str
    artist_mbid: str | None = None
    date: str | None = None
    year: str | None = None
    country: str | None = None
    status: str | None = None
    disambiguation: str | None = None
    track_count: int = 0
    disc_count: int = 1
    format: str | None = None
    label: str | None = None
    score: int = 0
    cover_art_url: str


class MusicBrainzTrackInfo(BaseModel):
    """Track entry returned by MusicBrainz release lookup."""

    disc_number: int
    disc_total: int
    track_number: int
    track_total: int
    title: str
    artist: str | None = None
    length_ms: int | None = None


class MusicBrainzReleaseDetail(MusicBrainzReleaseCandidate):
    """Full MusicBrainz release metadata including genre and tracklist."""

    genre: str | None = None
    compilation: bool = False
    tracks: list[MusicBrainzTrackInfo] = Field(default_factory=list)


class MusicBrainzApplyRequest(BaseModel):
    """Apply a chosen MusicBrainz release's metadata and/or Cover Art Archive image to target tracks."""

    mbid: str
    paths: list[str] = Field(..., min_length=1)
    apply_metadata: bool = True
    apply_artwork: bool = True
    apply_track_titles: bool = False
    trigger_navidrome_scan: bool = True


class MusicBrainzApplyResponse(BulkUpdateResponse):
    """Outcome of applying a MusicBrainz release match."""

    artwork_applied: bool = False
    artwork_note: str | None = None

