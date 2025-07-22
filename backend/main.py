import asyncio
import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Set
from collections import defaultdict
import os
import aiosqlite
import aiofiles
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, Request, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import httpx
import redis.asyncio as redis
from fastapi.responses import PlainTextResponse
from .shopify_integration import router as shopify_router
from dotenv import load_dotenv
import asyncio, subprocess, os
from pathlib import Path

from fastapi.staticfiles import StaticFiles

# ── Cloud‑Run helpers ────────────────────────────────────────────
PORT = int(os.getenv("PORT", "8080"))
BASE_URL = os.getenv("BASE_URL", f"http://localhost:{PORT}")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
DB_PATH = os.getenv("DB_PATH", "/tmp/whatsapp_messages.db")
# Anything that **must not** be baked in the image (tokens, IDs …) is
# already picked up with os.getenv() further below. Keep it that way.

# Load environment variables
load_dotenv()

# Configuration
class Config:
    PHONE_NUMBER_ID = "639720275894706"
    CATALOG_ID = "581487491181000"
    VERIFY_TOKEN = "chafiq"
    CATALOG_CACHE_FILE = "catalog_cache.json"
    UPLOADS_DIR = "uploads"
    WHATSAPP_API_VERSION = "v19.0"
    MAX_CATALOG_ITEMS = 30
    RATE_LIMIT_DELAY = 0.6

config = Config()
# Get environment variables
VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "chafiq")
ACCESS_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "your_access_token_here")
PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "your_phone_number_id")
CATALOG_ID = os.getenv("CATALOG_ID", "CATALOGID")
META_ACCESS_TOKEN = os.getenv("META_ACCESS_TOKEN", ACCESS_TOKEN)

print(f"🔧 Configuration loaded:")
print(f"   VERIFY_TOKEN: {VERIFY_TOKEN}")
print(f"   ACCESS_TOKEN: {ACCESS_TOKEN[:20]}..." if len(ACCESS_TOKEN) > 20 else f"   ACCESS_TOKEN: {ACCESS_TOKEN}")
print(f"   PHONE_NUMBER_ID: {PHONE_NUMBER_ID}")

def chunk_list(items: List[str], size: int):
    """Yield successive chunks from a list."""
    for i in range(0, len(items), size):
        yield items[i:i + size]

async def convert_webm_to_ogg(src_path: Path) -> Path:
    """
    Convert a WebM/unknown audio file to real OGG-Opus so WhatsApp accepts it.
    Returns the new path (same stem, .ogg extension).
    Requires ffmpeg to be installed on the server / Docker image.
    """
    dst_path = src_path.with_suffix(".ogg")
    cmd = [
        "ffmpeg", "-y",                      # overwrite if exists
        "-i", str(src_path),                 # input
        "-c:a", "libopus", "-b:a", "64k",    # Opus settings
        str(dst_path),
    ]

    loop = asyncio.get_event_loop()
    proc = await loop.run_in_executor(None, lambda: subprocess.run(cmd, capture_output=True))
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode())
    return dst_path

# Enhanced WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, Set[WebSocket]] = defaultdict(set)
        self.message_queue: Dict[str, List[dict]] = defaultdict(list)
        self.connection_metadata: Dict[WebSocket, dict] = {}
    
    async def connect(self, websocket: WebSocket, user_id: str, client_info: dict = None):
        """Connect a new WebSocket for a user"""
        await websocket.accept()
        self.active_connections[user_id].add(websocket)
        self.connection_metadata[websocket] = {
            "user_id": user_id,
            "connected_at": datetime.utcnow(),
            "client_info": client_info or {}
        }
        
        # Send queued messages to newly connected user
        if user_id in self.message_queue:
            for message in self.message_queue[user_id]:
                try:
                    await websocket.send_json(message)
                except:
                    pass
            del self.message_queue[user_id]
        
        print(f"✅ User {user_id} connected. Total connections: {len(self.active_connections[user_id])}")
    
    def disconnect(self, websocket: WebSocket):
        """Disconnect a WebSocket"""
        if websocket in self.connection_metadata:
            user_id = self.connection_metadata[websocket]["user_id"]
            self.active_connections[user_id].discard(websocket)
            del self.connection_metadata[websocket]
            
            if not self.active_connections[user_id]:
                del self.active_connections[user_id]
            
            print(f"❌ User {user_id} disconnected")
    
    async def send_to_user(self, user_id: str, message: dict):
        print(f"📤 Attempting to send to user {user_id}")
        print("📤 Message content:", json.dumps(message, indent=2))
        """Send message to all connections of a specific user"""
        if user_id in self.active_connections:
            disconnected = set()
            for websocket in self.active_connections[user_id].copy():
                try:
                    await websocket.send_json(message)
                except:
                    disconnected.add(websocket)
            
            for ws in disconnected:
                self.disconnect(ws)
        else:
            # Queue message for offline user
            self.message_queue[user_id].append(message)
            if len(self.message_queue[user_id]) > 100:
                self.message_queue[user_id] = self.message_queue[user_id][-50:]
    
    async def broadcast_to_admins(self, message: dict, exclude_user: str = None):
        """Broadcast message to all admin users"""
        admin_users = await self.get_admin_users()
        for admin_id in admin_users:
            if admin_id != exclude_user:
                await self.send_to_user(admin_id, message)
    
    def get_active_users(self) -> List[str]:
        """Get list of currently active users"""
        return list(self.active_connections.keys())
    
    async def get_admin_users(self) -> List[str]:
        """Get admin user IDs from database"""
        return await db_manager.get_admin_users()

