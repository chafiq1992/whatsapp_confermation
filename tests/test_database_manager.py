import asyncio
import os
import pytest
from backend.main import DatabaseManager
import aiosqlite

@pytest.mark.asyncio
async def test_upsert_message_filters_unknown_keys(tmp_path):
    db_path = tmp_path / "db.sqlite"
    dm = DatabaseManager(db_path=str(db_path))
    await dm.init_db()
    await dm.upsert_message({
        "wa_message_id": "x1",
        "user_id": "user",
        "message": "hello",
        "from_me": 0,
        "status": "received",
        "timestamp": "t",
        "url": "http://bad",  # unknown column should be ignored
    })
    msgs = await dm.get_messages("user")
    assert len(msgs) == 1
    msg = msgs[0]
    assert msg["wa_message_id"] == "x1"
    assert "url" not in msg


@pytest.mark.asyncio
async def test_init_db_creates_indexes(tmp_path):
    db_path = tmp_path / "db.sqlite"
    dm = DatabaseManager(db_path=str(db_path))
    await dm.init_db()

    async with aiosqlite.connect(str(db_path)) as db:
        cur = await db.execute("PRAGMA index_list(messages)")
        indexes = [row[1] for row in await cur.fetchall()]

    assert "idx_msg_wa_id" in indexes
    assert "idx_msg_temp_id" in indexes
