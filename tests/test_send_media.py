from fastapi.testclient import TestClient
from pathlib import Path
import asyncio
import pytest
from backend import main
from backend import google_cloud_storage
import json


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_send_media_returns_gcs_url(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    async def fake_upload(path: str, content_type=None):
        return f"https://storage.test/{Path(path).name}"

    monkeypatch.setattr(main, "upload_file_to_gcs", fake_upload)

    captured = {}

    async def fake_process(data):
        captured.update(data)
        return data

    monkeypatch.setattr(main.message_processor, "process_outgoing_message", fake_process)

    with TestClient(main.app) as client:
        resp = client.post(
            "/send-media",
            data={"user_id": "u1", "media_type": "image", "caption": "", "price": ""},
            files={"files": ("x.jpg", b"data", "image/jpeg")},
        )

    assert resp.status_code == 200
    result = resp.json()["messages"][0]
    expected_url = f"https://storage.test/{result['filename']}"
    assert result["media_url"] == expected_url
    assert captured["message"] == expected_url


def test_send_media_uses_remote_url_for_message(tmp_path, monkeypatch):
    """Audio uploads should send the GCS URL in the message payload."""
    monkeypatch.chdir(tmp_path)

    async def fake_upload(path: str, content_type=None):
        return f"https://storage.test/{Path(path).name}"

    captured = {}

    async def fake_process(data):
        captured.update(data)
        return {"ok": True}

    monkeypatch.setattr(main, "upload_file_to_gcs", fake_upload)
    monkeypatch.setattr(main.message_processor, "process_outgoing_message", fake_process)

    with TestClient(main.app) as client:
        resp = client.post(
            "/send-media",
            data={"user_id": "u1", "media_type": "audio", "caption": "", "price": ""},
            files={"files": ("x.ogg", b"sounddata", "audio/ogg")},
        )

        assert resp.status_code == 200
        filename = resp.json()["messages"][0]["filename"]
        expected_url = f"https://storage.test/{filename}"

        # The message passed to the processor should be the remote URL
        assert captured["message"] == expected_url
        assert captured["url"] == expected_url


def test_send_media_save_error(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    async def fake_open(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(main.aiofiles, "open", fake_open)

    async def fake_process(data):
        return {"ok": True}

    monkeypatch.setattr(main.message_processor, "process_outgoing_message", fake_process)

    with TestClient(main.app) as client:
        resp = client.post(
            "/send-media",
            data={"user_id": "u1", "media_type": "image", "caption": "", "price": ""},
            files={"files": ("x.jpg", b"data", "image/jpeg")},
        )

    assert resp.status_code == 500
    assert "Failed to save file" in resp.json()["detail"]


def test_send_media_conversion_error(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    async def fake_convert(path):
        raise RuntimeError("bad format")

    monkeypatch.setattr(main, "convert_webm_to_ogg", fake_convert)

    async def fake_process(data):
        return {"ok": True}

    monkeypatch.setattr(main.message_processor, "process_outgoing_message", fake_process)

    with TestClient(main.app) as client:
        resp = client.post(
            "/send-media",
            data={"user_id": "u1", "media_type": "audio", "caption": "", "price": ""},
            files={"files": ("x.webm", b"data", "audio/webm")},
        )

    assert resp.status_code == 500
    assert "Audio conversion failed" in resp.json()["detail"]


def test_gcs_json_credentials(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    monkeypatch.setenv("GCS_CREDENTIALS_FILE", str(tmp_path / "missing.json"))
    monkeypatch.setenv("GCS_CREDENTIALS_JSON", json.dumps({"foo": "bar"}))

    captured = {}

    def fake_from_info(info):
        captured["info"] = info
        return "creds"

    monkeypatch.setattr(
        google_cloud_storage.service_account.Credentials,
        "from_service_account_info",
        fake_from_info,
    )

    class DummyBlob:
        public_url = "https://storage.googleapis.com/bucket/x.txt"

        def upload_from_filename(self, filename, content_type=None):
            captured["uploaded"] = filename

        def make_public(self):
            captured["public"] = True

    class DummyBucket:
        def blob(self, name):
            captured["blob_name"] = name
            return DummyBlob()

    class DummyClient:
        def bucket(self, name):
            captured["bucket"] = name
            return DummyBucket()

    monkeypatch.setattr(
        google_cloud_storage,
        "storage",
        type("DummyStorage", (), {"Client": lambda *a, **k: DummyClient()}),
    )

    monkeypatch.setenv("GCS_BUCKET_NAME", "bucket")

    file_path = tmp_path / "x.txt"
    file_path.write_text("data")

    url = google_cloud_storage._upload_sync(str(file_path))

    assert url == "https://storage.googleapis.com/bucket/x.txt"
    assert captured["info"]["foo"] == "bar"
    assert captured["bucket"] == "bucket"
    assert captured["blob_name"] == "x.txt"
    assert captured["public"]


def test_upload_sync_sets_audio_ogg(tmp_path, monkeypatch):
    monkeypatch.setenv("GCS_BUCKET_NAME", "bucket")

    file_path = tmp_path / "sound.ogg"
    file_path.write_text("data")

    captured = {}

    class DummyBlob:
        public_url = "https://storage.googleapis.com/bucket/sound.ogg"

        def upload_from_filename(self, filename, content_type=None):
            captured["content_type"] = content_type

        def make_public(self):
            pass

    class DummyBucket:
        def blob(self, name):
            return DummyBlob()

    class DummyClient:
        def bucket(self, name):
            return DummyBucket()

    monkeypatch.setattr(google_cloud_storage, "_get_client", lambda: DummyClient())
    monkeypatch.setattr(google_cloud_storage.mimetypes, "guess_type", lambda path: (None, None))

    url = google_cloud_storage._upload_sync(str(file_path))

    assert url == DummyBlob.public_url
    assert captured["content_type"] == "audio/ogg"


@pytest.mark.anyio("asyncio")
async def test_process_outgoing_message_audio_fallback_url(db_manager, monkeypatch, tmp_path):
    """Audio messages fallback to /media URLs when no remote URL is ready."""

    monkeypatch.setattr(main, "BASE_URL", "https://chat.example")

    sent_payloads = []

    async def fake_send_to_user(user_id, payload):
        sent_payloads.append(payload)

    async def fake_cache_message(user_id, message):
        return None

    async def fake_send_bg(message):
        return None

    monkeypatch.setattr(main.connection_manager, "send_to_user", fake_send_to_user)
    monkeypatch.setattr(main.redis_manager, "cache_message", fake_cache_message)
    monkeypatch.setattr(main.message_processor, "_send_to_whatsapp_bg", fake_send_bg)

    media_file = tmp_path / "clip.ogg"
    media_file.write_bytes(b"audio")

    message_data = {
        "user_id": "user123",
        "message": str(media_file),
        "url": str(media_file),
        "type": "audio",
        "from_me": True,
        "caption": "",
        "price": "",
        "media_path": str(media_file),
    }

    optimistic = await main.message_processor.process_outgoing_message(message_data)
    await asyncio.sleep(0)

    expected_url = f"https://chat.example/media/{media_file.name}"

    assert optimistic["url"] == expected_url
    assert any(
        payload.get("data", {}).get("url") == expected_url
        for payload in sent_payloads
        if payload.get("type") == "message_sent"
    )


def test_send_to_whatsapp_prefers_upload(tmp_path, monkeypatch):
    file_path = tmp_path / "sound.ogg"
    file_path.write_bytes(b"oggdata")

    message = {
        "temp_id": "t1",
        "user_id": "u1",
        "type": "audio",
        "media_path": str(file_path),
        "url": "https://example.com/sound.ogg",
        "caption": "",
        "message": str(file_path),
    }

    captured = {}

    async def fake_upload(path, media_type):
        captured["uploaded"] = path
        return "id123"

    async def fake_send(to, media_type, media_id, caption):
        captured["sent"] = media_id
        return {"messages": [{"id": "wa123"}]}

    async def fake_send_to_user(user_id, msg):
        pass

    async def fake_save_message(msg, wa_id, status):
        pass

    monkeypatch.setattr(main.message_processor, "_upload_media_to_whatsapp", fake_upload)
    monkeypatch.setattr(main.message_processor.whatsapp_messenger, "send_media_message", fake_send)
    monkeypatch.setattr(main.message_processor.connection_manager, "send_to_user", fake_send_to_user)
    monkeypatch.setattr(main.message_processor.db_manager, "save_message", fake_save_message)

    async def run():
        await main.message_processor._send_to_whatsapp_bg(message)

    asyncio.run(run())

    assert captured["uploaded"] == str(file_path)
    assert captured["sent"] == "id123"

