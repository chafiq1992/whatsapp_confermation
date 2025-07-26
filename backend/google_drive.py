import asyncio
import os
from pathlib import Path
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

GOOGLE_DRIVE_FOLDER_ID = os.getenv("GOOGLE_DRIVE_FOLDER_ID")
GOOGLE_DRIVE_CREDENTIALS_FILE = os.getenv("GOOGLE_DRIVE_CREDENTIALS_FILE")

_SCOPES = ["https://www.googleapis.com/auth/drive"]


def _get_service():
    if not GOOGLE_DRIVE_CREDENTIALS_FILE:
        raise RuntimeError("GOOGLE_DRIVE_CREDENTIALS_FILE is not set")
    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_DRIVE_CREDENTIALS_FILE, scopes=_SCOPES
    )
    return build("drive", "v3", credentials=creds)


def _upload_sync(file_path: str) -> str:
    service = _get_service()
    metadata = {"name": Path(file_path).name}
    if GOOGLE_DRIVE_FOLDER_ID:
        metadata["parents"] = [GOOGLE_DRIVE_FOLDER_ID]
    media = MediaFileUpload(file_path, resumable=False)
    file = (
        service.files()
        .create(body=metadata, media_body=media, fields="id")
        .execute()
    )
    file_id = file.get("id")
    service.permissions().create(
        fileId=file_id, body={"role": "reader", "type": "anyone"}
    ).execute()
    return f"https://drive.google.com/uc?id={file_id}"


async def upload_file_to_drive(file_path: str) -> str:
    """Upload a file to Google Drive and return a public URL."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _upload_sync, file_path)
