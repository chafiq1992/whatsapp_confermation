from collections import defaultdict
from typing import Dict, Set
from fastapi import WebSocket
from datetime import datetime

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, Set[WebSocket]] = defaultdict(set)
        self.connection_metadata: Dict[WebSocket, dict] = {}

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.active_connections[user_id].add(websocket)
        self.connection_metadata[websocket] = {
            "user_id": user_id,
            "connected_at": datetime.utcnow()
        }

    def disconnect(self, websocket: WebSocket):
        user_id = self.connection_metadata.get(websocket, {}).get("user_id")
        if user_id:
            self.active_connections[user_id].discard(websocket)
            if not self.active_connections[user_id]:
                del self.active_connections[user_id]
        self.connection_metadata.pop(websocket, None)

    async def broadcast(self, user_id: str, message: dict):
        connections = self.active_connections.get(user_id, set())
        for ws in connections:
            try:
                await ws.send_json(message)
            except Exception as e:
                print("❌ Broadcast failed:", e)

# ✅ Add this at the end of the file:
connection_manager = ConnectionManager()
