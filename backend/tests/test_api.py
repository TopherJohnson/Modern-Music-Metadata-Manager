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

