import asyncio
import logging
import os
from pathlib import Path

from .main import DatabaseManager
from .google_cloud_storage import _get_client, GCS_BUCKET_NAME, upload_file_to_gcs

logger = logging.getLogger(__name__)


async def migrate_audio_urls() -> None:
    """Ensure audio messages have a public GCS URL.

    For each message of type 'audio' where ``url`` is NULL, reconstruct the
    expected GCS object name from ``media_path``. If the object does not exist in
    the bucket, attempt to upload the local file. Finally, update the ``url``
    column with the public URL.
    """
    db = DatabaseManager()
    bucket_name = os.getenv("GCS_BUCKET_NAME", GCS_BUCKET_NAME)
    if not bucket_name:
        logger.error("GCS_BUCKET_NAME is not configured")
        return

    client = _get_client()
    bucket = client.bucket(bucket_name)

    async with db._conn() as conn:
        query = "SELECT id, media_path FROM messages WHERE type='audio' AND url IS NULL"
        cursor = await conn.execute(query)
        rows = await cursor.fetchall()

        for row in rows:
            msg_id = row["id"]
            media_path = row["media_path"]
            if not media_path:
                logger.warning("Message %s missing media_path", msg_id)
                continue

            object_name = Path(media_path).name
            blob = bucket.blob(object_name)
            url: str | None = None

            try:
                if blob.exists():
                    blob.make_public()
                    url = blob.public_url
                elif Path(media_path).exists():
                    url = await upload_file_to_gcs(media_path)
                else:
                    logger.warning("File not found for message %s: %s", msg_id, media_path)
                    continue
            except Exception as exc:  # noqa: BLE001 - want to log any failure
                logger.error("Failed processing %s: %s", media_path, exc)
                continue

            if url:
                await conn.execute("UPDATE messages SET url=? WHERE id=?", (url, msg_id))

        if not db.use_postgres:
            await conn.commit()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(migrate_audio_urls())
