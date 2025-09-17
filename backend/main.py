import asyncio
import json
import uuid
import hashlib
import secrets
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
from collections import defaultdict
import time
import os
import re
import aiosqlite
import aiofiles
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, Request, UploadFile, File, Form, HTTPException, Body, Depends
from starlette.requests import Request as _LimiterRequest
from starlette.responses import Response as _LimiterResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
import httpx
import redis.asyncio as redis
from fastapi.responses import PlainTextResponse
from dotenv import load_dotenv
import subprocess
import asyncpg
import mimetypes
from .google_cloud_storage import upload_file_to_gcs, download_file_from_gcs
from prometheus_fastapi_instrumentator import Instrumentator
from fastapi_limiter import FastAPILimiter
from fastapi_limiter.depends import RateLimiter

from fastapi.staticfiles import StaticFiles
try:
    import orjson  # type: ignore
    from fastapi.responses import ORJSONResponse  # type: ignore
    _ORJSON_AVAILABLE = True
except Exception:
    _ORJSON_AVAILABLE = False
from starlette.requests import Request as StarletteRequest
from starlette.responses import Response as StarletteResponse
from fastapi.responses import StreamingResponse
from fastapi.responses import JSONResponse

# Absolute paths
ROOT_DIR = Path(__file__).resolve().parent.parent
MEDIA_DIR = ROOT_DIR / "media"
MEDIA_DIR.mkdir(exist_ok=True)

# ── Cloud‑Run helpers ────────────────────────────────────────────
PORT = int(os.getenv("PORT", "8080"))
BASE_URL = os.getenv("BASE_URL", f"http://localhost:{PORT}")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
DB_PATH = os.getenv("DB_PATH", "data/whatsapp_messages.db")
DATABASE_URL = os.getenv("DATABASE_URL")  # optional PostgreSQL URL
# Anything that **must not** be baked in the image (tokens, IDs …) is
# already picked up with os.getenv() further below. Keep it that way.

# Load environment variables
load_dotenv()

# Configure logging early
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

# Configuration is sourced from environment variables below. Removed duplicate static Config.
CATALOG_CACHE_FILE = "catalog_cache.json"
UPLOADS_DIR = "uploads"
WHATSAPP_API_VERSION = "v19.0"
MAX_CATALOG_ITEMS = 30
RATE_LIMIT_DELAY = 0
CATALOG_CACHE_TTL_SEC = 15 * 60

# Backwards-compatibility shim for tests and existing imports expecting `main.config`
try:
    from types import SimpleNamespace
    config = SimpleNamespace(
        WHATSAPP_API_VERSION=WHATSAPP_API_VERSION,
        MAX_CATALOG_ITEMS=MAX_CATALOG_ITEMS,
        CATALOG_ID=None,  # set below after env load
        CATALOG_CACHE_FILE=CATALOG_CACHE_FILE,
        RATE_LIMIT_DELAY=RATE_LIMIT_DELAY,
        UPLOADS_DIR=UPLOADS_DIR,
    )
except Exception:
    config = None  # type: ignore
# Verbose logging flag (minimize noisy logs when off)
LOG_VERBOSE = os.getenv("LOG_VERBOSE", "0") == "1"

# Backpressure and rate limiting configuration
WA_MAX_CONCURRENCY = int(os.getenv("WA_MAX_CONCURRENCY", "4"))
SEND_TEXT_PER_MIN = int(os.getenv("SEND_TEXT_PER_MIN", "30"))
SEND_MEDIA_PER_MIN = int(os.getenv("SEND_MEDIA_PER_MIN", "5"))
BURST_WINDOW_SEC = int(os.getenv("BURST_WINDOW_SEC", "10"))
ENABLE_WS_PUBSUB = os.getenv("ENABLE_WS_PUBSUB", "1") == "1"

# Global semaphore to cap concurrent WhatsApp Graph API calls per instance
wa_semaphore = asyncio.Semaphore(WA_MAX_CONCURRENCY)

def _vlog(*args, **kwargs):
    if LOG_VERBOSE:
        print(*args, **kwargs)

# Suppress noisy prints in production while preserving error-like messages
try:
    import builtins as _builtins  # type: ignore
    _original_print = _builtins.print

    def _smart_print(*args, **kwargs):
        text = " ".join(str(a) for a in args)
        lower = text.lower()
        if ("error" in lower) or ("failed" in lower) or ("\u274c" in text) or ("\u2757" in text):
            logging.error(text)
        elif LOG_VERBOSE:
            logging.info(text)
        # else: drop message to keep logs quiet

    if not LOG_VERBOSE:
        _builtins.print = _smart_print  # type: ignore
except Exception:
    # If anything goes wrong, keep default print behavior
    pass

# ── simple password hashing helpers ───────────────────────────────
def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), 100_000)
    return f"{salt}${dk.hex()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        salt, h = stored.split('$', 1)
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), 100_000)
        return h.lower() == dk.hex().lower()
    except Exception:
        return False
# Get environment variables
VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "chafiq")
ACCESS_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "your_access_token_here")
PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "your_phone_number_id")
CATALOG_ID = os.getenv("CATALOG_ID", "CATALOGID")
META_ACCESS_TOKEN = os.getenv("META_ACCESS_TOKEN", ACCESS_TOKEN)

# Sync CATALOG_ID into compatibility shim, if present
try:
    if config is not None:
        config.CATALOG_ID = CATALOG_ID  # type: ignore[attr-defined]
except Exception:
    pass

# Feature flags: auto-reply with catalog match
AUTO_REPLY_CATALOG_MATCH = os.getenv("AUTO_REPLY_CATALOG_MATCH", "0") == "1"
try:
    AUTO_REPLY_MIN_SCORE = float(os.getenv("AUTO_REPLY_MIN_SCORE", "0.6"))
except Exception:
    AUTO_REPLY_MIN_SCORE = 0.6

_vlog(f"🔧 Configuration loaded:")
_vlog(f"   VERIFY_TOKEN: {VERIFY_TOKEN}")
_vlog(f"   ACCESS_TOKEN: {ACCESS_TOKEN[:20]}..." if len(ACCESS_TOKEN) > 20 else f"   ACCESS_TOKEN: {ACCESS_TOKEN}")
_vlog(f"   PHONE_NUMBER_ID: {PHONE_NUMBER_ID}")

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
        # Optional: will be attached after initialization
        self.redis_manager = None
        # Per-agent token buckets for backpressure
        self._ws_buckets: Dict[str, Dict[str, float]] = {}
    
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
    
    async def _send_local(self, user_id: str, message: dict):
        _vlog(f"📤 Attempting to send to user {user_id}")
        _vlog("📤 Message content:", json.dumps(message, indent=2))
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

    def _consume_ws_token(self, user_id: str, is_media: bool = False) -> bool:
        try:
            # Simple leaky bucket using monotonic time
            bucket_key = f"{user_id}:{'media' if is_media else 'text'}"
            bucket = self._ws_buckets.get(bucket_key) or {"allowance": float(SEND_MEDIA_PER_MIN if is_media else SEND_TEXT_PER_MIN), "last": time.monotonic()}
            now = time.monotonic()
            rate_per_sec = (SEND_MEDIA_PER_MIN if is_media else SEND_TEXT_PER_MIN) / 60.0
            # Refill based on elapsed time
            bucket["allowance"] = min(float(SEND_MEDIA_PER_MIN if is_media else SEND_TEXT_PER_MIN), bucket["allowance"] + (now - bucket["last"]) * rate_per_sec)
            bucket["last"] = now
            if bucket["allowance"] < 1.0:
                self._ws_buckets[bucket_key] = bucket
                return False
            bucket["allowance"] -= 1.0
            self._ws_buckets[bucket_key] = bucket
            return True
        except Exception:
            return True

    async def send_to_user(self, user_id: str, message: dict):
        """Send locally and, if enabled, publish to Redis for other instances."""
        await self._send_local(user_id, message)
        try:
            if ENABLE_WS_PUBSUB and getattr(self, "redis_manager", None):
                await self.redis_manager.publish_ws_event(user_id, message)
        except Exception as exc:
            _vlog(f"WS publish error: {exc}")
    
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

    async def publish_ws_event(self, user_id: str, message: dict):
        """Publish a WebSocket event so other instances can deliver it."""
        if not self.redis_client:
            return
        try:
            payload = json.dumps({"user_id": user_id, "message": message})
            await self.redis_client.publish("ws_events", payload)
        except Exception as exc:
            print(f"Redis publish error: {exc}")

    async def subscribe_ws_events(self, connection_manager: "ConnectionManager"):
        """Subscribe to WS events and forward them to local connections only."""
        if not self.redis_client:
            return
        try:
            pubsub = self.redis_client.pubsub(ignore_subscribe_messages=True)
            await pubsub.subscribe("ws_events")
            async for msg in pubsub.listen():
                try:
                    if msg and msg.get("type") == "message":
                        data = json.loads(msg.get("data"))
                        uid = data.get("user_id")
                        payload = data.get("message")
                        if uid and payload:
                            await connection_manager._send_local(uid, payload)
                except Exception as inner_exc:
                    _vlog(f"WS subscribe handler error: {inner_exc}")
        except Exception as exc:
            print(f"Redis subscribe error: {exc}")

# WhatsApp API Client
class WhatsAppMessenger:
    def __init__(self):
        self.access_token = ACCESS_TOKEN
        self.phone_number_id = PHONE_NUMBER_ID
        self.base_url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{self.phone_number_id}"
        self.headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json"
        }
    
    async def send_text_message(self, to: str, message: str, context_message_id: str | None = None) -> dict:
        """Send text message via WhatsApp API"""
        url = f"{self.base_url}/messages"
        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "text",
            "text": {"body": message}
        }
        if context_message_id:
            payload["context"] = {"message_id": context_message_id}
        
        print(f"🚀 Sending WhatsApp message to {to}: {message}")
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            result = response.json()
            print(f"📱 WhatsApp API Response: {result}")
            return result

    async def send_reaction(self, to: str, target_message_id: str, emoji: str, action: str = "react") -> dict:
        """Send a reaction to a specific message via WhatsApp API."""
        data = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "reaction",
            "reaction": {
                "message_id": target_message_id,
                "emoji": emoji,
                "action": action or "react",
            },
        }
        return await self._make_request("messages", data)

    async def _make_request(self, endpoint: str, data: dict) -> dict:
        """Helper to send POST requests to WhatsApp API"""
        url = f"{self.base_url}/{endpoint}"
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=data, headers=self.headers)
            if response.status_code < 200 or response.status_code >= 300:
                # Log response body for easier debugging
                try:
                    body = response.text
                except Exception:
                    body = "<no body>"
                print(
                    f"❌ WhatsApp API request to {endpoint} failed with status {response.status_code}: {body}"
                )
                raise Exception(
                    f"WhatsApp API request failed with status {response.status_code}"
                )

            return response.json()

    async def send_catalog_products(self, user_id: str, product_ids: List[str]) -> List[Dict[str, Any]]:
        """Send multiple catalog products in chunks, with clear bilingual part labels."""
        results = []
        # Pre-split to compute part numbers and item ranges
        chunks: List[List[str]] = list(chunk_list(product_ids, MAX_CATALOG_ITEMS))
        total_parts: int = len(chunks) if chunks else 0
        running_index: int = 1

        for part_index, chunk in enumerate(chunks, start=1):
            start_idx = running_index
            end_idx = running_index + len(chunk) - 1
            running_index += len(chunk)

            # Short bilingual header: "Partie X/Y • الجزء X/Y"
            header_text = f"Partie {part_index}/{total_parts} • الجزء {part_index}/{total_parts}"
            # Bilingual body explaining which range this part covers
            body_text_fr = f"Voici la partie {part_index}/{total_parts} des articles (\u2116 {start_idx}–{end_idx})."
            body_text_ar = f"هذه هي الجزء {part_index}/{total_parts} من العناصر (رقم {start_idx}–{end_idx})."
            body_text = f"{body_text_fr}\n{body_text_ar}"

            # Also reflect the part info in the section title for extra visibility
            section_title = f"Part {part_index}/{total_parts}"

            data = {
                "messaging_product": "whatsapp",
                "to": user_id,
                "type": "interactive",
                "interactive": {
                    "type": "product_list",
                    "header": {"type": "text", "text": header_text},
                    "body": {"text": body_text},
                    "action": {
                        "catalog_id": CATALOG_ID,
                        "sections": [
                            {
                                "title": section_title,
                                "product_items": [
                                    {"product_retailer_id": rid} for rid in chunk
                                ],
                            }
                        ],
                    },
                },
            }

            result = await self._make_request("messages", data)
            results.append(result)
        return results

    async def send_single_catalog_item(self, user_id: str, product_retailer_id: str, caption: str = "") -> Dict[str, Any]:
        """Send a single catalog item (interactive) with optional caption."""
        data = {
            "messaging_product": "whatsapp",
            "to": user_id,
            "type": "interactive",
            "interactive": {
                "type": "product",
                "body": {"text": caption or "Découvrez ce produit !\nتفقد هذا المنتج!"},
                "action": {
                    "catalog_id": CATALOG_ID,
                    "product_retailer_id": product_retailer_id
                }
            }
        }
        return await self._make_request("messages", data)

    async def send_full_catalog(self, user_id: str, caption: str = "") -> List[Dict[str, Any]]:
        """Send the entire catalog to a user, optionally with a caption."""
        products = catalog_manager.get_cached_products()
        product_ids = [p.get("retailer_id") for p in products if p.get("retailer_id")]

        if caption:
            await self.send_text_message(user_id, caption)

        if not product_ids:
            return []

        return await self.send_catalog_products(user_id, product_ids)

    async def send_full_set(self, user_id: str, set_id: str, caption: str = "") -> List[Dict[str, Any]]:
        """Send all products for a specific set in chunks."""
        products = await CatalogManager.get_products_for_set(set_id)
        product_ids = [p.get("retailer_id") for p in products if p.get("retailer_id")]

        if caption:
            await self.send_text_message(user_id, caption)

        if not product_ids:
            return []

        return await self.send_catalog_products(user_id, product_ids)
    
    async def send_media_message(self, to: str, media_type: str, media_id_or_url: str, caption: str = "", context_message_id: str | None = None) -> dict:
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
        if context_message_id:
            payload["context"] = {"message_id": context_message_id}
        
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
    
    async def download_media(self, media_id: str) -> tuple[bytes, str]:
        """Download media from WhatsApp.

        Returns a tuple ``(content, mime_type)`` where ``content`` is the raw
        bytes of the file and ``mime_type`` comes from the ``Content-Type``
        header of the media response.
        """
        url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{media_id}"

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

            mime_type = media_response.headers.get("Content-Type", "")
            return media_response.content, mime_type