# Redis Manager for caching
class RedisManager:
    def __init__(self, redis_url: str | None = None):
        self.redis_url = redis_url or REDIS_URL
        self.redis_client: Optional[redis.Redis] = None
    
    async def connect(self):
        """Connect to Redis"""
        try:
            self.redis_client = redis.from_url(self.redis_url)
            await self.redis_client.ping()
            print("✅ Redis connected")
        except Exception as e:
            print(f"❌ Redis connection failed: {e}")
            self.redis_client = None
    
    async def cache_message(self, user_id: str, message: dict, ttl: int = 3600):
        """Cache message with TTL"""
        if not self.redis_client:
            return
        
        try:
            key = f"recent_messages:{user_id}"
            await self.redis_client.lpush(key, json.dumps(message))
            await self.redis_client.ltrim(key, 0, 49)  # Keep last 50 messages
            await self.redis_client.expire(key, ttl)
        except Exception as e:
            print(f"Redis cache error: {e}")
    
    async def get_recent_messages(self, user_id: str, limit: int = 20) -> List[dict]:
        """Get recent messages from cache"""
        if not self.redis_client:
            return []
        
        try:
            key = f"recent_messages:{user_id}"
            messages = await self.redis_client.lrange(key, 0, limit - 1)
            return [json.loads(msg) for msg in messages]
        except Exception as e:
            print(f"Redis get error: {e}")
            return []

# WhatsApp API Client
class WhatsAppMessenger:
    def __init__(self):
        self.access_token = ACCESS_TOKEN
        self.phone_number_id = PHONE_NUMBER_ID
        self.base_url = f"https://graph.facebook.com/v18.0/{self.phone_number_id}"
        self.headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json"
        }
    
    async def send_text_message(self, to: str, message: str) -> dict:
        """Send text message via WhatsApp API"""
        url = f"{self.base_url}/messages"
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": {"body": message}
        }
        
        print(f"🚀 Sending WhatsApp message to {to}: {message}")
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            result = response.json()
            print(f"📱 WhatsApp API Response: {result}")
            return result

    async def _make_request(self, endpoint: str, data: dict) -> dict:
        """Helper to send POST requests to WhatsApp API"""
        url = f"{self.base_url}/{endpoint}"
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=data, headers=self.headers)
            return response.json()

    async def send_catalog_products(self, user_id: str, product_ids: List[str]) -> List[Dict[str, Any]]:
        """Send multiple catalog products in chunks"""
        results = []
        for chunk in chunk_list(product_ids, config.MAX_CATALOG_ITEMS):
            data = {
                "messaging_product": "whatsapp",
                "to": user_id,
                "type": "multi_product",
                "multi_product": {
                    "catalog_id": config.CATALOG_ID,
                    "products": [{"product_retailer_id": rid} for rid in chunk]
                }
            }
            result = await self._make_request("messages", data)
            results.append(result)
            await asyncio.sleep(config.RATE_LIMIT_DELAY)
        return results

    async def send_single_catalog_item(self, user_id: str, product_retailer_id: str) -> Dict[str, Any]:
        """Send a single catalog item"""
        data = {
            "messaging_product": "whatsapp",
            "to": user_id,
            "type": "interactive",
            "interactive": {
                "type": "product",
                "body": {"text": "Check out this product!"},
                "footer": {"text": "Irrakids"},
                "action": {
                    "catalog_id": config.CATALOG_ID,
                    "product_retailer_id": product_retailer_id
                }
            }
        }
        return await self._make_request("messages", data)
    
    async def send_media_message(self, to: str, media_type: str, media_id_or_url: str, caption: str = "") -> dict:
        """Send media message - handles both media_id and URL"""
        url = f"{self.base_url}/messages"
        
        # Check if it's a media_id (no http/https) or URL
        if media_id_or_url.startswith(('http://', 'https://')):
            media_payload = {"link": media_id_or_url}
        else:
            media_payload = {"id": media_id_or_url}  # Use media_id
        
        if caption:
            media_payload["caption"] = caption
        
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": media_type,
            media_type: media_payload
        }
        
        print(f"🚀 Sending WhatsApp media to {to}: {media_type} - {media_id_or_url}")
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            result = response.json()
            print(f"📱 WhatsApp Media API Response: {result}")
            return result

    async def mark_message_as_read(self, message_id: str) -> dict:
        """Send a read receipt to WhatsApp for a given message"""
        url = f"{self.base_url}/messages"
        payload = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id,
        }
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            return response.json()
    
    async def download_media(self, media_id: str) -> bytes:
        """Download media from WhatsApp"""
        url = f"https://graph.facebook.com/v18.0/{media_id}"
        
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=self.headers)
            if response.status_code != 200:
                raise Exception(f"Failed to get media info: {response.text}")
            
            media_info = response.json()
            media_url = media_info.get("url")
            
            if not media_url:
                raise Exception("No media URL in response")
            
            media_response = await client.get(media_url, headers=self.headers)
            if media_response.status_code != 200:
                raise Exception(f"Failed to download media: {media_response.text}")
            
            return media_response.content

