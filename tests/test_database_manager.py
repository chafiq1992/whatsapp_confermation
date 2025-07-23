import asyncio
import os
import pytest
from backend.main import DatabaseManager

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
