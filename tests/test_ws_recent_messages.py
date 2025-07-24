import asyncio
from fastapi.testclient import TestClient
from backend import main


def test_ws_recent_messages_from_db(tmp_path, monkeypatch):
    db_path = tmp_path / "db.sqlite"
    dm = main.DatabaseManager(str(db_path))
    asyncio.run(dm.init_db())

    asyncio.run(dm.upsert_message({
        "wa_message_id": "m1",
        "user_id": "user1",
        "message": "hi",
        "from_me": 0,
        "status": "received",
        "timestamp": "t1",
    }))
    asyncio.run(dm.upsert_message({
        "wa_message_id": "m2",
        "user_id": "user1",
        "message": "hello",
        "from_me": 1,
        "status": "sent",
        "timestamp": "t2",
    }))

    monkeypatch.setattr(main, "DB_PATH", str(db_path))
    main.db_manager = dm
    main.message_processor.db_manager = dm

    async def fake_get_recent_messages(user_id, limit=20):
        return []

    monkeypatch.setattr(main.redis_manager, "get_recent_messages", fake_get_recent_messages)

    with TestClient(main.app) as client:
        with client.websocket_connect("/ws/user1") as ws:
            data = ws.receive_json()
            assert data["type"] == "recent_messages"
            ids = {m["wa_message_id"] for m in data["data"]}
            assert ids == {"m1", "m2"}

