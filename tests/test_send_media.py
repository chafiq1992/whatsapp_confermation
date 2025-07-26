from fastapi.testclient import TestClient
from pathlib import Path
from backend import main
from backend import google_drive
import json


def test_send_media_returns_drive_url(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    async def fake_upload(path: str):
        return f"https://drive.test/{Path(path).name}"

    monkeypatch.setattr(main, "upload_file_to_drive", fake_upload)

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
    expected_url = f"https://drive.test/{result['filename']}"
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


def test_drive_json_credentials(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    monkeypatch.setenv("GOOGLE_DRIVE_CREDENTIALS_FILE", str(tmp_path / "missing.json"))
    monkeypatch.setenv("GOOGLE_DRIVE_CREDENTIALS_JSON", json.dumps({"foo": "bar"}))

    captured = {}

    def fake_from_info(info, scopes=None):
        captured["info"] = info
        return "creds"

    monkeypatch.setattr(google_drive.service_account.Credentials, "from_service_account_info", fake_from_info)

    class DummyFiles:
        def create(self, body=None, media_body=None, fields=None):
            captured["body"] = body
            return self

        def execute(self):
            return {"id": "abc"}

    class DummyPermissions:
        def create(self, fileId=None, body=None):
            captured["perm"] = (fileId, body)
            return self

        def execute(self):
            pass

    class DummyService:
        def files(self):
            return DummyFiles()

        def permissions(self):
            return DummyPermissions()

    def fake_build(*args, **kwargs):
        captured["build"] = True
        return DummyService()

    monkeypatch.setattr(google_drive, "build", fake_build)
    monkeypatch.setattr(google_drive, "MediaFileUpload", lambda *a, **k: None)

    file_path = tmp_path / "x.txt"
    file_path.write_text("data")

    url = google_drive._upload_sync(str(file_path))

    assert url == "https://drive.google.com/uc?export=download&id=abc"
    assert captured["info"]["foo"] == "bar"
    assert captured["build"]