# ────────────────────────────────────────────────────────────
# Async, single-source Database helper – WhatsApp-Web logic
# ────────────────────────────────────────────────────────────
import aiosqlite
from contextlib import asynccontextmanager

_STATUS_RANK = {"sending": 0, "sent": 1, "delivered": 2, "read": 3, "failed": 99}

class DatabaseManager:
    """Aiosqlite helper with WhatsApp-Web-compatible schema & helpers."""

    def __init__(self, db_path: str | None = None):
        self.db_path = db_path or DB_PATH

    # ── basic connection helper ──
    @asynccontextmanager
    async def _conn(self):
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            yield db

    # ── schema ──
    async def init_db(self):
        async with self._conn() as db:
            await db.executescript(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    wa_message_id  TEXT UNIQUE,
                    temp_id        TEXT UNIQUE,
                    user_id        TEXT NOT NULL,
                    message        TEXT,
                    type           TEXT DEFAULT 'text',
                    from_me        INTEGER DEFAULT 0,             -- bool 0/1
                    status         TEXT  DEFAULT 'sending',
                    price          TEXT,
                    caption        TEXT,
                    media_path     TEXT,
                    timestamp      TEXT  DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS users (
                    user_id    TEXT PRIMARY KEY,
                    name       TEXT,
                    phone      TEXT,
                    is_admin   INTEGER DEFAULT 0,
                    last_seen  TEXT,
                    created_at TEXT  DEFAULT CURRENT_TIMESTAMP
                );

                CREATE INDEX IF NOT EXISTS idx_msg_user_time
                    ON messages (user_id, datetime(timestamp));
                """
            )
            await db.commit()

    # ── UPSERT with status-precedence ──
    async def upsert_message(self, data: dict):
        """
        Insert a new row or update an existing one (found by wa_message_id OR temp_id).
        The status is *only* upgraded – you can’t go from 'delivered' ➜ 'sent', etc.
        """
        async with self._conn() as db:
            # 1) look for an existing row
            row = None
            if data.get("wa_message_id"):
                cur = await db.execute(
                    "SELECT * FROM messages WHERE wa_message_id = ?",
                    (data["wa_message_id"],),
                )
                row = await cur.fetchone()

            if not row and data.get("temp_id"):
                cur = await db.execute(
                    "SELECT * FROM messages WHERE temp_id = ?",
                    (data["temp_id"],),
                )
                row = await cur.fetchone()

            # 2) decide insert vs update
            if row:
                current_status = row["status"]
                new_status     = data.get("status", current_status)

                # only overwrite if status is an upgrade
                if _STATUS_RANK.get(new_status, 0) < _STATUS_RANK.get(current_status, 0):
                    return  # ignore downgrade

                merged = {**dict(row), **data}
                cols   = [k for k in merged.keys() if k != "id"]
                sets   = ", ".join(f"{c}=:{c}" for c in cols)
                merged["id"] = row["id"]
                await db.execute(
                    f"UPDATE messages SET {sets} WHERE id = :id",
                    merged,
                )
            else:
                cols = ", ".join(data.keys())
                qs   = ", ".join("?" for _ in data)
                await db.execute(
                    f"INSERT INTO messages ({cols}) VALUES ({qs})",
                    tuple(data.values()),
                )
            await db.commit()

    # ── wrapper helpers re-used elsewhere ──
    async def get_messages(self, user_id: str, offset=0, limit=50) -> list[dict]:
        """Chronological (oldest➜newest) – just like WhatsApp."""
        async with self._conn() as db:
            cur = await db.execute(
                """
                SELECT * FROM messages
                WHERE user_id = ?
                ORDER BY datetime(timestamp) ASC
                LIMIT ? OFFSET ?
                """,
                (user_id, limit, offset),
            )
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def update_message_status(self, wa_message_id: str, status: str):
        await self.upsert_message({"wa_message_id": wa_message_id, "status": status})

    async def get_user_for_message(self, wa_message_id: str) -> str | None:
        async with self._conn() as db:
            cur = await db.execute(
                "SELECT user_id FROM messages WHERE wa_message_id = ?",
                (wa_message_id,),
            )
            row = await cur.fetchone()
            return row["user_id"] if row else None

    async def upsert_user(self, user_id: str, name=None, phone=None):
        async with self._conn() as db:
            await db.execute(
                """
                INSERT INTO users (user_id, name, phone, last_seen)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user_id) DO UPDATE SET
                    name       = COALESCE(excluded.name , name),
                    phone      = COALESCE(excluded.phone, phone),
                    last_seen  = CURRENT_TIMESTAMP
                """,
                (user_id, name, phone),
            )
            await db.commit()

# Message Processor with Complete Optimistic UI
class MessageProcessor:
    def __init__(self, connection_manager: ConnectionManager, redis_manager: RedisManager, db_manager: DatabaseManager):
        self.connection_manager = connection_manager
        self.redis_manager = redis_manager
        self.db_manager = db_manager
        self.whatsapp_messenger = WhatsAppMessenger()
        self.media_dir = Path("media")
        self.media_dir.mkdir(exist_ok=True)
    
    # Fix the method that was duplicated at the bottom of the file
    async def process_outgoing_message(self, message_data: dict) -> dict:
        """Process outgoing message with instant UI update"""
        user_id = message_data["user_id"]
        await self.db_manager.upsert_user(user_id)
        message_text = message_data["message"]
        message_type = message_data.get("type", "text")
        
        # Generate temporary message ID for instant UI
        # Re-use the temp_id that the React app already put in the payload
        # so the optimistic bubble can be updated instead of duplicated
        temp_id = (
            message_data.get("temp_id")          # ChatWindow / CatalogPanel
            or message_data.get("id")            # safety-net (sometimes they send id only)
            or f"temp_{uuid.uuid4().hex}"        # fall-back if neither exists
        )
        timestamp = datetime.utcnow().isoformat()
        
        # Create optimistic message object
        optimistic_message = {
            "id": temp_id,
            "user_id": user_id,
            "message": message_text,
            "type": message_type,
            "from_me": True,
            "status": "sending",  # Optimistic status
            "timestamp": timestamp,
            "temp_id": temp_id,
            "price": message_data.get("price", ""),
            "caption": message_data.get("caption", ""),
            "media_path": message_data.get("media_path")  # Add this field
        }
        
        # For media messages, add URL field
        if message_type in ["image", "audio", "video"]:
            if message_data.get("url"):
                optimistic_message["url"] = message_data["url"]
            elif message_text and not message_text.startswith("http"):
                filename = Path(message_text).name
                optimistic_message["url"] = f"{BASE_URL}/media/{filename}"
            else:
                optimistic_message["url"] = message_text
        
        # 1. INSTANT: Send to UI immediately (optimistic update)
        await self.connection_manager.send_to_user(user_id, {
            "type": "message_sent",
            "data": optimistic_message
        })
        
        # 2. Cache for quick retrieval
        await self.redis_manager.cache_message(user_id, optimistic_message)
        
        # 3. BACKGROUND: Send to WhatsApp API
        asyncio.create_task(self._send_to_whatsapp_bg(optimistic_message))
        
        return optimistic_message

    async def _send_to_whatsapp_bg(self, message: dict):
        """Background task to send message to WhatsApp and update status"""
        temp_id = message["temp_id"]
        user_id = message["user_id"]
        
        try:
            # Send to WhatsApp API
            if message["type"] == "text":
                wa_response = await self.whatsapp_messenger.send_text_message(
                    user_id, message["message"]
                )
            else:
                # For media messages, handle file upload first
                media_path = message.get("media_path")
                if media_path and Path(media_path).exists():
                    print(f"📤 Uploading media: {media_path}")
                    media_id = await self._upload_media_to_whatsapp(media_path, message["type"])
                    wa_response = await self.whatsapp_messenger.send_media_message(
                        user_id, message["type"], media_id, message.get("caption", "")
                    )
                else:
                    raise Exception(f"Media file not found: {media_path}")
            
            # Extract WhatsApp message ID
            wa_message_id = None
            if "messages" in wa_response and wa_response["messages"]:
                wa_message_id = wa_response["messages"][0].get("id")
            
            if not wa_message_id:
                raise Exception(f"No message ID in WhatsApp response: {wa_response}")
            
            # Update message status to 'sent'
            status_update = {
                "type": "message_status_update",
                "data": {
                    "temp_id": temp_id,
                    "wa_message_id": wa_message_id,
                    "status": "sent",
                    "timestamp": datetime.utcnow().isoformat()
                }
            }
            
            # Send status update to UI
            await self.connection_manager.send_to_user(user_id, status_update)
            
            # Save to database with real WhatsApp ID
            await self.db_manager.save_message(message, wa_message_id, "sent")
            
            print(f"✅ Message sent successfully: {wa_message_id}")
            
        except Exception as e:
            print(f"❌ WhatsApp send failed: {e}")
            # Update UI with error status
            error_update = {
                "type": "message_status_update", 
                "data": {
                    "temp_id": temp_id,
                    "status": "failed",
                    "error": str(e),
                    "timestamp": datetime.utcnow().isoformat()
                }
            }
            await self.connection_manager.send_to_user(user_id, error_update)

    async def _upload_media_to_whatsapp(self, file_path: str, media_type: str) -> str:
        """Upload media file to WhatsApp and return media_id"""
        if not Path(file_path).exists():
            raise Exception(f"Media file not found: {file_path}")
        
        upload_url = f"https://graph.facebook.com/v18.0/{self.whatsapp_messenger.phone_number_id}/media"
        
        try:
            # Read file content
            async with aiofiles.open(file_path, 'rb') as f:
                file_content = await f.read()
            
            # Determine proper MIME type
            mime_types = {
                "image": "image/jpeg",
                "audio": "audio/ogg", 
                "video": "video/mp4",
                "document": "application/pdf"
            }
            mime_type = mime_types.get(media_type, f'{media_type}/*')
            
            # Prepare multipart form data
            files = {
                'file': (Path(file_path).name, file_content, mime_type),
                'messaging_product': (None, 'whatsapp'),
                'type': (None, media_type)
            }
            
            headers = {"Authorization": f"Bearer {self.whatsapp_messenger.access_token}"}
            
            # Upload to WhatsApp
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(upload_url, files=files, headers=headers)
                
                print(f"📤 WhatsApp upload response: {response.status_code}")
                print(f"📤 Response body: {response.text}")
                
                if response.status_code != 200:
                    raise Exception(f"WhatsApp media upload failed: {response.text}")
                
                result = response.json()
                media_id = result.get("id")
                
                if not media_id:
                    raise Exception(f"No media_id in WhatsApp response: {result}")
                
                print(f"✅ Media uploaded successfully. ID: {media_id}")
                return media_id
                
        except httpx.TimeoutException:
            raise Exception("WhatsApp upload timeout - file may be too large")
        except Exception as e:
            print(f"❌ Media upload error: {e}")
            raise Exception(f"Failed to upload media to WhatsApp: {str(e)}")
    
    async def process_incoming_message(self, webhook_data: dict):
        print("🚨 process_incoming_message CALLED")
        print(json.dumps(webhook_data, indent=2))
        """Process incoming WhatsApp message"""
        try:
            value = webhook_data['entry'][0]['changes'][0]['value']
            
            # Handle status updates
            if "statuses" in value:
                await self._handle_status_updates(value["statuses"])
            
            # Handle incoming messages
            if "messages" in value:
                # Extract contacts info if available
                contacts_info = value.get("contacts", [])

                for i, message in enumerate(value["messages"]):
                    # Add contact info to message if available
                    if i < len(contacts_info):
                        message["contact_info"] = contacts_info[i]
                    await self._handle_incoming_message(message)

        except Exception as e:
            print(f"Webhook processing error: {e}")


    async def _handle_status_updates(self, statuses: list):
        """Process status notifications from WhatsApp"""
        for item in statuses:
            wa_id = item.get("id")
            status = item.get("status")
            if not wa_id or not status:
                continue

            # Update DB and fetch temp_id
            temp_id = await self.db_manager.update_message_status(wa_id, status)
            user_id = await self.db_manager.get_user_for_message(wa_id)
            if not user_id:
                continue

            timestamp = datetime.utcfromtimestamp(
                int(item.get("timestamp", 0))
            ).isoformat()

            await self.connection_manager.send_to_user(user_id, {
                "type": "message_status_update",
                "data": {
                    "temp_id": temp_id,
                    "wa_message_id": wa_id,
                    "status": status,
                    "timestamp": timestamp,
                }
            })


    async def _handle_incoming_message(self, message: dict):
        print("📨 _handle_incoming_message CALLED")
        print(json.dumps(message, indent=2))
        
        sender = message["from"]
        msg_type = message["type"]
        wa_message_id = message.get("id")
        timestamp = datetime.utcfromtimestamp(int(message.get("timestamp", 0))).isoformat()
        
        # Extract contact name from contacts array if available
        contact_name = None
        # Note: contacts info is typically in the webhook's 'contacts' field, not message
        
        await self.db_manager.upsert_user(sender, contact_name, sender)
        
        # Create message object with proper URL field
        message_obj = {
            "id": wa_message_id,
            "user_id": sender,
            "type": msg_type,
            "from_me": False,
            "status": "received",
            "timestamp": timestamp,
            "wa_message_id": wa_message_id
        }
        
        # Extract message content and generate proper URLs
        if msg_type == "text":
            message_obj["message"] = message["text"]["body"]
        elif msg_type == "image":
            image_path = await self._download_media(message["image"]["id"], "image")
            message_obj["message"] = image_path
            message_obj["url"] = f"{BASE_URL}/media/{Path(image_path).name}"
            message_obj["caption"] = message["image"].get("caption", "")
        elif msg_type == "audio":
            audio_path = await self._download_media(message["audio"]["id"], "audio")
            message_obj["message"] = audio_path
            message_obj["url"] = f"{BASE_URL}/media/{Path(audio_path).name}"
            message_obj["transcription"] = ""
        elif msg_type == "video":
            video_path = await self._download_media(message["video"]["id"], "video")
            message_obj["message"] = video_path
            message_obj["url"] = f"{BASE_URL}/media/{Path(video_path).name}"
            message_obj["caption"] = message["video"].get("caption", "")
        elif msg_type == "order":
            message_obj["message"] = json.dumps(message.get("order", {}))
        
        # Send to UI and process...
        await self.connection_manager.send_to_user(sender, {
            "type": "message_received",
            "data": message_obj
        })
        
        # Cache and save to database
        await self.redis_manager.cache_message(sender, message_obj)
        await self.db_manager.upsert_message(message_obj)
    
    async def _download_media(self, media_id: str, media_type: str) -> str:
        """Download media from WhatsApp"""
        try:
            media_content = await self.whatsapp_messenger.download_media(media_id)
            
            timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            file_extension = self._get_file_extension(media_type)
            filename = f"{media_type}_{timestamp}_{media_id[:8]}{file_extension}"
            file_path = self.media_dir / filename
            
            async with aiofiles.open(file_path, 'wb') as f:
                await f.write(media_content)
            
            return str(file_path)
            
        except Exception as e:
            print(f"Error downloading media {media_id}: {e}")
            return ""
    
    def _get_file_extension(self, media_type: str) -> str:
        """Get file extension based on media type"""
        extensions = {
            "image": ".jpg",
            "audio": ".ogg", 
            "video": ".mp4",
            "document": ".pdf"
        }
        return extensions.get(media_type, "")

# Initialize managers
db_manager = DatabaseManager()
connection_manager = ConnectionManager()
redis_manager = RedisManager()
message_processor = MessageProcessor(connection_manager, redis_manager, db_manager)
messenger = message_processor.whatsapp_messenger

# FastAPI app
app = FastAPI()
app.include_router(shopify_router)

# Mount the media directory to serve uploaded files
app.mount("/media", StaticFiles(directory="media"), name="media")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup():
    await db_manager.init_db()
    await redis_manager.connect()

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    """WebSocket endpoint for real-time communication"""
    await connection_manager.connect(websocket, user_id)
    
    try:
        # Send recent messages on connection
        recent_messages = await redis_manager.get_recent_messages(user_id)
        if recent_messages:
            await websocket.send_json({
                "type": "recent_messages",
                "data": recent_messages
            })
        
        # Listen for incoming WebSocket messages
        while True:
            data = await websocket.receive_json()
            await handle_websocket_message(websocket, user_id, data)
            
    except WebSocketDisconnect:
        connection_manager.disconnect(websocket)
    except Exception as e:
        print(f"WebSocket error: {e}")
        connection_manager.disconnect(websocket)

async def handle_websocket_message(websocket: WebSocket, user_id: str, data: dict):
    """Handle incoming WebSocket messages from client"""
    message_type = data.get("type")
    
    if message_type == "send_message":
        message_data = data.get("data", {})
        message_data["user_id"] = user_id
        # FIXED: Call the method on message_processor instance
        await message_processor.process_outgoing_message(message_data)

    elif message_type == "mark_as_read":
        message_ids = data.get("message_ids", [])
        await db_manager.mark_messages_as_read(user_id, message_ids or None)
        for mid in message_ids:
            try:
                await messenger.mark_message_as_read(mid)
            except Exception as e:
                print(f"Failed to send read receipt for {mid}: {e}")
        await connection_manager.send_to_user(user_id, {
            "type": "messages_marked_read",
            "data": {"user_id": user_id, "message_ids": message_ids}
        })
        
    elif message_type == "typing":
        is_typing = data.get("is_typing", False)
        # Broadcast typing status
        
    elif message_type == "get_conversation_history":
        offset = data.get("offset", 0)
        limit = data.get("limit", 50)
        messages = await db_manager.get_messages(user_id, offset, limit)
        await websocket.send_json({
            "type": "conversation_history",
            "data": messages
        })

@app.api_route("/webhook", methods=["GET", "POST"])
async def webhook(request: Request):
    """WhatsApp webhook endpoint"""
    if request.method == "GET":
        # --- Meta verification logic ---
        params = dict(request.query_params)
        mode = params.get("hub.mode")
        token = params.get("hub.verify_token")
        challenge = params.get("hub.challenge")
        
        print(f"🔐 Webhook verification: mode={mode}, token={token}, challenge={challenge}")
        
        if mode == "subscribe" and token == VERIFY_TOKEN and challenge:
            print("✅ Webhook verified successfully")
            return PlainTextResponse(challenge)
        print("❌ Webhook verification failed")
        return PlainTextResponse("Verification failed", status_code=403)
        
    elif request.method == "POST":
        data = await request.json()
        print("📥 Incoming Webhook Payload:")
        print(json.dumps(data, indent=2))

        await message_processor.process_incoming_message(data)
        return {"ok": True}

@app.post("/test-media-upload")
async def test_media_upload(file: UploadFile = File(...)):
    """Test endpoint to debug media upload issues"""
    try:
        print(f"📁 Received file: {file.filename}")
        print(f"📁 Content type: {file.content_type}")
        print(f"📁 File size: {file.size if hasattr(file, 'size') else 'Unknown'}")
        
        # Read file content
        content = await file.read()
        print(f"📁 Read {len(content)} bytes")
        
        # Reset file pointer for actual processing
        await file.seek(0)
        
        return {
            "status": "success",
            "filename": file.filename,
            "content_type": file.content_type,
            "size": len(content)
        }
        
    except Exception as e:
        print(f"❌ Test upload error: {e}")
        return {"error": str(e), "status": "failed"}

@app.post("/send-message")
async def send_message_endpoint(request: dict):
    """Send text message - Frontend uses this endpoint"""
    try:
        # Extract data from request
        user_id = request.get("user_id")
        message_text = request.get("message")
        message_type = request.get("type", "text")
        from_me = request.get("from_me", True)
        
        if not user_id or not message_text:
            return {"error": "Missing user_id or message"}
        
        # Create message object
        message_data = {
            "user_id": user_id,
            "message": message_text,
            "type": message_type,
            "from_me": from_me,
            "timestamp": datetime.utcnow().isoformat()
        }
        
        # Process the message
        result = await message_processor.process_outgoing_message(message_data)
        return {"status": "success", "message": result}
        
    except Exception as e:
        print(f"Error sending message: {e}")
        return {"error": str(e)}

@app.get("/conversations/{user_id}/messages")
async def get_conversation_messages(user_id: str, offset: int = 0, limit: int = 50):
    """Get conversation messages with pagination"""
    if offset == 0:
        cached_messages = await redis_manager.get_recent_messages(user_id, limit)
        if cached_messages:
            return {"messages": cached_messages, "source": "cache"}
    
    messages = await db_manager.get_messages(user_id, offset, limit)
    return {"messages": messages, "source": "database"}

@app.get("/users/online")
async def get_online_users():
    """Get list of currently online users"""
    return {"online_users": connection_manager.get_active_users()}

@app.post("/conversations/{user_id}/mark-read")
async def mark_conversation_read(user_id: str, message_ids: List[str] = None):
    """Mark messages as read"""
    try:
        await db_manager.mark_messages_as_read(user_id, message_ids)
        if message_ids:
            for mid in message_ids:
                try:
                    await messenger.mark_message_as_read(mid)
                except Exception as e:
                    print(f"Failed to send read receipt for {mid}: {e}")

        await connection_manager.send_to_user(user_id, {
            "type": "messages_marked_read",
            "data": {"user_id": user_id, "message_ids": message_ids}
        })
        
        return {"status": "success"}
    except Exception as e:
        print(f"Error marking messages as read: {e}")
        return {"error": str(e)}

@app.get("/active-users")
async def get_active_users():
    """Get currently active users"""
    return {"active_users": connection_manager.get_active_users()}

@app.get("/conversations")
async def get_conversations():
    """Get all conversations with proper stats for ChatList"""
    try:
        conversations = await db_manager.get_conversations_with_stats()
        return conversations
    except Exception as e:
        print(f"Error fetching conversations: {e}")
        return []

@app.get("/health")
async def health_check():
    """Health check endpoint"""  
    redis_status = "connected" if redis_manager.redis_client else "disconnected"
    return {
        "status": "healthy",
        "redis": redis_status,
        "active_connections": len(connection_manager.active_connections),
        "timestamp": datetime.utcnow().isoformat(),
        "whatsapp_config": {
            "access_token_configured": bool(ACCESS_TOKEN and ACCESS_TOKEN != "your_access_token_here"),
            "phone_number_id_configured": bool(PHONE_NUMBER_ID and PHONE_NUMBER_ID != "your_phone_number_id"),
            "verify_token_configured": bool(VERIFY_TOKEN)
        }
    }

@app.get("/messages/{user_id}")
async def get_messages_endpoint(user_id: str, offset: int = 0, limit: int = 50):
    """Get messages for a specific user - Frontend expects this endpoint"""
    try:
        # First try to get from cache
        if offset == 0:
            cached_messages = await redis_manager.get_recent_messages(user_id, limit)
            if cached_messages:
                return cached_messages
        
        # Fallback to database
        messages = await db_manager.get_messages(user_id, offset, limit)
        return messages
    except Exception as e:
        print(f"Error fetching messages: {e}")
        return []

@app.post("/send-media")
async def send_media(
    user_id: str = Form(...),
    media_type: str = Form(...),
    files: List[UploadFile] = File(...),
    caption: str = Form("", description="Optional caption"),
    price: str = Form("", description="Optional price"),
):
    """Send media message with proper error handling, plus WebM → OGG conversion"""

    try:
        # ---------- basic validation ----------
        if not user_id:
            return {"error": "user_id is required", "status": "failed"}

        if media_type not in ["image", "audio", "video", "document"]:
            return {
                "error": "Invalid media_type. Must be: image, audio, video, or document",
                "status": "failed",
            }

        if not files:
            return {"error": "No files uploaded", "status": "failed"}

        # ---------- ensure media folder ----------
        media_dir = Path("media")
        media_dir.mkdir(exist_ok=True)

        saved_results = []

        # ---------- process every uploaded file ----------
        for file in files:
            if not file.filename:
                continue

            timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            file_extension = Path(file.filename).suffix or ".bin"
            filename = f"{media_type}_{timestamp}_{uuid.uuid4().hex[:8]}{file_extension}"
            file_path = media_dir / filename

            # --- save the raw upload ---
            try:
                content = await file.read()
                async with aiofiles.open(file_path, "wb") as f:
                    await f.write(content)
            except Exception as exc:
                return {"error": f"Failed to save file: {exc}", "status": "failed"}

            # ---------- AUDIO-ONLY: convert WebM → OGG ----------
            if media_type == "audio" and file_extension.lower() != ".ogg":
                try:
                    ogg_path = await convert_webm_to_ogg(file_path)
                    file_path.unlink(missing_ok=True)  # delete original WebM
                    file_path = ogg_path
                    filename = ogg_path.name
                except Exception as exc:
                    return {"error": f"Audio conversion failed: {exc}", "status": "failed"}

            # ---------- build metadata ----------
            media_url = f"{BASE_URL}/media/{filename}"

            message_data = {
                "user_id": user_id,
                "message": str(file_path),
                "url": media_url,
                "type": media_type,
                "from_me": True,
                "caption": caption,
                "price": price,
                "timestamp": datetime.utcnow().isoformat(),
                "media_path": str(file_path),
            }

            # ---------- enqueue / send ----------
            result = await message_processor.process_outgoing_message(message_data)
            saved_results.append(
                {"filename": filename, "media_url": media_url, "result": result}
            )

        return {"status": "success", "messages": saved_results}

    except Exception as exc:
        print(f"❌ Error in /send-media: {exc}")
        return {"error": f"Internal server error: {exc}", "status": "failed"}


@app.post("/send-catalog-set")
async def send_catalog_set_endpoint(
    user_id: str = Form(...),
    product_ids: str = Form(...)
):
    try:
        product_id_list = json.loads(product_ids)
        customer_phone = lookup_phone(user_id) or user_id
        results = await messenger.send_catalog_products(customer_phone, product_id_list)
        return {"status": "ok", "results": results}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/send-catalog-item")
async def send_catalog_item_endpoint(
    user_id: str = Form(...),
    product_retailer_id: str = Form(...)
):
    customer_phone = lookup_phone(user_id) or user_id
    response = await messenger.send_single_catalog_item(customer_phone, product_retailer_id)
    return {"status": "ok", "response": response}


@app.get("/catalog-sets")
async def get_catalog_sets():
    sets = [
        {"id": CATALOG_ID, "name": "All Products"}
    ]
    return sets


@app.get("/catalog-all-products")
async def get_catalog_products_endpoint():
    return catalog_manager.get_cached_products()


@app.get("/catalog-set-products")
async def get_catalog_set_products(set_id: str):
    """Return products for the requested set."""
    # Currently only a single catalog exists, so ignore set_id
    return catalog_manager.get_cached_products()

@app.api_route("/refresh-catalog-cache", methods=["GET", "POST"])
async def refresh_catalog_cache_endpoint():
    count = await catalog_manager.refresh_catalog_cache()
    return {"status": "ok", "count": count}


@app.get("/all-catalog-products")
async def get_all_catalog_products():
    try:
        products = await CatalogManager.get_catalog_products()
        return products
    except Exception as e:
        print(f"Error fetching catalog: {e}")
        return []

# Add static file serving for media files
from fastapi.staticfiles import StaticFiles


# 1. Fix the port in main block
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)

META_CATALOG_URL = f"https://graph.facebook.com/v19.0/{CATALOG_ID}/products"

async def fetch_meta_catalog():
    headers = {
        "Authorization": f"Bearer {ACCESS_TOKEN}"
    }
    async with httpx.AsyncClient() as client:
        response = await client.get(META_CATALOG_URL, headers=headers)
        response.raise_for_status()
        return response.json().get("data", [])


async def get_whatsapp_headers() -> Dict[str, str]:
    """Return auth headers for WhatsApp API"""
    return {"Authorization": f"Bearer {ACCESS_TOKEN}"}


class CatalogManager:
    @staticmethod
    async def get_catalog_products() -> List[Dict[str, Any]]:
        products: List[Dict[str, Any]] = []
        url = f"https://graph.facebook.com/{config.WHATSAPP_API_VERSION}/{config.CATALOG_ID}/products"
        params = {
            "fields": "retailer_id,name,price,images,availability,quantity",
            "limit": 25,
        }
        headers = await get_whatsapp_headers()

        async with httpx.AsyncClient(timeout=40.0) as client:
            while url:
                response = await client.get(url, headers=headers, params=params if params else None)
                data = response.json()
                for product in data.get("data", []):
                    if CatalogManager._is_product_available(product):
                        products.append(CatalogManager._format_product(product))
                url = data.get("paging", {}).get("next")
                params = None
        return products

    @staticmethod
    def _is_product_available(product: Dict[str, Any]) -> bool:
        availability = str(product.get("availability", "")).lower()

        # FB sometimes returns null or an empty string ➜ treat as 0
        raw_qty = product.get("quantity", 0)
        try:
            quantity = int(raw_qty) if raw_qty not in (None, "") else 0
        except (ValueError, TypeError):
            quantity = 0

        return availability != "out_of_stock" and quantity > 0

    @staticmethod
    def _format_product(product: Dict[str, Any]) -> Dict[str, Any]:
        images = product.get("images", [])
        if isinstance(images, dict) and "data" in images:
            images = images["data"]

        formatted_images = []
        for img in images:
            if isinstance(img, str):
                try:
                    img = json.loads(img)
                except Exception:
                    continue
            if isinstance(img, dict):
                formatted_images.append(img)

        return {
            "retailer_id": product.get("retailer_id", product.get("id")),
            "name": product.get("name"),
            "price": product.get("price"),
            "availability": product.get("availability"),
            "quantity": product.get("quantity"),
            "images": formatted_images,
        }

    @staticmethod
    async def refresh_catalog_cache() -> int:
        products = await CatalogManager.get_catalog_products()
        with open(config.CATALOG_CACHE_FILE, "w", encoding="utf8") as f:
            json.dump(products, f, ensure_ascii=False)
        return len(products)

    @staticmethod
    def get_cached_products() -> List[Dict[str, Any]]:
        if not os.path.exists(config.CATALOG_CACHE_FILE):
            return []
        with open(config.CATALOG_CACHE_FILE, "r", encoding="utf8") as f:
            products = json.load(f)
        return [p for p in products if CatalogManager._is_product_available(p)]


catalog_manager = CatalogManager()