# ────────────────────────────────────────────────────────────
# Async, single-source Database helper – WhatsApp-Web logic
# ────────────────────────────────────────────────────────────
import aiosqlite
from contextlib import asynccontextmanager

_STATUS_RANK = {"sending": 0, "sent": 1, "delivered": 2, "read": 3, "failed": 99}

# Order status flags used by the payout/archive workflow
ORDER_STATUS_PAYOUT = "payout"
ORDER_STATUS_ARCHIVED = "archived"

class DatabaseManager:
    """Database helper supporting SQLite and optional PostgreSQL."""

    def __init__(self, db_path: str | None = None, db_url: str | None = None):
        self.db_url = db_url or DATABASE_URL
        self.db_path = db_path or DB_PATH
        self.use_postgres = bool(self.db_url)
        if not self.use_postgres:
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._pool: Optional[asyncpg.pool.Pool] = None
        # Columns allowed in the messages table (except auto-increment id)
        self.message_columns = {
            "wa_message_id",
            "temp_id",
            "user_id",
            "message",
            "type",
            "from_me",
            "status",
            "price",
            "caption",
            "media_path",
            "timestamp",
            "url",  # store public URL for media
            # reply / reactions metadata
            "reply_to",            # wa_message_id of the quoted/original message
            "quoted_text",         # optional cached snippet of the quoted message
            "reaction_to",         # wa_message_id of the message this reaction targets
            "reaction_emoji",      # emoji character (e.g. "👍")
            "reaction_action",     # add/remove per WhatsApp payload
        }

    async def _add_column_if_missing(self, db, table: str, column: str, col_def: str):
        """Add a column to a table if it doesn't already exist."""
        exists = False
        if self.use_postgres:
            q = (
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name=$1 AND column_name=$2"
            )
            exists = bool(await db.fetchrow(q, table, column))
        else:
            cur = await db.execute(f"PRAGMA table_info({table})")
            cols = [r[1] for r in await cur.fetchall()]
            exists = column in cols
        if not exists:
            await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}")
            if not self.use_postgres:
                await db.commit()

    async def _get_pool(self):
        if not self._pool:
            try:
                self._pool = await asyncpg.create_pool(self.db_url)
            except Exception as exc:
                # Fallback to SQLite if Postgres is unavailable at startup
                print(f"⚠️ Postgres pool creation failed, falling back to SQLite: {exc}")
                self.use_postgres = False
                self._pool = None
        return self._pool

    def _convert(self, query: str) -> str:
        """Convert SQLite style placeholders to asyncpg numbered ones."""
        if not self.use_postgres:
            return query

        idx = 1

        # Replace positional and named placeholders in the order they appear
        def repl(match):
            nonlocal idx
            rep = f"${idx}"
            idx += 1
            return rep

        query = re.sub(r"\?|:\w+", repl, query)
        return query

    # ── basic connection helper ──
    @asynccontextmanager
    async def _conn(self):
        if self.use_postgres:
            pool = await self._get_pool()
            async with pool.acquire() as conn:
                yield conn
        else:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                yield db

    # ── schema ──
    async def init_db(self):
        async with self._conn() as db:
            base_script = """
                CREATE TABLE IF NOT EXISTS messages (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    wa_message_id  TEXT,
                    temp_id        TEXT,
                    user_id        TEXT NOT NULL,
                    message        TEXT,
                    type           TEXT DEFAULT 'text',
                    from_me        INTEGER DEFAULT 0,             -- bool 0/1
                    status         TEXT  DEFAULT 'sending',
                    price          TEXT,
                    caption        TEXT,
                    url            TEXT,
                    media_path     TEXT,
                    -- replies & reactions
                    reply_to       TEXT,
                    quoted_text    TEXT,
                    reaction_to    TEXT,
                    reaction_emoji TEXT,
                    reaction_action TEXT,
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

                -- Agents who handle the shared inbox
                CREATE TABLE IF NOT EXISTS agents (
                    username      TEXT PRIMARY KEY,
                    name          TEXT NOT NULL,
                    password_hash TEXT NOT NULL,
                    is_admin      INTEGER DEFAULT 0,
                    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- Optional metadata per customer conversation
                CREATE TABLE IF NOT EXISTS conversation_meta (
                    user_id        TEXT PRIMARY KEY,
                    assigned_agent TEXT REFERENCES agents(username),
                    tags           TEXT, -- JSON array of strings
                    avatar_url     TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_msg_wa_id
                    ON messages (wa_message_id);

                CREATE INDEX IF NOT EXISTS idx_msg_user_time
                    ON messages (user_id, datetime(timestamp));

                -- Additional index to optimize TEXT-based timestamp ordering in SQLite
                CREATE INDEX IF NOT EXISTS idx_msg_user_ts_text
                    ON messages (user_id, timestamp);

                -- Idempotency: ensure per-chat uniqueness for wa_message_id and temp_id
                CREATE UNIQUE INDEX IF NOT EXISTS uniq_msg_user_wa
                    ON messages (user_id, wa_message_id);
                CREATE UNIQUE INDEX IF NOT EXISTS uniq_msg_user_temp
                    ON messages (user_id, temp_id);

                -- Orders table used to track payout status
                CREATE TABLE IF NOT EXISTS orders (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id   TEXT UNIQUE,
                    status     TEXT,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                );

                -- Key/value settings store (JSON-encoded values)
                CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                );
                """
            if self.use_postgres:
                script = base_script.replace(
                    "INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY"
                )
                # PostgreSQL doesn't support the SQLite datetime() function in
                # index definitions, so index the raw timestamp column instead.
                script = script.replace("datetime(timestamp)", "timestamp")
                statements = [s.strip() for s in script.split(";") if s.strip()]
                for stmt in statements:
                    await db.execute(stmt)
                # Ensure the additional composite index exists in Postgres as well
                await db.execute("CREATE INDEX IF NOT EXISTS idx_msg_user_ts_text ON messages (user_id, timestamp)")
            else:
                await db.executescript(base_script)
                await db.commit()

            # Ensure newer columns exist for deployments created before they were added
            await self._add_column_if_missing(db, "messages", "temp_id", "TEXT")
            await self._add_column_if_missing(db, "messages", "url", "TEXT")
            # reply/reactions columns (idempotent)
            await self._add_column_if_missing(db, "messages", "reply_to", "TEXT")
            await self._add_column_if_missing(db, "messages", "quoted_text", "TEXT")
            await self._add_column_if_missing(db, "messages", "reaction_to", "TEXT")
            await self._add_column_if_missing(db, "messages", "reaction_emoji", "TEXT")
            await self._add_column_if_missing(db, "messages", "reaction_action", "TEXT")

            # Create index on temp_id now that the column is guaranteed to exist
            if self.use_postgres:
                await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_temp_id ON messages (temp_id)")
                await db.execute("CREATE INDEX IF NOT EXISTS idx_msg_user_ts_text ON messages (user_id, timestamp)")
            else:
                await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_temp_id ON messages (temp_id)")
                await db.commit()

    # ── Agents management ──────────────────────────────────────────
    async def create_agent(self, username: str, name: str, password_hash: str, is_admin: int = 0):
        async with self._conn() as db:
            query = self._convert(
                """
                INSERT INTO agents (username, name, password_hash, is_admin)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET
                    name=EXCLUDED.name,
                    password_hash=EXCLUDED.password_hash,
                    is_admin=EXCLUDED.is_admin
                """
            )
            params = (username, name, password_hash, int(is_admin))
            if self.use_postgres:
                await db.execute(query, *params)
            else:
                await db.execute(query, params)
                await db.commit()

    async def list_agents(self) -> List[dict]:
        async with self._conn() as db:
            if self.use_postgres:
                query = self._convert("SELECT username, name, is_admin, created_at FROM agents ORDER BY created_at DESC")
                rows = await db.fetch(query)
                return [dict(r) for r in rows]
            else:
                query = self._convert("SELECT username, name, is_admin, created_at FROM agents ORDER BY datetime(created_at) DESC")
                cur = await db.execute(query)
                rows = await cur.fetchall()
                return [dict(r) for r in rows]

    async def delete_agent(self, username: str):
        async with self._conn() as db:
            query = self._convert("DELETE FROM agents WHERE username = ?")
            params = (username,)
            if self.use_postgres:
                await db.execute(query, *params)
            else:
                await db.execute(query, params)
                await db.commit()

    async def get_agent_password_hash(self, username: str) -> Optional[str]:
        async with self._conn() as db:
            query = self._convert("SELECT password_hash FROM agents WHERE username = ?")
            params = (username,)
            if self.use_postgres:
                row = await db.fetchrow(query, *params)
            else:
                cur = await db.execute(query, params)
                row = await cur.fetchone()
            return row[0] if row else None

    # ── Conversation metadata (assignment, tags, avatar) ───────────
    async def get_conversation_meta(self, user_id: str) -> dict:
        async with self._conn() as db:
            query = self._convert("SELECT assigned_agent, tags, avatar_url FROM conversation_meta WHERE user_id = ?")
            params = (user_id,)
            if self.use_postgres:
                row = await db.fetchrow(query, *params)
            else:
                cur = await db.execute(query, params)
                row = await cur.fetchone()
            if not row:
                return {}
            d = dict(row)
            try:
                if isinstance(d.get("tags"), str):
                    d["tags"] = json.loads(d["tags"]) if d["tags"] else []
            except Exception:
                d["tags"] = []
            return d

    async def upsert_conversation_meta(self, user_id: str, assigned_agent: Optional[str] = None, tags: Optional[List[str]] = None, avatar_url: Optional[str] = None):
        async with self._conn() as db:
            existing = await self.get_conversation_meta(user_id)
            new_tags = tags if tags is not None else existing.get("tags")
            new_assignee = assigned_agent if assigned_agent is not None else existing.get("assigned_agent")
            new_avatar = avatar_url if avatar_url is not None else existing.get("avatar_url")

            query = self._convert(
                """
                INSERT INTO conversation_meta (user_id, assigned_agent, tags, avatar_url)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    assigned_agent=EXCLUDED.assigned_agent,
                    tags=EXCLUDED.tags,
                    avatar_url=EXCLUDED.avatar_url
                """
            )
            params = (user_id, new_assignee, json.dumps(new_tags) if isinstance(new_tags, list) else new_tags, new_avatar)
            if self.use_postgres:
                await db.execute(query, *params)
            else:
                await db.execute(query, params)
                await db.commit()

    async def set_conversation_assignment(self, user_id: str, agent_username: Optional[str]):
        await self.upsert_conversation_meta(user_id, assigned_agent=agent_username)

    async def set_conversation_tags(self, user_id: str, tags: List[str]):
        await self.upsert_conversation_meta(user_id, tags=tags)

    # ── UPSERT with status-precedence ──
    async def upsert_message(self, data: dict):
        """
        Insert a new row or update an existing one (found by wa_message_id OR temp_id).
        The status is *only* upgraded – you can't go from 'delivered' ➜ 'sent', etc.
        """
        # Drop any keys not present in the messages table to avoid SQL errors
        data = {k: v for k, v in data.items() if k in self.message_columns}

        async with self._conn() as db:
            row = None
            if data.get("wa_message_id") and data.get("user_id"):
                query = self._convert("SELECT * FROM messages WHERE user_id = ? AND wa_message_id = ?")
                params = [data["user_id"], data["wa_message_id"]]
                if self.use_postgres:
                    row = await db.fetchrow(query, *params)
                else:
                    cur = await db.execute(query, tuple(params))
                    row = await cur.fetchone()

            if not row and data.get("temp_id") and data.get("user_id"):
                query = self._convert("SELECT * FROM messages WHERE user_id = ? AND temp_id = ?")
                params = [data["user_id"], data["temp_id"]]
                if self.use_postgres:
                    row = await db.fetchrow(query, *params)
                else:
                    cur = await db.execute(query, tuple(params))
                    row = await cur.fetchone()

            # 2) decide insert vs update
            if row:
                current_status = row["status"]
                new_status     = data.get("status", current_status)

                # only overwrite if status is an upgrade
                if _STATUS_RANK.get(new_status, 0) < _STATUS_RANK.get(current_status, 0):
                    return  # ignore downgrade

                merged = {**dict(row), **data}
                cols = [k for k in merged.keys() if k != "id"]
                sets = ", ".join(f"{c}=:{c}" for c in cols)
                merged["id"] = row["id"]
                query = self._convert(f"UPDATE messages SET {sets} WHERE id = :id")
                if self.use_postgres:
                    await db.execute(query, *[merged[c] for c in cols + ["id"]])
                else:
                    await db.execute(query, merged)
            else:
                # Avoid inserting placeholder rows without a user_id (would violate NOT NULL)
                if not data.get("user_id"):
                    return
                cols = ", ".join(data.keys())
                qs   = ", ".join("?" for _ in data)
                query = self._convert(f"INSERT INTO messages ({cols}) VALUES ({qs})")
                try:
                    if self.use_postgres:
                        await db.execute(query, *data.values())
                    else:
                        await db.execute(query, tuple(data.values()))
                except Exception as exc:
                    # If a concurrent insert violated unique (user_id, temp_id|wa_message_id), fall back to update
                    try:
                        if data.get("wa_message_id"):
                            sel = self._convert("SELECT * FROM messages WHERE user_id = ? AND wa_message_id = ?")
                            params = [data["user_id"], data["wa_message_id"]]
                        else:
                            sel = self._convert("SELECT * FROM messages WHERE user_id = ? AND temp_id = ?")
                            params = [data["user_id"], data.get("temp_id")]
                        if self.use_postgres:
                            row = await db.fetchrow(sel, *params)
                        else:
                            cur = await db.execute(sel, tuple(params))
                            row = await cur.fetchone()
                        if row:
                            current_status = row["status"]
                            new_status = data.get("status", current_status)
                            if _STATUS_RANK.get(new_status, 0) < _STATUS_RANK.get(current_status, 0):
                                return
                            merged = {**dict(row), **data}
                            cols2 = [k for k in merged.keys() if k != "id"]
                            sets2 = ", ".join(f"{c}=:{c}" for c in cols2)
                            merged["id"] = row["id"]
                            upd = self._convert(f"UPDATE messages SET {sets2} WHERE id = :id")
                            if self.use_postgres:
                                await db.execute(upd, *[merged[c] for c in cols2 + ["id"]])
                            else:
                                await db.execute(upd, merged)
                    except Exception:
                        raise exc
            if not self.use_postgres:
                await db.commit()

    # ── wrapper helpers re-used elsewhere ──
    async def get_messages(self, user_id: str, offset=0, limit=50) -> list[dict]:
        """Return the last N messages for a conversation, in chronological order (oldest→newest).

        Pagination is based on newest-first windows on the DB side (DESC with OFFSET),
        then reversed in-memory to chronological order for the UI.
        """
        async with self._conn() as db:
            if self.use_postgres:
                # In Postgres the column is TEXT, but ISO-8601 strings sort correctly lexicographically
                query = self._convert(
                    "SELECT * FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?"
                )
            else:
                # SQLite: avoid datetime() wrapper because our timestamps are ISO-8601 with 'T'
                # which sort correctly as TEXT
                query = self._convert(
                    "SELECT * FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?"
                )
            params = [user_id, limit, offset]
            if self.use_postgres:
                rows = await db.fetch(query, *params)
            else:
                cur = await db.execute(query, tuple(params))
                rows = await cur.fetchall()
            # Reverse to chronological order for display
            ordered = [dict(r) for r in rows][::-1]
            return ordered

    async def get_messages_since(self, user_id: str, since_timestamp: str, limit: int = 500) -> list[dict]:
        """Return messages newer than the given ISO-8601 timestamp, ascending order.

        Relies on ISO-8601 lexicographic ordering for TEXT timestamps.
        """
        async with self._conn() as db:
            query = self._convert(
                "SELECT * FROM messages WHERE user_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?"
            )
            params = [user_id, since_timestamp, limit]
            if self.use_postgres:
                rows = await db.fetch(query, *params)
            else:
                cur = await db.execute(query, tuple(params))
                rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def get_messages_before(self, user_id: str, before_timestamp: str, limit: int = 50) -> list[dict]:
        """Return messages older than the given ISO-8601 timestamp, ascending order.

        On the DB side we fetch newest-first (DESC) window older than the pivot,
        then reverse to chronological order for display.
        """
        async with self._conn() as db:
            query = self._convert(
                "SELECT * FROM messages WHERE user_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?"
            )
            params = [user_id, before_timestamp, limit]
            if self.use_postgres:
                rows = await db.fetch(query, *params)
            else:
                cur = await db.execute(query, tuple(params))
                rows = await cur.fetchall()
            return [dict(r) for r in rows][::-1]

    async def update_message_status(self, wa_message_id: str, status: str):
        await self.upsert_message({"wa_message_id": wa_message_id, "status": status})

    async def get_user_for_message(self, wa_message_id: str) -> str | None:
        async with self._conn() as db:
            query = self._convert("SELECT user_id FROM messages WHERE wa_message_id = ?")
            params = [wa_message_id]
            if self.use_postgres:
                row = await db.fetchrow(query, *params)
            else:
                cur = await db.execute(query, tuple(params))
                row = await cur.fetchone()
            return row["user_id"] if row else None

    async def upsert_user(self, user_id: str, name=None, phone=None, is_admin: int | None = None):
        async with self._conn() as db:
            if is_admin is None:
                query = self._convert(
                    """
                    INSERT INTO users (user_id, name, phone, last_seen)
                    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id) DO UPDATE SET
                        name=COALESCE(EXCLUDED.name, users.name),
                        phone=COALESCE(EXCLUDED.phone, users.phone),
                        last_seen=CURRENT_TIMESTAMP
                    """
                )
                params = (user_id, name, phone)
            else:
                query = self._convert(
                    """
                    INSERT INTO users (user_id, name, phone, is_admin, last_seen)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id) DO UPDATE SET
                        name=COALESCE(EXCLUDED.name, users.name),
                        phone=COALESCE(EXCLUDED.phone, users.phone),
                        is_admin=EXCLUDED.is_admin,
                        last_seen=CURRENT_TIMESTAMP
                    """
                )
                params = (user_id, name, phone, int(is_admin))

            if self.use_postgres:
                await db.execute(query, *params)
            else:
                await db.execute(query, params)
                await db.commit()

    async def save_message(self, message: dict, wa_message_id: str, status: str):
        """Persist a sent message using the final WhatsApp ID."""
        data = {
            "wa_message_id": wa_message_id,
            "temp_id": message.get("temp_id") or message.get("id"),
            "user_id": message.get("user_id"),
            "message": message.get("message"),
            "type": message.get("type", "text"),
            "from_me": 1,
            "status": status,
            "price": message.get("price"),
            "caption": message.get("caption"),
            "url": message.get("url"),
            "media_path": message.get("media_path"),
            "timestamp": message.get("timestamp"),
        }
        # Remove None values so SQL doesn't fail on NOT NULL columns
        clean = {k: v for k, v in data.items() if v is not None}
        await self.upsert_message(clean)

    async def mark_messages_as_read(self, user_id: str, message_ids: List[str] | None = None):
        """Mark one or all messages in a conversation as read."""
        async with self._conn() as db:
            if message_ids:
                placeholders = ",".join("?" * len(message_ids))
                query = self._convert(
                    f"UPDATE messages SET status='read' WHERE user_id = ? AND wa_message_id IN ({placeholders})"
                )
                params = [user_id, *message_ids]
            else:
                query = self._convert(
                    "UPDATE messages SET status='read' WHERE user_id = ? AND from_me = 0 AND status != 'read'"
                )
                params = [user_id]
            if self.use_postgres:
                await db.execute(query, *params)
            else:
                await db.execute(query, tuple(params))
                await db.commit()

    async def get_admin_users(self) -> List[str]:
        """Return list of user_ids flagged as admins."""
        async with self._conn() as db:
            query = self._convert("SELECT user_id FROM users WHERE is_admin = 1")
            if self.use_postgres:
                rows = await db.fetch(query)
            else:
                cur = await db.execute(query)
                rows = await cur.fetchall()
            return [r["user_id"] for r in rows]

    async def get_conversations_with_stats(self, q: Optional[str] = None, unread_only: bool = False, assigned: Optional[str] = None, tags: Optional[List[str]] = None) -> List[dict]:
        """Return conversation summaries for chat list with optional filters."""
        async with self._conn() as db:
            if self.use_postgres:
                user_rows = await db.fetch(self._convert("SELECT DISTINCT user_id FROM messages"))
            else:
                # SQLite: DISTINCT user_id is fine
                cur = await db.execute(self._convert("SELECT DISTINCT user_id FROM messages"))
                user_rows = await cur.fetchall()
            user_ids = [r["user_id"] for r in user_rows]

            conversations = []
            for uid in user_ids:
                params = [uid]
                if self.use_postgres:
                    user = await db.fetchrow(self._convert("SELECT name, phone FROM users WHERE user_id = ?"), *params)
                else:
                    cur = await db.execute(self._convert("SELECT name, phone FROM users WHERE user_id = ?"), tuple(params))
                    user = await cur.fetchone()

                if self.use_postgres:
                    last = await db.fetchrow(
                        self._convert(
                            "SELECT message, timestamp FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1"
                        ),
                        uid,
                    )
                else:
                    cur = await db.execute(
                        self._convert(
                            "SELECT message, timestamp FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1"
                        ),
                        (uid,)
                    )
                    last = await cur.fetchone()
                last_msg = last["message"] if last else None
                last_time = last["timestamp"] if last else None

                if self.use_postgres:
                    unread_row = await db.fetchrow(
                        self._convert("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND from_me = 0 AND status != 'read'"),
                        uid,
                    )
                else:
                    cur = await db.execute(
                        self._convert("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND from_me = 0 AND status != 'read'"),
                        (uid,)
                    )
                    unread_row = await cur.fetchone()
                unread = unread_row["c"]

                if self.use_postgres:
                    last_agent_row = await db.fetchrow(
                        self._convert(
                            "SELECT MAX(timestamp) as t FROM messages WHERE user_id = ? AND from_me = 1"
                        ),
                        uid,
                    )
                else:
                    cur = await db.execute(
                        self._convert(
                            "SELECT MAX(timestamp) as t FROM messages WHERE user_id = ? AND from_me = 1"
                        ),
                        (uid,)
                    )
                    last_agent_row = await cur.fetchone()
                last_agent = last_agent_row["t"] or "1970-01-01"

                if self.use_postgres:
                    unr_row = await db.fetchrow(
                        self._convert(
                            "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND from_me = 0 AND timestamp > ?"
                        ),
                        uid,
                        last_agent,
                    )
                else:
                    cur = await db.execute(
                        self._convert(
                            "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND from_me = 0 AND timestamp > ?"
                        ),
                        (uid, last_agent),
                    )
                    unr_row = await cur.fetchone()
                unresponded = unr_row["c"]

                meta = await self.get_conversation_meta(uid)
                conv = {
                    "user_id": uid,
                    "name": user["name"] if user else None,
                    "phone": user["phone"] if user else None,
                    "last_message": last_msg,
                    "last_message_time": last_time,
                    "unread_count": unread,
                    "unresponded_count": unresponded,
                    "avatar": meta.get("avatar_url"),
                    "assigned_agent": meta.get("assigned_agent"),
                    "tags": meta.get("tags", []),
                }
                # Apply filters in-memory for simplicity
                if q:
                    t = (conv.get("name") or conv.get("user_id") or "").lower()
                    if q.lower() not in t:
                        continue
                if unread_only and not (conv.get("unread_count") or 0) > 0:
                    continue
                if assigned is not None:
                    if assigned == "unassigned" and conv.get("assigned_agent"):
                        continue
                    if assigned not in (None, "unassigned") and conv.get("assigned_agent") != assigned:
                        continue
                if tags:
                    conv_tags = set(conv.get("tags") or [])
                    if not set(tags).issubset(conv_tags):
                        continue
                # filter conversations that need a reply if requested later via route param
                conversations.append(conv)

            conversations.sort(key=lambda x: x["last_message_time"] or "", reverse=True)
            return conversations

    # ── Settings (key/value JSON) ──────────────────────────────────
    async def get_setting(self, key: str) -> Optional[str]:
        async with self._conn() as db:
            query = self._convert("SELECT value FROM settings WHERE key = ?")
            params = (key,)
            if self.use_postgres:
                row = await db.fetchrow(query, *params)
                return row[0] if row else None
            else:
                cur = await db.execute(query, params)
                row = await cur.fetchone()
                return row[0] if row else None

    async def set_setting(self, key: str, value: Any):
        # value is JSON-serializable
        data = json.dumps(value)
        async with self._conn() as db:
            query = self._convert(
                """
                INSERT INTO settings (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value
                """
            )
            params = (key, data)
            if self.use_postgres:
                await db.execute(query, *params)
            else:
                await db.execute(query, params)
                await db.commit()

    async def get_tag_options(self) -> List[dict]:
        raw = await self.get_setting("tag_options")
        try:
            options = json.loads(raw) if raw else []
            # ensure list of dicts with label and icon
            cleaned = []
            for opt in options or []:
                if isinstance(opt, dict) and opt.get("label"):
                    cleaned.append({"label": opt["label"], "icon": opt.get("icon", "")})
                elif isinstance(opt, str):
                    cleaned.append({"label": opt, "icon": ""})
            return cleaned
        except Exception:
            return []

    async def set_tag_options(self, options: List[dict]):
        # Persist as provided
        await self.set_setting("tag_options", options)

    # ----- Order payout helpers -----
    async def add_delivered_order(self, order_id: str):
        """Add an order to the payouts list."""
        async with self._conn() as db:
            query = self._convert(
                """
                INSERT INTO orders (order_id, status)
                VALUES (?, ?)
                ON CONFLICT(order_id) DO UPDATE SET status=?
                """
            )
            params = [order_id, ORDER_STATUS_PAYOUT, ORDER_STATUS_PAYOUT]
            if self.use_postgres:
                await db.execute(query, *params)
            else:
                await db.execute(query, tuple(params))
                await db.commit()

    async def mark_payout_paid(self, order_id: str):
        """Archive an order once its payout has been processed."""
        async with self._conn() as db:
            query = self._convert("UPDATE orders SET status=? WHERE order_id = ?")
            params = [ORDER_STATUS_ARCHIVED, order_id]
            if self.use_postgres:
                await db.execute(query, *params)
            else:
                await db.execute(query, tuple(params))
                await db.commit()

    async def get_payouts(self) -> List[dict]:
        """Return orders currently awaiting payout."""
        async with self._conn() as db:
            if self.use_postgres:
                query = self._convert(
                    "SELECT * FROM orders WHERE status=? ORDER BY created_at DESC"
                )
            else:
                query = self._convert(
                    "SELECT * FROM orders WHERE status=? ORDER BY datetime(created_at) DESC"
                )
            params = [ORDER_STATUS_PAYOUT]
            if self.use_postgres:
                rows = await db.fetch(query, *params)
            else:
                cur = await db.execute(query, tuple(params))
                rows = await cur.fetchall()
            return [dict(r) for r in rows]

    async def get_archived_orders(self) -> List[dict]:
        """Return archived (paid) orders."""
        async with self._conn() as db:
            if self.use_postgres:
                query = self._convert(
                    "SELECT * FROM orders WHERE status=? ORDER BY created_at DESC"
                )
            else:
                query = self._convert(
                    "SELECT * FROM orders WHERE status=? ORDER BY datetime(created_at) DESC"
                )
            params = [ORDER_STATUS_ARCHIVED]
            if self.use_postgres:
                rows = await db.fetch(query, *params)
            else:
                cur = await db.execute(query, tuple(params))
                rows = await cur.fetchall()
            return [dict(r) for r in rows]

