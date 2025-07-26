import asyncio
import os
import json
from pathlib import Path
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

GOOGLE_DRIVE_FOLDER_ID = os.getenv("GOOGLE_DRIVE_FOLDER_ID")
GOOGLE_DRIVE_CREDENTIALS_FILE = os.getenv("GOOGLE_DRIVE_CREDENTIALS_FILE")
GOOGLE_DRIVE_CREDENTIALS_JSON = os.getenv("GOOGLE_DRIVE_CREDENTIALS_JSON")

_SCOPES = ["https://www.googleapis.com/auth/drive"]


def _get_service():
    creds_file = os.getenv("GOOGLE_DRIVE_CREDENTIALS_FILE", GOOGLE_DRIVE_CREDENTIALS_FILE)
    creds_json = os.getenv("GOOGLE_DRIVE_CREDENTIALS_JSON", GOOGLE_DRIVE_CREDENTIALS_JSON)

    if creds_file and Path(creds_file).exists():
        creds = service_account.Credentials.from_service_account_file(
            creds_file, scopes=_SCOPES
        )
    elif creds_json:
        creds_info = json.loads(creds_json)
        creds = service_account.Credentials.from_service_account_info(
            creds_info, scopes=_SCOPES
        )
    else:
        raise RuntimeError("Google Drive credentials not provided")

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
