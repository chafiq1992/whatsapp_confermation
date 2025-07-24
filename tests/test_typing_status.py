import asyncio
import types
import pytest
from backend import main


class DummyWebSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, data):
        self.sent.append(data)


@pytest.mark.asyncio
async def test_typing_broadcast(monkeypatch):
    captured = {}

    async def fake_broadcast(message, exclude_user=None):
        captured["message"] = message
        captured["exclude_user"] = exclude_user

    monkeypatch.setattr(main.connection_manager, "broadcast_to_admins", fake_broadcast)

    ws_sender = DummyWebSocket()
    # Register another websocket for same user to verify local broadcast
    ws_other = DummyWebSocket()
    main.connection_manager.active_connections["user1"] = {ws_sender, ws_other}

    await main.handle_websocket_message(
        ws_sender, "user1", {"type": "typing", "is_typing": True}
    )

    assert captured["message"] == {
        "type": "typing",
        "data": {"user_id": "user1", "is_typing": True},
    }
    assert captured["exclude_user"] == "user1"
    # ws_other should have received the typing event
    assert ws_other.sent == [captured["message"]]

    # Cleanup
    main.connection_manager.active_connections.clear()
