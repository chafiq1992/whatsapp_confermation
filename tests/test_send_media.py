from fastapi.testclient import TestClient
from pathlib import Path
from backend import main


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