# Message Processor with Complete Optimistic UI
class MessageProcessor:
    def __init__(self, connection_manager: ConnectionManager, redis_manager: RedisManager, db_manager: DatabaseManager):
        self.connection_manager = connection_manager
        self.redis_manager = redis_manager
        self.db_manager = db_manager
        self.whatsapp_messenger = WhatsAppMessenger()
        self.media_dir = MEDIA_DIR
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
        timestamp = datetime.now(timezone.utc).isoformat()
        
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
            "media_path": message_data.get("media_path"),  # Add this field
            # Pass-through identifiers for catalog items so background sender can use them
            "product_retailer_id": (
                message_data.get("product_retailer_id")
                or message_data.get("retailer_id")
                or message_data.get("product_id")
            ),
            # Preserve raw fields as well for debugging/DB if present
            "retailer_id": message_data.get("retailer_id"),
            "product_id": message_data.get("product_id"),
            # reply/reactions passthrough
            "reply_to": message_data.get("reply_to"),
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
        # Internal channels: user_id starting with "team:", "agent:", or "dm:" are NOT sent to WhatsApp
        if isinstance(user_id, str) and (
            user_id.startswith("team:") or user_id.startswith("agent:") or user_id.startswith("dm:")
        ):
            try:
                # Mark as sent immediately for internal channels
                await self.connection_manager.send_to_user(
                    user_id,
                    {"type": "message_status_update", "data": {"temp_id": temp_id, "status": "sent"}},
                )
                final_record = {**message, "status": "sent"}
                await self.db_manager.upsert_message(final_record)
                await self.redis_manager.cache_message(user_id, final_record)
                # Let admin dashboards update their lists
                try:
                    await self.connection_manager.broadcast_to_admins(
                        {"type": "message_received", "data": final_record}
                    )
                except Exception:
                    pass
            except Exception as exc:
                print(f"Internal channel processing error: {exc}")
            return
        
        try:
            # Send to WhatsApp API with concurrency guard
            async with wa_semaphore:
                if message["type"] == "text":
                    wa_response = await self.whatsapp_messenger.send_text_message(
                        user_id, message["message"], context_message_id=message.get("reply_to")
                    )
                elif message["type"] in ("catalog_item", "interactive_product"):
                    # Interactive single product via catalog
                    retailer_id = (
                        message.get("product_retailer_id")
                        or message.get("retailer_id")
                        or message.get("product_id")
                    )
                    caption = message.get("caption") or message.get("message") or ""
                    if not retailer_id:
                        raise Exception("Missing product_retailer_id for catalog_item")
                    wa_response = await self.whatsapp_messenger.send_single_catalog_item(
                        user_id, str(retailer_id), caption
                    )
                elif message["type"] == "order":
                    # For now send order payload as text to ensure delivery speed
                    payload = message.get("message")
                    wa_response = await self.whatsapp_messenger.send_text_message(
                        user_id, payload if isinstance(payload, str) else json.dumps(payload or {})
                    )
                else:
                    # For media messages: support either local path upload or direct link
                    media_path = message.get("media_path")
                    media_url = message.get("url")
                    # If we have a local path, optionally normalize audio, then upload both to WA and GCS
                    if media_path and Path(media_path).exists():
                        # Background upload to GCS to produce public URL for UI; don't block WA send
                        gcs_url: Optional[str] = None
                        try:
                            # Normalize audio to OGG if needed
                            if message["type"] == "audio" and not str(media_path).lower().endswith(".ogg"):
                                try:
                                    ogg_path = await convert_webm_to_ogg(Path(media_path))
                                    media_path = str(ogg_path)
                                except Exception as _exc:
                                    print(f"Audio normalization skipped: {_exc}")
                            gcs_url = await upload_file_to_gcs(str(media_path))
                            if gcs_url:
                                # Notify UI and persist URL when ready
                                try:
                                    await self.connection_manager.send_to_user(user_id, {
                                        "type": "message_status_update",
                                        "data": {"temp_id": temp_id, "url": gcs_url}
                                    })
                                except Exception:
                                    pass
                                try:
                                    await self.db_manager.upsert_message({
                                        "user_id": user_id,
                                        "temp_id": temp_id,
                                        "url": gcs_url,
                                    })
                                    await self.redis_manager.cache_message(user_id, {**message, "url": gcs_url})
                                except Exception:
                                    pass
                        except Exception as _exc:
                            print(f"GCS upload failed (non-fatal): {_exc}")

                        print(f"📤 Uploading media to WhatsApp: {media_path}")
                        media_id = await self._upload_media_to_whatsapp(media_path, message["type"])
                        if message.get("reply_to"):
                            wa_response = await self.whatsapp_messenger.send_media_message(
                                user_id, message["type"], media_id, message.get("caption", ""), context_message_id=message.get("reply_to")
                            )
                        else:
                            wa_response = await self.whatsapp_messenger.send_media_message(
                                user_id, message["type"], media_id, message.get("caption", "")
                            )
                    elif media_url and isinstance(media_url, str) and media_url.startswith(("http://", "https://")):
                        if message.get("reply_to"):
                            wa_response = await self.whatsapp_messenger.send_media_message(
                                user_id, message["type"], media_url, message.get("caption", ""), context_message_id=message.get("reply_to")
                            )
                        else:
                            wa_response = await self.whatsapp_messenger.send_media_message(
                                user_id, message["type"], media_url, message.get("caption", "")
                            )
                    else:
                        raise Exception("No media found: require url http(s) or valid media_path")
            
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
                    "status": "sent"
                }
            }
            
            # Send status update to UI
            await self.connection_manager.send_to_user(user_id, status_update)
            
            # Save to database with real WhatsApp ID
            await self.db_manager.save_message(message, wa_message_id, "sent")
            
            _vlog(f"✅ Message sent successfully: {wa_message_id}")
            
        except Exception as e:
            print(f"❌ WhatsApp send failed: {e}")
            # Update UI with error status
            error_update = {
                "type": "message_status_update", 
                "data": {
                    "temp_id": temp_id,
                    "status": "failed",
                    "error": str(e)
                }
            }
            await self.connection_manager.send_to_user(user_id, error_update)
        finally:
            media_path = message.get("media_path")
            if media_path and Path(media_path).exists():
                try:
                    Path(media_path).unlink(missing_ok=True)
                except Exception as e:
                    print(f"⚠️ Cleanup failed for {media_path}: {e}")

    async def _upload_media_to_whatsapp(self, file_path: str, media_type: str) -> str:
        """Upload media file to WhatsApp and return media_id"""
        if not Path(file_path).exists():
            raise Exception(f"Media file not found: {file_path}")
        
        upload_url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{self.whatsapp_messenger.phone_number_id}/media"
        
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
                
                _vlog(f"📤 WhatsApp upload response: {response.status_code}")
                _vlog(f"📤 Response body: {response.text}")
                
                if response.status_code != 200:
                    raise Exception(f"WhatsApp media upload failed: {response.text}")
                
                result = response.json()
                media_id = result.get("id")
                
                if not media_id:
                    raise Exception(f"No media_id in WhatsApp response: {result}")
                
                _vlog(f"✅ Media uploaded successfully. ID: {media_id}")
                return media_id
                
        except httpx.TimeoutException:
            raise Exception("WhatsApp upload timeout - file may be too large")
        except Exception as e:
            print(f"❌ Media upload error: {e}")
            raise Exception(f"Failed to upload media to WhatsApp: {str(e)}")
    
    async def process_incoming_message(self, webhook_data: dict):
        _vlog("🚨 process_incoming_message CALLED")
        _vlog(json.dumps(webhook_data, indent=2))
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

            # Update DB and fetch temp_id/user_id (skip if user_id unknown)
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
        
        sender = message.get("from") or (message.get("contact_info") or {}).get("wa_id")
        if not sender:
            raise RuntimeError("incoming message missing sender id")
        msg_type = message["type"]
        wa_message_id = message.get("id")
        timestamp = datetime.utcfromtimestamp(int(message.get("timestamp", 0))).isoformat()
        
        # Extract contact name from contacts array if available
        contact_name = None
        # Note: contacts info is typically in the webhook's 'contacts' field, not message
        
        await self.db_manager.upsert_user(sender, contact_name, sender)
        
        # Special case: reactions are not normal bubbles – broadcast an update instead
        if msg_type == "reaction":
            reaction = message.get("reaction", {})
            target_id = reaction.get("message_id")
            emoji = reaction.get("emoji")
            action = reaction.get("action", "react")
            reaction_event = {
                "type": "reaction_update",
                "data": {
                    "user_id": sender,
                    "target_wa_message_id": target_id,
                    "emoji": emoji,
                    "action": action,
                    "from_me": False,
                    "wa_message_id": wa_message_id,
                    "timestamp": timestamp,
                },
            }
            try:
                # Persist a lightweight record for auditing/history
                await self.db_manager.upsert_message({
                    "wa_message_id": wa_message_id,
                    "user_id": sender,
                    "type": "reaction",
                    "from_me": 0,
                    "status": "received",
                    "timestamp": timestamp,
                    "reaction_to": target_id,
                    "reaction_emoji": emoji,
                    "reaction_action": action,
                })
            except Exception:
                pass
            # Notify UI
            await self.connection_manager.send_to_user(sender, reaction_event)
            await self.connection_manager.broadcast_to_admins(reaction_event, exclude_user=sender)
            return

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
            image_path, drive_url = await self._download_media(message["image"]["id"], "image")
            message_obj["message"] = image_path
            message_obj["url"] = drive_url
            message_obj["caption"] = message["image"].get("caption", "")
        elif msg_type == "sticker":
            # Treat stickers as images for display purposes
            try:
                sticker_path, drive_url = await self._download_media(message["sticker"]["id"], "image")
                message_obj["type"] = "image"
                message_obj["message"] = sticker_path
                message_obj["url"] = drive_url
                message_obj["caption"] = ""
            except Exception:
                # Fallback to a text label if download fails
                message_obj["type"] = "text"
                message_obj["message"] = "[sticker]"
        elif msg_type == "audio":
            audio_path, drive_url = await self._download_media(message["audio"]["id"], "audio")
            message_obj["message"] = audio_path
            message_obj["url"] = drive_url
            message_obj["transcription"] = ""
        elif msg_type == "video":
            video_path, drive_url = await self._download_media(message["video"]["id"], "video")
            message_obj["message"] = video_path
            message_obj["url"] = drive_url
            message_obj["caption"] = message["video"].get("caption", "")
        elif msg_type == "order":
            message_obj["message"] = json.dumps(message.get("order", {}))

        # Replies: capture quoted message id if present
        try:
            ctx = message.get("context") or {}
            if isinstance(ctx, dict) and ctx.get("id"):
                message_obj["reply_to"] = ctx.get("id")
        except Exception:
            pass
        
        # Send to UI and process...
        await self.connection_manager.send_to_user(sender, {
            "type": "message_received",
            "data": message_obj
        })

        # Notify any admin dashboards about the new message
        await self.connection_manager.broadcast_to_admins(
            {"type": "message_received", "data": message_obj},
            exclude_user=sender
        )

        # Cache and save to database. Remove "id" so SQLite doesn't try to
        # insert the text wa_message_id into the INTEGER primary key column.
        db_data = {k: v for k, v in message_obj.items() if k != "id"}
        await self.redis_manager.cache_message(sender, db_data)
        await self.db_manager.upsert_message(db_data)
        
        # Auto-reply with catalog match for text messages
        try:
            if msg_type == "text":
                await self._maybe_auto_reply_with_catalog(sender, message_obj.get("message", ""))
        except Exception as _exc:
            # Never break incoming flow due to auto-reply errors
            print(f"Auto-reply failed: {_exc}")

    # ------------------------- auto-reply helpers -------------------------
    def _extract_product_retailer_id(self, text: str) -> Optional[str]:
        """Extract the last numeric product id from the user's text.

        Priority:
        - Explicit pattern like "ID: 123456789"
        - Otherwise, last long digit sequence (>= 6 digits)
        """
        try:
            if not text:
                return None
            # 1) Explicit label "ID: <digits>"
            m = re.search(r"\bID\s*[:：]\s*(\d{6,})\b", text, re.IGNORECASE)
            if m:
                return m.group(1)
            # 2) Any long digit sequences; pick the last one
            candidates = re.findall(r"(\d{6,})", text)
            if candidates:
                return candidates[-1]
        except Exception:
            pass
        return None
    def _normalize_for_match(self, text: str) -> list[str]:
        text_lc = (text or "").lower()
        # Replace non-alphanumerics with space and split
        tokens = re.split(r"[^a-z0-9]+", text_lc)
        return [t for t in tokens if len(t) >= 2]

    def _score_product_name_match(self, text_tokens: list[str], product_name: Optional[str]) -> float:
        if not product_name:
            return 0.0
        name_tokens = self._normalize_for_match(product_name)
        if not name_tokens:
            return 0.0
        name_token_set = set(name_tokens)
        text_token_set = set(text_tokens)
        common = name_token_set.intersection(text_token_set)
        # Base score: token overlap ratio relative to product name tokens
        score = len(common) / max(1, len(name_token_set))
        # Bonus if full normalized name appears as substring of text
        text_joined = " ".join(text_tokens)
        name_joined = " ".join(name_tokens)
        if name_joined and name_joined in text_joined:
            score += 0.2
        return min(score, 1.0)

    def _best_catalog_match(self, text: str) -> Optional[dict]:
        try:
            products = catalog_manager.get_cached_products()
        except Exception:
            products = []
        if not products:
            return None
        text_tokens = self._normalize_for_match(text)
        if not text_tokens:
            return None
        best: tuple[float, dict] | None = None
        for product in products:
            score = self._score_product_name_match(text_tokens, product.get("name"))
            if score <= 0:
                continue
            # Require at least one image to reply
            images = product.get("images") or []
            if not images:
                continue
            if not best or score > best[0]:
                best = (score, product)
        if not best:
            return None
        if best[0] < AUTO_REPLY_MIN_SCORE:
            return None
        return best[1]

    async def _maybe_auto_reply_with_catalog(self, user_id: str, text: str) -> None:
        if not AUTO_REPLY_CATALOG_MATCH:
            return
        # 1) Try explicit retailer_id extraction from text
        retailer_id = self._extract_product_retailer_id(text)
        if retailer_id:
            try:
                products = catalog_manager.get_cached_products()
            except Exception:
                products = []
            if products:
                matched = next((p for p in products if str(p.get("retailer_id")) == str(retailer_id)), None)
            else:
                matched = None

            if matched:
                # Send interactive catalog item
                await self.process_outgoing_message({
                    "user_id": user_id,
                    "type": "catalog_item",
                    "from_me": True,
                    "product_retailer_id": str(retailer_id),
                    "caption": matched.get("name") or "",
                    "timestamp": datetime.utcnow().isoformat(),
                })
                # Then follow-up Arabic confirmation below the catalog item
                await self.process_outgoing_message({
                    "user_id": user_id,
                    "type": "text",
                    "from_me": True,
                    "message": "أهلًا بك! يرجى تأكيد المقاس واللون المطلوبين لهذا المنتج.",
                    "timestamp": datetime.utcnow().isoformat(),
                })
                return

        # 2) Fallback to name-based best match using score threshold
        product = self._best_catalog_match(text)
        if not product:
            return
        images = product.get("images") or []
        if not images:
            return
        image_url = images[0].get("url")
        if not image_url:
            return
        caption_parts = [p for p in [product.get("name"), product.get("price")] if p]
        caption = " - ".join(caption_parts)
        message_data = {
            "user_id": user_id,
            "message": image_url,
            "url": image_url,
            "type": "image",
            "from_me": True,
            "caption": caption,
            "price": product.get("price", ""),
            "timestamp": datetime.utcnow().isoformat(),
        }
        await self.process_outgoing_message(message_data)

    async def _download_media(self, media_id: str, media_type: str) -> tuple[str, str]:
        """Download media from WhatsApp and upload it to Google Cloud Storage.

        Returns a tuple ``(local_path, drive_url)`` where ``drive_url`` is the
        public link to the uploaded file. Raises an exception if the upload
        fails so callers don't fall back to local paths.
        """
        try:
            media_content, mime_type = await self.whatsapp_messenger.download_media(media_id)
            mime_type = mime_type.split(';', 1)[0].strip()

            timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            file_extension = mimetypes.guess_extension(mime_type) or ""
            if not file_extension and mime_type.startswith("audio/"):
                file_extension = ".ogg"
            filename = f"{media_type}_{timestamp}_{media_id[:8]}{file_extension}"
            file_path = self.media_dir / filename

            async with aiofiles.open(file_path, 'wb') as f:
                await f.write(media_content)

            drive_url = await upload_file_to_gcs(
                str(file_path), mime_type
            )
            if not drive_url:
                raise RuntimeError("GCS upload failed")

            # Return a relative path for clients and the public GCS URL
            return f"/media/{filename}", drive_url

        except Exception as e:
            print(f"Error downloading media {media_id}: {e}")
            raise

