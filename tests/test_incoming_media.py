import asyncio
import pytest
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
        return b"data"

    async def fake_upload(path):
        return None

    monkeypatch.setattr(mp.whatsapp_messenger, "download_media", fake_download, raising=False)
    monkeypatch.setattr(main, "upload_file_to_gcs", fake_upload, raising=False)

    with pytest.raises(RuntimeError):
        asyncio.run(mp._download_media("mid", "image"))
