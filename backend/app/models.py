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
    """Editable standard metadata tags shared across ID3v2, Vorbis, and MP4."""

    title: str | None = None
    artist: str | None = None
    album_artist: str | None = None
    album: str | None = None
    year: str | None = None
    track_number: str | None = None
    disc_number: str | None = None
    genre: str | None = None
    composer: str | None = None


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
    trigger_navidrome_scan: bool = True


class BulkUpdateError(BaseModel):
    """Per-file failure detail during a bulk update."""

    path: str
    error: str


class BulkUpdateResponse(BaseModel):
    """Response returned after a bulk metadata update."""

    updated: list[TrackMetadata]
    errors: list[BulkUpdateError] = Field(default_factory=list)
    navidrome_sync: NavidromeSyncResult


class AlbumGroup(BaseModel):
    """Album entry containing its sorted tracks."""

    id: str
    title: str
    artist: str
    year: str | None = None
    genre: str | None = None
    cover_track_path: str | None = None
    track_count: int
    total_duration: float
    formats: list[str] = Field(default_factory=list)
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
