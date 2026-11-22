# Modern Music Metadata Manager (M⁴)

A lightweight, self-hosted web application designed as a companion to **[Navidrome](https://www.navidrome.org/)** for browsing, inspecting, identifying, organizing, and editing audio file metadata and embedded cover art directly on disk.

M⁴ ships as a **single Docker container** (FastAPI backend + compiled React/Vite/Tailwind CSS frontend) that reads and writes audio tags directly in your music mounts using `mutagen`, storing only a fast mtime/size scan cache, per-library settings, and batch-undoable edit history in `/config/m4.db`.

> [!NOTE]
> **Disclaimer:** This project is **100% vibe coded** with AI assistance. Because M⁴ edits audio metadata and moves files directly on disk, keep backups of your music library and use at your own risk!

---

## Features

- **Direct On-Disk Tag Editing:** Supports **MP3** (ID3v2), **FLAC** (Vorbis Comments + Picture blocks), **M4A/MP4** (MP4 atoms + `covr`), **OGG Vorbis**, and **Opus** (`METADATA_BLOCK_PICTURE`).
- **Artist → Album → Track Browser & Diagnostics:** Fast recursive scanner with SQLite `(mtime, size)` caching, instant search, red **Major Metadata Missing** alerts, and **Navidrome Split-Album (`PID.Album`)** mismatch diagnostics.
- **MusicBrainz Identification (Album & Single Track):** Jellyfin-style album identification with Cover Art Archive previews, plus single-track recording search for untagged stray files.
- **Library Folder & Sidecar Organizer:** Persisted per-library folder structure presets (`Artist/Album`, `Artist/Year - Album`, `Album`, `Album - Artist`), dry-run preview with collision detection, safe file moves, companion sidecar mover (`.lrc`, `.txt`, `cover.*`, `folder.*`, `.cue`, `.log`), and empty directory cleanup.
- **Batch-Grouped Activity History & One-Click Undo:** Bulk tag edits, MusicBrainz album updates, and multi-file reorganizations are grouped into collapsible batches so you can revert an entire 99-file operation (including sidecars) in one click, or expand to inspect/undo individual files.
- **Multi-Library Support:** Manage multiple music directories (`M4_LIBRARIES`) with isolated scan caches, audit history, and per-library folder organization settings, plus a header Library Switcher.
- **Optional Basic Auth:** Protect the UI and API with `M4_AUTH_USER` and `M4_AUTH_PASS` (disabled by default) using HMAC-SHA256 signed `HttpOnly` session cookies and HTTP Basic support.
- **Optional Navidrome Auto-Scan:** Configure `NAVIDROME_URL`, `NAVIDROME_USER`, and `NAVIDROME_PASS` to automatically trigger Navidrome's Subsonic `startScan` API after saving changes. Navidrome is **not required** to run M⁴.
- **Permission-Safe Self-Hosting:** `PUID` and `PGID` user/group mapping at container startup (via `gosu`) ensures edited files keep the exact ownership Navidrome expects, without ever recursively `chown`-ing `/music`.

See [ROADMAP.md](ROADMAP.md) for planned future features (deeper Navidrome admin integrations, AcoustID fingerprinting, background watcher, and more).

---

## Quick Start (Docker Compose)

Prebuilt multi-arch images (`linux/amd64` and `linux/arm64`) are published automatically to GitHub Container Registry (`ghcr.io/topherjohnson/modern-music-metadata-manager`).

1. Copy [docker-compose.yml](docker-compose.yml) and replace `/path/to/music` with the path to your music library (matching the `PUID` / `PGID` used by your Navidrome container). Config data mounts to `./m4-metadata-manager/config:/config` so it stays isolated in multi-service stacks.
2. Pull and start M⁴:

```bash
docker compose pull && docker compose up -d
```

*(Pin a specific release such as `ghcr.io/topherjohnson/modern-music-metadata-manager:0.5.1`, or uncomment the `build:` block in `docker-compose.yml` to build locally from source.)*

3. Open the web UI at `http://localhost:3333` (or verify container health at `http://localhost:3333/api/health`).

---

## Configuration (Environment Variables)

| Variable | Default | Description |
| --- | --- | --- |
| `PUID` | `1000` | User ID the app process runs as (matches host/Navidrome file ownership) |
| `PGID` | `1000` | Group ID the app process runs as |
| `TZ` | `UTC` | Container timezone (e.g., `America/Chicago`) |
| `M4_MUSIC_DIR` | `/music` | Single-library audio directory (used when `M4_LIBRARIES` is not set) |
| `M4_LIBRARIES` | *(empty)* | Optional comma-separated list of named libraries: `Main:/music/main,Soundtracks:/music/ost` |
| `M4_CONFIG_DIR` | `/config` | Directory for SQLite cache, settings, session secret, and audit history (`m4.db`) |
| `M4_AUTH_USER` | *(empty)* | Optional username to enable built-in Basic Auth / login screen |
| `M4_AUTH_PASS` | *(empty)* | Optional password (both `M4_AUTH_USER` and `M4_AUTH_PASS` must be set to enable auth) |
| `M4_SESSION_SECRET` | *(auto)* | Optional HMAC secret for signing session cookies (auto-persisted in `/config/.session_secret` if unset) |
| `NAVIDROME_URL` | *(empty)* | Optional base URL of your Navidrome instance (e.g., `http://navidrome:4533`) |
| `NAVIDROME_USER` | *(empty)* | Optional Navidrome username for Subsonic `startScan` |
| `NAVIDROME_PASS` | *(empty)* | Optional Navidrome password (sent via salted MD5 Subsonic token auth) |
| `NAVIDROME_AUTO_SCAN` | `true` | Automatically trigger `startScan` after saving metadata, artwork, or file moves |

---

## REST API Overview

All library/track/history/organize endpoints target the default library unless scoped with `?library=<id>` or the `X-M4-Library: <id>` header.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Container status, mount readability & writability, auth & Navidrome status (always open for healthchecks) |
| `GET` | `/api/auth/status` | Check whether Basic Auth is enabled and whether the current session is authenticated |
| `POST` | `/api/auth/login` | Validate Basic Auth credentials and set an `HttpOnly` session cookie |
| `POST` | `/api/auth/logout` | Clear the active session cookie |
| `GET` | `/api/libraries` | List all configured libraries with mount readiness and cached track counts |
| `GET` | `/api/library?q=&rescan=` | Library tree grouped by `Artist -> Album -> Track` with optional search |
| `POST` | `/api/library/scan` | Force a full rescan of the active library and refresh cache |
| `GET` | `/api/track?path=` | Read live metadata for a single track directly from disk |
| `GET` | `/api/track/raw?path=` | Inspect all raw audio tag frames/atoms on a file |
| `PUT` | `/api/track` | Write updated tags to a single track (and optionally trigger Navidrome scan) |
| `DELETE` | `/api/track?path=` | Permanently delete a single track file (plus optional matching `.lrc`/`.txt` sidecars and empty parent folders) |
| `PUT` | `/api/tracks/bulk` | Batch-update shared tags across multiple tracks (grouped under one `batch_id`) |
| `POST` | `/api/albums/merge` | Merge multiple albums or move stray tracks into a unified canonical album (+ cover art, track overrides, optional folder consolidation, single-batch undo) |
| `GET` | `/api/track/artwork?path=` | Serve embedded front cover art for a track |
| `PUT` | `/api/track/artwork` | Embed or replace cover art on one or more tracks |
| `POST` | `/api/track/artwork/copy` | Copy an existing album track's embedded cover art onto target tracks |
| `DELETE` | `/api/track/artwork?path=` | Remove embedded cover art from a track |
| `GET` | `/api/history` | Inspect recent metadata edit and file move audit history for the active library |
| `POST` | `/api/history/{id}/undo` | Revert a single tag edit or file (+ sidecar) move on disk |
| `POST` | `/api/history/batch/{batch_id}/undo` | Revert an entire grouped batch of edits or moves (+ sidecars) in one request |
| `POST` | `/api/navidrome/scan` | Manually trigger a Navidrome Subsonic `startScan` |
| `GET` | `/api/musicbrainz/search` | Search MusicBrainz releases by album & artist |
| `GET` | `/api/musicbrainz/search/track` | Search MusicBrainz recordings to identify a single untagged track |
| `GET` | `/api/musicbrainz/cover/{mbid}` | Proxy Cover Art Archive front cover preview |
| `POST` | `/api/musicbrainz/preview` | Preview prioritized track-to-release matching before overwriting track titles/numbers |
| `POST` | `/api/musicbrainz/apply` | Apply a chosen MusicBrainz release's tags and/or cover art to an album |
| `POST` | `/api/musicbrainz/apply/track` | Apply a chosen MusicBrainz recording/release match to a single track |
| `GET/PUT` | `/api/settings/organize` | Read or update persisted per-library folder structure preferences |
| `POST` | `/api/organize/preview` | Generate a dry-run preview of planned folder, filename, and sidecar moves |
| `POST` | `/api/organize/apply` | Execute planned library reorganization moves and prune empty folders |

---

## Local Development (Without Docker)

### Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
M4_MUSIC_DIR=/path/to/music M4_CONFIG_DIR=../config uvicorn app.main:app --reload --port 3333
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Vite runs on `http://localhost:5173` and automatically proxies `/api/*` requests to FastAPI on port `3333`.
