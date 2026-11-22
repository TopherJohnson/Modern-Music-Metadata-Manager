# M⁴ Future Roadmap & Ideas

This document tracks larger features and optional deeper integrations intentionally deferred from the core self-hosted build so M⁴ stays lightweight and does not hard-depend on any specific media server.

---

## Deeper Navidrome Integrations (Optional)

- **Navidrome Credential Sign-In (SSO-style Auth):**
  - Allow signing into M⁴ using existing Navidrome admin credentials (validating against Navidrome's `/auth/login` or Subsonic API with admin privilege verification) as an alternative to standalone `M4_AUTH_USER` / `M4_AUTH_PASS`.
- **Auto-Discovery of Navidrome Libraries:**
  - When connected with Navidrome admin credentials, query Navidrome's configured library list (`GET /api/library`) and automatically map/match them to mounted paths inside the M⁴ container (with optional path-prefix translation when container mount points differ from Navidrome's paths).
- **Per-Library Targeted Navidrome Rescans:**
  - Trigger Navidrome rescans scoped only to the edited library rather than scanning all libraries.

---

## Metadata & Library Automation

- **AcoustID / Chromaprint Audio Fingerprinting:**
  - Identify completely untagged files (e.g., `Track01.mp3`) by acoustic fingerprint (`fpcalc` + AcoustID API -> MusicBrainz recording) when filename/tags give no clues.
- **Background Watch Mode / Scheduled Rescan:**
  - Optional cron schedule or filesystem watcher (e.g., `M4_SCAN_INTERVAL_MINUTES`) to automatically refresh the SQLite cache and surface newly added albums (e.g., from Soulbeets/Lidarr) with missing metadata or folder drift alerts.
- **Playlist Path Rewriter (`.m3u` / `.m3u8`):**
  - Optionally scan and update relative/absolute track references inside `.m3u` / `.m3u8` playlist files when M⁴ reorganizes folders or renames audio files.
- **Tag-from-Filename & Filename-from-Tag Templates:**
  - Custom format strings beyond the built-in folder/filename presets (e.g., `%albumartist%/%year% - %album%/%disc%-%track% %title%`).
