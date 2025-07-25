from fastapi.testclient import TestClient
from backend import main


def test_send_media_uses_s3_endpoint(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(main, "MEDIA_BUCKET", "testbucket")
    monkeypatch.setattr(main, "S3_ENDPOINT_URL", "https://endpoint.test")

    class DummyS3:
        def upload_file(self, src, bucket, key):
            self.src = src
            self.bucket = bucket
            self.key = key

    dummy = DummyS3()
    monkeypatch.setattr(main.boto3, "client", lambda *a, **k: dummy)

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
    expected_url = f"https://endpoint.test/testbucket/{result['filename']}"
    assert result["media_url"] == expected_url


def test_send_media_save_error(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(main, "MEDIA_BUCKET", None)

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
    monkeypatch.setattr(main, "MEDIA_BUCKET", None)

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
