from backend import main


def test_second_page_pagination(db_manager, client, insert_messages):
    # Insert 120 messages and fetch the second page (messages 21-70)
    insert_messages(db_manager, "user1", 120)

    res = client.get("/messages/user1?offset=50&limit=50")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 50

    # Ensure chronological order
    timestamps = [m["timestamp"] for m in data]
    assert timestamps == sorted(timestamps)

    expected_messages = [f"msg {i}" for i in range(21, 71)]
    assert [m["message"] for m in data] == expected_messages


def test_new_message_persisted_and_paginated(db_manager, client, insert_messages, monkeypatch):
    # Insert initial 100 messages
    insert_messages(db_manager, "user1", 100)

    # Stub message processing to immediately store message
    async def fake_process(message_data):
        await db_manager.upsert_message({
            "wa_message_id": "wa_101",
            "user_id": message_data["user_id"],
            "message": message_data["message"],
            "type": message_data.get("type", "text"),
            "from_me": 1,
            "status": "sent",
            "timestamp": message_data["timestamp"],
        })
        return {**message_data, "wa_message_id": "wa_101"}

    async def fake_get_recent_messages(*args, **kwargs):
        return []

    monkeypatch.setattr(main.message_processor, "process_outgoing_message", fake_process)
    monkeypatch.setattr(main.redis_manager, "get_recent_messages", fake_get_recent_messages)

    # Send a new message
    resp = client.post("/send-message", json={"user_id": "user1", "message": "msg 101"})
    assert resp.status_code == 200

    # Fetch first page - should include the new message as the most recent
    res1 = client.get("/messages/user1?offset=0&limit=50")
    assert res1.status_code == 200
    data1 = res1.json()
    assert len(data1) == 50
    expected_first_page = [f"msg {i}" for i in range(52, 102)]
    assert [m["message"] for m in data1] == expected_first_page

    # Fetch second page - should reflect shifted window
    res2 = client.get("/messages/user1?offset=50&limit=50")
    assert res2.status_code == 200
    data2 = res2.json()
    expected_second_page = [f"msg {i}" for i in range(2, 52)]
    assert [m["message"] for m in data2] == expected_second_page
