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
    auth_enabled: bool = False
    libraries_count: int = 1


class LibraryInfo(BaseModel):
    """Metadata and mount readiness for a single configured music library."""

    id: str
    name: str
    path: str
    exists: bool
    readable: bool
    writable: bool
    cached_tracks: int = 0


class AuthStatusResponse(BaseModel):
    """Current authentication mode and session status for the browser client."""

    enabled: bool
    authenticated: bool
    username: str | None = None


class LoginRequest(BaseModel):
    """Credentials payload for POST /api/auth/login."""

    username: str
    password: str


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
    missing_fields: list[str] = Field(default_factory=list)


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


class TrackDeleteResponse(BaseModel):
    """Response returned after permanently deleting an audio file from disk."""

    deleted_path: str
    deleted_sidecars: list[str] = Field(default_factory=list)
    removed_empty_dirs: int = 0
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
    has_missing_metadata: bool = False
    needs_reorganize: bool = False
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
    """Recorded metadata modification or file move entry stored in /config/m4.db."""

    id: int
    timestamp: str
    library_id: str = "default"
    batch_id: str | None = None
    path: str
    action: str
    before_tags: dict[str, str | list[dict[str, str]] | None]
    after_tags: dict[str, str | list[dict[str, str]] | None]
    undone: bool = False
    can_undo: bool = False
    changed_fields: list[str] = Field(default_factory=list)


class UndoResponse(BaseModel):
    """Result of undoing a previous metadata edit or file move."""

    entry_id: int
    action: str
    restored_path: str
    restored_sidecars: int = 0
    track: TrackMetadata | None = None
    navidrome_sync: NavidromeSyncResult


class BatchUndoResponse(BaseModel):
    """Result of undoing an entire batch of grouped metadata edits or file moves."""

    batch_id: str
    undone_count: int
    restored_sidecars: int = 0
    errors: list[BulkUpdateError] = Field(default_factory=list)
    navidrome_sync: NavidromeSyncResult


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


class MusicBrainzTrackMatch(BaseModel):
    """Mapping between a local audio track and a matched (or unmatched) MusicBrainz release track."""

    local_path: str
    local_filename: str
    local_title: str | None = None
    local_artist: str | None = None
    local_track_number: str | None = None
    local_disc_number: str | None = None
    local_duration: float = 0.0
    matched: bool = False
    # "disc_track" | "title_duration" | "title" | "duration" | "unmatched"
    match_method: str = "unmatched"
    # "high" | "medium" | "low" | "none"
    confidence: str = "none"
    reason: str | None = None
    mb_disc_number: int | None = None
    mb_disc_total: int | None = None
    mb_track_number: int | None = None
    mb_track_total: int | None = None
    mb_title: str | None = None
    mb_artist: str | None = None
    mb_length_ms: int | None = None


class MusicBrainzPreviewRequest(BaseModel):
    """Request track-by-track MusicBrainz release matching preview for local paths."""

    mbid: str
    paths: list[str] = Field(..., min_length=1)


class MusicBrainzPreviewResponse(BaseModel):
    """Track-by-track mapping preview between local files and a MusicBrainz release."""

    release: MusicBrainzReleaseDetail
    local_track_count: int
    release_track_count: int
    matched_count: int
    unmatched_count: int
    matches: list[MusicBrainzTrackMatch] = Field(default_factory=list)


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
    matched_tracks: int = 0
    unmatched_paths: list[str] = Field(default_factory=list)


class MusicBrainzTrackCandidate(BaseModel):
    """Single-track search candidate pairing a MusicBrainz recording with a specific release."""

    recording_mbid: str
    release_mbid: str | None = None
    title: str
    artist: str
    artist_mbid: str | None = None
    album: str | None = None
    album_artist: str | None = None
    date: str | None = None
    year: str | None = None
    country: str | None = None
    release_type: str | None = None
    track_number: str | None = None
    disc_number: str | None = None
    length_ms: int | None = None
    score: int = 0
    cover_art_url: str | None = None


class MusicBrainzApplyTrackRequest(BaseModel):
    """Apply a chosen MusicBrainz single-track recording/release match onto one audio file."""

    path: str
    title: str
    artist: str
    album_artist: str | None = None
    album: str | None = None
    year: str | None = None
    release_date: str | None = None
    track_number: str | None = None
    disc_number: str | None = None
    release_mbid: str | None = None
    artist_mbid: str | None = None
    apply_artwork: bool = True
    trigger_navidrome_scan: bool = True


class MusicBrainzApplyTrackResponse(TrackUpdateResponse):
    """Outcome of applying a MusicBrainz single-track match."""

    artwork_applied: bool = False
    artwork_note: str | None = None


class OrganizeSettings(BaseModel):
    """Persisted user preferences for library folder organization."""

    enabled: bool = False
    # Presets: "artist_album" | "artist_year_album" | "album_only" | "album_with_artist"
    template: str = "artist_album"
    rename_files: bool = False
    compilation_folder: str = "Various Artists"
    cleanup_empty_dirs: bool = True
    skip_missing_metadata: bool = True
    move_sidecars: bool = True


class MovePlanItem(BaseModel):
    """Single file entry in an organization dry-run plan."""

    source_path: str
    target_path: str
    album: str
    artist: str
    # "move" | "unchanged" | "skipped" | "conflict"
    status: str
    reason: str | None = None


class OrganizeMoveResult(BaseModel):
    """Planned or completed file move record."""

    source_path: str
    target_path: str


class OrganizePreviewRequest(BaseModel):
    """Optional filter and unsaved settings override for dry-run reorganization preview."""

    paths: list[str] | None = None
    settings: OrganizeSettings | None = None


class OrganizePreviewResponse(BaseModel):
    """Dry-run summary and list of planned audio & sidecar file moves."""

    settings: OrganizeSettings
    total_tracks: int
    moves_count: int
    unchanged_count: int
    skipped_count: int
    conflict_count: int
    sidecar_moves_count: int = 0
    items: list[MovePlanItem] = Field(default_factory=list)
    sidecars: list[OrganizeMoveResult] = Field(default_factory=list)


class OrganizeApplyRequest(BaseModel):
    """Execute planned moves for the specified source paths (or all planned moves if paths omitted)."""

    paths: list[str] | None = None
    settings: OrganizeSettings | None = None
    trigger_navidrome_scan: bool = True


class OrganizeApplyResponse(BaseModel):
    """Outcome of executing library reorganization."""

    moved: list[OrganizeMoveResult] = Field(default_factory=list)
    moved_sidecars: list[OrganizeMoveResult] = Field(default_factory=list)
    skipped: int = 0
    errors: list[BulkUpdateError] = Field(default_factory=list)
    removed_empty_dirs: int = 0
    navidrome_sync: NavidromeSyncResult

