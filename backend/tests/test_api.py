"""End-to-end API and Mutagen tag I/O tests for Modern Music Metadata Manager (M⁴)."""

from __future__ import annotations

import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from mutagen.flac import FLAC
from mutagen.id3 import ID3, TALB, TIT2, TPE1, TPE2, TRCK

from app.config import Settings
from app.main import create_app


# Minimal valid 1x1 PNG bytes for embedded artwork testing
TINY_PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"
    b"\x00\x00\x00\x0cIDATx\x9cc\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00\x18\xdd\x8d\xb0"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _create_minimal_mp3(path: Path) -> None:
    """Create a minimal valid MP3 file (1 MPEG1 Layer III frame at 128kbps, 44.1kHz)."""
    # Frame header: 0xFF 0xFB 0x90 0x00 -> MPEG1, Layer III, 128kbps, 44100Hz, stereo -> 417 bytes
    frame = b"\xff\xfb\x90\x00" + (b"\x00" * 413)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(frame * 4)

    tags = ID3()
    tags.add(TIT2(encoding=3, text=["Intro"]))
    tags.add(TPE1(encoding=3, text=["Boards of Canada"]))
    tags.add(TPE2(encoding=3, text=["Boards of Canada"]))
    tags.add(TALB(encoding=3, text=["Geogaddi"]))
    tags.add(TRCK(encoding=3, text=["1/23"]))
    tags.save(path)


def _create_minimal_flac(path: Path) -> None:
    """Create a minimal valid FLAC file with a STREAMINFO block so Mutagen can read/write Vorbis comments."""
    # fLaC magic + last-metadata-block flag (0x80) | type 0 (STREAMINFO), length 34 bytes
    min_block = 4096
    max_block = 4096
    # 20-bit sample rate (44100), 3-bit (channels-1=1), 5-bit (bps-1=15), 36-bit total samples (44100)
    sr_ch_bps_samples = (44100 << 44) | (1 << 41) | (15 << 36) | 44100
    streaminfo = (
        struct.pack(">HH", min_block, max_block)
        + b"\x00\x00\x00"  # min frame size
        + b"\x00\x00\x00"  # max frame size
        + sr_ch_bps_samples.to_bytes(8, "big")
        + (b"\x00" * 16)  # MD5 signature
    )
    header = b"fLaC" + bytes([0x80, 0x00, 0x00, 34]) + streaminfo
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header)

    audio = FLAC(path)
    audio["TITLE"] = ["Music Is Math"]
    audio["ARTIST"] = ["Boards of Canada"]
    audio["ALBUMARTIST"] = ["Boards of Canada"]
    audio["ALBUM"] = ["Geogaddi"]
    audio["DATE"] = ["2002"]
    audio["TRACKNUMBER"] = ["2"]
    audio["TRACKTOTAL"] = ["23"]
    audio["GENRE"] = ["Electronic"]
    audio.save()


@pytest.fixture()
def client(tmp_path: Path):
    music_dir = tmp_path / "music"
    config_dir = tmp_path / "config"
    music_dir.mkdir()
    config_dir.mkdir()

    _create_minimal_mp3(music_dir / "Boards of Canada" / "Geogaddi" / "01 - Intro.mp3")
    _create_minimal_flac(
        music_dir / "Boards of Canada" / "Geogaddi" / "02 - Music Is Math.flac"
    )

    settings = Settings(
        music_dir=music_dir,
        config_dir=config_dir,
        static_dir=None,
        navidrome_url=None,
        navidrome_user=None,
        navidrome_pass=None,
        navidrome_auto_scan=True,
        log_level="warning",
    )
    app = create_app(settings=settings)
    with TestClient(app) as test_client:
        yield test_client


def test_health_endpoint(client: TestClient) -> None:
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["music_dir_exists"] is True
    assert body["music_dir_readable"] is True
    assert body["music_dir_writable"] is True
    assert body["config_dir_writable"] is True
    assert body["navidrome_configured"] is False


def test_library_grouping_and_search(client: TestClient) -> None:
    res = client.get("/api/library")
    assert res.status_code == 200
    data = res.json()
    assert data["stats"]["artist_count"] == 1
    assert data["stats"]["album_count"] == 1
    assert data["stats"]["track_count"] == 2

    album = data["artists"][0]["albums"][0]
    assert album["title"] == "Geogaddi"
    assert [t["title"] for t in album["tracks"]] == ["Intro", "Music Is Math"]
    assert album["formats"] == ["FLAC", "MP3"]

    # Search filtering
    filtered = client.get("/api/library", params={"q": "math"}).json()
    assert filtered["stats"]["track_count"] == 1
    assert filtered["artists"][0]["albums"][0]["tracks"][0]["title"] == "Music Is Math"


def test_single_track_edit_and_audit_history(client: TestClient) -> None:
    rel_path = "Boards of Canada/Geogaddi/01 - Intro.mp3"

    # Read track
    get_res = client.get("/api/track", params={"path": rel_path})
    assert get_res.status_code == 200
    assert get_res.json()["title"] == "Intro"

    # Update all editable tags
    put_res = client.put(
        "/api/track",
        json={
            "path": rel_path,
            "title": "Ready Lets Go",
            "year": "2002",
            "genre": "IDM",
            "composer": "Marcus Eoin & Mike Sandison",
            "disc_number": "1/1",
        },
    )
    assert put_res.status_code == 200
    updated = put_res.json()["track"]
    assert updated["title"] == "Ready Lets Go"
    assert updated["year"] == "2002"
    assert updated["genre"] == "IDM"
    assert updated["composer"] == "Marcus Eoin & Mike Sandison"
    assert updated["disc_number"] == "1/1"
    # Untouched fields remain preserved
    assert updated["album"] == "Geogaddi"
    assert updated["artist"] == "Boards of Canada"

    # Re-read directly from disk to confirm persistence
    reread = client.get("/api/track", params={"path": rel_path}).json()
    assert reread["title"] == "Ready Lets Go"
    assert reread["composer"] == "Marcus Eoin & Mike Sandison"

    # Audit history logged in /config/m4.db
    history = client.get("/api/history").json()
    assert len(history) == 1
    assert history[0]["action"] == "update_track"
    assert history[0]["before_tags"]["title"] == "Intro"
    assert history[0]["after_tags"]["title"] == "Ready Lets Go"


