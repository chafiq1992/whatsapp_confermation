import asyncio
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from backend import main


def test_handle_incoming_message_uses_gcs_url(monkeypatch):
    captured = {}

    async def fake_download_media(self, media_id, media_type):
        return "local/file.jpg", "https://storage.test/file.jpg"

    async def fake_send_to_user(user_id, message):
        captured['message'] = message

    async def fake_broadcast(*args, **kwargs):
        return None

    async def fake_upsert_user(*a, **k):
        return None

    async def fake_cache(*a, **k):
        return None

    async def fake_upsert_message(*a, **k):
        return None

    monkeypatch.setattr(main.MessageProcessor, "_download_media", fake_download_media, raising=False)
    monkeypatch.setattr(main.connection_manager, "send_to_user", fake_send_to_user, raising=False)
    monkeypatch.setattr(main.connection_manager, "broadcast_to_admins", fake_broadcast, raising=False)
    monkeypatch.setattr(main.db_manager, "upsert_user", fake_upsert_user, raising=False)
    monkeypatch.setattr(main.redis_manager, "cache_message", fake_cache, raising=False)
    monkeypatch.setattr(main.db_manager, "upsert_message", fake_upsert_message, raising=False)

    message = {
        "from": "u1",
        "type": "image",
        "id": "msg1",
        "timestamp": "0",
        "image": {"id": "m1", "caption": "hi"},
    }

    asyncio.run(main.message_processor._handle_incoming_message(message))

    assert captured['message']['data']['url'] == "https://storage.test/file.jpg"


def test_download_media_raises_on_gcs_failure(tmp_path, monkeypatch):
    mp = main.message_processor
    mp.media_dir = tmp_path

    async def fake_download(media_id):
        return b"data", "image/jpeg"

    async def fake_upload(path, content_type=None):
        return None

    monkeypatch.setattr(mp.whatsapp_messenger, "download_media", fake_download, raising=False)
    monkeypatch.setattr(main, "upload_file_to_gcs", fake_upload, raising=False)

    with pytest.raises(RuntimeError):
        asyncio.run(mp._download_media("mid", "image"))


def test_download_media_returns_relative_path(tmp_path, monkeypatch):
    mp = main.message_processor
    mp.media_dir = tmp_path

    async def fake_download(media_id):
        return b"data", "audio/ogg"

    async def fake_upload(path, content_type=None):
        return f"https://storage.test/{Path(path).name}"

    monkeypatch.setattr(mp.whatsapp_messenger, "download_media", fake_download, raising=False)
    monkeypatch.setattr(main, "upload_file_to_gcs", fake_upload, raising=False)

    relative_path, drive_url = asyncio.run(mp._download_media("mid123", "audio"))
    assert relative_path.startswith("/media/")
    assert "mid123"[:8] in relative_path
    assert drive_url.startswith("https://storage.test/")


def test_messages_endpoint_includes_audio_url(tmp_path, monkeypatch):
    db_path = tmp_path / "db.sqlite"
    dm = main.DatabaseManager(str(db_path))
    asyncio.run(dm.init_db())

    # point application to temp database
    main.db_manager = dm
    main.message_processor.db_manager = dm

    # stub out external dependencies
    async def fake_cache(*args, **kwargs):
        return None

    async def fake_get_recent_messages(*args, **kwargs):
        return []

    async def fake_send_to_user(*args, **kwargs):
        return None

    async def fake_broadcast(*args, **kwargs):
        return None

    async def fake_download_media(self, media_id, media_type):
        return "/media/audio.ogg", "https://storage.test/audio.ogg"

    monkeypatch.setattr(main.redis_manager, "cache_message", fake_cache, raising=False)
    monkeypatch.setattr(main.redis_manager, "get_recent_messages", fake_get_recent_messages, raising=False)
    monkeypatch.setattr(main.connection_manager, "send_to_user", fake_send_to_user, raising=False)
    monkeypatch.setattr(main.connection_manager, "broadcast_to_admins", fake_broadcast, raising=False)
    monkeypatch.setattr(main.MessageProcessor, "_download_media", fake_download_media, raising=False)

    message = {
        "from": "user1",
        "type": "audio",
        "id": "msg1",
        "timestamp": "0",
        "audio": {"id": "m1"},
    }

    asyncio.run(main.message_processor._handle_incoming_message(message))

    with TestClient(main.app) as client:
        res = client.get("/messages/user1")
        assert res.status_code == 200
        data = res.json()
        assert len(data) == 1
        assert data[0]["url"] == "https://storage.test/audio.ogg"
