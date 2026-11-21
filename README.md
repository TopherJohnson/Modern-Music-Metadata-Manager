# Modern Music Metadata Manager (M⁴)

A lightweight, self-hosted web application designed as a companion to **[Navidrome](https://www.navidrome.org/)** for browsing, inspecting, and editing audio file metadata and embedded cover art directly on disk.

M⁴ ships as a **single Docker container** (FastAPI backend + compiled React/Vite/Tailwind CSS frontend) that reads and writes audio tags directly in your `/music` mount using `mutagen`, storing only a fast mtime/size scan cache and edit audit log in `/config/m4.db`.

---

## Features

- **Direct On-Disk Tag Editing:** Supports **MP3** (ID3v2), **FLAC** (Vorbis Comments + Picture blocks), **M4A/MP4** (MP4 atoms + `covr`), **OGG Vorbis**, and **Opus** (`METADATA_BLOCK_PICTURE`).
- **Artist → Album → Track Browser:** Fast recursive scanner with SQLite `(mtime, size)` caching and instant search across tags, genres, formats, and file paths.
- **Single-Track & Bulk Album Editing:** Edit `title`, `artist`, `album_artist`, `album`, `year`, `track_number`, `disc_number`, `genre`, `composer`, and embedded cover art on individual tracks or batch-apply shared fields across an entire album without clobbering untouched fields.
- **Optional Navidrome Auto-Scan:** Configure `NAVIDROME_URL`, `NAVIDROME_USER`, and `NAVIDROME_PASS` to automatically trigger Navidrome's Subsonic `startScan` API after saving changes.
- **Permission-Safe Self-Hosting:** `PUID` and `PGID` user/group mapping at container startup (via `gosu`) ensures edited files keep the exact ownership Navidrome expects, without ever recursively `chown`-ing `/music`.

---

## Quick Start (Docker Compose)

1. Edit `docker-compose.yml` and replace `/path/to/music` with the path to your music library (matching the `PUID` / `PGID` used by your Navidrome container).
2. Build and start M⁴:

```bash
docker compose up --build
```

3. Open the web UI at `http://localhost:8080` (or verify container health at `http://localhost:8080/api/health`).

---

## Configuration (Environment Variables)

| Variable | Default | Description |
| --- | --- | --- |
| `PUID` | `1000` | User ID the app process runs as (matches host/Navidrome file ownership) |
| `PGID` | `1000` | Group ID the app process runs as |
| `TZ` | `UTC` | Container timezone (e.g., `America/Chicago`) |
| `M4_MUSIC_DIR` | `/music` | Mounted audio library directory (must be read-write to save tags) |
| `M4_CONFIG_DIR` | `/config` | Directory for SQLite cache and edit history (`m4.db`) |
| `NAVIDROME_URL` | *(empty)* | Optional base URL of your Navidrome instance (e.g., `http://navidrome:4533`) |
| `NAVIDROME_USER` | *(empty)* | Optional Navidrome username for Subsonic `startScan` |
| `NAVIDROME_PASS` | *(empty)* | Optional Navidrome password (sent via salted MD5 Subsonic token auth) |
| `NAVIDROME_AUTO_SCAN` | `true` | Automatically trigger `startScan` after saving metadata or artwork |

---

## Project Layout

```text
Modern-Music-Metadata-Manager/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app factory, lifespan, static SPA serving
│   │   ├── config.py            # Environment settings
│   │   ├── database.py          # SQLite (/config/m4.db) scan cache & audit history
│   │   ├── models.py            # Pydantic request/response schemas
│   │   ├── routers/
│   │   │   ├── health.py        # GET /api/health
│   │   │   ├── library.py       # GET /api/library, POST /api/library/scan, GET /api/history
│   │   │   └── tracks.py        # GET/PUT /api/track, PUT /api/tracks/bulk, artwork CRUD
│   │   └── services/
│   │       ├── tags.py          # Mutagen tag + cover art I/O & path-traversal guard
│   │       ├── scanner.py       # /music walker with SQLite caching & Artist->Album->Track grouping
│   │       └── navidrome.py     # Optional Subsonic startScan client
│   ├── tests/
│   │   └── test_api.py          # Backend unit & integration tests
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── api/client.ts        # Typed REST API client
│   │   ├── components/          # Header, Sidebar, TrackList, MetadataEditor, Toast
│   │   ├── types/music.ts       # Shared TypeScript interfaces
│   │   ├── App.tsx
│   │   └── index.css            # Tailwind CSS v4 + studio design tokens
│   ├── package.json
│   └── vite.config.ts
├── docker/
│   └── docker-entrypoint.sh     # PUID/PGID mapping + gosu privilege drop
├── Dockerfile                   # Multi-stage build (Node 22 Alpine -> Python 3.12 Slim)
└── docker-compose.yml           # Ready-to-use self-hosted Compose stack
```

---

## REST API Overview

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Container status, `/music` readability & writability, Navidrome status |
| `GET` | `/api/library?q=&rescan=` | Library tree grouped by `Artist -> Album -> Track` with optional search |
| `POST` | `/api/library/scan` | Force a full rescan of `/music` and refresh cache |
| `GET` | `/api/track?path=` | Read live metadata for a single track directly from disk |
| `GET` | `/api/track/raw?path=` | Inspect all raw audio tag frames/atoms on a file |
| `PUT` | `/api/track` | Write updated tags to a single track (and optionally trigger Navidrome scan) |
| `PUT` | `/api/tracks/bulk` | Batch-update shared tags across multiple tracks (album-level edit) |
| `GET` | `/api/track/artwork?path=` | Serve embedded front cover art for a track |
| `PUT` | `/api/track/artwork` | Embed or replace cover art on one or more tracks |
| `POST` | `/api/track/artwork/copy` | Copy an existing album track's embedded cover art onto target tracks |
| `DELETE` | `/api/track/artwork?path=` | Remove embedded cover art from a track |
| `GET` | `/api/history` | Inspect recent metadata edit audit history stored in `/config/m4.db` |
| `POST` | `/api/navidrome/scan` | Manually trigger a Navidrome Subsonic `startScan` |
| `GET` | `/api/musicbrainz/search` | Search MusicBrainz releases by album & artist |
| `GET` | `/api/musicbrainz/search/track` | Search MusicBrainz recordings to identify a single untagged track |
| `GET` | `/api/musicbrainz/cover/{mbid}` | Proxy Cover Art Archive front cover preview |
| `POST` | `/api/musicbrainz/apply` | Apply a chosen MusicBrainz release's tags and/or cover art to an album |
| `POST` | `/api/musicbrainz/apply/track` | Apply a chosen MusicBrainz recording/release match to a single track |

---

## Local Development (Without Docker)

### Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
M4_MUSIC_DIR=/path/to/music M4_CONFIG_DIR=../config uvicorn app.main:app --reload --port 8080
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```
Vite runs on `http://localhost:5173` and automatically proxies `/api/*` requests to FastAPI on port `8080`.