# ------------------------- helpers -------------------------

async def lookup_phone(user_id: str) -> Optional[str]:
    """Return the stored phone number for a user, if available."""
    try:
        async with db_manager._conn() as conn:
            cur = await conn.execute(
                "SELECT phone FROM users WHERE user_id = ?",
                (user_id,),
            )
            row = await cur.fetchone()
            if row:
                phone = row["phone"]
                if phone:
                    return str(phone)
    except Exception as exc:
        print(f"lookup_phone error: {exc}")
    return None

# Initialize managers
db_manager = DatabaseManager()
connection_manager = ConnectionManager()
redis_manager = RedisManager()
message_processor = MessageProcessor(connection_manager, redis_manager, db_manager)
messenger = message_processor.whatsapp_messenger

# FastAPI app
app = FastAPI(default_response_class=(ORJSONResponse if _ORJSON_AVAILABLE else JSONResponse))

# Expose Prometheus metrics
Instrumentator().instrument(app).expose(app, endpoint="/metrics")

# Enable Shopify integration only if it can be imported/configured.
try:
    from .shopify_integration import router as shopify_router  # type: ignore
    app.include_router(shopify_router)
    print("✅ Shopify integration routes enabled")
except Exception as exc:
    print(f"⚠️ Shopify integration disabled: {exc}")


