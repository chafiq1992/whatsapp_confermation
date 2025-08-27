from fastapi.testclient import TestClient
from pathlib import Path
from backend import main
from backend import google_cloud_storage
import json


def test_send_media_returns_gcs_url(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    async def fake_upload(path: str, content_type=None):
        return f"https://storage.test/{Path(path).name}"

    monkeypatch.setattr(main, "upload_file_to_gcs", fake_upload)

    async def fake_process(data):
        return {"ok": True}

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