def test_bulk_album_update_preserves_titles(client: TestClient) -> None:
    paths = [
        "Boards of Canada/Geogaddi/01 - Intro.mp3",
        "Boards of Canada/Geogaddi/02 - Music Is Math.flac",
    ]
    res = client.put(
        "/api/tracks/bulk",
        json={
            "paths": paths,
            "genre": "Downtempo",
            "year": "2002",
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["errors"] == []
    assert len(body["updated"]) == 2
    assert {t["genre"] for t in body["updated"]} == {"Downtempo"}
    assert [t["title"] for t in body["updated"]] == ["Intro", "Music Is Math"]


def test_artwork_upload_read_and_delete(client: TestClient) -> None:
    rel_path = "Boards of Canada/Geogaddi/02 - Music Is Math.flac"

    # Initially no artwork
    res_missing = client.get("/api/track/artwork", params={"path": rel_path})
    assert res_missing.status_code == 404

    # Upload PNG artwork
    upload_res = client.put(
        "/api/track/artwork",
        data={"path": rel_path},
        files={"file": ("cover.png", TINY_PNG, "image/png")},
    )
    assert upload_res.status_code == 200
    assert upload_res.json()["updated"][0]["has_artwork"] is True
    assert upload_res.json()["updated"][0]["artwork_mime"] == "image/png"

    # Fetch embedded artwork back
    art_res = client.get("/api/track/artwork", params={"path": rel_path})
    assert art_res.status_code == 200
    assert art_res.headers["content-type"].startswith("image/png")
    assert art_res.content == TINY_PNG

    # Delete artwork
    del_res = client.delete("/api/track/artwork", params={"path": rel_path})
    assert del_res.status_code == 200
    assert del_res.json()["track"]["has_artwork"] is False


def test_path_traversal_rejected(client: TestClient) -> None:
    res = client.get("/api/track", params={"path": "../../etc/passwd"})
    assert res.status_code == 400


def test_existing_album_artwork_variants_and_copy(client: TestClient) -> None:
    mp3_path = "Boards of Canada/Geogaddi/01 - Intro.mp3"
    flac_path = "Boards of Canada/Geogaddi/02 - Music Is Math.flac"

    # Embed two different images on the two tracks of the same album
    alt_png = TINY_PNG + b"\x00"
    assert (
        client.put(
            "/api/track/artwork",
            data={"path": mp3_path},
            files={"file": ("cover1.png", TINY_PNG, "image/png")},
        ).status_code
        == 200
    )
    assert (
        client.put(
            "/api/track/artwork",
            data={"path": flac_path},
            files={"file": ("cover2.png", alt_png, "image/png")},
        ).status_code
        == 200
    )

    album = client.get("/api/library").json()["artists"][0]["albums"][0]
    assert len(album["artwork_variants"]) == 2
    assert any(w["field"] == "artwork" for w in album["navidrome_warnings"])

    # Copy the MP3's existing cover onto both tracks in the album
    copy_res = client.post(
        "/api/track/artwork/copy",
        json={
            "source_path": mp3_path,
            "target_paths": [mp3_path, flac_path],
        },
    )
    assert copy_res.status_code == 200
    assert copy_res.json()["errors"] == []

    # Now both tracks share 1 identical cover hash
    album_after = client.get("/api/library").json()["artists"][0]["albums"][0]
    assert len(album_after["artwork_variants"]) == 1
    assert album_after["artwork_variants"][0]["track_count"] == 2
    assert not any(w["field"] == "artwork" for w in album_after["navidrome_warnings"])


def test_navidrome_split_diagnostics_and_raw_tags(client: TestClient) -> None:
    mp3_path = "Boards of Canada/Geogaddi/01 - Intro.mp3"
    flac_path = "Boards of Canada/Geogaddi/02 - Music Is Math.flac"

    # Set a MusicBrainz Album ID and Release Date on only one track
    res = client.put(
        "/api/track",
        json={
            "path": mp3_path,
            "year": "2002",
            "musicbrainz_album_id": "11111111-2222-3333-4444-555555555555",
            "release_date": "2002-02-18",
        },
    )
    assert res.status_code == 200

    album = client.get("/api/library").json()["artists"][0]["albums"][0]
    warning_fields = {w["field"] for w in album["navidrome_warnings"]}
    assert "musicbrainz_album_id" in warning_fields
    assert "release_date" in warning_fields

    # Inspect raw tags endpoint
    raw_res = client.get("/api/track/raw", params={"path": mp3_path})
    assert raw_res.status_code == 200
    raw_tags = raw_res.json()["tags"]
    assert any("MusicBrainz Album Id" in k for k in raw_tags.keys())

    # Clear mismatched Navidrome tags across the album in bulk
    bulk_res = client.put(
        "/api/tracks/bulk",
        json={
            "paths": [mp3_path, flac_path],
            "musicbrainz_album_id": None,
            "release_date": None,
            "year": "2002",
        },
    )
    assert bulk_res.status_code == 200

    album_fixed = client.get("/api/library").json()["artists"][0]["albums"][0]
    split_warnings = [
        w for w in album_fixed["navidrome_warnings"] if w["severity"] == "split"
    ]
    assert split_warnings == []


def test_musicbrainz_search_and_apply(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.models import (
        MusicBrainzReleaseCandidate,
        MusicBrainzReleaseDetail,
        MusicBrainzTrackInfo,
    )
    from app.routers import musicbrainz as mb_router

    mbid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    artist_mbid = "11111111-1111-1111-1111-111111111111"

    async def fake_search(album: str, artist: str | None = None, limit: int = 10):
        return [
            MusicBrainzReleaseCandidate(
                mbid=mbid,
                title="Geogaddi",
                artist="Boards of Canada",
                artist_mbid=artist_mbid,
                date="2002-02-18",
                year="2002",
                country="GB",
                track_count=2,
                score=100,
                cover_art_url=f"/api/musicbrainz/cover/{mbid}?size=500",
            )
        ]

    async def fake_detail(release_id: str):
        return MusicBrainzReleaseDetail(
            mbid=release_id,
            title="Geogaddi",
            artist="Boards of Canada",
            artist_mbid=artist_mbid,
            date="2002-02-18",
            year="2002",
            country="GB",
            track_count=2,
            genre="Idm",
            compilation=False,
            cover_art_url=f"/api/musicbrainz/cover/{release_id}?size=500",
            tracks=[
                MusicBrainzTrackInfo(
                    disc_number=1,
                    disc_total=1,
                    track_number=1,
                    track_total=2,
                    title="Ready Lets Go",
                    artist="Boards of Canada",
                ),
                MusicBrainzTrackInfo(
                    disc_number=1,
                    disc_total=1,
                    track_number=2,
                    track_total=2,
                    title="Music Is Math",
                    artist="Boards of Canada",
                ),
            ],
        )

    async def fake_cover(release_id: str, size: int | None = 1200):
        return TINY_PNG, "image/png"

    monkeypatch.setattr(mb_router, "search_releases", fake_search)
    monkeypatch.setattr(mb_router, "get_release_detail", fake_detail)
    monkeypatch.setattr(mb_router, "fetch_cover_art", fake_cover)

    search_res = client.get(
        "/api/musicbrainz/search",
        params={"album": "Geogaddi", "artist": "Boards of Canada"},
    )
    assert search_res.status_code == 200
    assert search_res.json()[0]["mbid"] == mbid

    paths = [
        "Boards of Canada/Geogaddi/01 - Intro.mp3",
        "Boards of Canada/Geogaddi/02 - Music Is Math.flac",
    ]
    apply_res = client.post(
        "/api/musicbrainz/apply",
        json={
            "mbid": mbid,
            "paths": paths,
            "apply_metadata": True,
            "apply_artwork": True,
            "apply_track_titles": True,
        },
    )
    assert apply_res.status_code == 200
    body = apply_res.json()
    assert body["errors"] == []
    assert body["artwork_applied"] is True
    assert len(body["updated"]) == 2
    assert {t["musicbrainz_album_id"] for t in body["updated"]} == {mbid}
    assert {t["release_date"] for t in body["updated"]} == {"2002-02-18"}
    assert [t["title"] for t in body["updated"]] == ["Ready Lets Go", "Music Is Math"]
    assert all(t["has_artwork"] for t in body["updated"])


def test_missing_major_metadata_and_single_track_identify(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.models import MusicBrainzReleaseDetail, MusicBrainzTrackCandidate
    from app.routers import musicbrainz as mb_router

    # Drop a completely untagged MP3 file into /music
    music_dir = client.app.state.settings.music_dir
    stray = music_dir / "01 - The Black Keys - Lonely Boy.mp3"
    stray.write_bytes((b"\xff\xfb\x90\x00" + b"\x00" * 413) * 4)

    lib = client.get("/api/library").json()
    unknown_artist = next(a for a in lib["artists"] if a["name"] == "Unknown Artist")
    unknown_album = unknown_artist["albums"][0]
    assert unknown_album["title"] == "Unknown Album"
    assert unknown_album["has_missing_metadata"] is True
    assert any(w["severity"] == "missing" for w in unknown_album["navidrome_warnings"])
    stray_track = unknown_album["tracks"][0]
    assert set(stray_track["missing_fields"]) == {"title", "artist", "album"}

    # Mock single-track MusicBrainz recording search + apply
    rel_mbid = "99999999-8888-7777-6666-555555555555"
    artist_mbid = "22222222-3333-4444-5555-666666666666"

    async def fake_search_recordings(
        title: str,
        artist: str | None = None,
        album: str | None = None,
        duration_sec: float | None = None,
        limit: int = 12,
    ):
        return [
            MusicBrainzTrackCandidate(
                recording_mbid="rec-123",
                release_mbid=rel_mbid,
                title="Lonely Boy",
                artist="The Black Keys",
                artist_mbid=artist_mbid,
                album="El Camino",
                album_artist="The Black Keys",
                date="2011-12-06",
                year="2011",
                country="US",
                release_type="Album",
                track_number="1/11",
                disc_number="1",
                length_ms=193000,
                score=100,
                cover_art_url=f"/api/musicbrainz/cover/{rel_mbid}?size=500",
            )
        ]

    async def fake_detail(mbid: str):
        return MusicBrainzReleaseDetail(
            mbid=mbid,
            title="El Camino",
            artist="The Black Keys",
            artist_mbid=artist_mbid,
            date="2011-12-06",
            year="2011",
            genre="Garage Rock",
            compilation=False,
            cover_art_url=f"/api/musicbrainz/cover/{mbid}?size=500",
        )

    async def fake_cover(mbid: str, size: int | None = 1200):
        return TINY_PNG, "image/png"

    monkeypatch.setattr(mb_router, "search_recordings", fake_search_recordings)
    monkeypatch.setattr(mb_router, "get_release_detail", fake_detail)
    monkeypatch.setattr(mb_router, "fetch_cover_art", fake_cover)

    search_res = client.get(
        "/api/musicbrainz/search/track",
        params={"title": "Lonely Boy", "artist": "The Black Keys"},
    )
    assert search_res.status_code == 200
    cand = search_res.json()[0]
    assert cand["album"] == "El Camino"

    apply_res = client.post(
        "/api/musicbrainz/apply/track",
        json={
            "path": stray_track["path"],
            "title": cand["title"],
            "artist": cand["artist"],
            "album_artist": cand["album_artist"],
            "album": cand["album"],
            "year": cand["year"],
            "release_date": cand["date"],
            "track_number": cand["track_number"],
            "disc_number": cand["disc_number"],
            "release_mbid": cand["release_mbid"],
            "artist_mbid": cand["artist_mbid"],
            "apply_artwork": True,
        },
    )
    assert apply_res.status_code == 200
    body = apply_res.json()
    assert body["artwork_applied"] is True
    assert body["track"]["title"] == "Lonely Boy"
    assert body["track"]["album"] == "El Camino"
    assert body["track"]["genre"] == "Garage Rock"
    assert body["track"]["missing_fields"] == []

    # Confirm it moved out of Unknown Artist and no longer has missing-metadata flags
    lib_after = client.get("/api/library").json()
    assert all(a["name"] != "Unknown Artist" for a in lib_after["artists"])
    tbk = next(a for a in lib_after["artists"] if a["name"] == "The Black Keys")
    assert tbk["albums"][0]["has_missing_metadata"] is False


def test_library_folder_organization_preview_and_apply(client: TestClient) -> None:
    music_dir = client.app.state.settings.music_dir

    # Default settings start disabled
    initial = client.get("/api/settings/organize").json()
    assert initial["enabled"] is False
    assert initial["template"] == "artist_album"

    # Enable Album-only layout + filename standardization
    saved = client.put(
        "/api/settings/organize",
        json={
            "enabled": True,
            "template": "album_only",
            "rename_files": True,
            "compilation_folder": "Various Artists",
            "cleanup_empty_dirs": True,
            "skip_missing_metadata": True,
        },
    )
    assert saved.status_code == 200
    assert saved.json()["template"] == "album_only"

    # Library now flags the album as needing reorganization
    lib = client.get("/api/library").json()
    album = lib["artists"][0]["albums"][0]
    assert album["needs_reorganize"] is True
    assert any(w["severity"] == "structure" for w in album["navidrome_warnings"])

    # Add an untagged file to verify skip_missing_metadata protects it
    stray = music_dir / "random_untagged.mp3"
    stray.write_bytes((b"\xff\xfb\x90\x00" + b"\x00" * 413) * 4)

    # Dry-run preview shows 2 moves and 1 skipped untagged file
    preview = client.post("/api/organize/preview", json={}).json()
    assert preview["moves_count"] == 2
    assert preview["skipped_count"] == 1
    assert preview["conflict_count"] == 0
    targets = {
        item["target_path"]
        for item in preview["items"]
        if item["status"] == "move"
    }
    assert targets == {
        "Geogaddi/01 - Intro.mp3",
        "Geogaddi/02 - Music Is Math.flac",
    }

    # Execute moves
    apply_res = client.post("/api/organize/apply", json={})
    assert apply_res.status_code == 200
    body = apply_res.json()
    assert len(body["moved"]) == 2
    assert body["errors"] == []
    assert body["removed_empty_dirs"] >= 2

    # Files exist at new flat Album/ paths and old empty Artist/Album dirs are gone
    assert (music_dir / "Geogaddi" / "01 - Intro.mp3").is_file()
    assert (music_dir / "Geogaddi" / "02 - Music Is Math.flac").is_file()
    assert not (music_dir / "Boards of Canada").exists()
    # Untagged file stayed untouched
    assert stray.is_file()

    # After moving, Geogaddi no longer reports folder structure drift
    lib_after = client.get("/api/library").json()
    boc = next(a for a in lib_after["artists"] if a["name"] == "Boards of Canada")
    assert boc["albums"][0]["needs_reorganize"] is False

    # Move events recorded in audit history
    history = client.get("/api/history").json()
    assert any(entry["action"] == "move_track" for entry in history)


def test_history_undo_tags_and_sidecar_moves(client: TestClient) -> None:
    music_dir = client.app.state.settings.music_dir
    rel_mp3 = "Boards of Canada/Geogaddi/01 - Intro.mp3"

    # 1. Edit a tag, then undo it via /api/history/{id}/undo
    edit_res = client.put(
        "/api/track",
        json={"path": rel_mp3, "title": "Temporary Title", "genre": "Ambient"},
    )
    assert edit_res.status_code == 200

    history = client.get("/api/history").json()
    edit_entry = history[0]
    assert edit_entry["can_undo"] is True
    assert set(edit_entry["changed_fields"]) == {"title", "genre"}

    undo_res = client.post(f"/api/history/{edit_entry['id']}/undo")
    assert undo_res.status_code == 200
    assert undo_res.json()["track"]["title"] == "Intro"
    assert undo_res.json()["track"]["genre"] is None

    # Double-undo is rejected cleanly
    assert client.post(f"/api/history/{edit_entry['id']}/undo").status_code == 409

    # 2. Add track-level (.lrc) and album-level (cover.jpg) sidecars and reorganize
    album_dir = music_dir / "Boards of Canada" / "Geogaddi"
    lrc_file = album_dir / "01 - Intro.lrc"
    cover_file = album_dir / "cover.jpg"
    lrc_file.write_text("[00:01.00] Intro lyrics\n", encoding="utf-8")
    cover_file.write_bytes(TINY_PNG)

    org_settings = {
        "enabled": True,
        "template": "album_only",
        "rename_files": True,
        "compilation_folder": "Various Artists",
        "cleanup_empty_dirs": True,
        "skip_missing_metadata": True,
        "move_sidecars": True,
    }
    client.put("/api/settings/organize", json=org_settings)

    preview = client.post("/api/organize/preview", json={}).json()
    assert preview["moves_count"] == 2
    assert preview["sidecar_moves_count"] == 2
    sc_targets = {s["target_path"] for s in preview["sidecars"]}
    assert sc_targets == {"Geogaddi/01 - Intro.lrc", "Geogaddi/cover.jpg"}

    apply_res = client.post("/api/organize/apply", json={}).json()
    assert len(apply_res["moved"]) == 2
    assert len(apply_res["moved_sidecars"]) == 2
    assert (music_dir / "Geogaddi" / "01 - Intro.lrc").is_file()
    assert (music_dir / "Geogaddi" / "cover.jpg").is_file()
    assert not (music_dir / "Boards of Canada").exists()

    # 3. Undo both move_track history entries and verify audio + sidecars return to original folder
    move_entries = [
        e for e in client.get("/api/history").json() if e["action"] == "move_track"
    ]
    assert len(move_entries) == 2
    restored_sidecars = 0
    for move_entry in move_entries:
        res = client.post(f"/api/history/{move_entry['id']}/undo")
        assert res.status_code == 200
        restored_sidecars += res.json()["restored_sidecars"]

    assert restored_sidecars == 2
    assert (music_dir / "Boards of Canada" / "Geogaddi" / "01 - Intro.mp3").is_file()
    assert (music_dir / "Boards of Canada" / "Geogaddi" / "01 - Intro.lrc").is_file()
    assert (music_dir / "Boards of Canada" / "Geogaddi" / "cover.jpg").is_file()
    assert not (music_dir / "Geogaddi").exists()


def test_batch_grouped_history_and_one_click_batch_undo(client: TestClient) -> None:
    music_dir = client.app.state.settings.music_dir
    paths = [
        "Boards of Canada/Geogaddi/01 - Intro.mp3",
        "Boards of Canada/Geogaddi/02 - Music Is Math.flac",
    ]

    # 1. Bulk tag edit creates grouped entries sharing one batch_id
    bulk_res = client.put(
        "/api/tracks/bulk",
        json={"paths": paths, "genre": "IDM", "year": "2002"},
    )
    assert bulk_res.status_code == 200

    history = client.get("/api/history").json()
    bulk_entries = [e for e in history if e["action"] == "bulk_update"]
    assert len(bulk_entries) == 2
    tag_batch_id = bulk_entries[0]["batch_id"]
    assert tag_batch_id is not None
    assert all(e["batch_id"] == tag_batch_id for e in bulk_entries)

    # One-click batch undo reverts both tracks at once
    undo_batch_res = client.post(f"/api/history/batch/{tag_batch_id}/undo")
    assert undo_batch_res.status_code == 200
    body = undo_batch_res.json()
    assert body["undone_count"] == 2
    assert body["errors"] == []

    # Verify original tags restored
    mp3_after = client.get("/api/track", params={"path": paths[0]}).json()
    flac_after = client.get("/api/track", params={"path": paths[1]}).json()
    assert mp3_after["genre"] is None
    assert flac_after["genre"] == "Electronic"

    # Re-undoing the same batch returns 409
    assert client.post(f"/api/history/batch/{tag_batch_id}/undo").status_code == 409

    # 2. Multi-file organize move (+ sidecar) shares one batch_id and reverts in one click
    album_dir = music_dir / "Boards of Canada" / "Geogaddi"
    (album_dir / "01 - Intro.lrc").write_text("[00:01.00] lyrics\n", encoding="utf-8")
    (album_dir / "cover.jpg").write_bytes(TINY_PNG)

    client.put(
        "/api/settings/organize",
        json={
            "enabled": True,
            "template": "album_only",
            "rename_files": True,
            "compilation_folder": "Various Artists",
            "cleanup_empty_dirs": True,
            "skip_missing_metadata": True,
            "move_sidecars": True,
        },
    )
    apply_res = client.post("/api/organize/apply", json={})
    assert apply_res.status_code == 200
    assert len(apply_res.json()["moved"]) == 2
    assert len(apply_res.json()["moved_sidecars"]) == 2

    move_entries = [
        e for e in client.get("/api/history").json() if e["action"] == "move_track"
    ]
    assert len(move_entries) == 2
    move_batch_id = move_entries[0]["batch_id"]
    assert move_batch_id is not None
    assert all(e["batch_id"] == move_batch_id for e in move_entries)

    # Single batch undo restores both audio files and both sidecars
    undo_move_batch = client.post(f"/api/history/batch/{move_batch_id}/undo")
    assert undo_move_batch.status_code == 200
    undo_body = undo_move_batch.json()
    assert undo_body["undone_count"] == 2
    assert undo_body["restored_sidecars"] == 2
    assert undo_body["errors"] == []

    assert (album_dir / "01 - Intro.mp3").is_file()
    assert (album_dir / "02 - Music Is Math.flac").is_file()
    assert (album_dir / "01 - Intro.lrc").is_file()
    assert (album_dir / "cover.jpg").is_file()
    assert not (music_dir / "Geogaddi").exists()


def test_multi_library_isolation_and_per_library_settings(tmp_path: Path) -> None:
    from app.config import LibraryConfig

    main_dir = tmp_path / "main"
    ost_dir = tmp_path / "soundtracks"
    config_dir = tmp_path / "config"
    main_dir.mkdir()
    ost_dir.mkdir()
    config_dir.mkdir()

    _create_minimal_mp3(main_dir / "Boards of Canada" / "Geogaddi" / "01 - Intro.mp3")
    _create_minimal_flac(ost_dir / "Composer" / "Score" / "01 - Theme.flac")

    settings = Settings(
        music_dir=main_dir,
        config_dir=config_dir,
        static_dir=None,
        navidrome_url=None,
        navidrome_user=None,
        navidrome_pass=None,
        navidrome_auto_scan=False,
        log_level="warning",
        libraries=(
            LibraryConfig(id="main", name="Main", path=main_dir),
            LibraryConfig(id="soundtracks", name="Soundtracks", path=ost_dir),
        ),
    )

    with TestClient(create_app(settings=settings)) as tc:
        libs = tc.get("/api/libraries").json()
        assert [l["id"] for l in libs] == ["main", "soundtracks"]
        assert all(l["exists"] and l["writable"] for l in libs)

        # Default library is main (1 MP3 track)
        main_lib = tc.get("/api/library").json()
        assert main_lib["stats"]["track_count"] == 1
        assert main_lib["artists"][0]["albums"][0]["tracks"][0]["format"] == "MP3"

        # Switching via X-M4-Library header returns soundtracks (1 FLAC track)
        ost_lib = tc.get("/api/library", headers={"X-M4-Library": "soundtracks"}).json()
        assert ost_lib["stats"]["track_count"] == 1
        assert ost_lib["artists"][0]["albums"][0]["tracks"][0]["format"] == "FLAC"

        # Unknown library returns 404
        assert tc.get("/api/library", params={"library": "nonexistent"}).status_code == 404

        # Organize settings are isolated per library
        tc.put(
            "/api/settings/organize",
            headers={"X-M4-Library": "soundtracks"},
            json={
                "enabled": True,
                "template": "album_only",
                "rename_files": False,
                "compilation_folder": "Various Artists",
                "cleanup_empty_dirs": True,
                "skip_missing_metadata": True,
                "move_sidecars": True,
            },
        )
        assert tc.get("/api/settings/organize", headers={"X-M4-Library": "main"}).json()["enabled"] is False
        assert tc.get("/api/settings/organize", headers={"X-M4-Library": "soundtracks"}).json()["template"] == "album_only"

        # Edits and audit history are isolated per library
        tc.put(
            "/api/track",
            headers={"X-M4-Library": "soundtracks"},
            json={"path": "Composer/Score/01 - Theme.flac", "title": "Opening Theme"},
        )
        assert len(tc.get("/api/history", headers={"X-M4-Library": "main"}).json()) == 0
        ost_hist = tc.get("/api/history", headers={"X-M4-Library": "soundtracks"}).json()
        assert len(ost_hist) == 1
        assert ost_hist[0]["library_id"] == "soundtracks"


def test_optional_basic_auth_cookie_and_header(tmp_path: Path) -> None:
    import base64

    music_dir = tmp_path / "music"
    config_dir = tmp_path / "config"
    music_dir.mkdir()
    config_dir.mkdir()
    _create_minimal_mp3(music_dir / "Boards of Canada" / "Geogaddi" / "01 - Intro.mp3")

    settings = Settings(
        music_dir=music_dir,
        config_dir=config_dir,
        static_dir=None,
        navidrome_url=None,
        navidrome_user=None,
        navidrome_pass=None,
        navidrome_auto_scan=False,
        log_level="warning",
        auth_user="admin",
        auth_pass="s3cret-pass",
    )

    with TestClient(create_app(settings=settings)) as tc:
        # /api/health and /api/auth/status remain accessible without credentials
        health = tc.get("/api/health")
        assert health.status_code == 200
        assert health.json()["auth_enabled"] is True

        status = tc.get("/api/auth/status").json()
        assert status == {"enabled": True, "authenticated": False, "username": None}

        # Protected API endpoints reject unauthenticated requests with 401
        unauth = tc.get("/api/library")
        assert unauth.status_code == 401
        assert "Basic" in unauth.headers.get("www-authenticate", "")
        assert tc.get("/api/libraries").status_code == 401

        # HTTP Basic header works directly
        basic_token = base64.b64encode(b"admin:s3cret-pass").decode("ascii")
        basic_ok = tc.get(
            "/api/library", headers={"Authorization": f"Basic {basic_token}"}
        )
        assert basic_ok.status_code == 200
        assert basic_ok.json()["stats"]["track_count"] == 1

        # Invalid login fails with 401
        bad_login = tc.post(
            "/api/auth/login",
            json={"username": "admin", "password": "wrong"},
        )
        assert bad_login.status_code == 401

        # Valid login sets HttpOnly cookie and grants access
        good_login = tc.post(
            "/api/auth/login",
            json={"username": "admin", "password": "s3cret-pass"},
        )
        assert good_login.status_code == 200
        assert good_login.json() == {
            "enabled": True,
            "authenticated": True,
            "username": "admin",
        }
        assert tc.get("/api/auth/status").json()["authenticated"] is True
        assert tc.get("/api/library").status_code == 200

        # Logout clears cookie and revokes access
        logout_res = tc.post("/api/auth/logout")
        assert logout_res.status_code == 200
        assert logout_res.json()["authenticated"] is False
        assert tc.get("/api/library").status_code == 401


def test_delete_track_file_and_sidecars(client: TestClient) -> None:
    music_dir = client.app.state.settings.music_dir
    rel_mp3 = "Boards of Canada/Geogaddi/01 - Intro.mp3"
    rel_flac = "Boards of Canada/Geogaddi/02 - Music Is Math.flac"
    lrc_file = music_dir / "Boards of Canada" / "Geogaddi" / "01 - Intro.lrc"
    lrc_file.write_text("[00:01.00] Intro lyrics\n", encoding="utf-8")

    # Path traversal is rejected
    assert client.delete("/api/track", params={"path": "../secret.mp3"}).status_code == 400

    # Delete first track + matching .lrc sidecar (folder stays because FLAC remains)
    res1 = client.delete("/api/track", params={"path": rel_mp3})
    assert res1.status_code == 200
    body1 = res1.json()
    assert body1["deleted_path"] == rel_mp3
    assert body1["deleted_sidecars"] == ["Boards of Canada/Geogaddi/01 - Intro.lrc"]
    assert body1["removed_empty_dirs"] == 0
    assert not (music_dir / rel_mp3).exists()
    assert not lrc_file.exists()
    assert (music_dir / rel_flac).is_file()

    # Library now reflects 1 track
    assert client.get("/api/library").json()["stats"]["track_count"] == 1

    # Audit log recorded the non-undoable deletion
    history = client.get("/api/history").json()
    assert history[0]["action"] == "delete_track"
    assert history[0]["path"] == rel_mp3
    assert history[0]["can_undo"] is False

    # Deleting the final track in the album prunes the empty parent directories
    res2 = client.delete("/api/track", params={"path": rel_flac})
    assert res2.status_code == 200
    assert res2.json()["removed_empty_dirs"] >= 2
    assert not (music_dir / "Boards of Canada").exists()
    assert client.get("/api/library").json()["stats"]["track_count"] == 0


def test_musicbrainz_track_matching_missing_track_one_and_unmatched(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issue #3: missing track 1 must never shift track 2 -> track 1; unmatched tracks stay untouched."""
    from app.models import MusicBrainzReleaseDetail, MusicBrainzTrackInfo
    from app.routers import musicbrainz as mb_router

    music_dir = client.app.state.settings.music_dir
    # Remove track 1 so local album only has track 2 ("Music Is Math"), plus add an extra bonus track
    (music_dir / "Boards of Canada" / "Geogaddi" / "01 - Intro.mp3").unlink()

    bonus_path = music_dir / "Boards of Canada" / "Geogaddi" / "99 - Hidden Bonus.mp3"
    _create_minimal_mp3(bonus_path)
    bonus_tags = ID3(bonus_path)
    bonus_tags.setall("TIT2", [TIT2(encoding=3, text=["Secret Bonus Jam"])])
    bonus_tags.setall("TRCK", [TRCK(encoding=3, text=["99"])])
    bonus_tags.save(bonus_path)

    mbid = "33333333-3333-3333-3333-333333333333"

    async def fake_detail(requested_mbid: str):
        return MusicBrainzReleaseDetail(
            mbid=requested_mbid,
            title="Geogaddi",
            artist="Boards of Canada",
            date="2002-02-18",
            year="2002",
            track_count=3,
            disc_count=1,
            cover_art_url=f"/api/musicbrainz/cover/{requested_mbid}?size=500",
            tracks=[
                MusicBrainzTrackInfo(
                    disc_number=1,
                    disc_total=1,
                    track_number=1,
                    track_total=3,
                    title="Ready Lets Go",
                    artist="Boards of Canada",
                    length_ms=59000,
                ),
                MusicBrainzTrackInfo(
                    disc_number=1,
                    disc_total=1,
                    track_number=2,
                    track_total=3,
                    title="Music Is Math (Official)",
                    artist="Boards of Canada",
                    length_ms=321000,
                ),
                MusicBrainzTrackInfo(
                    disc_number=1,
                    disc_total=1,
                    track_number=3,
                    track_total=3,
                    title="Beware the Friendly Stranger",
                    artist="Boards of Canada",
                    length_ms=37000,
                ),
            ],
        )

    monkeypatch.setattr(mb_router, "get_release_detail", fake_detail)

    paths = [
        "Boards of Canada/Geogaddi/02 - Music Is Math.flac",
        "Boards of Canada/Geogaddi/99 - Hidden Bonus.mp3",
    ]

    # 1. Preview maps track 2 -> MB track 2 (NOT track 1!) and leaves bonus track unmatched
    prev_res = client.post("/api/musicbrainz/preview", json={"mbid": mbid, "paths": paths})
    assert prev_res.status_code == 200
    prev = prev_res.json()
    assert prev["local_track_count"] == 2
    assert prev["release_track_count"] == 3
    assert prev["matched_count"] == 1
    assert prev["unmatched_count"] == 1

    by_path = {m["local_path"]: m for m in prev["matches"]}
    assert by_path[paths[0]]["matched"] is True
    assert by_path[paths[0]]["match_method"] in {"title", "title_duration"}
    assert by_path[paths[0]]["mb_track_number"] == 2
    assert by_path[paths[0]]["mb_title"] == "Music Is Math (Official)"
    assert by_path[paths[1]]["matched"] is False
    assert by_path[paths[1]]["match_method"] == "unmatched"

    # 2. Apply overwrites track 2 accurately and leaves the unmatched bonus track's title/track # untouched
    apply_res = client.post(
        "/api/musicbrainz/apply",
        json={
            "mbid": mbid,
            "paths": paths,
            "apply_metadata": True,
            "apply_artwork": False,
            "apply_track_titles": True,
        },
    )
    assert apply_res.status_code == 200
    body = apply_res.json()
    assert body["matched_tracks"] == 1
    assert body["unmatched_paths"] == [paths[1]]

    updated_by_path = {t["path"]: t for t in body["updated"]}
    assert updated_by_path[paths[0]]["title"] == "Music Is Math (Official)"
    assert updated_by_path[paths[0]]["track_number"] == "2/3"
    assert updated_by_path[paths[1]]["title"] == "Secret Bonus Jam"
    assert updated_by_path[paths[1]]["track_number"] == "99"


def test_musicbrainz_matcher_title_duration_and_multidisc() -> None:
    """Verify title-first matching, disc/track fallback for generic titles, and pure duration fallback."""
    from app.models import MusicBrainzTrackInfo, TrackMetadata
    from app.services.musicbrainz import match_tracks_to_release

    mb_tracks = [
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=2, track_number=1, track_total=2,
            title="Opening Overture", length_ms=180000,
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=2, track_number=2, track_total=2,
            title="Midnight Express", length_ms=245000,
        ),
        MusicBrainzTrackInfo(
            disc_number=2, disc_total=2, track_number=1, track_total=1,
            title="Encore Finale", length_ms=312000,
        ),
    ]

    local_tracks = [
        # Disc 2 Track 1 with generic title -> falls back cleanly to Stage 2 disc_track
        TrackMetadata(
            path="d2t1.flac", filename="d2t1.flac", format="FLAC",
            disc_number="2/2", track_number="1/1", title="Track 01", duration=311.5,
        ),
        # No track number at all -> matched in Stage 1 by title + duration
        TrackMetadata(
            path="midnight.flac", filename="midnight.flac", format="FLAC",
            title="Midnight Express (Remastered)", duration=246.0,
        ),
        # Untitled & unnumbered -> matched unambiguously in Stage 3 by duration (180s)
        TrackMetadata(
            path="untitled.flac", filename="TrackUnknown.flac", format="FLAC",
            title=None, duration=181.0,
        ),
    ]

    matches = match_tracks_to_release(local_tracks, mb_tracks)
    assert matches[0].matched is True
    assert matches[0].mb_disc_number == 2
    assert matches[0].mb_track_number == 1
    assert matches[0].match_method == "disc_track"

    assert matches[1].matched is True
    assert matches[1].mb_title == "Midnight Express"
    assert matches[1].match_method == "title_duration"

    assert matches[2].matched is True
    assert matches[2].mb_title == "Opening Overture"
    assert matches[2].match_method == "duration"


def test_musicbrainz_matcher_prioritizes_title_over_wrong_track_number() -> None:
    """Reopened Issue #3: misnumbered/shifted local track numbers must match by title first, with (disc, track) tie-breaking."""
    from app.models import MusicBrainzTrackInfo, TrackMetadata
    from app.services.musicbrainz import match_tracks_to_release

    mb_tracks = [
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=1, track_total=4,
            title="Intro", length_ms=60000,
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=2, track_total=4,
            title="Superstition", length_ms=266000,
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=3, track_total=4,
            title="Sir Duke", length_ms=234000,
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=4, track_total=4,
            title="Intro", length_ms=60000,
        ),
    ]

    local_tracks = [
        # Local track #1 is actually MB track #3 ("Sir Duke") — shifted numbering!
        TrackMetadata(
            path="01.flac", filename="01 - Sir Duke.flac", format="FLAC",
            track_number="1", title="Sir Duke", duration=234.0,
        ),
        # Local track #3 is actually MB track #2 ("Superstition")
        TrackMetadata(
            path="03.flac", filename="03 - Superstition.flac", format="FLAC",
            track_number="3", title="Superstition", duration=265.0,
        ),
        # Duplicate title "Intro" at track #4 should tie-break to MB track #4 (not #1)
        TrackMetadata(
            path="04.flac", filename="04 - Intro.flac", format="FLAC",
            track_number="4", title="Intro", duration=60.0,
        ),
    ]

    matches = match_tracks_to_release(local_tracks, mb_tracks)
    assert matches[0].matched is True
    assert matches[0].mb_track_number == 3
    assert matches[0].mb_title == "Sir Duke"
    assert matches[0].match_method == "title_duration"

    assert matches[1].matched is True
    assert matches[1].mb_track_number == 2
    assert matches[1].mb_title == "Superstition"
    assert matches[1].match_method == "title_duration"

    assert matches[2].matched is True
    assert matches[2].mb_track_number == 4
    assert matches[2].mb_title == "Intro"
    assert matches[2].match_method == "title_duration"


def test_cross_album_split_detection_and_guards() -> None:
    """Issue #2: detect cross-album near-duplicate/shared-folder/shared-MBID splits without Vol. 1/2 false positives."""
    from app.models import TrackMetadata
    from app.services.scanner import build_library_response

    tracks = [
        # 1. Punctuation split (same artist)
        TrackMetadata(
            path="Stevie Wonder/Album A/01.mp3", filename="01.mp3", format="MP3",
            artist="Stevie Wonder", album_artist="Stevie Wonder",
            album="Song Review: A Greatest Hits Collection", title="Superstition",
        ),
        TrackMetadata(
            path="Stevie Wonder/Album B/02.mp3", filename="02.mp3", format="MP3",
            artist="Stevie Wonder", album_artist="Stevie Wonder",
            album="Song Review (A Greatest Hits Collection)", title="Sir Duke",
        ),
        # 2. Fuzzy typo split (same artist)
        TrackMetadata(
            path="Pink Floyd/DSOTM1/01.flac", filename="01.flac", format="FLAC",
            artist="Pink Floyd", album_artist="Pink Floyd",
            album="The Dark Side of the Moon", title="Time",
        ),
        TrackMetadata(
            path="Pink Floyd/DSOTM2/02.flac", filename="02.flac", format="FLAC",
            artist="Pink Floyd", album_artist="Pink Floyd",
            album="The Dark Side of the Moom", title="Money",
        ),
        # 3. Shared folder split (different album tags in same non-generic folder)
        TrackMetadata(
            path="Daft Punk/Discovery/01.flac", filename="01.flac", format="FLAC",
            artist="Daft Punk", album_artist="Daft Punk",
            album="Discovery", title="One More Time",
        ),
        TrackMetadata(
            path="Daft Punk/Discovery/02.flac", filename="02.flac", format="FLAC",
            artist="Daft Punk", album_artist="Daft Punk",
            album="Discovery (Japanese Bonus)", title="Aerodynamic",
        ),
        # 4. Shared MusicBrainz Album ID across two differently named albums
        TrackMetadata(
            path="Miles Davis/KOB1/01.flac", filename="01.flac", format="FLAC",
            artist="Miles Davis", album_artist="Miles Davis",
            album="Kind of Blue", title="So What",
            musicbrainz_album_id="99999999-9999-9999-9999-999999999999",
        ),
        TrackMetadata(
            path="Miles Davis/KOB2/02.flac", filename="02.flac", format="FLAC",
            artist="Miles Davis", album_artist="Miles Davis",
            album="K.O.B. Legacy", title="Freddie Freeloader",
            musicbrainz_album_id="99999999-9999-9999-9999-999999999999",
        ),
        # 5. False-positive guards: Vol. 1 vs Vol. 2 and Chronicle II vs Chronicle III must NOT flag
        TrackMetadata(
            path="Queen/Vol1/01.mp3", filename="01.mp3", format="MP3",
            artist="Queen", album_artist="Queen",
            album="Greatest Hits Vol. 1", title="Bohemian Rhapsody",
        ),
        TrackMetadata(
            path="Queen/Vol2/01.mp3", filename="01.mp3", format="MP3",
            artist="Queen", album_artist="Queen",
            album="Greatest Hits Vol. 2", title="Under Pressure",
        ),
        TrackMetadata(
            path="CCR/II/01.mp3", filename="01.mp3", format="MP3",
            artist="CCR", album_artist="CCR",
            album="Chronicle II", title="Fortunate Son",
        ),
        TrackMetadata(
            path="CCR/III/01.mp3", filename="01.mp3", format="MP3",
            artist="CCR", album_artist="CCR",
            album="Chronicle III", title="Bad Moon Rising",
        ),
    ]

    lib = build_library_response(tracks)
    albums_by_title = {
        album.title: album
        for artist in lib.artists
        for album in artist.albums
    }

    def dup_warning(title: str):
        return next(
            (w for w in albums_by_title[title].navidrome_warnings if w.field == "duplicate_album"),
            None,
        )

    # 1. Punctuation split detected & cross-linked
    sw1 = dup_warning("Song Review: A Greatest Hits Collection")
    sw2 = dup_warning("Song Review (A Greatest Hits Collection)")
    assert sw1 is not None and sw2 is not None
    assert sw1.severity == "split"
    assert albums_by_title["Song Review (A Greatest Hits Collection)"].id in sw1.related_album_ids
    assert albums_by_title["Song Review: A Greatest Hits Collection"].id in sw2.related_album_ids

    # 2. Fuzzy typo split detected
    pf1 = dup_warning("The Dark Side of the Moon")
    pf2 = dup_warning("The Dark Side of the Moom")
    assert pf1 is not None and pf2 is not None
    assert albums_by_title["The Dark Side of the Moom"].id in pf1.related_album_ids

    # 3. Shared folder split detected
    dp1 = dup_warning("Discovery")
    dp2 = dup_warning("Discovery (Japanese Bonus)")
    assert dp1 is not None and dp2 is not None
    assert "same folder" in dp1.message

    # 4. Shared MBID split detected
    md1 = dup_warning("Kind of Blue")
    md2 = dup_warning("K.O.B. Legacy")
    assert md1 is not None and md2 is not None
    assert "MusicBrainz Album ID" in md1.message

    # 5. Series / volume guards prevent false positives
    assert dup_warning("Greatest Hits Vol. 1") is None
    assert dup_warning("Greatest Hits Vol. 2") is None
    assert dup_warning("Chronicle II") is None
    assert dup_warning("Chronicle III") is None


def test_merge_multiple_albums_and_single_batch_undo(client: TestClient) -> None:
    """Issue #4: merge 3 split albums (incl. stray track), unify PID tags + artwork + folder, and undo in one batch."""
    from app.services.tags import write_track_artwork, write_track_metadata

    music_dir = client.app.state.settings.music_dir

    # Create 3 separate albums (mirroring Issue #4's 3-way split example)
    p1 = "Stevie Wonder/Song Review - Hits/01 - Superstition.mp3"
    p2 = "Stevie Wonder/Song Review (Hits)/02 - Sir Duke.mp3"
    p3 = "Stevie Wonder/Stray Singles/01 - Isnt She Lovely.mp3"
    for p in (p1, p2, p3):
        _create_minimal_mp3(music_dir / p)

    write_track_metadata(
        music_dir,
        p1,
        {
            "title": "Superstition",
            "artist": "Stevie Wonder",
            "album_artist": "Stevie Wonder",
            "album": "Song Review - A Greatest Hits Collection",
            "year": "1996",
            "track_number": "1",
            "musicbrainz_album_id": "aaaa1111-1111-1111-1111-111111111111",
        },
    )
    write_track_artwork(music_dir, p1, TINY_PNG, mime_type="image/png")

    write_track_metadata(
        music_dir,
        p2,
        {
            "title": "Sir Duke",
            "artist": "Stevie Wonder",
            "album_artist": "Stevie Wonder",
            "album": "Song Review (A Greatest Hits Collection)",
            "year": "1996",
            "track_number": "2",
            "album_version": "UK Edition",
            "musicbrainz_album_id": "bbbb2222-2222-2222-2222-222222222222",
        },
    )

    write_track_metadata(
        music_dir,
        p3,
        {
            "title": "Isn't She Lovely",
            "artist": "Stevie Wonder",
            "album_artist": "Stevie Wonder",
            "album": "Random Singles",
            "year": "1976",
            "track_number": "1",  # collides with p1 before override!
        },
    )

    # Confirm 3 distinct Stevie Wonder albums exist before merge
    lib_before = client.get("/api/library", params={"rescan": True}).json()
    sw_before = next(a for a in lib_before["artists"] if a["name"] == "Stevie Wonder")
    assert sw_before["album_count"] == 3

    # Enable folder organization to test optional folder consolidation
    client.put(
        "/api/settings/organize",
        json={
            "enabled": True,
            "template": "artist_album",
            "rename_files": False,
            "compilation_folder": "Various Artists",
            "cleanup_empty_dirs": True,
            "skip_missing_metadata": True,
            "move_sidecars": True,
        },
    )

    # Merge all 3 albums: unify album/PID tags (clearing album_version!), fix colliding track # on p3,
    # unify cover art from p1, and consolidate folders
    merge_res = client.post(
        "/api/albums/merge",
        json={
            "paths": [p1, p2, p3],
            "album": "Song Review: A Greatest Hits Collection",
            "album_artist": "Stevie Wonder",
            "year": "1996",
            "release_date": None,
            "genre": "Soul",
            "album_version": None,
            "compilation": None,
            "musicbrainz_album_id": "aaaa1111-1111-1111-1111-111111111111",
            "musicbrainz_album_artist_id": None,
            "track_overrides": [
                {"path": p1, "track_number": "1/3", "disc_number": "1/1"},
                {"path": p2, "track_number": "2/3", "disc_number": "1/1"},
                {"path": p3, "track_number": "3/3", "disc_number": "1/1"},
            ],
            "artwork_source_path": p1,
            "reorganize": True,
        },
    )
    assert merge_res.status_code == 200
    body = merge_res.json()
    assert len(body["updated"]) == 3
    assert body["errors"] == []
    assert body["artwork_applied"] is True
    assert body["batch_id"] is not None
    assert len(body["moved"]) == 3
    assert body["removed_empty_dirs"] >= 3

    # All 3 tracks are now unified under ONE album with zero Navidrome split/artwork warnings
    lib_after = client.get("/api/library").json()
    sw_after = next(a for a in lib_after["artists"] if a["name"] == "Stevie Wonder")
    assert sw_after["album_count"] == 1
    merged_album = sw_after["albums"][0]
    assert merged_album["title"] == "Song Review: A Greatest Hits Collection"
    assert merged_album["track_count"] == 3
    assert merged_album["navidrome_warnings"] == []
    assert len(merged_album["artwork_variants"]) == 1
    assert [t["track_number"] for t in merged_album["tracks"]] == ["1/3", "2/3", "3/3"]
    assert all(t["album_version"] is None for t in merged_album["tracks"])
    assert all(
        t["musicbrainz_album_id"] == "aaaa1111-1111-1111-1111-111111111111"
        for t in merged_album["tracks"]
    )

    # First undo the move batch, then undo the single merge_albums tag batch -> restores all 3 albums!
    history = client.get("/api/history").json()
    move_batch_id = next(e["batch_id"] for e in history if e["action"] == "move_track")
    tag_batch_id = body["batch_id"]

    assert client.post(f"/api/history/batch/{move_batch_id}/undo").status_code == 200
    undo_tags_res = client.post(f"/api/history/batch/{tag_batch_id}/undo")
    assert undo_tags_res.status_code == 200
    assert undo_tags_res.json()["undone_count"] == 3

    lib_reverted = client.get("/api/library").json()
    sw_reverted = next(a for a in lib_reverted["artists"] if a["name"] == "Stevie Wonder")
    assert sw_reverted["album_count"] == 3


def test_local_missing_tracks_detection_and_guardrails() -> None:
    """Issue #5 Tier 1: offline gap/total/disc detection with single, unnumbered, continuous-disc, and hidden-track guardrails."""
    from app.models import TrackMetadata
    from app.services.scanner import build_library_response

    tracks = [
        # 1. Sequence gaps: tracks 2 and 4 -> missing #1 and #3
        TrackMetadata(
            path="A/Gaps/02.flac", filename="02.flac", format="FLAC",
            artist="Artist A", album_artist="Artist A", album="Gap Album",
            title="Two", track_number="2",
        ),
        TrackMetadata(
            path="A/Gaps/04.flac", filename="04.flac", format="FLAC",
            artist="Artist A", album_artist="Artist A", album="Gap Album",
            title="Four", track_number="4",
        ),
        # 2. Short of declared total: 1/4, 2/4 -> missing #3, #4
        TrackMetadata(
            path="A/Short/01.flac", filename="01.flac", format="FLAC",
            artist="Artist A", album_artist="Artist A", album="Short Total",
            title="One", track_number="1/4",
        ),
        TrackMetadata(
            path="A/Short/02.flac", filename="02.flac", format="FLAC",
            artist="Artist A", album_artist="Artist A", album="Short Total",
            title="Two", track_number="2/4",
        ),
        # 3. Missing Disc 2 of 2
        TrackMetadata(
            path="A/Discs/1-01.flac", filename="1-01.flac", format="FLAC",
            artist="Artist A", album_artist="Artist A", album="Two Disc Set",
            title="D1T1", disc_number="1/2", track_number="1/1",
        ),
        # 4. Guardrail: unnumbered album -> 0 missing
        TrackMetadata(
            path="B/Unnum/a.mp3", filename="a.mp3", format="MP3",
            artist="Artist B", album_artist="Artist B", album="Unnumbered",
            title="Alpha",
        ),
        TrackMetadata(
            path="B/Unnum/b.mp3", filename="b.mp3", format="MP3",
            artist="Artist B", album_artist="Artist B", album="Unnumbered",
            title="Beta",
        ),
        # 5. Guardrail: standalone 1-track single without /total -> 0 missing
        TrackMetadata(
            path="B/Single/01.mp3", filename="01.mp3", format="MP3",
            artist="Artist B", album_artist="Artist B", album="Standalone Single",
            title="Hit Single", track_number="4",
        ),
        # 6. Explicit partial 1-track album tagged 2/4 -> missing #1, #3, #4
        TrackMetadata(
            path="B/Partial/02.mp3", filename="02.mp3", format="MP3",
            artist="Artist B", album_artist="Artist B", album="Partial Single Tag",
            title="Only Track", track_number="2/4",
        ),
        # 7. Guardrail: continuous multi-disc numbering (Disc 1: 1..2, Disc 2: 3..4) -> 0 missing
        TrackMetadata(
            path="C/Cont/1-01.flac", filename="1-01.flac", format="FLAC",
            artist="Artist C", album_artist="Artist C", album="Continuous Multi",
            title="T1", disc_number="1/2", track_number="1",
        ),
        TrackMetadata(
            path="C/Cont/1-02.flac", filename="1-02.flac", format="FLAC",
            artist="Artist C", album_artist="Artist C", album="Continuous Multi",
            title="T2", disc_number="1/2", track_number="2",
        ),
        TrackMetadata(
            path="C/Cont/2-03.flac", filename="2-03.flac", format="FLAC",
            artist="Artist C", album_artist="Artist C", album="Continuous Multi",
            title="T3", disc_number="2/2", track_number="3",
        ),
        TrackMetadata(
            path="C/Cont/2-04.flac", filename="2-04.flac", format="FLAC",
            artist="Artist C", album_artist="Artist C", album="Continuous Multi",
            title="T4", disc_number="2/2", track_number="4",
        ),
        # 8. Guardrail: hidden bonus track #99 after #1, #2 -> 0 missing
        TrackMetadata(
            path="C/Bonus/01.flac", filename="01.flac", format="FLAC",
            artist="Artist C", album_artist="Artist C", album="Hidden Track Album",
            title="First", track_number="1",
        ),
        TrackMetadata(
            path="C/Bonus/02.flac", filename="02.flac", format="FLAC",
            artist="Artist C", album_artist="Artist C", album="Hidden Track Album",
            title="Second", track_number="2",
        ),
        TrackMetadata(
            path="C/Bonus/99.flac", filename="99.flac", format="FLAC",
            artist="Artist C", album_artist="Artist C", album="Hidden Track Album",
            title="Secret Outro", track_number="99",
        ),
    ]

    lib = build_library_response(tracks)
    by_title = {alb.title: alb for art in lib.artists for alb in art.albums}

    assert [(m.disc_number, m.track_number, m.source) for m in by_title["Gap Album"].missing_tracks] == [
        (1, 1, "local_gap"),
        (1, 3, "local_gap"),
    ]
    assert [(m.disc_number, m.track_number, m.source) for m in by_title["Short Total"].missing_tracks] == [
        (1, 3, "local_total"),
        (1, 4, "local_total"),
    ]
    assert [(m.disc_number, m.track_number, m.source) for m in by_title["Two Disc Set"].missing_tracks] == [
        (2, 0, "local_disc"),
    ]
    assert by_title["Unnumbered"].missing_track_count == 0
    assert by_title["Standalone Single"].missing_track_count == 0
    assert [m.track_number for m in by_title["Partial Single Tag"].missing_tracks] == [1, 3, 4]
    assert by_title["Continuous Multi"].missing_track_count == 0
    assert by_title["Hidden Track Album"].missing_track_count == 0


def test_completeness_musicbrainz_cache_stray_search_and_ignores(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issue #5 Tier 2 + Library Search + Single/Bulk Ignores stored in SQLite."""
    from app.models import MusicBrainzReleaseDetail, MusicBrainzTrackInfo
    from app.routers import completeness as comp_router
    from app.services.tags import write_track_metadata

    music_dir = client.app.state.settings.music_dir

    # Create an incomplete Stevie Wonder album (tracks 1 & 2) + stray track #3 sitting in Unknown Album
    p1 = "Stevie Wonder/Song Review/01 - Superstition.mp3"
    p2 = "Stevie Wonder/Song Review/02 - Sir Duke.mp3"
    p_stray = "Inbox/Isnt She Lovely.mp3"
    p_partial = "Stevie Wonder/Talking Book/02 - Maybe Your Baby.mp3"
    for p in (p1, p2, p_stray, p_partial):
        _create_minimal_mp3(music_dir / p)

    mbid = "55555555-5555-5555-5555-555555555555"
    write_track_metadata(
        music_dir, p1,
        {
            "title": "Superstition", "artist": "Stevie Wonder",
            "album_artist": "Stevie Wonder", "album": "Song Review",
            "track_number": "1/3", "musicbrainz_album_id": mbid,
        },
    )
    write_track_metadata(
        music_dir, p2,
        {
            "title": "Sir Duke", "artist": "Stevie Wonder",
            "album_artist": "Stevie Wonder", "album": "Song Review",
            "track_number": "2/3", "musicbrainz_album_id": mbid,
        },
    )
    write_track_metadata(
        music_dir, p_stray,
        {
            "title": "Isn't She Lovely", "artist": "Stevie Wonder",
            "album_artist": None, "album": None,
        },
    )
    write_track_metadata(
        music_dir, p_partial,
        {
            "title": "Maybe Your Baby", "artist": "Stevie Wonder",
            "album_artist": "Stevie Wonder", "album": "Talking Book",
            "track_number": "2/4",
        },
    )

    mb_calls = 0

    async def fake_release(requested_mbid: str):
        nonlocal mb_calls
        mb_calls += 1
        return MusicBrainzReleaseDetail(
            mbid=requested_mbid,
            title="Song Review",
            artist="Stevie Wonder",
            date="1996",
            year="1996",
            track_count=3,
            disc_count=1,
            cover_art_url=f"/api/musicbrainz/cover/{requested_mbid}?size=500",
            tracks=[
                MusicBrainzTrackInfo(
                    disc_number=1, disc_total=1, track_number=1, track_total=3,
                    title="Superstition", artist="Stevie Wonder", length_ms=266000,
                ),
                MusicBrainzTrackInfo(
                    disc_number=1, disc_total=1, track_number=2, track_total=3,
                    title="Sir Duke", artist="Stevie Wonder", length_ms=234000,
                ),
                MusicBrainzTrackInfo(
                    disc_number=1, disc_total=1, track_number=3, track_total=3,
                    title="Isn't She Lovely", artist="Stevie Wonder", length_ms=394000,
                ),
            ],
        )

    monkeypatch.setattr(comp_router, "get_release_detail", fake_release)

    lib_before = client.get("/api/library", params={"rescan": True}).json()
    albums = {alb["title"]: alb for art in lib_before["artists"] for alb in art["albums"]}
    song_review = albums["Song Review"]
    talking_book = albums["Talking Book"]

    # Tier 1 already spots track #3 missing on Song Review and #1,#3,#4 on Talking Book
    assert song_review["missing_track_count"] == 1
    assert song_review["completeness_source"] == "local"
    assert talking_book["missing_track_count"] == 3

    # Tier 2 check fetches MB tracklist, caches it in SQLite, and auto-matches the stray track in Unknown Album
    check1 = client.post("/api/albums/completeness/check", json={"album_id": song_review["id"]})
    assert check1.status_code == 200
    body1 = check1.json()
    assert mb_calls == 1
    assert body1["cached"] is False
    assert body1["missing_track_count"] == 1
    assert body1["missing_tracks"][0]["title"] == "Isn't She Lovely"
    assert body1["missing_tracks"][0]["source"] == "musicbrainz"
    assert len(body1["missing_tracks"][0]["candidates"]) >= 1
    top_cand = body1["missing_tracks"][0]["candidates"][0]
    assert top_cand["path"] == p_stray
    assert top_cand["album"] == "Unknown Album"
    assert top_cand["album_track_count"] == 1

    # Second check uses SQLite mb_release_cache without hitting MusicBrainz again
    check2 = client.post("/api/albums/completeness/check", json={"album_id": song_review["id"]})
    assert check2.status_code == 200
    assert check2.json()["cached"] is True
    assert mb_calls == 1

    # Library endpoint automatically hydrates Tier 2 missing title + candidate from SQLite cache
    lib_after_mb = client.get("/api/library").json()
    sr_mb = next(
        alb for art in lib_after_mb["artists"] for alb in art["albums"] if alb["id"] == song_review["id"]
    )
    assert sr_mb["completeness_source"] == "musicbrainz"
    assert sr_mb["missing_tracks"][0]["title"] == "Isn't She Lovely"
    assert sr_mb["missing_tracks"][0]["candidates"][0]["path"] == p_stray

    # Dedicated local library search finds the stray track
    search_res = client.get(
        "/api/albums/completeness/search-library",
        params={"album_id": song_review["id"], "q": "Isn't She Lovely", "artist": "Stevie Wonder"},
    )
    assert search_res.status_code == 200
    assert search_res.json()["candidates"][0]["path"] == p_stray

    # Single-track ignore suppresses track #3 while keeping ignored=True in payload
    ign_one = client.post(
        "/api/albums/completeness/ignore",
        json={"album_id": song_review["id"], "disc_number": 1, "track_number": 3, "ignore": True},
    )
    assert ign_one.status_code == 200
    lib_ign1 = client.get("/api/library").json()
    sr_ign1 = next(
        alb for art in lib_ign1["artists"] for alb in art["albums"] if alb["id"] == song_review["id"]
    )
    assert sr_ign1["missing_track_count"] == 0
    assert sr_ign1["missing_tracks"][0]["ignored"] is True
    assert sr_ign1["missing_tracks_ignored"] is False

    # Bulk ignore marks both Song Review and Talking Book as intentional partial albums
    bulk_ign = client.post(
        "/api/albums/completeness/ignore/bulk",
        json={"album_ids": [song_review["id"], talking_book["id"]], "ignore": True},
    )
    assert bulk_ign.status_code == 200
    assert bulk_ign.json()["updated_count"] == 2

    lib_bulk = client.get("/api/library").json()
    albums_bulk = {alb["id"]: alb for art in lib_bulk["artists"] for alb in art["albums"]}
    assert albums_bulk[song_review["id"]]["missing_tracks_ignored"] is True
    assert albums_bulk[song_review["id"]]["missing_track_count"] == 0
    assert albums_bulk[talking_book["id"]]["missing_tracks_ignored"] is True
    assert albums_bulk[talking_book["id"]]["missing_track_count"] == 0

    # Bulk re-enable restores active missing-track counts on both albums
    bulk_restore = client.post(
        "/api/albums/completeness/ignore/bulk",
        json={"album_ids": [song_review["id"], talking_book["id"]], "ignore": False},
    )
    assert bulk_restore.status_code == 200
    lib_restored = client.get("/api/library").json()
    albums_restored = {alb["id"]: alb for art in lib_restored["artists"] for alb in art["albums"]}
    assert albums_restored[song_review["id"]]["missing_tracks_ignored"] is False
    assert albums_restored[song_review["id"]]["missing_track_count"] == 1
    assert albums_restored[talking_book["id"]]["missing_tracks_ignored"] is False
    assert albums_restored[talking_book["id"]]["missing_track_count"] == 3


def test_staging_inbox_preview_drop_in_import_navidrome_guard_and_batch_undo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issue #8: standalone Staging works without slskd, suppresses Navidrome on edits, detects drop-in albums, moves sidecars, and supports batch undo."""
    from app.models import NavidromeSyncResult
    from app.routers import staging as staging_router
    from app.routers import tracks as tracks_router
    from app.services.tags import write_track_metadata

    music_dir = tmp_path / "music"
    staging_dir = tmp_path / "downloads"
    config_dir = tmp_path / "config"
    music_dir.mkdir()
    staging_dir.mkdir()
    config_dir.mkdir()

    # Existing album in library using a custom folder name
    existing_path = "Boards of Canada/Geogaddi (2002 Original)/01 - Intro.mp3"
    _create_minimal_mp3(music_dir / existing_path)
    write_track_metadata(
        music_dir,
        existing_path,
        {
            "title": "Intro",
            "artist": "Boards of Canada",
            "album_artist": "Boards of Canada",
            "album": "Geogaddi",
            "year": "2002",
            "track_number": "1/3",
        },
    )

    # Staged files: 1 single missing track matching Geogaddi (should drop-in!) + 1 new album with .lrc sidecar
    staged_dropin = "slskd-user/03 - Beware.flac"
    staged_new = "incoming/01 - Alpha.mp3"
    _create_minimal_flac(staging_dir / staged_dropin)
    _create_minimal_mp3(staging_dir / staged_new)
    (staging_dir / "incoming" / "01 - Alpha.lrc").write_text("[00:01.00] Alpha\n", encoding="utf-8")

    write_track_metadata(
        staging_dir,
        staged_dropin,
        {
            "title": "Beware",
            "artist": "Boards of Canada",
            "album_artist": "Boards of Canada",
            "album": "Geogaddi",
            "track_number": "3/3",
        },
    )
    write_track_metadata(
        staging_dir,
        staged_new,
        {
            "title": "Alpha",
            "artist": "New Artist",
            "album_artist": "New Artist",
            "album": "New Album",
            "track_number": "1/1",
        },
    )

    navidrome_calls: list[bool] = []

    async def fake_navidrome(_settings, *, requested: bool = True):
        if requested:
            navidrome_calls.append(True)
            return NavidromeSyncResult(triggered=True, configured=True, ok=True)
        return NavidromeSyncResult(triggered=False, configured=True, ok=False)

    monkeypatch.setattr(tracks_router, "trigger_navidrome_scan", fake_navidrome)
    monkeypatch.setattr(staging_router, "trigger_navidrome_scan", fake_navidrome)

    settings = Settings(
        music_dir=music_dir,
        config_dir=config_dir,
        static_dir=None,
        navidrome_url="http://navidrome:4533",
        navidrome_user="admin",
        navidrome_pass="secret",
        navidrome_auto_scan=True,
        log_level="warning",
        staging_dir=staging_dir,
        slskd_url=None,
        slskd_api_key=None,
    )

    with TestClient(create_app(settings=settings)) as tc:
        # 1. Health reports Staging enabled & slskd disabled (completely independent!)
        health = tc.get("/api/health").json()
        assert health["staging_configured"] is True
        assert health["staging_dir_writable"] is True
        assert health["slskd_configured"] is False

        # Real libraries list excludes __staging__
        libs = tc.get("/api/libraries").json()
        assert all(l["id"] != "__staging__" for l in libs)

        # Staging status reports 2 staged tracks across 2 albums
        st_status = tc.get("/api/staging/status", params={"rescan": True}).json()
        assert st_status["configured"] is True
        assert st_status["track_count"] == 2
        assert st_status["album_count"] == 2

        # 2. Editing a staged track does NOT trigger Navidrome rescan!
        edit_res = tc.put(
            "/api/track",
            headers={"X-M4-Library": "__staging__"},
            json={"path": staged_new, "genre": "Ambient"},
        )
        assert edit_res.status_code == 200
        assert edit_res.json()["navidrome_sync"]["triggered"] is False
        assert len(navidrome_calls) == 0

        # 3. Preview detects single-track drop-in into the existing Geogaddi folder + standard template for New Album
        prev_res = tc.post("/api/staging/preview", json={})
        assert prev_res.status_code == 200
        prev = prev_res.json()
        assert prev["import_count"] == 2
        assert prev["drop_in_count"] == 1
        assert prev["sidecar_moves_count"] == 1

        by_src = {i["source_path"]: i for i in prev["items"]}
        assert by_src[staged_dropin]["drop_in"] is True
        assert by_src[staged_dropin]["target_path"] == "Boards of Canada/Geogaddi (2002 Original)/03 - Beware.flac"
        assert by_src[staged_new]["drop_in"] is False
        assert by_src[staged_new]["target_path"] == "New Artist/New Album/01 - Alpha.mp3"

        # 4. Import moves files + sidecars, cleans empty staging folders, and triggers ONE Navidrome scan
        imp_res = tc.post("/api/staging/import", json={})
        assert imp_res.status_code == 200
        imp = imp_res.json()
        assert len(imp["imported"]) == 2
        assert len(imp["moved_sidecars"]) == 1
        assert imp["errors"] == []
        assert imp["batch_id"] is not None
        assert imp["removed_empty_dirs"] >= 2
        assert imp["navidrome_sync"]["triggered"] is True
        assert len(navidrome_calls) == 1

        assert (music_dir / "Boards of Canada/Geogaddi (2002 Original)/03 - Beware.flac").is_file()
        assert (music_dir / "New Artist/New Album/01 - Alpha.mp3").is_file()
        assert (music_dir / "New Artist/New Album/01 - Alpha.lrc").is_file()
        assert not (staging_dir / staged_dropin).exists()
        assert not (staging_dir / staged_new).exists()
        assert tc.get("/api/staging/status").json()["track_count"] == 0
        assert tc.get("/api/library").json()["stats"]["track_count"] == 3

        # 5. Batch undo in History moves both tracks + sidecar cleanly back to Staging!
        undo_res = tc.post(f"/api/history/batch/{imp['batch_id']}/undo")
        assert undo_res.status_code == 200
        undo_body = undo_res.json()
        assert undo_body["undone_count"] == 2
        assert undo_body["restored_sidecars"] == 1
        assert undo_body["errors"] == []

        assert (staging_dir / staged_dropin).is_file()
        assert (staging_dir / staged_new).is_file()
        assert (staging_dir / "incoming" / "01 - Alpha.lrc").is_file()
        assert not (music_dir / "New Artist").exists()
        assert tc.get("/api/library").json()["stats"]["track_count"] == 1
        assert tc.get("/api/staging/status").json()["track_count"] == 2


def test_slskd_ranking_search_queue_and_downloads_independent_of_staging(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issue #6: slskd works independently without Staging, ranks candidates by format/duration/slot, and exposes search/queue/downloads endpoints."""
    from app.models import (
        SlskdDownloadsResponse,
        SlskdQueueDownloadResponse,
        SlskdSearchResponse,
        SlskdTransferItem,
    )
    from app.routers import slskd as slskd_router
    from app.services.slskd import rank_slskd_responses

    # 1. Pure ranking engine test (format alignment, duration closeness, free slot, locked & non-audio filtering)
    mock_responses = [
        {
            "username": "lossy_peer",
            "hasFreeUploadSlot": False,
            "uploadSpeed": 120000,
            "queueLength": 15,
            "files": [
                {
                    "filename": "Music\\Stevie\\03 - Isn't She Lovely (Live).mp3",
                    "size": 4_000_000,
                    "bitRate": 128,
                    "length": 480,  # 86s off from expected 394s
                    "isLocked": False,
                },
                {
                    "filename": "Music\\Stevie\\cover.jpg",
                    "size": 90_000,
                    "isLocked": False,
                },
                {
                    "filename": "Music\\Stevie\\03 - Isn't She Lovely.flac",
                    "size": 45_000_000,
                    "length": 394,
                    "isLocked": True,  # locked -> must be skipped
                },
            ],
        },
        {
            "username": "audiophile_peer",
            "hasFreeUploadSlot": True,
            "uploadSpeed": 2_500_000,
            "queueLength": 0,
            "files": [
                {
                    "filename": "FLAC\\Stevie Wonder\\Song Review\\03 - Isn't She Lovely.flac",
                    "size": 42_000_000,
                    "sampleRate": 44100,
                    "bitDepth": 16,
                    "length": 395,  # within 1s of expected 394s!
                    "isLocked": False,
                },
            ],
        },
    ]

    ranked, total_files = rank_slskd_responses(
        mock_responses,
        query="Stevie Wonder Isn't She Lovely",
        track_title="Isn't She Lovely",
        artist="Stevie Wonder",
        preferred_formats=["FLAC"],
        expected_length_ms=394_000,
    )
    assert total_files == 4
    assert len(ranked) == 2  # cover.jpg and locked flac excluded
    assert ranked[0].username == "audiophile_peer"
    assert ranked[0].format == "FLAC"
    assert ranked[0].has_free_upload_slot is True
    assert ranked[0].duration_diff_sec == 1.0
    assert ranked[0].score > ranked[1].score

    # 2. Endpoint wiring when slskd is configured WITHOUT Staging
    music_dir = tmp_path / "music"
    config_dir = tmp_path / "config"
    music_dir.mkdir()
    config_dir.mkdir()

    async def fake_search(_settings, payload):
        return SlskdSearchResponse(
            search_id="search-123",
            query=payload.query,
            state="Completed",
            is_complete=True,
            response_count=2,
            file_count=4,
            candidates=ranked,
        )

    async def fake_queue(_settings, username, files):
        return SlskdQueueDownloadResponse(
            ok=True, username=username, queued_count=len(files), detail="Queued"
        )

    async def fake_downloads(_settings):
        return SlskdDownloadsResponse(
            active_count=1,
            completed_count=0,
            failed_count=0,
            transfers=[
                SlskdTransferItem(
                    id="tr-1",
                    username="audiophile_peer",
                    filename="FLAC\\Stevie Wonder\\03 - Isn't She Lovely.flac",
                    basename="03 - Isn't She Lovely.flac",
                    size=42_000_000,
                    bytes_transferred=21_000_000,
                    percent_complete=50.0,
                    state="InProgress",
                    average_speed=1_500_000.0,
                )
            ],
        )

    monkeypatch.setattr(slskd_router, "search_slskd", fake_search)
    monkeypatch.setattr(slskd_router, "queue_slskd_downloads", fake_queue)
    monkeypatch.setattr(slskd_router, "list_slskd_downloads", fake_downloads)

    settings = Settings(
        music_dir=music_dir,
        config_dir=config_dir,
        static_dir=None,
        navidrome_url=None,
        navidrome_user=None,
        navidrome_pass=None,
        navidrome_auto_scan=False,
        log_level="warning",
        staging_dir=None,
        slskd_url="http://slskd:5030",
        slskd_api_key="test-key",
    )

    with TestClient(create_app(settings=settings)) as tc:
        health = tc.get("/api/health").json()
        assert health["slskd_configured"] is True
        assert health["staging_configured"] is False

        # Staging preview rejects cleanly when Staging isn't configured
        assert tc.post("/api/staging/preview", json={}).status_code == 400

        search_res = tc.post(
            "/api/slskd/search",
            json={
                "query": "Stevie Wonder Isn't She Lovely",
                "track_title": "Isn't She Lovely",
                "preferred_formats": ["FLAC"],
                "expected_length_ms": 394000,
            },
        )
        assert search_res.status_code == 200
        assert search_res.json()["candidates"][0]["username"] == "audiophile_peer"

        q_res = tc.post(
            "/api/slskd/download",
            json={
                "username": "audiophile_peer",
                "files": [{"filename": ranked[0].filename, "size": ranked[0].size}],
            },
        )
        assert q_res.status_code == 200
        assert q_res.json()["queued_count"] == 1

        dl_res = tc.get("/api/slskd/downloads")
        assert dl_res.status_code == 200
        assert dl_res.json()["active_count"] == 1
        assert dl_res.json()["transfers"][0]["percent_complete"] == 50.0


def test_in_app_integration_settings_and_live_reload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """In-app Settings persist slskd & Navidrome config in SQLite, mask secrets, and take effect immediately without restart."""
    from app.models import NavidromeSyncResult, SlskdStatusResponse
    from app.routers import settings as settings_router

    music_dir = tmp_path / "music"
    config_dir = tmp_path / "config"
    music_dir.mkdir()
    config_dir.mkdir()

    probed_slskd: list[tuple[str | None, str | None]] = []
    probed_nav: list[tuple[str | None, str | None, str | None]] = []

    async def fake_check_slskd(probe_settings):
        probed_slskd.append((probe_settings.slskd_url, probe_settings.slskd_api_key))
        return SlskdStatusResponse(
            configured=True,
            connected=True,
            detail="Connected to slskd (v0.22.0)",
        )

    async def fake_test_navidrome(url, user, password):
        probed_nav.append((url, user, password))
        return NavidromeSyncResult(
            configured=True,
            triggered=False,
            ok=True,
            detail="Connected to Navidrome",
        )

    monkeypatch.setattr(settings_router, "check_slskd_status", fake_check_slskd)
    monkeypatch.setattr(settings_router, "test_navidrome_connection", fake_test_navidrome)

    base_settings = Settings(
        music_dir=music_dir,
        config_dir=config_dir,
        static_dir=None,
        navidrome_url=None,
        navidrome_user=None,
        navidrome_pass=None,
        navidrome_auto_scan=True,
        log_level="warning",
        staging_dir=None,
        slskd_url=None,
        slskd_api_key=None,
    )

    with TestClient(create_app(settings=base_settings)) as tc:
        # Initially unconfigured
        health0 = tc.get("/api/health").json()
        assert health0["slskd_configured"] is False
        assert health0["navidrome_configured"] is False

        cfg0 = tc.get("/api/settings/integrations").json()
        assert cfg0["slskd_enabled"] is False
        assert cfg0["slskd_api_key_set"] is False
        assert cfg0["navidrome_enabled"] is False
        assert cfg0["navidrome_pass_set"] is False

        # Save both slskd and Navidrome in-app — secrets must NOT be echoed back
        put1 = tc.put(
            "/api/settings/integrations",
            json={
                "slskd_enabled": True,
                "slskd_url": "http://gluetun:5030/",
                "slskd_api_key": "super-secret-slskd-key",
                "navidrome_enabled": True,
                "navidrome_url": "http://navidrome:4533/",
                "navidrome_user": "chris",
                "navidrome_pass": "nav-secret-pass",
                "navidrome_auto_scan": True,
            },
        )
        assert put1.status_code == 200
        body1 = put1.json()
        assert body1["slskd_enabled"] is True
        assert body1["slskd_url"] == "http://gluetun:5030"
        assert body1["slskd_api_key_set"] is True
        assert "super-secret-slskd-key" not in put1.text
        assert body1["navidrome_enabled"] is True
        assert body1["navidrome_url"] == "http://navidrome:4533"
        assert body1["navidrome_user"] == "chris"
        assert body1["navidrome_pass_set"] is True
        assert "nav-secret-pass" not in put1.text

        # Immediately active in /api/health with zero container restart
        health1 = tc.get("/api/health").json()
        assert health1["slskd_configured"] is True
        assert health1["navidrome_configured"] is True

        # Partial update changing only slskd_url preserves the saved API key
        put2 = tc.put(
            "/api/settings/integrations",
            json={"slskd_url": "http://slskd-host:5030"},
        )
        assert put2.status_code == 200
        assert put2.json()["slskd_url"] == "http://slskd-host:5030"
        assert put2.json()["slskd_api_key_set"] is True

        # Test connection using saved credentials (omitting api_key/password)
        t_slskd = tc.post("/api/settings/integrations/test-slskd", json={})
        assert t_slskd.status_code == 200
        assert t_slskd.json()["connected"] is True
        assert probed_slskd[-1] == ("http://slskd-host:5030", "super-secret-slskd-key")

        # Test connection with unsaved form overrides
        t_nav = tc.post(
            "/api/settings/integrations/test-navidrome",
            json={"url": "http://alt-nav:4533/", "user": "admin"},
        )
        assert t_nav.status_code == 200
        assert t_nav.json()["ok"] is True
        assert probed_nav[-1] == ("http://alt-nav:4533", "admin", "nav-secret-pass")

        # Disabling slskd immediately disables health flag and rejects /api/slskd/search
        put3 = tc.put("/api/settings/integrations", json={"slskd_enabled": False})
        assert put3.status_code == 200
        assert tc.get("/api/health").json()["slskd_configured"] is False
        assert tc.post("/api/slskd/search", json={"query": "test"}).status_code == 400

        # Clearing API key removes stored secret
        put4 = tc.put(
            "/api/settings/integrations",
            json={"slskd_enabled": True, "clear_slskd_api_key": True},
        )
        assert put4.status_code == 200
        assert put4.json()["slskd_api_key_set"] is False
        assert tc.get("/api/health").json()["slskd_configured"] is False


def test_musicbrainz_non_latin_cjk_title_matching() -> None:
    """Issue #13: Unicode-aware title normalization & track matching for Japanese, Korean, Cyrillic, Greek, and accented Latin."""
    from app.models import MusicBrainzTrackInfo, TrackMetadata
    from app.services.musicbrainz import (
        _normalize_title,
        _title_similarity,
        match_tracks_to_release,
    )

    # 1. Normalization & similarity across scripts
    assert _normalize_title("覇王樹") == "覇王樹"
    assert _normalize_title("晴伝説") == "晴伝説"
    assert _normalize_title("ガチ桜") == "ガチ桜"
    # Full-width vs half-width katakana fold identically via NFKC
    assert _normalize_title("ｶﾗｽ") == _normalize_title("カラス")
    # Hiragana vs Katakana fold cleanly in _title_similarity
    assert _title_similarity("からす", "カラス") >= 0.95
    assert _title_similarity("ｶﾗｽ", "カラス") == 1.0
    # Short CJK containment boost (>=2 chars)
    assert _title_similarity("晴伝説", "晴伝説 〜Original Mix〜") >= 0.85
    # Korean (Hangul), Cyrillic, Greek
    assert _title_similarity("봄날", "봄날 (Spring Day)") >= 0.85
    assert _title_similarity("Группа крови", "Группа крови") == 1.0
    assert _title_similarity("Θάλασσα", "Θαλασσα") == 1.0
    # Accented Latin regression check
    assert _normalize_title("Café del Mar (Remastered)") == "cafe del mar"
    assert _title_similarity("Café", "Cafe") == 1.0

    # 2. Reported Japanese album scenario (湘南乃風):
    # Track 4 "覇王樹" has a large duration difference (4:40 local vs 6:01 MB) -> must still match by title with high confidence!
    # Tracks 5..8 ("晴伝説", "ガチ桜", "親友よ", "カラス") sit at different positions on the MB release (#10, #9, #11, #12)
    # and must all match their true MB tracks by title across the full release tracklist rather than falling back to positional slots #5..#8!
    # And an extra bonus track #99 ("未収録ボーナス曲") not on the release stays unmatched.
    mb_tracks = [
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=4, track_total=12,
            title="覇王樹", length_ms=361000,  # 6:01
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=5, track_total=12,
            title="純恋歌", length_ms=432000,  # 7:12
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=6, track_total=12,
            title="睡蓮花", length_ms=439000,  # 7:19
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=7, track_total=12,
            title="黄金魂", length_ms=335000,  # 5:35
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=8, track_total=12,
            title="恋時雨", length_ms=390000,  # 6:30
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=9, track_total=12,
            title="ガチ桜", length_ms=296000,  # 4:56 — sits at #9 on MB release!
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=10, track_total=12,
            title="晴伝説", length_ms=242000,  # 4:02 — sits at #10 on MB release!
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=11, track_total=12,
            title="親友よ", length_ms=178000,  # 2:58 — sits at #11 on MB release!
        ),
        MusicBrainzTrackInfo(
            disc_number=1, disc_total=1, track_number=12, track_total=12,
            title="カラス", length_ms=166000,  # 2:46 — sits at #12 on MB release!
        ),
    ]

    local_tracks = [
        TrackMetadata(
            path="04.flac", filename="04 覇王樹.flac", format="FLAC",
            track_number="4", title="覇王樹", duration=280.0,  # 4:40
        ),
        TrackMetadata(
            path="05.flac", filename="05 晴伝説.flac", format="FLAC",
            track_number="5", title="晴伝説", duration=242.0,  # 4:02
        ),
        TrackMetadata(
            path="06.flac", filename="06 ガチ桜.flac", format="FLAC",
            track_number="6", title="ガチ桜", duration=296.0,  # 4:56
        ),
        TrackMetadata(
            path="07.flac", filename="07 親友よ.flac", format="FLAC",
            track_number="7", title="親友よ", duration=178.0,  # 2:58
        ),
        TrackMetadata(
            path="08.flac", filename="08 ｶﾗｽ.flac", format="FLAC",
            track_number="8", title="ｶﾗｽ", duration=166.0,  # 2:46 (half-width katakana)
        ),
        TrackMetadata(
            path="99.flac", filename="99 未収録ボーナス曲.flac", format="FLAC",
            track_number="99", title="未収録ボーナス曲", duration=120.0,
        ),
    ]

    matches = match_tracks_to_release(local_tracks, mb_tracks)
    by_path = {m.local_path: m for m in matches}

    # Track 4 "覇王樹" matches MB #4 "覇王樹" with high confidence despite 81s duration diff
    assert by_path["04.flac"].matched is True
    assert by_path["04.flac"].mb_track_number == 4
    assert by_path["04.flac"].mb_title == "覇王樹"
    assert by_path["04.flac"].confidence == "high"

    # Shuffled tracks 5, 6, 7, 8 find their true MB positions (#10, #9, #11, #12) by title
    assert by_path["05.flac"].matched is True
    assert by_path["05.flac"].mb_track_number == 10
    assert by_path["05.flac"].mb_title == "晴伝説"
    assert by_path["05.flac"].confidence == "high"

    assert by_path["06.flac"].matched is True
    assert by_path["06.flac"].mb_track_number == 9
    assert by_path["06.flac"].mb_title == "ガチ桜"
    assert by_path["06.flac"].confidence == "high"

    assert by_path["07.flac"].matched is True
    assert by_path["07.flac"].mb_track_number == 11
    assert by_path["07.flac"].mb_title == "親友よ"
    assert by_path["07.flac"].confidence == "high"

    assert by_path["08.flac"].matched is True
    assert by_path["08.flac"].mb_track_number == 12
    assert by_path["08.flac"].mb_title == "カラス"
    assert by_path["08.flac"].confidence == "high"

    # Bonus track #99 is not on this MB release and stays unmatched
    assert by_path["99.flac"].matched is False
    assert by_path["99.flac"].match_method == "unmatched"
    assert by_path["99.flac"].mb_title is None


def test_slskd_search_cleanup_and_ttl_sweep(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issue #14: delete M⁴-created slskd searches on close/re-search/queue, ignore non-M⁴ searches, tolerate 404, and sweep expired TTL entries."""
    import asyncio
    import httpx
    from app.services import slskd as slskd_service

    music_dir = tmp_path / "music"
    config_dir = tmp_path / "config"
    music_dir.mkdir()
    config_dir.mkdir()

    slskd_service._SEARCH_CONTEXT.clear()
    slskd_service._OWNED_SEARCH_IDS.clear()

    put_calls: list[str] = []
    delete_calls: list[str] = []
    return_404_for: set[str] = set()

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url: str, headers=None, json=None):
            if url.endswith("/api/v0/searches"):
                sid = json.get("id")
                return httpx.Response(
                    200,
                    json={"id": sid, "searchText": json.get("searchText"), "state": "Completed", "isComplete": True},
                    request=httpx.Request("POST", url),
                )
            return httpx.Response(200, json={}, request=httpx.Request("POST", url))

        async def get(self, url: str, headers=None):
            if "/responses" in url:
                return httpx.Response(200, json=[], request=httpx.Request("GET", url))
            if "/api/v0/searches/" in url:
                sid = url.rsplit("/", 1)[-1]
                return httpx.Response(
                    200,
                    json={"id": sid, "state": "Completed", "isComplete": True, "responseCount": 0},
                    request=httpx.Request("GET", url),
                )
            return httpx.Response(200, json=[], request=httpx.Request("GET", url))

        async def put(self, url: str, headers=None):
            sid = url.rsplit("/", 1)[-1]
            put_calls.append(sid)
            return httpx.Response(200, request=httpx.Request("PUT", url))

        async def delete(self, url: str, headers=None, params=None):
            sid = url.rsplit("/", 1)[-1]
            delete_calls.append(sid)
            status = 404 if sid in return_404_for else 200
            return httpx.Response(status, request=httpx.Request("DELETE", url))

    monkeypatch.setattr(slskd_service.httpx, "AsyncClient", FakeAsyncClient)

    settings = Settings(
        music_dir=music_dir,
        config_dir=config_dir,
        static_dir=None,
        navidrome_url=None,
        navidrome_user=None,
        navidrome_pass=None,
        navidrome_auto_scan=False,
        log_level="warning",
        staging_dir=None,
        slskd_url="http://slskd:5030",
        slskd_api_key="test-key",
    )

    with TestClient(create_app(settings=settings)) as tc:
        # 1. Start search 1 (M⁴ records ownership)
        s1 = tc.post("/api/slskd/search", json={"query": "Stevie Wonder", "timeout_sec": 1.0})
        assert s1.status_code == 200
        sid1 = s1.json()["search_id"]
        assert sid1 in slskd_service._OWNED_SEARCH_IDS

        # 2. Frontend calls DELETE /api/slskd/search/{sid1} (e.g. on close / re-search / queue)
        del1 = tc.delete(f"/api/slskd/search/{sid1}")
        assert del1.status_code == 200
        assert del1.json() == {"ok": True, "deleted": True}
        assert sid1 in put_calls
        assert sid1 in delete_calls
        assert sid1 not in slskd_service._OWNED_SEARCH_IDS
        assert sid1 not in slskd_service._SEARCH_CONTEXT

        # 3. Attempting to delete a manual search ID that M⁴ never created is safely ignored
        manual_id = "user-manual-slskd-search-id"
        del_manual = tc.delete(f"/api/slskd/search/{manual_id}")
        assert del_manual.status_code == 200
        assert del_manual.json() == {"ok": True, "deleted": False}
        assert manual_id not in delete_calls

        # 4. 404 from slskd (already deleted) is tolerated as success
        s2 = tc.post("/api/slskd/search", json={"query": "Boards of Canada", "timeout_sec": 1.0})
        sid2 = s2.json()["search_id"]
        return_404_for.add(sid2)
        del2 = tc.delete(f"/api/slskd/search/{sid2}")
        assert del2.status_code == 200
        assert del2.json() == {"ok": True, "deleted": True}
        assert sid2 in delete_calls

        # 5. TTL eviction safety net automatically deletes expired M⁴ searches in slskd
        s3 = tc.post("/api/slskd/search", json={"query": "Daft Punk", "timeout_sec": 1.0})
        sid3 = s3.json()["search_id"]
        old_ts, old_ctx = slskd_service._SEARCH_CONTEXT[sid3]
        slskd_service._SEARCH_CONTEXT[sid3] = (old_ts - slskd_service._SEARCH_CTX_TTL - 10.0, old_ctx)

        evicted = asyncio.run(slskd_service.sweep_expired_slskd_searches(settings))
        assert sid3 in evicted
        assert sid3 in delete_calls
        assert sid3 not in slskd_service._SEARCH_CONTEXT
        assert sid3 not in slskd_service._OWNED_SEARCH_IDS