# Mount the media directory to serve uploaded files
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")

# Configure CORS via environment (comma-separated list). Default to '*'.
_allowed_origins = os.getenv("ALLOWED_ORIGINS", "*")
allowed_origins = [o.strip() for o in _allowed_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins if allowed_origins else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Compression for faster responses
app.add_middleware(GZipMiddleware, minimum_size=500)

# Trusted hosts (optional but recommended in production)
_allowed_hosts_env = os.getenv("ALLOWED_HOSTS", "*")
allowed_hosts = [h.strip() for h in _allowed_hosts_env.split(",") if h.strip()]
if allowed_hosts and allowed_hosts != ["*"]:
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)

# Smart caching: no-cache HTML shell, long cache for static assets
@app.middleware("http")
async def no_cache_html(request: StarletteRequest, call_next):
    response: StarletteResponse = await call_next(request)
    path = request.url.path or "/"
    if path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    # Enable long-lived cache for versioned static assets
    if (
        path.startswith("/static/")
        or path.endswith((
            ".js",
            ".css",
            ".map",
            ".png",
            ".jpg",
            ".jpeg",
            ".svg",
            ".ico",
            ".woff",
            ".woff2",
            ".ttf",
        ))
    ) and not path.endswith(".html"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response

@app.on_event("startup")
async def startup():
    logging.getLogger("httpx").setLevel(logging.WARNING)
    await db_manager.init_db()
    await redis_manager.connect()
    # Attach Redis manager to connection manager for WS pub/sub
    connection_manager.redis_manager = redis_manager
    if ENABLE_WS_PUBSUB and redis_manager.redis_client:
        asyncio.create_task(redis_manager.subscribe_ws_events(connection_manager))
    # Initialize rate limiter
    if redis_manager.redis_client:
        try:
            await FastAPILimiter.init(redis_manager.redis_client)
        except Exception as exc:
            print(f"Rate limiter init failed: {exc}")
    # Catalog cache: avoid blocking startup in production
    try:
        # Try hydrate from GCS quickly if missing
        if not os.path.exists(CATALOG_CACHE_FILE):
            try:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(
                    None,
                    download_file_from_gcs,
                    CATALOG_CACHE_FILE,
                    CATALOG_CACHE_FILE,
                )
            except Exception:
                pass

        # In tests, refresh synchronously so assertions can observe the file
        if os.getenv("PYTEST_CURRENT_TEST"):
            try:
                count = await catalog_manager.refresh_catalog_cache()
                print(f"Catalog cache created with {count} items (sync in tests)")
            except Exception as exc:
                print(f"Catalog cache refresh failed (tests): {exc}")
        else:
            # In prod, refresh in background to avoid startup timeouts
            async def _refresh_cache_bg():
                try:
                    count = await catalog_manager.refresh_catalog_cache()
                    print(f"Catalog cache created with {count} items")
                except Exception as exc:
                    print(f"Catalog cache refresh failed: {exc}")

            asyncio.create_task(_refresh_cache_bg())
    except Exception as exc:
        print(f"Catalog cache init error: {exc}")

# Optional rate limit dependencies that no-op when limiter is not initialized
async def _optional_rate_limit_text(request: _LimiterRequest, response: _LimiterResponse):
    try:
        if FastAPILimiter.redis:
            limiter = RateLimiter(times=SEND_TEXT_PER_MIN, seconds=60)
            return await limiter(request, response)
    except Exception:
        return

async def _optional_rate_limit_media(request: _LimiterRequest, response: _LimiterResponse):
    try:
        if FastAPILimiter.redis:
            limiter = RateLimiter(times=SEND_MEDIA_PER_MIN, seconds=60)
            return await limiter(request, response)
    except Exception:
        return

    

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    """WebSocket endpoint for real-time communication"""
    await connection_manager.connect(websocket, user_id)
    if user_id == "admin":
        await db_manager.upsert_user(user_id, is_admin=1)
    
    try:
        # Send recent messages on connection
        recent_messages = await redis_manager.get_recent_messages(user_id)
        if not recent_messages:
            recent_messages = await db_manager.get_messages(user_id, limit=20)
        if recent_messages:
            # Ensure chronological order for the client
            try:
                # Detect if Redis returned newest-first due to LPUSH usage
                def to_ms(t):
                    if not t: return 0
                    s = str(t)
                    if s.isdigit():
                        return int(s) * (1000 if len(s) <= 10 else 1)
                    from datetime import datetime as _dt
                    try:
                        return int(_dt.fromisoformat(s).timestamp() * 1000)
                    except Exception:
                        return 0
                recent_messages = sorted(recent_messages, key=lambda m: to_ms(m.get("timestamp")))
            except Exception:
                pass
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
        # Enforce WS backpressure: token bucket per agent
        is_media = str(message_data.get("type", "text")) in ("image", "audio", "video", "document")
        if not connection_manager._consume_ws_token(user_id, is_media=is_media):
            try:
                await websocket.send_json({
                    "type": "error",
                    "data": {
                        "code": "rate_limited",
                        "message": f"Rate limit exceeded for {'media' if is_media else 'text'} messages. Please slow down.",
                    }
                })
            except Exception:
                pass
            return
        # FIXED: Call the method on message_processor instance
        await message_processor.process_outgoing_message(message_data)

    elif message_type == "mark_as_read":
        message_ids = data.get("message_ids", [])
        if message_ids:
            message_ids = list(set(message_ids))
        print(f"Marking messages as read: {message_ids}")
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
        typing_event = {
            "type": "typing",
            "data": {"user_id": user_id, "is_typing": is_typing},
        }

        # Send to other connections of the same user (excluding sender)
        for ws in connection_manager.active_connections.get(user_id, set()).copy():
            if ws is not websocket:
                try:
                    await ws.send_json(typing_event)
                except Exception:
                    connection_manager.disconnect(ws)

        # Notify admin dashboards
        await connection_manager.broadcast_to_admins(
            typing_event, exclude_user=user_id
        )
        
    elif message_type == "react":
        # Send a reaction to a specific message
        target_id = data.get("target_wa_message_id") or data.get("message_id")
        emoji = data.get("emoji")
        action = data.get("action") or "react"
        if not (target_id and emoji):
            return
        try:
            await messenger.send_reaction(user_id, target_id, emoji, action)
        except Exception as e:
            print(f"Failed to send reaction: {e}")
            return
        event = {
            "type": "reaction_update",
            "data": {
                "user_id": user_id,
                "target_wa_message_id": target_id,
                "emoji": emoji,
                "action": action,
                "from_me": True,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        }
        await connection_manager.send_to_user(user_id, event)
        await connection_manager.broadcast_to_admins(event, exclude_user=user_id)
        try:
            await db_manager.upsert_message({
                "user_id": user_id,
                "type": "reaction",
                "from_me": 1,
                "status": "sent",
                "timestamp": event["data"]["timestamp"],
                "reaction_to": target_id,
                "reaction_emoji": emoji,
                "reaction_action": action,
            })
        except Exception:
            pass

    elif message_type == "get_conversation_history":
        offset = data.get("offset", 0)
        limit = data.get("limit", 50)
        messages = await db_manager.get_messages(user_id, offset, limit)
        await websocket.send_json({
            "type": "conversation_history",
            "data": messages
        })
    elif message_type == "resume_since":
        since = data.get("since")
        limit = int(data.get("limit", 500))
        if since:
            try:
                messages = await db_manager.get_messages_since(user_id, since, limit=limit)
                if messages:
                    await websocket.send_json({"type": "conversation_history", "data": messages})
            except Exception as e:
                print(f"resume_since failed: {e}")
    elif message_type == "ping":
        try:
            await websocket.send_json({"type": "pong", "ts": data.get("ts")})
        except Exception:
            pass

@app.api_route("/webhook", methods=["GET", "POST"])
async def webhook(request: Request):
    """WhatsApp webhook endpoint"""
    if request.method == "GET":
        # --- Meta verification logic ---
        params = dict(request.query_params)
        mode = params.get("hub.mode")
        token = params.get("hub.verify_token")
        challenge = params.get("hub.challenge")
        
        _vlog(f"🔐 Webhook verification: mode={mode}, token={token}, challenge={challenge}")
        
        if mode == "subscribe" and token == VERIFY_TOKEN and challenge:
            _vlog("✅ Webhook verified successfully")
            return PlainTextResponse(challenge)
        _vlog("❌ Webhook verification failed")
        return PlainTextResponse("Verification failed", status_code=403)
        
    elif request.method == "POST":
        data = await request.json()
        _vlog("📥 Incoming Webhook Payload:")
        _vlog(json.dumps(data, indent=2))

        await message_processor.process_incoming_message(data)
        return {"ok": True}

@app.post("/test-media-upload")
async def test_media_upload(file: UploadFile = File(...)):
    """Test endpoint to debug media upload issues"""
    try:
        _vlog(f"📁 Received file: {file.filename}")
        _vlog(f"📁 Content type: {file.content_type}")
        _vlog(f"📁 File size: {file.size if hasattr(file, 'size') else 'Unknown'}")
        
        # Read file content
        content = await file.read()
        _vlog(f"📁 Read {len(content)} bytes")
        
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
async def send_message_endpoint(
    request: dict,
    _: None = Depends(_optional_rate_limit_text),
):
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

@app.get("/messages/{user_id}/since")
async def get_messages_since_endpoint(user_id: str, since: str, limit: int = 500):
    """Get messages newer than the given ISO-8601 timestamp."""
    try:
        messages = await db_manager.get_messages_since(user_id, since, limit)
        return messages
    except Exception as e:
        print(f"Error fetching messages since: {e}")
        return []

@app.get("/messages/{user_id}/before")
async def get_messages_before_endpoint(user_id: str, before: str, limit: int = 50):
    """Get messages older than the given ISO-8601 timestamp."""
    try:
        messages = await db_manager.get_messages_before(user_id, before, limit)
        return messages
    except Exception as e:
        print(f"Error fetching messages before: {e}")
        return []

@app.get("/users/online")
async def get_online_users():
    """Get list of currently online users"""
    return {"online_users": connection_manager.get_active_users()}

@app.post("/conversations/{user_id}/mark-read")
async def mark_conversation_read(user_id: str, message_ids: List[str] = Body(None)):
    """Mark messages as read"""
    try:
        if message_ids:
            message_ids = list(set(message_ids))
        print(f"Marking messages as read: {message_ids}")
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
async def get_conversations(q: Optional[str] = None, unread_only: bool = False, assigned: Optional[str] = None, tags: Optional[str] = None, unresponded_only: bool = False):
    """Get conversations with optional filters: q, unread_only, assigned, tags (csv), unresponded_only."""
    try:
        tag_list = [t.strip() for t in tags.split(",")] if tags else None
        conversations = await db_manager.get_conversations_with_stats(q=q, unread_only=unread_only, assigned=assigned, tags=tag_list)
        if unresponded_only:
            conversations = [c for c in conversations if (c.get("unresponded_count") or 0) > 0]
        return conversations
    except Exception as e:
        print(f"Error fetching conversations: {e}")
        return []

# ----- Agents & assignments management -----

@app.get("/admin/agents")
async def list_agents_endpoint():
    return await db_manager.list_agents()

# ---- Tags options management ----
@app.get("/admin/tag-options")
async def get_tag_options_endpoint():
    return await db_manager.get_tag_options()

@app.post("/admin/tag-options")
async def set_tag_options_endpoint(payload: dict = Body(...)):
    options = payload.get("options") or []
    if not isinstance(options, list):
        raise HTTPException(status_code=400, detail="options must be a list")
    # normalize items: require label, optional icon
    norm = []
    for item in options:
        if isinstance(item, dict) and item.get("label"):
            norm.append({"label": str(item["label"]), "icon": str(item.get("icon", ""))})
        elif isinstance(item, str):
            norm.append({"label": item, "icon": ""})
    await db_manager.set_tag_options(norm)
    return {"ok": True, "count": len(norm)}

@app.post("/admin/agents")
async def create_agent_endpoint(payload: dict = Body(...)):
    username = (payload.get("username") or "").strip()
    name = (payload.get("name") or username).strip()
    password = payload.get("password") or ""
    is_admin = int(bool(payload.get("is_admin", False)))
    if not username or not password:
        raise HTTPException(status_code=400, detail="username and password are required")
    await db_manager.create_agent(username=username, name=name, password_hash=hash_password(password), is_admin=is_admin)
    return {"ok": True}

@app.delete("/admin/agents/{username}")
async def delete_agent_endpoint(username: str):
    await db_manager.delete_agent(username)
    return {"ok": True}

@app.post("/auth/login")
async def auth_login(payload: dict = Body(...)):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""
    stored = await db_manager.get_agent_password_hash(username)
    if not stored or not verify_password(password, stored):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    # Minimal session token: for simplicity return echo token (NOT JWT). Frontend can store.
    token = uuid.uuid4().hex
    return {"token": token, "username": username}

@app.post("/conversations/{user_id}/assign")
async def assign_conversation(user_id: str, payload: dict = Body(...)):
    agent = payload.get("agent")  # string or None
    await db_manager.set_conversation_assignment(user_id, agent)
    return {"ok": True, "user_id": user_id, "assigned_agent": agent}

@app.post("/conversations/{user_id}/tags")
async def update_conversation_tags(user_id: str, payload: dict = Body(...)):
    tags = payload.get("tags") or []
    if not isinstance(tags, list):
        raise HTTPException(status_code=400, detail="tags must be a list")
    await db_manager.set_conversation_tags(user_id, tags)
    return {"ok": True, "user_id": user_id, "tags": tags}

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

# ----- Payout and archive endpoints -----

@app.post("/orders/{order_id}/delivered")
async def order_delivered(order_id: str):
    """Record a delivered order in the payouts list."""
    await db_manager.add_delivered_order(order_id)
    return {"status": ORDER_STATUS_PAYOUT, "order_id": order_id}


@app.post("/payouts/{order_id}/mark-paid")
async def mark_payout_paid_endpoint(order_id: str):
    """Mark payout as paid and archive the order."""
    await db_manager.mark_payout_paid(order_id)
    return {"status": ORDER_STATUS_ARCHIVED, "order_id": order_id}


@app.get("/payouts")
async def list_payouts():
    """List orders awaiting payout."""
    return await db_manager.get_payouts()


@app.get("/archive")
async def list_archive():
    """List archived (paid) orders."""
    return await db_manager.get_archived_orders()

@app.get("/messages/{user_id}")
async def get_messages_endpoint(user_id: str, offset: int = 0, limit: int = 50, since: str | None = None, before: str | None = None):
    """Cursor-friendly fetch: use since/before OR legacy offset.

    - since: return messages newer than this timestamp (ascending)
    - before: return messages older than this timestamp (ascending)
    - else: use legacy offset/limit window (ascending)
    """
    try:
        if since:
            return await db_manager.get_messages_since(user_id, since, limit=max(1, min(limit, 500)))
        if before:
            return await db_manager.get_messages_before(user_id, before, limit=max(1, min(limit, 200)))
        # First try to get from cache for the newest window
        if offset == 0:
            cached_messages = await redis_manager.get_recent_messages(user_id, limit)
            if cached_messages:
                return cached_messages
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
    _: None = Depends(_optional_rate_limit_media),
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
        media_dir = MEDIA_DIR
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
                raise HTTPException(status_code=500, detail=f"Failed to save file: {exc}")

            # ---------- AUDIO-ONLY: convert WebM → OGG ----------
            if media_type == "audio" and file_extension.lower() != ".ogg":
                try:
                    ogg_path = await convert_webm_to_ogg(file_path)
                    file_path.unlink(missing_ok=True)  # delete original WebM
                    file_path = ogg_path
                    filename = ogg_path.name
                except Exception as exc:
                    raise HTTPException(status_code=500, detail=f"Audio conversion failed: {exc}")

            # ---------- upload to Google Drive ----------
            media_url = await upload_file_to_gcs(
                str(file_path)
            )

            # Build message payload using the public GCS URL instead of a local path
            message_data = {
                "user_id": user_id,
                "message": media_url,
                "url": media_url,
                "type": media_type,
                "from_me": True,
                "caption": caption,
                "price": price,
                "timestamp": datetime.utcnow().isoformat(),
                # Keep absolute path for internal processing/sending to WhatsApp
                "media_path": str(file_path),
            }

            # ---------- enqueue / send ----------
            result = await message_processor.process_outgoing_message(message_data)
            saved_results.append(
                {"filename": filename, "media_url": media_url, "result": result}
            )

        return {"status": "success", "messages": saved_results}

    except HTTPException:
        # Propagate HTTP errors to the client
        raise
    except Exception as exc:
        print(f"❌ Error in /send-media: {exc}")
        return {"error": f"Internal server error: {exc}", "status": "failed"}


@app.post("/send-media-async", status_code=202)
async def send_media_async(
    user_id: str = Form(...),
    media_type: str = Form(...),
    files: List[UploadFile] = File(...),
    caption: str = Form("", description="Optional caption"),
    price: str = Form("", description="Optional price"),
    temp_id: str | None = Form(None),
    _: None = Depends(_optional_rate_limit_media),
):
    """Accept media quickly and process in background. UI updates via WebSocket.

    This endpoint avoids synchronous transcode/upload to keep p95 low under bursts.
    """
    try:
        if not user_id:
            return {"error": "user_id is required", "status": "failed"}
        if media_type not in ["image", "audio", "video", "document"]:
            return {"error": "Invalid media_type. Must be: image, audio, video, or document", "status": "failed"}
        if not files:
            return {"error": "No files uploaded", "status": "failed"}

        media_dir = MEDIA_DIR
        media_dir.mkdir(exist_ok=True)

        accepted: List[dict] = []
        for file in files:
            if not file.filename:
                continue
            timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            file_extension = Path(file.filename).suffix or ".bin"
            filename = f"{media_type}_{timestamp}_{uuid.uuid4().hex[:8]}{file_extension}"
            file_path = media_dir / filename
            # Save immediately and schedule processing
            content = await file.read()
            async with aiofiles.open(file_path, "wb") as f:
                await f.write(content)

            optimistic_payload = {
                "user_id": user_id,
                "message": str(file_path),
                "url": str(file_path),
                "type": media_type,
                "from_me": True,
                "caption": caption,
                "price": price,
                "timestamp": datetime.utcnow().isoformat(),
                "media_path": str(file_path),
            }
            if temp_id:
                optimistic_payload["temp_id"] = temp_id

            asyncio.create_task(message_processor.process_outgoing_message(optimistic_payload))
            accepted.append({"filename": filename, **({"temp_id": temp_id} if temp_id else {})})

        return {"status": "accepted", "accepted": accepted}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"❌ Error in /send-media-async: {exc}")
        return {"error": f"Internal server error: {exc}", "status": "failed"}

@app.post("/send-catalog-set")
async def send_catalog_set_endpoint(
    user_id: str = Form(...),
    product_ids: str = Form(...),
    _: None = Depends(_optional_rate_limit_text),
):
    try:
        product_id_list = json.loads(product_ids)
        customer_phone = await lookup_phone(user_id) or user_id
        results = await messenger.send_catalog_products(customer_phone, product_id_list)
        return {"status": "ok", "results": results}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/send-catalog-item")
async def send_catalog_item_endpoint(
    user_id: str = Form(...),
    product_retailer_id: str = Form(...),
    caption: str = Form(""),
    _: None = Depends(_optional_rate_limit_text),
):
    customer_phone = await lookup_phone(user_id) or user_id
    response = await messenger.send_single_catalog_item(customer_phone, product_retailer_id, caption)
    return {"status": "ok", "response": response}


@app.post("/send-catalog-all")
async def send_catalog_all_endpoint(
    user_id: str = Form(...),
    caption: str = Form(""),
    _: None = Depends(_optional_rate_limit_text),
):
    customer_phone = await lookup_phone(user_id) or user_id
    results = await messenger.send_full_catalog(customer_phone, caption)
    return {"status": "ok", "results": results}


@app.post("/send-catalog-set-all")
async def send_catalog_set_all_endpoint(
    background_tasks: BackgroundTasks,
    user_id: str = Form(...),
    set_id: str = Form(...),
    caption: str = Form(""),
    _: None = Depends(_optional_rate_limit_text),
):
    customer_phone = await lookup_phone(user_id) or user_id
    job_id = str(uuid.uuid4())
    # Emit optimistic message immediately for instant UI feedback
    temp_id = f"temp_{uuid.uuid4().hex}"
    timestamp = datetime.now(timezone.utc).isoformat()
    optimistic_record = {
        "id": temp_id,
        "temp_id": temp_id,
        "user_id": user_id,
        "message": caption or f"Catalog set {set_id}",
        "type": "catalog_set",
        "from_me": True,
        "status": "sending",
        "timestamp": timestamp,
        "caption": caption,
    }
    await redis_manager.cache_message(user_id, optimistic_record)
    await connection_manager.send_to_user(
        user_id, {"type": "message_sent", "data": optimistic_record}
    )

    async def run_send_full_set():
        try:
            await messenger.send_full_set(customer_phone, set_id, caption)
            print(f"Successfully sent catalog set {set_id} to {customer_phone}")
            # Update UI status to 'sent' and persist
            await connection_manager.send_to_user(
                user_id,
                {"type": "message_status_update", "data": {"temp_id": temp_id, "status": "sent"}},
            )
            final_record = {**optimistic_record, "status": "sent"}
            await db_manager.upsert_message(final_record)
            await redis_manager.cache_message(user_id, final_record)
        except Exception as exc:
            error_message = f"Error sending catalog set {set_id} to {customer_phone}: {exc}"
            print(error_message)
            await connection_manager.send_to_user(
                user_id,
                {
                    "type": "catalog_set_send_error",
                    "job_id": job_id,
                    "error": str(exc),
                },
            )

    background_tasks.add_task(run_send_full_set)
    return {"status": "started", "job_id": job_id}


@app.get("/catalog-sets")
async def get_catalog_sets():
    try:
        sets = await CatalogManager.get_catalog_sets()
        return sets
    except Exception as exc:
        print(f"Error fetching catalog sets: {exc}")
        # Fallback to All Products
        return [{"id": CATALOG_ID, "name": "All Products"}]


@app.get("/catalog-all-products")
async def get_catalog_products_endpoint(force_refresh: bool = False):
    # Refresh cache if forced or stale/missing; otherwise serve cached for speed
    need_refresh = bool(force_refresh)
    try:
        if not os.path.exists(CATALOG_CACHE_FILE):
            need_refresh = True
        else:
            import time as _time
            age_sec = _time.time() - os.path.getmtime(CATALOG_CACHE_FILE)
            if age_sec > CATALOG_CACHE_TTL_SEC:
                need_refresh = True
    except Exception:
        need_refresh = True

    if need_refresh:
        try:
            await catalog_manager.refresh_catalog_cache()
        except Exception as exc:
            print(f"Catalog cache refresh failed in endpoint: {exc}")

    return catalog_manager.get_cached_products() or []


@app.get("/catalog-set-products")
async def get_catalog_set_products(set_id: str, limit: int = 60):
    """Return products for the requested set (or full catalog)."""
    try:
        products = await CatalogManager.get_products_for_set(set_id, limit=limit)
        print(f"Catalog: returning {len(products)} products for set_id={set_id}")
        return products
    except Exception as exc:
        print(f"Error fetching set products: {exc}")
        return []

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


@app.get("/proxy-audio")
async def proxy_audio(url: str, request: StarletteRequest):
    """Proxy remote audio with Range support for reliable HTML5 playback/seek."""
    if not url or not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid url")
    try:
        range_header = request.headers.get("range") or request.headers.get("Range")
        fwd_headers = {"User-Agent": "Mozilla/5.0"}
        if range_header:
            fwd_headers["Range"] = range_header

        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            resp = await client.get(url, headers=fwd_headers, stream=True)

        status_code = resp.status_code
        media_type = resp.headers.get("Content-Type", "audio/ogg")
        passthrough = {"Cache-Control": "public, max-age=86400"}
        for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
            v = resp.headers.get(h)
            if v:
                passthrough[h] = v
        if "Accept-Ranges" not in passthrough:
            passthrough["Accept-Ranges"] = "bytes"

        return StreamingResponse(resp.aiter_bytes(), status_code=status_code, media_type=media_type, headers=passthrough)
    except Exception as exc:
        print(f"Proxy audio error: {exc}")
        raise HTTPException(status_code=502, detail="Proxy fetch failed")


@app.get("/proxy-image")
async def proxy_image(url: str):
    """Proxy remote images to avoid CORS/expired signed URLs and enable caching.

    Accepts an absolute image URL and streams it back with cache headers.
    """
    if not url or not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid url")
    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        media_type = resp.headers.get("Content-Type", "image/jpeg")
        return StarletteResponse(
            content=resp.content,
            media_type=media_type,
            headers={
                "Cache-Control": "public, max-age=86400",
                "Vary": "Accept",
            },
        )
    except Exception as exc:
        print(f"Proxy image error: {exc}")
        raise HTTPException(status_code=502, detail="Proxy fetch failed")

# Lightweight link preview endpoint to extract OG metadata (title/image)
@app.get("/link-preview")
async def link_preview(url: str):
    if not url or not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid url")
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        html = resp.text or ""
        # Local import to avoid global dependency if unused on cold paths
        try:
            from bs4 import BeautifulSoup  # type: ignore
        except Exception:
            BeautifulSoup = None  # type: ignore
        title = ""
        description = ""
        image = ""
        if html and BeautifulSoup is not None:
            soup = BeautifulSoup(html, "html.parser")
            def get_meta(name: str):
                tag = soup.find("meta", {"property": name}) or soup.find("meta", {"name": name})
                return (tag.get("content") or "").strip() if tag else ""
            title = get_meta("og:title") or (soup.title.string.strip() if getattr(soup, "title", None) and getattr(soup.title, "string", None) else "")
            description = get_meta("og:description") or get_meta("description")
            image = get_meta("og:image") or get_meta("twitter:image")
        return {"url": url, "title": title, "description": description, "image": image}
    except Exception as exc:
        print(f"Link preview error: {exc}")
        raise HTTPException(status_code=502, detail="Preview fetch failed")

# Serve React build after all routes
app.mount("/", StaticFiles(directory="frontend/build", html=True), name="frontend")



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
    # Simple in-memory cache for set products to speed up responses
    _SET_CACHE: dict[str, list[Dict[str, Any]]] = {}
    _SET_CACHE_TS: dict[str, float] = {}
    _SET_CACHE_TTL_SEC: int = 15 * 60

    @staticmethod
    def _set_cache_filename(set_id: str) -> str:
        return f"catalog_set_{set_id}.json"

    @staticmethod
    def _load_persisted_set(set_id: str) -> list[dict]:
        """Load a persisted set cache from local disk or GCS if present."""
        filename = CatalogManager._set_cache_filename(set_id)
        try:
            if not os.path.exists(filename):
                try:
                    download_file_from_gcs(filename, filename)
                except Exception:
                    return []
            if os.path.getsize(filename) == 0:
                return []
            with open(filename, "r", encoding="utf8") as f:
                data = json.load(f)
            # Normalize
            return [CatalogManager._format_product(p) for p in data if CatalogManager._is_product_available(p)]
        except Exception:
            return []

    @staticmethod
    async def _persist_set_async(set_id: str, products: list[dict]) -> None:
        """Persist set products to local disk and upload to GCS (best-effort)."""
        filename = CatalogManager._set_cache_filename(set_id)
        try:
            with open(filename, "w", encoding="utf8") as f:
                json.dump(products, f, ensure_ascii=False)
            try:
                await upload_file_to_gcs(filename)
            except Exception:
                pass
        except Exception:
            pass

    @staticmethod
    async def get_catalog_sets() -> List[Dict[str, Any]]:
        """Return available product sets (collections) for the configured catalog.

        Graph API: /{catalog_id}/product_sets?fields=id,name
        """
        url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{CATALOG_ID}/product_sets"
        params = {"fields": "id,name", "limit": 200}
        headers = await get_whatsapp_headers()

        # Always include the whole catalog as a fallback option
        result: List[Dict[str, Any]] = [{"id": CATALOG_ID, "name": "All Products"}]
        seen: set[str] = {CATALOG_ID}

        async with httpx.AsyncClient(timeout=30.0) as client:
            while url:
                response = await client.get(url, headers=headers, params=params)
                data = response.json()
                sets = data.get("data", [])
                for s in sets:
                    try:
                        sid = str(s.get("id"))
                        name = s.get("name")
                        if sid and name and sid not in seen:
                            seen.add(sid)
                            result.append({"id": sid, "name": name})
                    except Exception:
                        continue
                # Follow pagination if present
                url = data.get("paging", {}).get("next")
                params = None
        return result

    @staticmethod
    async def get_catalog_products() -> List[Dict[str, Any]]:
        products: List[Dict[str, Any]] = []
        url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{CATALOG_ID}/products"
        params = {
            # Ask Graph for image URLs explicitly to ensure we receive usable links
            "fields": "retailer_id,name,price,images{url},availability,quantity",
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
    async def get_products_for_set(set_id: str, limit: int = 60) -> List[Dict[str, Any]]:
        """Return products for a specific product set.

        Graph API: /{product_set_id}/products
        Fallback: fetch entire catalog if set_id equals the catalog id.
        """
        # If requesting the full catalog, serve from on-disk cache instantly
        if not set_id or set_id == CATALOG_ID:
            cached = catalog_manager.get_cached_products()
            if cached:
                return cached[: max(1, int(limit))]
            # Fallback to live fetch if cache empty; also persist to cache for next requests
            products_live = await CatalogManager.get_catalog_products()
            try:
                with open(CATALOG_CACHE_FILE, "w", encoding="utf8") as f:
                    json.dump(products_live, f, ensure_ascii=False)
                try:
                    await upload_file_to_gcs(CATALOG_CACHE_FILE)
                except Exception as _exc:
                    print(f"GCS upload failed after live fetch: {_exc}")
            except Exception as _exc:
                print(f"Writing local catalog cache failed: {_exc}")
            return products_live[: max(1, int(limit))]

        # Serve from persisted cache if fresh
        use_persisted = False
        try:
            filename = CatalogManager._set_cache_filename(set_id)
            if os.path.exists(filename):
                import time as _time
                if (_time.time() - os.path.getmtime(filename)) < CatalogManager._SET_CACHE_TTL_SEC:
                    use_persisted = True
        except Exception:
            use_persisted = False

        if use_persisted:
            persisted = CatalogManager._load_persisted_set(set_id)
            if persisted:
                return persisted[: max(1, int(limit))]

        # Serve from in-memory cache if fresh (warm instance)
        import time as _time
        ts = CatalogManager._SET_CACHE_TS.get(set_id)
        if ts and (_time.time() - ts) < CatalogManager._SET_CACHE_TTL_SEC:
            cached_list = CatalogManager._SET_CACHE.get(set_id, [])
            if cached_list:
                return cached_list[: max(1, int(limit))]

        products: List[Dict[str, Any]] = []
        url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{set_id}/products"
        params = {
            "fields": "retailer_id,name,price,images{url},availability,quantity",
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
                        if len(products) >= max(1, int(limit)):
                            return products
                url = data.get("paging", {}).get("next")
                params = None
        # Store in memory and persist for fast subsequent responses across instances
        try:
            CatalogManager._SET_CACHE[set_id] = products
            CatalogManager._SET_CACHE_TS[set_id] = _time.time()
            try:
                await CatalogManager._persist_set_async(set_id, products)
            except Exception:
                pass
        except Exception:
            pass
        return products

    @staticmethod
    def _is_product_available(product: Dict[str, Any]) -> bool:
        availability = str(product.get("availability", "")).lower()
        # Be permissive: include everything except explicit out_of_stock.
        # Many catalogs omit quantity; filtering by quantity hides valid items.
        return availability != "out_of_stock"

    @staticmethod
    def _format_product(product: Dict[str, Any]) -> Dict[str, Any]:
        images = product.get("images", [])
        # Facebook can return images as an array, or as an object with a data array
        if isinstance(images, dict) and "data" in images:
            images = images["data"]

        formatted_images: list[dict] = []
        for img in images:
            # Normalize to dict form
            if isinstance(img, str):
                # Some APIs return a bare URL string
                url_string = img
                try:
                    # Rarely images are JSON-encoded strings
                    possible = json.loads(img)
                    if isinstance(possible, dict):
                        img = possible
                    else:
                        img = {"url": url_string}
                except Exception:
                    img = {"url": url_string}

            if isinstance(img, dict):
                # Normalize common keys to `url`
                url = (
                    img.get("url")
                    or img.get("src")
                    or img.get("image_url")
                    or img.get("original_url")
                    or img.get("href")
                )
                if url:
                    formatted_images.append({"url": url})

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
        with open(CATALOG_CACHE_FILE, "w", encoding="utf8") as f:
            json.dump(products, f, ensure_ascii=False)
        try:
            await upload_file_to_gcs(CATALOG_CACHE_FILE)
            await upload_file_to_gcs(CATALOG_CACHE_FILE)
        except Exception as exc:
            print(f"GCS upload failed: {exc}")
        return len(products)

    @staticmethod
    def get_cached_products() -> List[Dict[str, Any]]:
        if not os.path.exists(CATALOG_CACHE_FILE):
            try:
                download_file_from_gcs(
                    CATALOG_CACHE_FILE, CATALOG_CACHE_FILE
                )
            except Exception:
                return []
        # If file exists but is empty or invalid, return empty list gracefully
        try:
            if os.path.getsize(CATALOG_CACHE_FILE) == 0:
                return []
        except Exception:
            return []

        try:
            with open(CATALOG_CACHE_FILE, "r", encoding="utf8") as f:
                products = json.load(f)
        except Exception:
            return []

        # Ensure images normalized on cached entries as well
        normalized: list[dict] = []
        for prod in products:
            try:
                normalized.append(CatalogManager._format_product(prod))
            except Exception:
                # If formatting fails, skip that product
                continue
        return [p for p in normalized if CatalogManager._is_product_available(p)]


catalog_manager = CatalogManager()

# 1. Fix the port in main block
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)


# ------------------------- Cash-in endpoint -------------------------
@app.post("/cashin")
async def cashin(
    user_id: str = Form(...),
    amount: str = Form(...),
    file: UploadFile | None = File(None),
):
    """Record a cash-in receipt and notify the UI immediately.

    - If an image file is provided, it is saved locally and uploaded to GCS.
    - A message is created as an image with caption 'cashin' and price set to the amount.
    - The message is sent via the existing real-time flow (optimistic update + WhatsApp send).
    """
    try:
        media_url: str | None = None
        media_path: str | None = None

        if file and file.filename:
            # Ensure media folder exists
            media_dir = MEDIA_DIR
            media_dir.mkdir(exist_ok=True)

            # Persist upload
            timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
            file_extension = Path(file.filename).suffix or ".bin"
            filename = f"cashin_{timestamp}_{uuid.uuid4().hex[:8]}{file_extension}"
            file_path = media_dir / filename

            content = await file.read()
            async with aiofiles.open(file_path, "wb") as f:
                await f.write(content)

            # Upload to Google Cloud Storage
            media_url = await upload_file_to_gcs(
                str(file_path)
            )
            media_path = str(file_path)

        # Build message payload
        message_data = {
            "user_id": user_id,
            # Use image type so WhatsApp accepts it as media. Use caption to mark as cashin.
            "type": "image" if media_url else "text",
            "from_me": True,
            "timestamp": datetime.utcnow().isoformat(),
            "price": amount,              # store amount in price field
            "caption": "cashin",         # marker for UI rendering
        }
        if media_url:
            message_data["message"] = media_path  # local path for internal handling
            message_data["url"] = media_url       # public URL for UI
            message_data["media_path"] = media_path
        else:
            message_data["message"] = f"Cash-in: {amount}"

        # Send through the normal pipeline (triggers immediate WS update)
        result = await message_processor.process_outgoing_message(message_data)
        return {"status": "success", "message": result}

    except HTTPException:
        raise
    except Exception as exc:
        print(f"❌ Error in /cashin: {exc}")
        return {"error": f"Internal server error: {exc}", "status": "failed"}
