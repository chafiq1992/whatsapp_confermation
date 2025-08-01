import asyncio
import os
import json
from pathlib import Path
import mimetypes
try:
    from google.cloud import storage
except Exception:  # pragma: no cover - library may be missing in tests
    storage = None
from google.oauth2 import service_account

GCS_BUCKET_NAME = os.getenv("GCS_BUCKET_NAME")
GCS_CREDENTIALS_FILE = os.getenv("GCS_CREDENTIALS_FILE")
GCS_CREDENTIALS_JSON = os.getenv("GCS_CREDENTIALS_JSON")


def _get_client():
    creds_file = os.getenv("GCS_CREDENTIALS_FILE", GCS_CREDENTIALS_FILE)
    creds_json = os.getenv("GCS_CREDENTIALS_JSON", GCS_CREDENTIALS_JSON)
    credentials = None

    if creds_file and Path(creds_file).exists():
        credentials = service_account.Credentials.from_service_account_file(creds_file)
    elif creds_json:
        creds_info = json.loads(creds_json)
        credentials = service_account.Credentials.from_service_account_info(creds_info)

    if storage is None:
        raise RuntimeError("google-cloud-storage library not installed")
    return storage.Client(credentials=credentials)


def _upload_sync(file_path: str) -> str:
    bucket_name = os.getenv("GCS_BUCKET_NAME", GCS_BUCKET_NAME)
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME is not set")

    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(Path(file_path).name)

    content_type, _ = mimetypes.guess_type(file_path)
    blob.upload_from_filename(file_path, content_type=content_type)
    blob.make_public()

    return blob.public_url


async def upload_file_to_gcs(file_path: str) -> str:
    """Upload a file to Google Cloud Storage and return a public URL."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _upload_sync, file_path)
