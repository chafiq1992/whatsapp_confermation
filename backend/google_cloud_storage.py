import asyncio
import os
import json
from pathlib import Path
import mimetypes
from functools import partial
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


def _upload_sync(file_path: str, content_type: str | None = None, bucket_name: str | None = None) -> str:
    # Allow callers to explicitly choose a bucket; otherwise fall back to default
    bucket_name = bucket_name or os.getenv("GCS_BUCKET_NAME", GCS_BUCKET_NAME)
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME is not set")

    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(Path(file_path).name)

    if content_type is None:
        content_type, _ = mimetypes.guess_type(file_path)
        if content_type is None and file_path.lower().endswith('.ogg'):
            content_type = 'audio/ogg'
    blob.upload_from_filename(file_path, content_type=content_type)
    blob.make_public()

    return blob.public_url


async def upload_file_to_gcs(file_path: str, content_type: str | None = None, bucket_name: str | None = None) -> str:
    """Upload a file to Google Cloud Storage and return a public URL.

    If ``bucket_name`` is provided, the file will be uploaded to that bucket;
    otherwise the default ``GCS_BUCKET_NAME`` will be used.
    """
    loop = asyncio.get_event_loop()
    func = partial(_upload_sync, file_path, content_type, bucket_name)
    return await loop.run_in_executor(None, func)


def _download_sync(blob_name: str, destination: str) -> None:
    bucket_name = os.getenv("GCS_BUCKET_NAME", GCS_BUCKET_NAME)
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME is not set")

    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    blob.download_to_filename(destination)


def download_file_from_gcs(blob_name: str, destination: str) -> None:
    """Download a file from Google Cloud Storage to a local destination."""
    _download_sync(blob_name, destination)


async def download_file_from_gcs_async(blob_name: str, destination: str) -> None:
    """Asynchronously download a file from Google Cloud Storage."""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _download_sync, blob_name, destination)


# ---------------- Signed URL helpers ----------------
def _parse_gcs_url(url: str) -> tuple[str | None, str | None]:
    """Parse a GCS URL into (bucket, blob). Supports:
    - https://storage.googleapis.com/<bucket>/<object>
    - https://<bucket>.storage.googleapis.com/<object>
    - gs://<bucket>/<object>
    Returns (None, None) if not a recognizable GCS URL.
    """
    try:
        if not url:
            return None, None
        lower = url.lower()
        if lower.startswith("gs://"):
            rest = url[5:]
            if "/" in rest:
                bucket, blob = rest.split("/", 1)
                return bucket, blob
            return rest, None
        if "storage.googleapis.com" in lower:
            # form 1: https://storage.googleapis.com/<bucket>/<object>
            # form 2: https://<bucket>.storage.googleapis.com/<object>
            from urllib.parse import urlparse
            p = urlparse(url)
            host = p.netloc
            path = p.path.lstrip("/")
            if host == "storage.googleapis.com":
                if "/" in path:
                    bucket, blob = path.split("/", 1)
                    return bucket, blob
                return path, None
            elif host.endswith(".storage.googleapis.com"):
                bucket = host.split(".storage.googleapis.com", 1)[0]
                return bucket, path
        return None, None
    except Exception:
        return None, None


def generate_v4_signed_url(
    bucket_name: str,
    blob_name: str,
    method: str = "GET",
    expires_seconds: int = 600,
    response_content_type: str | None = None,
    response_disposition: str | None = None,
) -> str:
    """Generate a V4 signed URL for a GCS object.

    Requires service account credentials (from file or JSON in env).
    """
    if storage is None:
        raise RuntimeError("google-cloud-storage library not installed")

    client = _get_client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(blob_name)

    params = {}
    if response_content_type:
        params["response-content-type"] = response_content_type
    if response_disposition:
        params["response-content-disposition"] = response_disposition

    url = blob.generate_signed_url(
        version="v4",
        expiration=expires_seconds,
        method=method,
        virtual_hosted_style=False,
        include_google_signing=True,
        query_parameters=params or None,
    )
    return url


def maybe_signed_url_for(url: str, ttl_seconds: int = 600) -> str | None:
    """If the URL points to a GCS object, return a V4 signed URL; otherwise None.

    If the URL doesn't include a bucket (e.g., local file), uses default bucket.
    """
    try:
        bucket, blob = _parse_gcs_url(url)
        # If it's our default bucket and URL is just object name
        if (not bucket) and blob is None and url and not url.startswith("http"):
            bucket = os.getenv("GCS_BUCKET_NAME", GCS_BUCKET_NAME)
            blob = url
        if bucket and blob:
            return generate_v4_signed_url(bucket, blob, expires_seconds=ttl_seconds)
        return None
    except Exception:
        return None