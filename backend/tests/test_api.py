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
    assert by_path[paths[0]]["match_method"] == "disc_track"
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
    """Verify title similarity, pure duration fallback, and multi-disc disambiguation."""
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
        # Disc 2 Track 1 with explicit disc tag
        TrackMetadata(
            path="d2t1.flac", filename="d2t1.flac", format="FLAC",
            disc_number="2/2", track_number="1/1", title="Encore", duration=311.5,
        ),
        # No track number at all -> matched by title + duration
        TrackMetadata(
            path="midnight.flac", filename="midnight.flac", format="FLAC",
            title="Midnight Express (Remastered)", duration=246.0,
        ),
        # Untitled & unnumbered -> matched unambiguously by duration (180s)
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








