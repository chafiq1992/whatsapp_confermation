import asyncio
import json
import uuid
import hashlib
import hmac
import base64
import secrets
import logging
from datetime import datetime, timezone, timedelta
import struct
from typing import Any, Dict, List, Optional, Set
from collections import defaultdict
import time
import os
import re
import re
import aiosqlite
import aiofiles
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks, Request, UploadFile, File, Form, HTTPException, Body, Depends
from starlette.requests import Request as _LimiterRequest
from starlette.responses import Response as _LimiterResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
import httpx
import redis.asyncio as redis
from fastapi.responses import PlainTextResponse
from fastapi.responses import FileResponse
from fastapi.responses import HTMLResponse
from dotenv import load_dotenv
import subprocess
import asyncpg
import mimetypes
from .google_cloud_storage import upload_file_to_gcs, download_file_from_gcs, maybe_signed_url_for, _parse_gcs_url, _get_client
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
from fastapi.responses import RedirectResponse
from PIL import Image, ImageOps  # type: ignore
import io

# Absolute paths
ROOT_DIR = Path(__file__).resolve().parent.parent
MEDIA_DIR = ROOT_DIR / "media"
MEDIA_DIR.mkdir(exist_ok=True)

# (static mount will be added later, after route declarations)


# ── Cloud‑Run helpers ────────────────────────────────────────────
PORT = int(os.getenv("PORT", "8080"))
BASE_URL = os.getenv("BASE_URL", f"http://localhost:{PORT}")
REDIS_URL = os.getenv("REDIS_URL", "")
DB_PATH = os.getenv("DB_PATH") or "/tmp/whatsapp_messages.db"
DATABASE_URL = os.getenv("DATABASE_URL")  # optional PostgreSQL URL
PG_POOL_MIN = int(os.getenv("PG_POOL_MIN", "1"))
PG_POOL_MAX = int(os.getenv("PG_POOL_MAX", "4"))
REQUIRE_POSTGRES = int(os.getenv("REQUIRE_POSTGRES", "1"))  # when 1 and DATABASE_URL is set, never fallback to SQLite
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
DISABLE_AUTH = os.getenv("DISABLE_AUTH", "0") == "1"

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
# ── Agent auth token (stateless, HMAC‑signed) ─────────────────────
AGENT_AUTH_SECRET = os.getenv("AGENT_AUTH_SECRET", "") or os.getenv("SECRET_KEY", "")
_AGENT_AUTH_SECRET_BYTES = AGENT_AUTH_SECRET.encode("utf-8")

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")

def _b64url_decode(data_str: str) -> bytes:
    padding = "=" * (-len(data_str) % 4)
    return base64.urlsafe_b64decode((data_str + padding).encode())

def issue_agent_token(username: str, is_admin: bool, ttl_seconds: int = 30 * 24 * 3600) -> str:
    payload = {"u": username, "a": 1 if is_admin else 0, "exp": int(time.time()) + int(ttl_seconds)}
    body = _b64url_encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
    sig = hmac.new(_AGENT_AUTH_SECRET_BYTES, body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64url_encode(sig)}"

def parse_agent_token(token: str) -> Optional[dict]:
    try:
        if not token or "." not in token or not _AGENT_AUTH_SECRET_BYTES:
            return None
        body, sig = token.split(".", 1)
        expected = _b64url_encode(hmac.new(_AGENT_AUTH_SECRET_BYTES, body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return {"username": str(payload.get("u") or ""), "is_admin": bool(payload.get("a"))}
    except Exception:
        return None
# Get environment variables
VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "chafiq")
ACCESS_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "your_access_token_here")
PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "your_phone_number_id")
WABA_ID_ENV = (
    os.getenv("WHATSAPP_WABA_ID")
    or os.getenv("WHATSAPP_BUSINESS_ACCOUNT_ID")
    or os.getenv("WABA_ID")
    or os.getenv("BUSINESS_ACCOUNT_ID")
)
CATALOG_ID = os.getenv("CATALOG_ID", "CATALOGID")
META_ACCESS_TOKEN = os.getenv("META_ACCESS_TOKEN", ACCESS_TOKEN)
META_APP_ID = os.getenv("META_APP_ID", "") or os.getenv("FB_APP_ID", "")
META_APP_SECRET = os.getenv("META_APP_SECRET", "") or os.getenv("FB_APP_SECRET", "")

# Sync CATALOG_ID into compatibility shim, if present
try:
    if config is not None:
        config.CATALOG_ID = CATALOG_ID  # type: ignore[attr-defined]
except Exception:
    pass

# Feature flags: auto-reply with catalog match
# Default ON so catalog links/IDs auto-respond for all customers
AUTO_REPLY_CATALOG_MATCH = os.getenv("AUTO_REPLY_CATALOG_MATCH", "1") == "1"
try:
    AUTO_REPLY_MIN_SCORE = float(os.getenv("AUTO_REPLY_MIN_SCORE", "0.6"))
except Exception:
    AUTO_REPLY_MIN_SCORE = 0.6

# Optional: restrict auto-replies to a whitelist of phone numbers (WhatsApp IDs)
def _digits_only(value: str) -> str:
    try:
        return "".join([ch for ch in str(value) if ch.isdigit()])
    except Exception:
        return str(value or "")

# Canonical conversation key: digits-only, Morocco phones normalized to 212XXXXXXXXX
def _normalize_user_id(value: str) -> str:
    try:
        s = str(value or "").strip()
        # Internal channels should pass through unchanged
        if s.startswith(("team:", "agent:", "dm:")):
            return s
        digits = _digits_only(s)
        if not digits:
            return s
        # If starts with 0 -> convert to 212...
        if digits.startswith("0"):
            return "212" + digits[1:]
        # If already starts with 212 -> keep
        if digits.startswith("212"):
            return digits
        # Fallback: assume it's a country code without plus
        return digits
    except Exception:
        return str(value or "")

_TEST_NUMBERS_RAW = os.getenv("AUTO_REPLY_TEST_NUMBERS", "")
AUTO_REPLY_TEST_NUMBERS: Set[str] = set(
    _digits_only(n.strip()) for n in _TEST_NUMBERS_RAW.split(",") if n.strip()
)

# Survey test config (override scheduler for specific numbers)
_SURVEY_TEST_NUMBERS_RAW = os.getenv("SURVEY_TEST_NUMBERS", "")
SURVEY_TEST_NUMBERS: Set[str] = set(
    _digits_only(n.strip()) for n in _SURVEY_TEST_NUMBERS_RAW.split(",") if n.strip()
)
try:
    SURVEY_TEST_DELAY_SEC = int(os.getenv("SURVEY_TEST_DELAY_SEC", "0") or "0")
except Exception:
    SURVEY_TEST_DELAY_SEC = 0
SURVEY_TEST_IGNORE_INVOICE = os.getenv("SURVEY_TEST_IGNORE_INVOICE", "0") == "1"
SURVEY_TEST_BYPASS_COOLDOWN = os.getenv("SURVEY_TEST_BYPASS_COOLDOWN", "0") == "1"
try:
    SURVEY_TEST_COOLDOWN_SEC = int(os.getenv("SURVEY_TEST_COOLDOWN_SEC", "60") or "60")
except Exception:
    SURVEY_TEST_COOLDOWN_SEC = 60

_vlog(f"🔧 Configuration loaded:")
_vlog(f"   VERIFY_TOKEN: {VERIFY_TOKEN}")
_vlog(f"   ACCESS_TOKEN: {ACCESS_TOKEN[:20]}..." if len(ACCESS_TOKEN) > 20 else f"   ACCESS_TOKEN: {ACCESS_TOKEN}")
_vlog(f"   PHONE_NUMBER_ID: {PHONE_NUMBER_ID}")

# Feature flags / tunables
AUDIO_VOICE_ENABLED = (os.getenv("WA_AUDIO_VOICE", "1") or "1").strip() not in ("0", "false", "False")

# Order confirmation: allowed numbers
_ORDER_CONFIRM_ALLOWED_RAW = os.getenv("ORDER_CONFIRM_ALLOWED_NUMBERS", "")
ORDER_CONFIRM_ALLOWED_NUMBERS: Set[str] = set(
    _digits_only(n.strip()) for n in _ORDER_CONFIRM_ALLOWED_RAW.split(",") if n.strip()
)
# Always include these defaults
try:
    ORDER_CONFIRM_ALLOWED_NUMBERS.update({"212650161162", "212606315335"})
except Exception:
    pass

# Allow sending order confirmation to all numbers (bypass whitelist)
ORDER_CONFIRM_ALLOW_ALL = (os.getenv("ORDER_CONFIRM_ALLOW_ALL", "0") or "0").strip() not in ("0", "false", "False")
ORDER_CONFIRM_SEND_CATALOG = (os.getenv("ORDER_CONFIRM_SEND_CATALOG", "0") or "0").strip() not in ("0", "false", "False")

# Build/version identifiers for frontend refresh banner
APP_BUILD_ID = os.getenv("APP_BUILD_ID") or datetime.utcnow().strftime("%Y%m%d%H%M%S")
APP_STARTED_AT = datetime.utcnow().isoformat()

def chunk_list(items: List[str], size: int):
    """Yield successive chunks from a list."""
    for i in range(0, len(items), size):
        yield items[i:i + size]

def _format_price_mad(value: str) -> str:
    s = str(value or "").strip()
    if not s:
        return ""
    # Avoid duplicating MAD if already present
    if re.search(r"\bMAD\b", s, re.IGNORECASE):
        return s
    return f"{s} MAD"

async def convert_webm_to_ogg(src_path: Path) -> Path:
    """
    Convert a WebM/unknown audio file to real OGG-Opus so WhatsApp accepts it.
    Returns the new path (same stem, .ogg extension).
    Requires ffmpeg to be installed on the server / Docker image.
    """
    # Always write to a new .ogg file to avoid in-place overwrite
    # Keep human-friendly stem when possible and add a short suffix
    safe_stem = src_path.stem or "audio"
    dst_path = src_path.with_name(f"{safe_stem}_opus48_{uuid.uuid4().hex[:6]}.ogg")
    cmd = [
        "ffmpeg", "-y",
        "-i", str(src_path),
        # Hardened Opus settings per WA Cloud guidance
        "-vn",
        "-ac", "1",
        "-ar", "48000",
        "-c:a", "libopus",
        "-b:a", "32k",
        "-vbr", "on",
        "-compression_level", "10",
        "-application", "voip",
        "-frame_duration", "20",
        str(dst_path),
    ]

    loop = asyncio.get_event_loop()
    proc = await loop.run_in_executor(None, lambda: subprocess.run(cmd, capture_output=True))
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode())
    return dst_path

async def compute_audio_waveform(src_path: Path, buckets: int = 56) -> list[int]:
    """Compute a simple peak-based waveform (0..100) using ffmpeg to decode to PCM.

    - Decodes to mono 16-bit PCM at 16 kHz
    - Splits into N buckets and records the peak absolute amplitude per bucket
    - Normalizes to 0..100 for UI
    """
    try:
        # Decode with ffmpeg to raw PCM (s16le), 1 channel, 16 kHz
        cmd = [
            "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
            "-i", str(src_path),
            "-ac", "1", "-ar", "16000",
            "-f", "s16le",
            "pipe:1",
        ]
        loop = asyncio.get_event_loop()
        proc = await loop.run_in_executor(None, lambda: subprocess.run(cmd, capture_output=True))
        if proc.returncode != 0:
            # If decode fails, return a flat placeholder waveform
            return [30] * max(1, int(buckets))
        pcm = proc.stdout or b""
        if not pcm:
            return [30] * max(1, int(buckets))

        # Interpret bytes as signed 16-bit little-endian samples
        num_samples = len(pcm) // 2
        if num_samples <= 0:
            return [30] * max(1, int(buckets))

        # Avoid extreme memory on edge cases: cap to ~5 minutes at 16 kHz
        max_samples = 5 * 60 * 16000
        if num_samples > max_samples:
            pcm = pcm[: max_samples * 2]
            num_samples = max_samples

        # Unpack in chunks to avoid a giant tuple at once
        # We'll compute peaks per bucket on the fly
        num_buckets = max(8, min(256, int(buckets)))
        bucket_size = max(1, num_samples // num_buckets)
        peaks: list[int] = []
        max_abs = 1
        for i in range(0, num_samples, bucket_size):
            chunk = pcm[i * 2 : (i + bucket_size) * 2]
            if not chunk:
                break
            # iterate 2 bytes at a time
            local_peak = 0
            for j in range(0, len(chunk), 2):
                sample = struct.unpack_from('<h', chunk, j)[0]
                a = abs(sample)
                if a > local_peak:
                    local_peak = a
            peaks.append(local_peak)
            if local_peak > max_abs:
                max_abs = local_peak

        # Normalize to 0..100 and clamp to at least 8 and at most 46 like UI bounds
        norm = []
        for p in peaks[:num_buckets]:
            v = int(round((p / max_abs) * 100)) if max_abs > 0 else 0
            norm.append(max(0, min(100, v)))
        # Ensure fixed length by padding/truncating
        if len(norm) < num_buckets:
            norm += [0] * (num_buckets - len(norm))
        elif len(norm) > num_buckets:
            norm = norm[:num_buckets]
        return norm
    except Exception:
        return [30] * max(1, int(buckets))

async def convert_any_to_m4a(src_path: Path) -> Path:
    """Convert any input audio to M4A/AAC 44.1 kHz mono.

    Used as a last-resort fallback if Graph rejects Opus/OGG upload.
    """
    dst_path = src_path.with_suffix(".m4a")
    cmd = [
        "ffmpeg", "-y",
        "-i", str(src_path),
        "-vn",
        "-ac", "1",
        "-ar", "44100",
        "-c:a", "aac",
        "-b:a", "48k",
        str(dst_path),
    ]
    loop = asyncio.get_event_loop()
    proc = await loop.run_in_executor(None, lambda: subprocess.run(cmd, capture_output=True))
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode())
    return dst_path

async def probe_audio_channels(src_path: Path) -> int:
    """Return number of channels for the first audio stream, or 0 if unknown."""
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=channels",
            "-of", "csv=p=0",
            str(src_path),
        ]
        loop = asyncio.get_event_loop()
        proc = await loop.run_in_executor(None, lambda: subprocess.run(cmd, capture_output=True))
        if proc.returncode == 0:
            out = (proc.stdout or b"").decode().strip()
            try:
                return int(out)
            except Exception:
                return 0
        return 0
    except Exception:
        return 0

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

    # -------- simple feature helpers --------
    async def was_auto_reply_recent(self, user_id: str, window_sec: int = 24 * 60 * 60) -> bool:
        """Return True if an auto-reply marker exists for the user (within TTL)."""
        if not self.redis_client:
            return False
        try:
            key = f"auto_reply_sent:{user_id}"
            exists = await self.redis_client.exists(key)
            return bool(exists)
        except Exception:
            return False

    async def mark_auto_reply_sent(self, user_id: str, window_sec: int = 24 * 60 * 60) -> None:
        """Set a marker that suppresses further auto replies for window_sec seconds."""
        if not self.redis_client:
            return
        try:
            key = f"auto_reply_sent:{user_id}"
            await self.redis_client.setex(key, window_sec, "1")
        except Exception:
            return

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

    # -------- survey helpers --------
    async def get_json(self, key: str) -> Optional[dict]:
        if not self.redis_client:
            return None
        try:
            raw = await self.redis_client.get(key)
            if not raw:
                return None
            return json.loads(raw)
        except Exception:
            return None

    async def set_json(self, key: str, value: dict, ttl: int | None = None) -> None:
        if not self.redis_client:
            return
        try:
            data = json.dumps(value, ensure_ascii=False)
            if ttl and ttl > 0:
                await self.redis_client.setex(key, ttl, data)
            else:
                await self.redis_client.set(key, data)
        except Exception:
            return

    async def was_survey_invited_recent(self, user_id: str) -> bool:
        if not self.redis_client:
            return False
        try:
            key = f"survey_invited:{user_id}"
            exists = await self.redis_client.exists(key)
            return bool(exists)
        except Exception:
            return False

    async def mark_survey_invited(self, user_id: str, window_sec: int = 30 * 24 * 60 * 60) -> None:
        if not self.redis_client:
            return
        try:
            key = f"survey_invited:{user_id}"
            await self.redis_client.setex(key, window_sec, "1")
        except Exception:
            return

    async def get_survey_state(self, user_id: str) -> Optional[dict]:
        return await self.get_json(f"survey_state:{user_id}")

    async def set_survey_state(self, user_id: str, state: dict, ttl_sec: int = 3 * 24 * 60 * 60) -> None:
        await self.set_json(f"survey_state:{user_id}", state, ttl=ttl_sec)

    async def clear_survey_state(self, user_id: str) -> None:
        if not self.redis_client:
            return
        try:
            await self.redis_client.delete(f"survey_state:{user_id}")
        except Exception:
            return

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
        
        logging.info("send_text_message start to=%s context=%s", to, (context_message_id or ""))
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            result = response.json()
            logging.info("send_text_message response status=%s body=%s", response.status_code, result)
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

    async def check_whatsapp_contact(self, phone_e164: str) -> dict:
        """Check if a phone has WhatsApp using the contacts endpoint.
        Returns the raw response with entries like [{ input, status, wa_id? }].
        """
        url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{self.phone_number_id}/contacts"
        payload = {
            "blocking": "wait",
            "contacts": [phone_e164],
            "force_check": True,
        }
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(url, json=payload, headers=self.headers)
            return resp.json() if resp is not None else {}

    async def send_template_message(
        self,
        to: str,
        template_name: str,
        language: str = "en",
        components: list | None = None,
        context_message_id: str | None = None,
    ) -> dict:
        url = f"{self.base_url}/messages"
        payload: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "template",
            "template": {
                "name": template_name,
                "language": {"code": language},
            },
        }
        if components:
            payload["template"]["components"] = components
        if context_message_id:
            payload["context"] = {"message_id": context_message_id}
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(url, json=payload, headers=self.headers)
            return resp.json() if resp is not None else {}

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

    async def send_reply_buttons(self, user_id: str, body_text: str, buttons: List[Dict[str, str]]) -> Dict[str, Any]:
        """Send WhatsApp interactive reply buttons.

        buttons: list of {"id": str, "title": str}
        """
        data = {
            "messaging_product": "whatsapp",
            "to": user_id,
            "type": "interactive",
            "interactive": {
                "type": "button",
                "body": {"text": body_text},
                "action": {
                    "buttons": [
                        {"type": "reply", "reply": {"id": str(b.get("id")), "title": str(b.get("title"))[:20]}}  # WA title max 20 chars
                        for b in (buttons or []) if b.get("id") and b.get("title")
                    ]
                },
            },
        }
        return await self._make_request("messages", data)

    async def send_list_message(
        self,
        user_id: str,
        body_text: str,
        button_text: str,
        sections: List[Dict[str, Any]],
        header_text: Optional[str] = None,
        footer_text: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send WhatsApp interactive list message.

        sections: [ { title: str, rows: [ { id: str, title: str, description?: str } ] } ]
        """
        interactive: Dict[str, Any] = {
            "type": "list",
            "body": {"text": body_text},
            "action": {
                "button": button_text[:20] if button_text else "Choose",
                "sections": [],
            },
        }
        if header_text:
            interactive["header"] = {"type": "text", "text": header_text}
        if footer_text:
            interactive["footer"] = {"text": footer_text}

        cleaned_sections: List[Dict[str, Any]] = []
        for sec in sections or []:
            title = str(sec.get("title") or "")
            rows_in = sec.get("rows") or []
            rows: List[Dict[str, str]] = []
            for r in rows_in:
                rid = str(r.get("id") or "").strip()
                rtitle = str(r.get("title") or "").strip()
                if not rid or not rtitle:
                    continue
                row: Dict[str, str] = {"id": rid, "title": rtitle[:24]}
                desc = str(r.get("description") or "").strip()
                if desc:
                    row["description"] = desc[:72]
                rows.append(row)
            if rows:
                cleaned_sections.append({
                    **({"title": title[:24]} if title else {}),
                    "rows": rows,
                })
        interactive["action"]["sections"] = cleaned_sections

        data = {
            "messaging_product": "whatsapp",
            "to": user_id,
            "type": "interactive",
            "interactive": interactive,
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
    
    async def send_media_message(
        self,
        to: str,
        media_type: str,
        media_id_or_url: str,
        caption: str = "",
        context_message_id: str | None = None,
        audio_voice: bool | None = None,
    ) -> dict:
        """Send media message - handles both media_id and URL"""
        url = f"{self.base_url}/messages"
        
        # Check if it's a media_id (no http/https) or URL
        is_link = media_id_or_url.startswith(('http://', 'https://'))
        if is_link:
            media_payload = {"link": media_id_or_url}
        else:
            media_payload = {"id": media_id_or_url}  # Use media_id
        
        # Only attach caption for media types that support it
        if caption and media_type in ("image", "video", "document"):
            media_payload["caption"] = caption
        
        # Apply audio-specific flags for PTT/voice notes when using media_id
        if media_type == "audio" and not is_link:
            # WA Cloud voice note hints improve cross-client reliability
            enable_voice = (audio_voice is None or audio_voice is True) and AUDIO_VOICE_ENABLED
            if enable_voice:
                media_payload["voice"] = True

        payload = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": media_type,
            media_type: media_payload
        }
        if context_message_id:
            payload["context"] = {"message_id": context_message_id}
        
        logging.info("send_media_message start to=%s type=%s is_link=%s", to, media_type, is_link)
        async with httpx.AsyncClient() as client:
            response = await client.post(url, json=payload, headers=self.headers)
            result = response.json()
            logging.info("send_media_message response status=%s body=%s", response.status_code, result)
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
            "server_ts",
            "url",  # store public URL for media
            # reply / reactions metadata
            "reply_to",            # wa_message_id of the quoted/original message
            "quoted_text",         # optional cached snippet of the quoted message
            "reaction_to",         # wa_message_id of the message this reaction targets
            "reaction_emoji",      # emoji character (e.g. "👍")
            "reaction_action",     # add/remove per WhatsApp payload
            "waveform",            # optional JSON array of peaks for audio
            # product identifiers (ensure catalog items render after reload)
            "product_retailer_id",
            "retailer_id",
            "product_id",
            # agent attribution
            "agent_username",
        }
        # Columns allowed in the conversation_notes table (except auto-increment id)
        self.note_columns = {
            "user_id",
            "agent_username",
            "type",
            "text",
            "url",
            "created_at",
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
                # Limit pool sizes to avoid exhausting free-tier Postgres (e.g., Supabase)
                self._pool = await asyncpg.create_pool(
                    self.db_url,
                    min_size=PG_POOL_MIN,
                    max_size=PG_POOL_MAX,
                    timeout=30.0,
                    # PgBouncer (Supabase pooler) + prepared statements don't mix in transaction pooling
                    # Disable statement cache to avoid prepared-statement usage across pooled connections
                    statement_cache_size=0,
                    # Recycle idle connections to keep footprint small on free tiers
                    max_inactive_connection_lifetime=60.0,
                )
            except Exception as exc:
                if self.db_url and REQUIRE_POSTGRES:
                    # Explicitly require Postgres: surface error and do not silently fallback
                    raise
                # Fallback to SQLite if not strictly requiring Postgres
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
        # Try Postgres first, but robustly fall back to SQLite if no pool
        if self.use_postgres:
            pool = await self._get_pool()
            if pool:
                async with pool.acquire() as conn:
                    yield conn
                return
            # Pool unavailable → switch to SQLite for this session
            if self.db_url and REQUIRE_POSTGRES:
                raise RuntimeError("Postgres required but connection pool is unavailable")
            self.use_postgres = False
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
                    waveform       TEXT,
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

                -- Internal, agent-only notes attached to a conversation
                CREATE TABLE IF NOT EXISTS conversation_notes (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id         TEXT NOT NULL,
                    agent_username  TEXT,
                    type            TEXT DEFAULT 'text', -- 'text' | 'audio'
                    text            TEXT,
                    url             TEXT,
                    created_at      TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE INDEX IF NOT EXISTS idx_msg_wa_id
                    ON messages (wa_message_id);

                CREATE INDEX IF NOT EXISTS idx_msg_user_time
                    ON messages (user_id, datetime(timestamp));

                -- Additional index to optimize TEXT-based timestamp ordering in SQLite
                CREATE INDEX IF NOT EXISTS idx_msg_user_ts_text
                    ON messages (user_id, timestamp);

                CREATE INDEX IF NOT EXISTS idx_notes_user_time
                    ON conversation_notes (user_id, datetime(created_at));

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

                -- Orders created attribution (per agent)
                CREATE TABLE IF NOT EXISTS orders_created (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id        TEXT,
                    user_id         TEXT,
                    agent_username  TEXT,
                    created_at      TEXT DEFAULT CURRENT_TIMESTAMP
                );

                CREATE INDEX IF NOT EXISTS idx_orders_created_agent_time
                    ON orders_created (agent_username, created_at);

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
                script = script.replace("datetime(created_at)", "created_at")
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
            await self._add_column_if_missing(db, "messages", "waveform", "TEXT")
            # Ensure product identifiers columns exist for catalog items
            await self._add_column_if_missing(db, "messages", "product_retailer_id", "TEXT")
            await self._add_column_if_missing(db, "messages", "retailer_id", "TEXT")
            await self._add_column_if_missing(db, "messages", "product_id", "TEXT")
            # Ensure server-side timestamp column exists
            await self._add_column_if_missing(db, "messages", "server_ts", "TEXT")
            # Ensure agent attribution column exists
            await self._add_column_if_missing(db, "messages", "agent_username", "TEXT")
            # Add index on server_ts for ordering by receive time
            if self.use_postgres:
                await db.execute("CREATE INDEX IF NOT EXISTS idx_msg_user_server_ts ON messages (user_id, server_ts)")
            else:
                await db.execute("CREATE INDEX IF NOT EXISTS idx_msg_user_server_ts ON messages (user_id, server_ts)")
                await db.commit()

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

    async def get_agent_is_admin(self, username: str) -> int:
        """Return 1 if agent is admin, else 0."""
        async with self._conn() as db:
            query = self._convert("SELECT is_admin FROM agents WHERE username = ?")
            params = (username,)
            if self.use_postgres:
                row = await db.fetchrow(query, *params)
                return int(row[0]) if row else 0
            else:
                cur = await db.execute(query, params)
                row = await cur.fetchone()
                return int(row[0]) if row else 0

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
                # Order by server receive time when available, falling back to original timestamp
                query = self._convert(
                    "SELECT * FROM messages WHERE user_id = ? ORDER BY COALESCE(server_ts, timestamp) DESC LIMIT ? OFFSET ?"
                )
            else:
                # SQLite: ISO-8601 strings sort correctly lexicographically
                query = self._convert(
                    "SELECT * FROM messages WHERE user_id = ? ORDER BY COALESCE(server_ts, timestamp) DESC LIMIT ? OFFSET ?"
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
                "SELECT * FROM messages WHERE user_id = ? AND COALESCE(server_ts, timestamp) > ? ORDER BY COALESCE(server_ts, timestamp) ASC LIMIT ?"
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
                "SELECT * FROM messages WHERE user_id = ? AND COALESCE(server_ts, timestamp) < ? ORDER BY COALESCE(server_ts, timestamp) DESC LIMIT ?"
            )
            params = [user_id, before_timestamp, limit]
            if self.use_postgres:
                rows = await db.fetch(query, *params)
            else:
                cur = await db.execute(query, tuple(params))
                rows = await cur.fetchall()
            return [dict(r) for r in rows][::-1]

    # ── Conversation notes helpers ─────────────────────────────────
    async def add_note(self, note: dict) -> dict:
        """Insert a new conversation note and return the stored row."""
        data = {k: v for k, v in (note or {}).items() if k in self.note_columns}
        if not data.get("user_id"):
            raise HTTPException(status_code=400, detail="user_id is required")
        async with self._conn() as db:
            cols = ", ".join(data.keys())
            qs = ", ".join("?" for _ in data)
            query = self._convert(f"INSERT INTO conversation_notes ({cols}) VALUES ({qs})")
            if self.use_postgres:
                await db.execute(query, *data.values())
                rowq = self._convert(
                    "SELECT * FROM conversation_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
                )
                rows = await db.fetch(rowq, data["user_id"], 1)
                return dict(rows[0]) if rows else data
            else:
                await db.execute(query, tuple(data.values()))
                await db.commit()
                cur = await db.execute(
                    "SELECT * FROM conversation_notes WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 1",
                    (data["user_id"],),
                )
                row = await cur.fetchone()
                return dict(row) if row else data

    async def list_notes(self, user_id: str) -> list[dict]:
        if not user_id:
            return []
        async with self._conn() as db:
            if self.use_postgres:
                q = self._convert(
                    "SELECT * FROM conversation_notes WHERE user_id = ? ORDER BY created_at ASC"
                )
                rows = await db.fetch(q, user_id)
                return [dict(r) for r in rows]
            else:
                cur = await db.execute(
                    "SELECT * FROM conversation_notes WHERE user_id = ? ORDER BY datetime(created_at) ASC",
                    (user_id,),
                )
                rows = await cur.fetchall()
                return [dict(r) for r in rows]

    async def delete_note(self, note_id: int):
        async with self._conn() as db:
            if self.use_postgres:
                await db.execute("DELETE FROM conversation_notes WHERE id = $1", note_id)
            else:
                await db.execute("DELETE FROM conversation_notes WHERE id = ?", (note_id,))
                await db.commit()

    async def update_message_status(self, wa_message_id: str, status: str):
        """Persist a status update for a message identified by wa_message_id.

        Returns the temp_id if available so the UI can reconcile optimistic bubbles.
        """
        # Look up the owning user and temp_id so we can perform a precise upsert
        user_id: Optional[str] = None
        temp_id: Optional[str] = None
        async with self._conn() as db:
            try:
                query = self._convert("SELECT user_id, temp_id, status FROM messages WHERE wa_message_id = ?")
                params = [wa_message_id]
                if self.use_postgres:
                    row = await db.fetchrow(query, *params)
                else:
                    cur = await db.execute(query, tuple(params))
                    row = await cur.fetchone()
                if row:
                    user_id = row["user_id"]
                    temp_id = row["temp_id"]
                    # Guard against downgrades at DB boundary as well (belt and braces)
                    current_status = row["status"]
                    if _STATUS_RANK.get(status, 0) < _STATUS_RANK.get(current_status, 0):
                        return temp_id
            except Exception:
                # If lookup fails, fall back to best-effort upsert without temp_id
                pass

        if user_id:
            await self.upsert_message({"user_id": user_id, "wa_message_id": wa_message_id, "status": status})
        # If we couldn't resolve user_id, do nothing to avoid inserting orphan rows
        return temp_id

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

    async def get_last_agent_message_time(self, user_id: str) -> Optional[str]:
        """Return ISO timestamp of the last outbound (from_me=1) message for a user."""
        async with self._conn() as db:
            query = self._convert(
                "SELECT MAX(COALESCE(server_ts, timestamp)) as t FROM messages WHERE user_id = ? AND from_me = 1"
            )
            params = [user_id]
            if self.use_postgres:
                row = await db.fetchrow(query, *params)
            else:
                cur = await db.execute(query, tuple(params))
                row = await cur.fetchone()
            return (row and (row["t"] or None)) if row else None

    async def has_invoice_message(self, user_id: str) -> bool:
        """Detect whether an automated invoice image was sent in this chat.

        Heuristic: any outbound image message with an Arabic caption containing 'فاتورتك'.
        """
        async with self._conn() as db:
            # Use LIKE on caption; fall back to 0 when caption is NULL
            query = self._convert(
                "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND from_me = 1 AND type = 'image' AND COALESCE(caption, '') LIKE ?"
            )
            params = [user_id, "%فاتورتك%"]
            if self.use_postgres:
                row = await db.fetchrow(query, *params)
                count = int(row[0]) if row else 0
            else:
                cur = await db.execute(query, tuple(params))
                row = await cur.fetchone()
                count = int(row[0]) if row else 0
            return count > 0

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
            "waveform": message.get("waveform"),
            # persist product identifiers so frontend can restore rich bubble
            "product_retailer_id": (
                message.get("product_retailer_id")
                or message.get("retailer_id")
                or message.get("product_id")
            ),
            "retailer_id": message.get("retailer_id"),
            "product_id": message.get("product_id"),
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

    async def get_conversations_with_stats(self, q: Optional[str] = None, unread_only: bool = False, assigned: Optional[str] = None, tags: Optional[List[str]] = None, limit: int = 200, offset: int = 0) -> List[dict]:
        """Return conversation summaries for chat list with optional filters.

        Optimized single-query plan for Postgres; SQLite uses existing per-user aggregation.
        """
        async with self._conn() as db:
            # Postgres optimized path
            if self.use_postgres:
                # Fetch a window of conversations ordered by last message time using LATERAL
                base = self._convert(
                    """
                    SELECT
                      m.user_id,
                      u.name,
                      u.phone,
                      last_msg.message       AS last_message,
                      last_msg.type          AS last_message_type,
                      last_msg.from_me       AS last_message_from_me,
                      last_msg.status        AS last_message_status,
                      last_msg.ts            AS last_message_time,
                      (SELECT COUNT(*) FROM messages mu WHERE mu.user_id = m.user_id AND mu.from_me = 0 AND mu.status != 'read') AS unread_count,
                      (
                        SELECT COUNT(*)
                        FROM messages mx
                        WHERE mx.user_id = m.user_id
                          AND mx.from_me = 0
                          AND mx.status = 'read'
                          AND COALESCE(mx.server_ts, mx.timestamp) > (
                            SELECT COALESCE(MAX(COALESCE(server_ts, timestamp)), '1970-01-01')
                            FROM messages ma
                            WHERE ma.user_id = m.user_id AND ma.from_me = 1
                          )
                      ) AS unresponded_count,
                      cm.assigned_agent,
                      cm.tags,
                      cm.avatar_url AS avatar
                    FROM (SELECT DISTINCT user_id FROM messages) m
                    LEFT JOIN users u ON u.user_id = m.user_id
                    LEFT JOIN LATERAL (
                      SELECT message, type, from_me, status, COALESCE(server_ts, timestamp) AS ts
                      FROM messages mm
                      WHERE mm.user_id = m.user_id
                      ORDER BY COALESCE(server_ts, timestamp) DESC
                      LIMIT 1
                    ) last_msg ON TRUE
                    LEFT JOIN conversation_meta cm ON cm.user_id = m.user_id
                    ORDER BY last_msg.ts DESC NULLS LAST
                    LIMIT ? OFFSET ?
                    """
                )
                rows = await db.fetch(base, limit, offset)
                conversations: List[dict] = []
                for r in rows:
                    # Normalize tags JSON to list
                    tags_raw = r["tags"] if "tags" in r else None
                    try:
                        tags_list = json.loads(tags_raw) if isinstance(tags_raw, str) and tags_raw else []
                    except Exception:
                        tags_list = []
                    conv = {
                        "user_id": r["user_id"],
                        "name": r["name"],
                        "phone": r["phone"],
                        "last_message": r["last_message"],
                        "last_message_time": r["last_message_time"],
                        "last_message_type": r["last_message_type"],
                        "last_message_from_me": bool(r["last_message_from_me"]) if r["last_message_from_me"] is not None else None,
                        "last_message_status": r["last_message_status"],
                        "unread_count": r["unread_count"] or 0,
                        "unresponded_count": r["unresponded_count"] or 0,
                        "avatar": (r["avatar"] if "avatar" in r else None),
                        "assigned_agent": r["assigned_agent"],
                        "tags": tags_list,
                    }
                    # Apply light in-memory filters
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
                    conversations.append(conv)
                return conversations

            # SQLite fallback path (existing logic)
            cur = await db.execute(self._convert("SELECT DISTINCT user_id FROM messages"))
            user_rows = await cur.fetchall()
            user_ids = [r["user_id"] for r in user_rows]

            conversations = []
            for uid in user_ids:
                cur = await db.execute(self._convert("SELECT name, phone FROM users WHERE user_id = ?"), (uid,))
                user = await cur.fetchone()

                cur = await db.execute(
                    self._convert(
                        "SELECT message, type, from_me, status, COALESCE(server_ts, timestamp) AS ts FROM messages WHERE user_id = ? ORDER BY COALESCE(server_ts, timestamp) DESC LIMIT 1"
                    ),
                    (uid,)
                )
                last = await cur.fetchone()
                last_msg = last["message"] if last else None
                last_time = last["ts"] if last else None
                last_type = last["type"] if last else None
                last_from_me = bool(last["from_me"]) if last and ("from_me" in last) else None
                last_status = last["status"] if last else None

                cur = await db.execute(
                    self._convert("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND from_me = 0 AND status != 'read'"),
                    (uid,)
                )
                unread_row = await cur.fetchone()
                unread = unread_row["c"]

                cur = await db.execute(
                    self._convert(
                        "SELECT MAX(COALESCE(server_ts, timestamp)) as t FROM messages WHERE user_id = ? AND from_me = 1"
                    ),
                    (uid,)
                )
                last_agent_row = await cur.fetchone()
                last_agent = (last_agent_row["t"] or "1970-01-01") if last_agent_row else "1970-01-01"

                cur = await db.execute(
                    self._convert(
                        "SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND from_me = 0 AND status = 'read' AND COALESCE(server_ts, timestamp) > ?"
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
                    "last_message_type": last_type,
                    "last_message_from_me": last_from_me,
                    "last_message_status": last_status,
                    "unread_count": unread,
                    "unresponded_count": unresponded,
                    "avatar": meta.get("avatar_url"),
                    "assigned_agent": meta.get("assigned_agent"),
                    "tags": meta.get("tags", []),
                }
                # Apply filters in-memory
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
                conversations.append(conv)

            conversations.sort(key=lambda x: x["last_message_time"] or "", reverse=True)
            # Apply pagination for SQLite path
            return conversations[offset: offset + limit]

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

    # ----- Agent analytics helpers -----
    async def log_order_created(self, order_id: str, user_id: Optional[str], agent_username: Optional[str]):
        async with self._conn() as db:
            query = self._convert(
                """
                INSERT INTO orders_created (order_id, user_id, agent_username, created_at)
                VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
                """
            )
            # created_at left None for default
            params = [order_id, user_id, agent_username, None]
            if self.use_postgres:
                await db.execute(query, *params)
            else:
                await db.execute(query, tuple(params))
                await db.commit()

    async def get_agent_analytics(self, agent_username: str, start: Optional[str] = None, end: Optional[str] = None) -> dict:
        # Default window: last 30 days
        end_iso = end or datetime.utcnow().isoformat()
        start_iso = start or (datetime.utcnow() - timedelta(days=30)).isoformat()
        async with self._conn() as db:
            # messages sent by this agent
            q_msg = self._convert(
                """
                SELECT COUNT(*) AS c
                FROM messages
                WHERE from_me = 1 AND agent_username = ?
                  AND SUBSTR(REPLACE(COALESCE(server_ts, timestamp), ' ', 'T'), 1, 19) >= SUBSTR(REPLACE(?, ' ', 'T'), 1, 19)
                  AND SUBSTR(REPLACE(COALESCE(server_ts, timestamp), ' ', 'T'), 1, 19) <= SUBSTR(REPLACE(?, ' ', 'T'), 1, 19)
                """
            )
            params = [agent_username, start_iso, end_iso]
            if self.use_postgres:
                row = await db.fetchrow(q_msg, *params)
                messages_sent = (row[0] if row else 0) or 0
            else:
                cur = await db.execute(q_msg, tuple(params))
                row = await cur.fetchone()
                messages_sent = (row[0] if row else 0) or 0

            # orders created by this agent
            q_order = self._convert(
                """
                SELECT COUNT(*) AS c
                FROM orders_created
                WHERE agent_username = ?
                  AND SUBSTR(REPLACE(created_at, ' ', 'T'), 1, 19) >= SUBSTR(REPLACE(?, ' ', 'T'), 1, 19)
                  AND SUBSTR(REPLACE(created_at, ' ', 'T'), 1, 19) <= SUBSTR(REPLACE(?, ' ', 'T'), 1, 19)
                """
            )
            if self.use_postgres:
                row = await db.fetchrow(q_order, *params)
                orders_created = (row[0] if row else 0) or 0
            else:
                cur = await db.execute(q_order, tuple(params))
                row = await cur.fetchone()
                orders_created = (row[0] if row else 0) or 0

            # average response time in seconds (to previous inbound)
            if self.use_postgres:
                q_avg = self._convert(
                    """
                    SELECT AVG(
                        EXTRACT(EPOCH FROM CAST(COALESCE(m.server_ts, m.timestamp) AS TIMESTAMP)) -
                        EXTRACT(EPOCH FROM CAST((
                            SELECT COALESCE(mi.server_ts, mi.timestamp)
                            FROM messages mi
                            WHERE mi.user_id = m.user_id AND mi.from_me = 0
                                  AND COALESCE(mi.server_ts, mi.timestamp) <= COALESCE(m.server_ts, m.timestamp)
                            ORDER BY COALESCE(mi.server_ts, mi.timestamp) DESC
                            LIMIT 1
                        ) AS TIMESTAMP))
                    ) AS avg_sec
                    FROM messages m
                    WHERE m.from_me = 1 AND m.agent_username = ?
                      AND SUBSTR(REPLACE(COALESCE(m.server_ts, m.timestamp), ' ', 'T'), 1, 19) >= SUBSTR(REPLACE(?, ' ', 'T'), 1, 19)
                      AND SUBSTR(REPLACE(COALESCE(m.server_ts, m.timestamp), ' ', 'T'), 1, 19) <= SUBSTR(REPLACE(?, ' ', 'T'), 1, 19)
                    """
                )
            else:
                q_avg = self._convert(
                    """
                    SELECT AVG(
                        strftime('%s', COALESCE(m.server_ts, m.timestamp)) -
                        strftime('%s', (
                            SELECT COALESCE(mi.server_ts, mi.timestamp)
                            FROM messages mi
                            WHERE mi.user_id = m.user_id AND mi.from_me = 0
                                  AND COALESCE(mi.server_ts, mi.timestamp) <= COALESCE(m.server_ts, m.timestamp)
                            ORDER BY COALESCE(mi.server_ts, mi.timestamp) DESC
                            LIMIT 1
                        ))
                    ) AS avg_sec
                    FROM messages m
                    WHERE m.from_me = 1 AND m.agent_username = ?
                      AND SUBSTR(REPLACE(COALESCE(m.server_ts, m.timestamp), ' ', 'T'), 1, 19) >= SUBSTR(REPLACE(?, ' ', 'T'), 1, 19)
                      AND SUBSTR(REPLACE(COALESCE(m.server_ts, m.timestamp), ' ', 'T'), 1, 19) <= SUBSTR(REPLACE(?, ' ', 'T'), 1, 19)
                    """
                )
            if self.use_postgres:
                row = await db.fetchrow(q_avg, *params)
                avg_response_seconds = float(row[0]) if row and row[0] is not None else None
            else:
                cur = await db.execute(q_avg, tuple(params))
                row = await cur.fetchone()
                avg_response_seconds = float(row[0]) if row and row[0] is not None else None

            return {
                "agent": agent_username,
                "start": start_iso,
                "end": end_iso,
                "messages_sent": int(messages_sent),
                "orders_created": int(orders_created),
                **({"avg_response_seconds": avg_response_seconds} if avg_response_seconds is not None else {}),
            }

    async def get_all_agents_analytics(self, start: Optional[str] = None, end: Optional[str] = None) -> List[dict]:
        agents = await self.list_agents()
        results: List[dict] = []
        for a in agents:
            username = a.get("username")
            if not username:
                continue
            stats = await self.get_agent_analytics(username, start, end)
            # add agent name if present
            if a.get("name"):
                stats["name"] = a.get("name")
            results.append(stats)
        return results

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
        message_text = str(message_data.get("message", ""))
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
            "server_ts": timestamp,
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
            # carry flags
            "needs_bilingual_prompt": bool(message_data.get("needs_bilingual_prompt")),
            # reply/reactions passthrough
            "reply_to": message_data.get("reply_to"),
            # buttons passthrough for interactive messages
            "buttons": message_data.get("buttons"),
        }
        # Attach agent attribution if present
        agent_username = message_data.get("agent_username")
        if agent_username:
            optimistic_message["agent_username"] = agent_username
            # Also include a generic 'agent' alias for UI compatibility
            optimistic_message["agent"] = agent_username
        
        # For media messages, add URL field
        if message_type in ["image", "audio", "video"]:
            if message_data.get("url"):
                optimistic_message["url"] = message_data["url"]
            elif message_text and not message_text.startswith("http"):
                filename = Path(message_text).name
                optimistic_message["url"] = f"{BASE_URL}/media/{filename}"
            else:
                optimistic_message["url"] = message_text
            # pass-through waveform if present
            if message_type == "audio" and isinstance(message_data.get("waveform"), list):
                optimistic_message["waveform"] = message_data.get("waveform")
        
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

    # -------------------- Shopify helpers --------------------
    async def _fetch_shopify_variant(self, variant_id: str) -> Optional[dict]:
        try:
            import httpx  # type: ignore
            from .shopify_integration import admin_api_base, _client_args  # type: ignore
            async with httpx.AsyncClient(timeout=12.0) as client:
                resp = await client.get(f"{admin_api_base()}/variants/{variant_id}.json", **_client_args())
                if resp.status_code == 200:
                    return (resp.json() or {}).get("variant") or None
        except Exception:
            return None
        return None

    async def _resolve_shopify_variant(self, numeric_id: str) -> tuple[Optional[str], Optional[dict]]:
        """Return a valid Shopify variant id and variant dict.

        If the provided id is a product id, attempt to fetch its first variant.
        """
        # 1) Try as variant id directly
        v = await self._fetch_shopify_variant(numeric_id)
        if v and v.get("id"):
            return str(v.get("id")), v
        # 2) Try as product id -> first variant
        try:
            import httpx  # type: ignore
            from .shopify_integration import admin_api_base, _client_args  # type: ignore
            async with httpx.AsyncClient(timeout=12.0) as client:
                resp = await client.get(f"{admin_api_base()}/products/{numeric_id}.json", **_client_args())
                if resp.status_code == 200:
                    prod = (resp.json() or {}).get("product") or {}
                    variants = prod.get("variants") or []
                    if variants:
                        v0 = variants[0]
                        # Enrich minimal fields similar to /shopify-variant
                        v0["product_title"] = prod.get("title")
                        images = prod.get("images") or []
                        image_src = (prod.get("image") or {}).get("src") or (images[0].get("src") if images else None)
                        if image_src:
                            v0["image_src"] = image_src
                        return str(v0.get("id")), v0
        except Exception:
            pass
        return None, None

    async def _handle_order_status_request(self, user_id: str) -> None:
        """Fetch recent orders (last 4 days) for this phone and send details."""
        try:
            import httpx  # type: ignore
            from .shopify_integration import fetch_customer_by_phone, admin_api_base, _client_args  # type: ignore
            cust = await fetch_customer_by_phone(user_id)
            if not cust or not isinstance(cust, dict) or not cust.get("customer_id"):
                await self.process_outgoing_message({
                    "user_id": user_id,
                    "type": "text",
                    "from_me": True,
                    "message": (
                        "Aucune commande trouvée pour votre numéro.\n"
                        "لم يتم العثور على أي طلب مرتبط برقم هاتفك."
                    ),
                    "timestamp": datetime.utcnow().isoformat(),
                })
                return
            customer_id = cust["customer_id"]
            now = datetime.utcnow()
            since = (now - timedelta(days=4)).isoformat() + "Z"
            params = {
                "customer_id": str(customer_id),
                "status": "any",
                "order": "created_at desc",
                "limit": 10,
                "created_at_min": since,
            }
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(f"{admin_api_base()}/orders.json", params=params, **_client_args())
                if resp.status_code >= 400:
                    raise Exception(f"Shopify orders error {resp.status_code}")
                orders = (resp.json() or {}).get("orders", [])
            if not orders:
                await self.process_outgoing_message({
                    "user_id": user_id,
                    "type": "text",
                    "from_me": True,
                    "message": (
                        "Aucune commande des 4 derniers jours.\n"
                        "لا توجد طلبات خلال آخر 4 أيام."
                    ),
                    "timestamp": datetime.utcnow().isoformat(),
                })
                return
            # Compose bilingual summary
            lines_fr: list[str] = ["Voici vos commandes (4 derniers jours):"]
            lines_ar: list[str] = ["هذه طلباتك خلال آخر 4 أيام:"]
            # Also collect up to 2 images to send
            images: list[tuple[str, str]] = []  # (url, caption)
            for o in orders[:3]:
                name = o.get("name") or f"#{o.get('id')}"
                created_at = o.get("created_at", "")
                status = o.get("fulfillment_status") or "unfulfilled"
                status_fr = "expédiée" if status == "fulfilled" else "non expédiée"
                status_ar = "مكتملة" if status == "fulfilled" else "غير مكتملة"
                lines_fr.append(f"- {name} — {created_at[:10]} — Statut: {status_fr}")
                lines_ar.append(f"- {name} — {created_at[:10]} — الحالة: {status_ar}")
                for li in (o.get("line_items") or [])[:2]:
                    t = li.get("title") or ""
                    vt = li.get("variant_title") or ""
                    q = li.get("quantity") or 1
                    lines_fr.append(f"  • {t} — {vt} ×{q}")
                    lines_ar.append(f"  • {t} — {vt} ×{q}")
                    # Try to resolve variant image
                    try:
                        vid = li.get("variant_id")
                        if vid and len(images) < 2:
                            v_id_str, v_obj = await self._resolve_shopify_variant(str(vid))
                            img = (v_obj or {}).get("image_src")
                            if img:
                                cap = f"{t} — {vt}"
                                images.append((img, cap))
                    except Exception:
                        pass
            summary = "\n".join(lines_fr + [""] + lines_ar)
            await self.process_outgoing_message({
                "user_id": user_id,
                "type": "text",
                "from_me": True,
                "message": summary,
                "timestamp": datetime.utcnow().isoformat(),
            })
            for url, cap in images:
                await self.process_outgoing_message({
                    "user_id": user_id,
                    "type": "image",
                    "from_me": True,
                    "message": url,
                    "url": url,
                    "caption": cap,
                    "timestamp": datetime.utcnow().isoformat(),
                })
        except Exception as exc:
            print(f"order status fetch error: {exc}")
            await self.process_outgoing_message({
                "user_id": user_id,
                "type": "text",
                "from_me": True,
                "message": (
                    "Une erreur est survenue lors de la récupération de vos commandes.\n"
                    "حدث خطأ أثناء جلب طلباتك."
                ),
                "timestamp": datetime.utcnow().isoformat(),
            })

    async def _send_buy_gender_list(self, user_id: str) -> None:
        body = (
            "Veuillez choisir: Fille ou Garçon\n"
            "يرجى الاختيار: بنت أم ولد"
        )
        sections = [{
            "title": "Genre | النوع",
            "rows": [
                {"id": "gender_girls", "title": "Fille | بنت"},
                {"id": "gender_boys", "title": "Garçon | ولد"},
            ],
        }]
        await self.process_outgoing_message({
            "user_id": user_id,
            "type": "list",
            "from_me": True,
            "message": body,
            "button_text": "Choisir | اختر",
            "sections": sections,
            "timestamp": datetime.utcnow().isoformat(),
        })

    async def _send_gender_prompt(self, user_id: str, reply_id: str) -> None:
        if reply_id == "gender_girls":
            msg = (
                "Filles: indiquez l'âge (0 mois à 7 ans) et la pointure (16 à 38).\n"
                "البنات: يرجى تزويدنا بالعمر (من 0 شهر إلى 7 سنوات) ومقاس الحذاء (من 16 إلى 38)."
            )
        else:
            msg = (
                "Garçons: indiquez l'âge (0 mois à 10 ans) et la pointure (16 à 38).\n"
                "الأولاد: يرجى تزويدنا بالعمر (من 0 شهر إلى 10 سنوات) ومقاس الحذاء (من 16 إلى 38)."
            )
        await self.process_outgoing_message({
            "user_id": user_id,
            "type": "text",
            "from_me": True,
            "message": msg,
            "timestamp": datetime.utcnow().isoformat(),
        })

    async def _send_to_whatsapp_bg(self, message: dict):
        """Background task to send message to WhatsApp and update status"""
        temp_id = message["temp_id"]
        user_id = message["user_id"]
        logging.info("send_to_whatsapp attempt user_id=%s type=%s temp_id=%s", user_id, message.get("type"), temp_id)
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
                logging.error("Internal channel processing error user_id=%s temp_id=%s error=%s", user_id, temp_id, exc, exc_info=True)
            return
        
        try:
            # Normalize destination for WhatsApp API (E.164 with plus) except internal channels
            if isinstance(user_id, str) and not user_id.startswith(("team:", "agent:", "dm:")):
                wa_to = _normalize_ma_phone(user_id)
            else:
                wa_to = user_id
            # Send to WhatsApp API with concurrency guard
            async with wa_semaphore:
                if message["type"] == "text":
                    wa_response = await self.whatsapp_messenger.send_text_message(
                        wa_to, message["message"], context_message_id=message.get("reply_to")
                    )
                elif message["type"] in ("catalog_item", "interactive_product"):
                    # Interactive single product via catalog
                    retailer_id = (
                        message.get("retailer_id")
                        or message.get("product_retailer_id")
                        or message.get("product_id")
                    )
                    caption = message.get("caption") or message.get("message") or ""
                    if not retailer_id:
                        raise Exception("Missing product_retailer_id for catalog_item")
                    try:
                        wa_response = await self.whatsapp_messenger.send_single_catalog_item(
                            wa_to, str(retailer_id), caption
                        )
                        # After interactive is delivered, optionally send bilingual prompt as a reply
                        if message.get("needs_bilingual_prompt"):
                            wa_msg_id = None
                            try:
                                wa_msg_id = (((wa_response or {}).get("messages") or [{}])[0] or {}).get("id")
                            except Exception:
                                wa_msg_id = None
                            prompt = (
                                "*Bienvenue chez IRRAKIDS* 👋\n"
                                "*Merci de nous indiquer :*\n"
                                "• Taille souhaitée 📏\n"
                                "• Âge de l'enfant 🎂\n"
                                "• Garçon ou fille 👦👧\n"
                                "*Nous vérifierons la disponibilité et vous proposerons d'autres articles adaptés à votre enfant.*\n"
                                "*مرحبًا بك في IRRAKIDS* 👋\n"
                                "*يرجى تزويدنا بـ:*\n"
                                "• المقاس المطلوب 📏\n"
                                "• عمر الطفل 🎂\n"
                                "• هل هو ولد أم بنت 👦👧\n"
                                "*سنتاكد من تواجد القياس ونرسل لك المنتجات المناسبة لقياس طفلك*"
                            )
                            await self.process_outgoing_message({
                                "user_id": user_id,
                                "type": "text",
                                "from_me": True,
                                "message": prompt,
                                **({"reply_to": wa_msg_id} if wa_msg_id else {}),
                                "timestamp": datetime.utcnow().isoformat(),
                            })
                    except Exception as _exc:
                        # Fallback: try to send first image from cached catalog for visibility
                        try:
                            products = catalog_manager.get_cached_products()
                        except Exception:
                            products = []
                        img_url = None
                        price = ""
                        if products:
                            try:
                                p = next((p for p in products if str(p.get("retailer_id")) == str(retailer_id)), None)
                                if p:
                                    images = p.get("images") or []
                                    if images:
                                        img_url = images[0].get("url")
                                    price = p.get("price") or ""
                            except Exception:
                                pass
                        # If not found in Meta catalog, try Shopify variant image using the UI variant id
                        if not img_url:
                            try:
                                ui_variant_id = (
                                    message.get("product_retailer_id")
                                    or message.get("product_id")
                                    or ""
                                )
                                if ui_variant_id:
                                    v = await self._fetch_shopify_variant(str(ui_variant_id))
                                    if v and v.get("image_src"):
                                        img_url = v.get("image_src")
                                        price = v.get("price") or price
                                        # If caption is empty, use variant title
                                        if not caption:
                                            caption = v.get("title") or ""
                            except Exception:
                                pass
                        if img_url:
                            # Send as image with caption if interactive fails
                            safe_caption = caption or (price and _format_price_mad(price) or "")
                            wa_response = await self.whatsapp_messenger.send_media_message(
                                wa_to, "image", img_url, safe_caption
                            )
                            if message.get("needs_bilingual_prompt"):
                                wa_msg_id = None
                                try:
                                    wa_msg_id = (((wa_response or {}).get("messages") or [{}])[0] or {}).get("id")
                                except Exception:
                                    wa_msg_id = None
                                prompt = (
                                    "*Bienvenue chez IRRAKIDS* 👋\n"
                                    "*Merci de nous indiquer :*\n"
                                    "• Taille souhaitée 📏\n"
                                    "• Âge de l'enfant 🎂\n"
                                    "• Garçon ou fille 👦👧\n"
                                    "*Nous vérifierons la disponibilité et vous proposerons d'autres articles adaptés à votre enfant.*\n"
                                    "*مرحبًا بك في IRRAKIDS* 👋\n"
                                    "*يرجى تزويدنا بـ:*\n"
                                    "• المقاس المطلوب 📏\n"
                                    "• عمر الطفل 🎂\n"
                                    "• هل هو ولد أم بنت 👦👧\n"
                                    "*سنتاكد من تواجد القياس ونرسل لك المنتجات المناسبة لقياس طفلك*"
                                )
                                await self.process_outgoing_message({
                                    "user_id": user_id,
                                    "type": "text",
                                    "from_me": True,
                                    "message": prompt,
                                    **({"reply_to": wa_msg_id} if wa_msg_id else {}),
                                    "timestamp": datetime.utcnow().isoformat(),
                                })
                        else:
                            # Final fallback to text
                            wa_response = await self.whatsapp_messenger.send_text_message(
                                wa_to, caption or str(retailer_id)
                            )
                            if message.get("needs_bilingual_prompt"):
                                wa_msg_id = None
                                try:
                                    wa_msg_id = (((wa_response or {}).get("messages") or [{}])[0] or {}).get("id")
                                except Exception:
                                    wa_msg_id = None
                                prompt = (
                                    "*Bienvenue chez IRRAKIDS* 👋\n"
                                    "*Merci de nous indiquer :*\n"
                                    "• Taille souhaitée 📏\n"
                                    "• Âge de l'enfant 🎂\n"
                                    "• Garçon ou fille 👦👧\n"
                                    "*Nous vérifierons la disponibilité et vous proposerons d'autres articles adaptés à votre enfant.*\n"
                                    "*مرحبًا بك في IRRAKIDS* 👋\n"
                                    "*يرجى تزويدنا بـ:*\n"
                                    "• المقاس المطلوب 📏\n"
                                    "• عمر الطفل 🎂\n"
                                    "• هل هو ولد أم بنت 👦👧\n"
                                    "*سنتاكد من تواجد القياس ونرسل لك المنتجات المناسبة لقياس طفلك*"
                                )
                                await self.process_outgoing_message({
                                    "user_id": user_id,
                                    "type": "text",
                                    "from_me": True,
                                    "message": prompt,
                                    **({"reply_to": wa_msg_id} if wa_msg_id else {}),
                                    "timestamp": datetime.utcnow().isoformat(),
                                })
                elif message["type"] in ("buttons", "interactive_buttons"):
                    body_text = message.get("message") or ""
                    buttons = message.get("buttons") or []
                    if not isinstance(buttons, list) or not buttons:
                        # Fallback to text to avoid hard failure
                        wa_response = await self.whatsapp_messenger.send_text_message(
                            wa_to, body_text or ""
                        )
                    else:
                        wa_response = await self.whatsapp_messenger.send_reply_buttons(
                            wa_to, body_text, buttons
                        )
                elif message["type"] in ("list", "interactive_list"):
                    body_text = message.get("message") or ""
                    sections = message.get("sections") or []
                    button_text = message.get("button_text") or "Choose"
                    header_text = message.get("header_text") or None
                    footer_text = message.get("footer_text") or None
                    if not isinstance(sections, list) or not sections:
                        wa_response = await self.whatsapp_messenger.send_text_message(
                            wa_to, body_text or ""
                        )
                    else:
                        wa_response = await self.whatsapp_messenger.send_list_message(
                            wa_to,
                            body_text,
                            button_text,
                            sections,
                            header_text=header_text,
                            footer_text=footer_text,
                        )
                elif message["type"] == "order":
                    # For now send order payload as text to ensure delivery speed
                    payload = message.get("message")
                    wa_response = await self.whatsapp_messenger.send_text_message(
                        wa_to, payload if isinstance(payload, str) else json.dumps(payload or {})
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
                            # Always normalize audio to OGG/Opus 48k mono
                            if message["type"] == "audio":
                                try:
                                    ogg_path = await convert_webm_to_ogg(Path(media_path))
                                    try:
                                        Path(media_path).unlink(missing_ok=True)
                                    except Exception:
                                        pass
                                    media_path = str(ogg_path)
                                except Exception as _exc:
                                    print(f"Audio normalization failed/skipped: {_exc}")
                            gcs_url = await upload_file_to_gcs(str(media_path))
                            if gcs_url:
                                # Mutate in-memory message so final DB save includes correct URL
                                try:
                                    message["url"] = gcs_url
                                    if message.get("type") in ("audio", "video", "image"):
                                        message["message"] = gcs_url
                                except Exception:
                                    pass
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
                                        "message": gcs_url if message.get("type") in ("audio", "video", "image") else None,
                                    })
                                except Exception:
                                    pass
                        except Exception as _exc:
                            print(f"GCS upload failed (non-fatal): {_exc}")

                        print(f"📤 Uploading media to WhatsApp: {media_path}")
                        media_info = await self._upload_media_to_whatsapp(media_path, message["type"])
                        if message["type"] == "audio":
                            # Small settle delay after upload to avoid iOS fetching race
                            await asyncio.sleep(0.5)
                        if message.get("reply_to"):
                            wa_response = await self.whatsapp_messenger.send_media_message(
                                wa_to,
                                message["type"],
                                media_info["id"],
                                message.get("caption", ""),
                                context_message_id=message.get("reply_to"),
                                audio_voice=("audio/ogg" in (media_info.get("mime_type") or "")) if message["type"] == "audio" else None,
                            )
                        else:
                            wa_response = await self.whatsapp_messenger.send_media_message(
                                wa_to,
                                message["type"],
                                media_info["id"],
                                message.get("caption", ""),
                                audio_voice=("audio/ogg" in (media_info.get("mime_type") or "")) if message["type"] == "audio" else None,
                            )
                    elif media_url and isinstance(media_url, str) and media_url.startswith(("http://", "https://")):
                        # Prefer reliability: fetch the remote URL, upload to WhatsApp, then send by media_id
                        local_tmp_path: Optional[Path] = None
                        try:
                            async with httpx.AsyncClient(timeout=30.0) as client:
                                resp = await client.get(media_url)
                                if resp.status_code >= 400 or not resp.content:
                                    raise Exception(f"download status {resp.status_code}")
                                # Determine extension from content-type or URL
                                ctype = resp.headers.get("Content-Type", "")
                                ext = None
                                if "audio/ogg" in ctype or "opus" in ctype:
                                    ext = ".ogg"
                                elif message["type"] == "audio" and ("webm" in ctype or media_url.lower().endswith((".webm", ".weba"))):
                                    ext = ".webm"
                                elif message["type"] == "image" and ("jpeg" in ctype or media_url.lower().endswith((".jpg", ".jpeg"))):
                                    ext = ".jpg"
                                elif message["type"] == "image" and ("png" in ctype or media_url.lower().endswith(".png")):
                                    ext = ".png"
                                elif message["type"] == "video" and ("mp4" in ctype or media_url.lower().endswith(".mp4")):
                                    ext = ".mp4"
                                elif message["type"] == "document":
                                    # try to preserve original extension if any
                                    parsed = urlparse(media_url)
                                    name = os.path.basename(parsed.path or "")
                                    ext = os.path.splitext(name)[1] or ".bin"
                                else:
                                    ext = ".bin"

                                ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
                                local_tmp_path = self.media_dir / f"{message['type']}_{ts}_{uuid.uuid4().hex[:8]}{ext}"
                                async with aiofiles.open(local_tmp_path, "wb") as f:
                                    await f.write(resp.content)

                            # Always normalize audio → OGG/Opus 48k mono
                            if message["type"] == "audio":
                                try:
                                    ogg_path = await convert_webm_to_ogg(local_tmp_path)
                                    try:
                                        local_tmp_path.unlink(missing_ok=True)
                                    except Exception:
                                        pass
                                    local_tmp_path = ogg_path
                                except Exception as _exc:
                                    print(f"Audio normalization from URL failed/skipped: {_exc}")

                            media_info = await self._upload_media_to_whatsapp(str(local_tmp_path), message["type"])
                            if message["type"] == "audio":
                                await asyncio.sleep(0.5)
                            if message.get("reply_to"):
                                wa_response = await self.whatsapp_messenger.send_media_message(
                                    wa_to,
                                    message["type"],
                                    media_info["id"],
                                    message.get("caption", ""),
                                    context_message_id=message.get("reply_to"),
                                    audio_voice=("audio/ogg" in (media_info.get("mime_type") or "")) if message["type"] == "audio" else None,
                                )
                            else:
                                wa_response = await self.whatsapp_messenger.send_media_message(
                                    wa_to,
                                    message["type"],
                                    media_info["id"],
                                    message.get("caption", ""),
                                    audio_voice=("audio/ogg" in (media_info.get("mime_type") or "")) if message["type"] == "audio" else None,
                                )

                            # Store media_path for cleanup in finally and to align with DB/UI state
                            try:
                                message["media_path"] = str(local_tmp_path)
                            except Exception:
                                pass
                        except Exception as _exc:
                            # For audio, never fall back to sending by link – raise to surface failure
                            if message.get("type") == "audio":
                                print(f"URL fetch→upload failed for audio, not sending by link: {_exc}")
                                raise
                            # For other media, last resort: send public link
                            print(f"URL fetch→upload fallback failed, sending link: {_exc}")
                            if message.get("reply_to"):
                                wa_response = await self.whatsapp_messenger.send_media_message(
                                    wa_to, message["type"], media_url, message.get("caption", ""), context_message_id=message.get("reply_to")
                                )
                            else:
                                wa_response = await self.whatsapp_messenger.send_media_message(
                                    wa_to, message["type"], media_url, message.get("caption", "")
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
            
            logging.info("send_to_whatsapp success user_id=%s temp_id=%s wa_message_id=%s", user_id, temp_id, wa_message_id)
            # Send status update to UI
            await self.connection_manager.send_to_user(user_id, status_update)
            
            # Save to database with real WhatsApp ID
            await self.db_manager.save_message(message, wa_message_id, "sent")
            
            # If this is an invoice image (Arabic caption contains 'فاتورتك'), send the warning message as a reply
            try:
                if (message.get("type") == "image"):
                    cap = str(message.get("caption") or "")
                    if "فاتورتك" in cap:
                        warning_msg = (
                            "تنبيه مهم ⚠️\n"
                            "عند استلام طلبك، يرجى فحص المنتج وتجربته قبل دفع المبلغ للموزع. 📦✅\n"
                            "إذا كان المقاس غير مناسب أو وُجدت أي مشكلة في المنتج، يُرجى إرجاع الطلب فورًا مع الموزع، وسنتكفل بإرسال بديل دون أي رسوم إضافية. 🙏⭐\n"
                            "رضاكم أولويتنا دائمًا مع IRRAKIDS. شكرًا لثقتكم بنا ❤️"
                        )
                        await self.process_outgoing_message({
                            "user_id": user_id,
                            "type": "text",
                            "from_me": True,
                            "message": warning_msg,
                            "reply_to": wa_message_id,
                            "timestamp": datetime.utcnow().isoformat(),
                        })
            except Exception as _exc:
                print(f"invoice warning follow-up failed: {_exc}")
            
            _vlog(f"✅ Message sent successfully: {wa_message_id}")
            
        except Exception as e:
            logging.error("send_to_whatsapp failed user_id=%s temp_id=%s error=%s", user_id, temp_id, e, exc_info=True)
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
                    logging.warning("Cleanup failed for %s error=%s", media_path, e)

    async def _verify_graph_media(self, media_id: str) -> dict:
        """Fetch media metadata from Graph and return JSON."""
        url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{media_id}"
        headers = {"Authorization": f"Bearer {self.whatsapp_messenger.access_token}"}
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                raise Exception(f"Media verify failed: {resp.status_code} {resp.text}")
            return resp.json()

    async def _upload_media_to_whatsapp(self, file_path: str, media_type: str) -> dict:
        """Upload media file to WhatsApp and return {id, mime_type, filename}.

        Implements backoff and, for audio, verifies Graph media and may fallback to AAC/M4A.
        """
        src = Path(file_path)
        if not src.exists():
            raise Exception(f"Media file not found: {file_path}")

        upload_url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{self.whatsapp_messenger.phone_number_id}/media"

        async def choose_mime(path: Path, mtype: str) -> str:
            suffix = path.suffix.lower()
            if mtype == "audio":
                if suffix == ".ogg":
                    return "audio/ogg"
                if suffix in (".m4a", ".mp4", ".aac"):
                    return "audio/mp4"
            if mtype == "image":
                if suffix in (".jpg", ".jpeg"):
                    return "image/jpeg"
                if suffix == ".png":
                    return "image/png"
            if mtype == "video":
                return "video/mp4"
            if mtype == "document":
                if suffix == ".pdf":
                    return "application/pdf"
            return f"{mtype}/*"

        async def attempt_upload(path: Path, mtype: str) -> dict:
            # Read file content
            async with aiofiles.open(path, 'rb') as f:
                file_content = await f.read()

            mime_type = await choose_mime(path, mtype)
            files = {
                'file': (path.name, file_content, mime_type),
                'messaging_product': (None, 'whatsapp'),
                # Graph expects concrete MIME here (e.g., audio/ogg), not generic 'audio'
                'type': (None, mime_type),
            }
            headers = {"Authorization": f"Bearer {self.whatsapp_messenger.access_token}"}

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
                return {"id": media_id, "upload_mime": mime_type, "filename": path.name}

        # Backoff attempts
        delays = [0.25, 0.5, 1.0, 2.0, 4.0]
        last_err: Optional[Exception] = None
        for i, delay in enumerate(delays, start=1):
            try:
                info = await attempt_upload(src, media_type)
                # Verify for audio
                if media_type == "audio":
                    meta = await self._verify_graph_media(info["id"])
                    # Expect strict fields
                    mime = (meta.get("mime_type") or "").lower()
                    sha256 = meta.get("sha256")
                    size = meta.get("file_size")
                    if not sha256 or not size:
                        raise Exception("Graph media missing sha256/file_size")
                    # Prefer explicit Opus-in-Ogg when source was .ogg
                    if src.suffix.lower() == ".ogg" and "audio/ogg" not in mime:
                        raise Exception(f"Unexpected audio MIME from Graph: {mime}")
                    info["mime_type"] = mime
                else:
                    meta = await self._verify_graph_media(info["id"])  # sanity
                    info["mime_type"] = (meta.get("mime_type") or info.get("upload_mime") or "").lower()
                _vlog(f"✅ Media uploaded & verified. ID: {info['id']} MIME: {info.get('mime_type')}")
                return info
            except Exception as e:
                last_err = e
                _vlog(f"⏳ Upload attempt {i} failed: {e}")
                await asyncio.sleep(delay)

        # Final fallback for audio: convert to M4A and re-upload (still by media_id, never link)
        if media_type == "audio":
            try:
                m4a_path = await convert_any_to_m4a(src)
                info = await attempt_upload(m4a_path, media_type)
                meta = await self._verify_graph_media(info["id"])
                info["mime_type"] = (meta.get("mime_type") or info.get("upload_mime") or "").lower()
                _vlog(f"✅ Fallback M4A uploaded & verified. ID: {info['id']} MIME: {info.get('mime_type')}")
                return info
            except Exception as e:
                raise Exception(f"Failed after retries and m4a fallback: {e}")

        # Non-audio: give up
        raise Exception(f"Failed to upload media to WhatsApp after retries: {last_err}")
    
    async def process_incoming_message(self, webhook_data: dict):
        _vlog("🚨 process_incoming_message CALLED")
        _vlog(json.dumps(webhook_data, indent=2))
        """Process incoming WhatsApp message"""
        try:
            value = webhook_data['entry'][0]['changes'][0]['value']
            # Filter by phone_number_id so this instance only processes its own inbox
            try:
                meta = value.get("metadata") or {}
                incoming_phone_id = str(meta.get("phone_number_id") or "")
                configured_phone_id = str(PHONE_NUMBER_ID or "")
                if (
                    incoming_phone_id
                    and configured_phone_id
                    and configured_phone_id != "your_phone_number_id"
                    and incoming_phone_id != configured_phone_id
                ):
                    _vlog(
                        f"⏭️ Skipping webhook for phone_number_id {incoming_phone_id} (configured {configured_phone_id})"
                    )
                    return
            except Exception:
                # If metadata is missing or unexpected, proceed without filtering
                pass
            
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
        
        sender_raw = message.get("from") or (message.get("contact_info") or {}).get("wa_id")
        if not sender_raw:
            raise RuntimeError("incoming message missing sender id")
        sender = _normalize_user_id(sender_raw)
        msg_type = message["type"]
        wa_message_id = message.get("id")
        timestamp = datetime.utcfromtimestamp(int(message.get("timestamp", 0))).isoformat()
        server_now = datetime.now(timezone.utc).isoformat()
        
        # Extract contact name from contacts array if available
        contact_name = None
        # Note: contacts info is typically in the webhook's 'contacts' field, not message
        
        await self.db_manager.upsert_user(sender, contact_name, sender)
        # Auto-unarchive: if conversation is marked as Done, remove the tag on any new incoming message
        try:
            meta = await self.db_manager.get_conversation_meta(sender)
            tags = list(meta.get("tags") or []) if isinstance(meta, dict) else []
            if any(str(t).lower() == 'done' for t in tags):
                new_tags = [t for t in tags if str(t).lower() != 'done']
                await self.db_manager.set_conversation_tags(sender, new_tags)
        except Exception as _e:
            # Non-fatal: do not block message processing
            pass
        
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
            "server_ts": server_now,
            "wa_message_id": wa_message_id
        }
        
        # Extract message content and generate proper URLs
        if msg_type == "text":
            message_obj["message"] = message["text"]["body"]
        elif msg_type == "interactive":
            try:
                inter = message.get("interactive", {}) or {}
                btn = inter.get("button_reply") or {}
                lst = inter.get("list_reply") or {}
                title = (btn.get("title") or lst.get("title") or "").strip()
                # Capture id for workflow routing
                reply_id = (btn.get("id") or lst.get("id") or "").strip()
                # Extra fallbacks if title missing in payload variants
                if not title:
                    try:
                        # Some clients may not include title; fallback to visible button text or body text
                        title = (
                            (inter.get("button") or {}).get("text")
                            or inter.get("title")
                            or (inter.get("body") or {}).get("text")
                            or reply_id
                            or ""
                        ).strip()
                    except Exception:
                        title = reply_id or ""
                message_obj["type"] = "text"
                message_obj["message"] = title or "[interactive_reply]"
                # Order confirmation flow button handling (Arabic labels)
                try:
                    def _norm_ar(s: str) -> str:
                        t = (s or "").strip()
                        try:
                            t = t.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا")
                            t = t.replace("ي", "ى") if False else t  # placeholder for future normalization
                        except Exception:
                            pass
                        return t
                    tnorm = _norm_ar(title)
                    # Map known buttons
                    BTN1 = {"تاكيد الطلب", "تأكيد الطلب"}
                    BTN2 = {"تغير المعلومات", "تغيير المعلومات"}
                    BTN3 = {"تكلم مع العميل"}
                    if tnorm in BTN1:
                        audio_url = os.getenv("ORDER_CONFIRM_BTN1_AUDIO_URL", "")
                        if audio_url:
                            try:
                                to = _normalize_ma_phone(sender)
                                wa_id = await self._send_audio_via_upload(to, str(audio_url))
                                if not wa_id:
                                    res = await self.whatsapp_messenger.send_media_message(to=to, media_type="audio", media_id_or_url=str(audio_url), audio_voice=True)
                                    try:
                                        arr = (res or {}).get("messages") or []
                                        if isinstance(arr, list) and arr:
                                            wa_id = str((arr[0] or {}).get("id") or "") or None
                                    except Exception:
                                        wa_id = None
                                synthetic_audio = {
                                    "temp_id": f"temp_{uuid.uuid4().hex}",
                                    "user_id": sender,
                                    "message": str(audio_url),
                                    "type": "audio",
                                    "url": str(audio_url),
                                    "from_me": 1,
                                    "timestamp": datetime.utcnow().isoformat(),
                                    **({"wa_message_id": wa_id} if wa_id else {}),
                                    "status": "sent",
                                }
                                await self.db_manager.upsert_message(synthetic_audio)
                                await self.redis_manager.cache_message(sender, synthetic_audio)
                                await self.connection_manager.send_to_user(sender, {"type": "message_sent", "data": synthetic_audio})
                            except Exception:
                                pass
                        # Always send pending variant images after confirm
                        try:
                            await self._send_pending_variant_media(sender)
                        except Exception:
                            pass
                    elif tnorm in BTN2:
                        audio_url = os.getenv("ORDER_CONFIRM_BTN2_AUDIO_URL", "")
                        if audio_url:
                            try:
                                to = _normalize_ma_phone(sender)
                                ok = await self._send_audio_via_upload(to, str(audio_url))
                                if not ok:
                                    await self.whatsapp_messenger.send_media_message(to=to, media_type="audio", media_id_or_url=str(audio_url), audio_voice=True)
                                synthetic_audio = {
                                    "temp_id": f"temp_{uuid.uuid4().hex}",
                                    "user_id": sender,
                                    "message": str(audio_url),
                                    "type": "audio",
                                    "url": str(audio_url),
                                    "from_me": 1,
                                    "timestamp": datetime.utcnow().isoformat(),
                                }
                                await self.db_manager.upsert_message(synthetic_audio)
                                await self.redis_manager.cache_message(sender, synthetic_audio)
                                await self.connection_manager.send_to_user(sender, {"type": "message_sent", "data": synthetic_audio})
                            except Exception:
                                pass
                    elif tnorm in BTN3:
                        audio_url = os.getenv("ORDER_CONFIRM_BTN3_AUDIO_URL", "")
                        if audio_url:
                            try:
                                to = _normalize_ma_phone(sender)
                                ok = await self._send_audio_via_upload(to, str(audio_url))
                                if not ok:
                                    await self.whatsapp_messenger.send_media_message(to=to, media_type="audio", media_id_or_url=str(audio_url), audio_voice=True)
                                synthetic_audio = {
                                    "temp_id": f"temp_{uuid.uuid4().hex}",
                                    "user_id": sender,
                                    "message": str(audio_url),
                                    "type": "audio",
                                    "url": str(audio_url),
                                    "from_me": 1,
                                    "timestamp": datetime.utcnow().isoformat(),
                                }
                                await self.db_manager.upsert_message(synthetic_audio)
                                await self.redis_manager.cache_message(sender, synthetic_audio)
                                await self.connection_manager.send_to_user(sender, {"type": "message_sent", "data": synthetic_audio})
                            except Exception:
                                pass
                except Exception:
                    pass
                # Route survey interactions before generic acknowledgment
                if reply_id.startswith("survey_"):
                    # Persist the textual reply bubble first
                    await self.connection_manager.send_to_user(sender, {
                        "type": "message_received",
                        "data": message_obj
                    })
                    await self.connection_manager.broadcast_to_admins(
                        {"type": "message_received", "data": message_obj}, exclude_user=sender
                    )
                    db_data = {k: v for k, v in message_obj.items() if k != "id"}
                    await self.redis_manager.cache_message(sender, db_data)
                    await self.db_manager.upsert_message(db_data)
                    # Handle the survey reply and return (skip default ack)
                    try:
                        await self._handle_survey_interaction(sender, reply_id, title)
                    except Exception as _exc:
                        print(f"Survey interaction error: {_exc}")
                    return
                # Order status flow
                if reply_id == "order_status":
                    # Persist UI bubble then handle
                    await self.connection_manager.send_to_user(sender, {
                        "type": "message_received",
                        "data": message_obj
                    })
                    await self.connection_manager.broadcast_to_admins(
                        {"type": "message_received", "data": message_obj}, exclude_user=sender
                    )
                    db_data = {k: v for k, v in message_obj.items() if k != "id"}
                    await self.redis_manager.cache_message(sender, db_data)
                    await self.db_manager.upsert_message(db_data)
                    try:
                        await self._handle_order_status_request(sender)
                    except Exception as _exc:
                        print(f"order_status flow error: {_exc}")
                    return
                # Buy flow start → show gender list
                if reply_id == "buy_item":
                    await self.connection_manager.send_to_user(sender, {
                        "type": "message_received",
                        "data": message_obj
                    })
                    await self.connection_manager.broadcast_to_admins(
                        {"type": "message_received", "data": message_obj}, exclude_user=sender
                    )
                    db_data = {k: v for k, v in message_obj.items() if k != "id"}
                    await self.redis_manager.cache_message(sender, db_data)
                    await self.db_manager.upsert_message(db_data)
                    try:
                        await self._send_buy_gender_list(sender)
                    except Exception as _exc:
                        print(f"buy flow start error: {_exc}")
                    return
                # Gender selection → send size/age prompt
                if reply_id in ("gender_girls", "gender_boys"):
                    await self.connection_manager.send_to_user(sender, {
                        "type": "message_received",
                        "data": message_obj
                    })
                    await self.connection_manager.broadcast_to_admins(
                        {"type": "message_received", "data": message_obj}, exclude_user=sender
                    )
                    db_data = {k: v for k, v in message_obj.items() if k != "id"}
                    await self.redis_manager.cache_message(sender, db_data)
                    await self.db_manager.upsert_message(db_data)
                    try:
                        await self._send_gender_prompt(sender, reply_id)
                    except Exception as _exc:
                        print(f"gender prompt error: {_exc}")
                    return
            except Exception:
                message_obj["type"] = "text"
                message_obj["message"] = "[interactive_reply]"
        elif msg_type == "button":
            try:
                btn = message.get("button", {}) or {}
                title = (btn.get("text") or btn.get("payload") or "").strip()
            except Exception:
                title = "[button_reply]"
            message_obj["type"] = "text"
            message_obj["message"] = title or "[button_reply]"
            # Order confirmation quick-reply buttons (non-interactive payloads)
            try:
                def _norm_ar_btn(s: str) -> str:
                    t = (s or "").strip()
                    try:
                        t = t.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا")
                    except Exception:
                        pass
                    return t
                tnorm = _norm_ar_btn(title)
                BTN1 = {"تاكيد الطلب", "تأكيد الطلب"}
                BTN2 = {"تغير المعلومات", "تغيير المعلومات"}
                BTN3 = {"تكلم مع العميل"}
                matched = None
                if tnorm in BTN1:
                    matched = os.getenv("ORDER_CONFIRM_BTN1_AUDIO_URL", "")
                elif tnorm in BTN2:
                    matched = os.getenv("ORDER_CONFIRM_BTN2_AUDIO_URL", "")
                elif tnorm in BTN3:
                    matched = os.getenv("ORDER_CONFIRM_BTN3_AUDIO_URL", "")
                if matched:
                    try:
                        to = _normalize_ma_phone(sender)
                        wa_id = await self._send_audio_via_upload(to, str(matched))
                        if not wa_id:
                            res = await self.whatsapp_messenger.send_media_message(to=to, media_type="audio", media_id_or_url=str(matched), audio_voice=True)
                            try:
                                arr = (res or {}).get("messages") or []
                                if isinstance(arr, list) and arr:
                                    wa_id = str((arr[0] or {}).get("id") or "") or None
                            except Exception:
                                wa_id = None
                        synthetic_audio = {
                            "temp_id": f"temp_{uuid.uuid4().hex}",
                            "user_id": sender,
                            "message": str(matched),
                            "type": "audio",
                            "url": str(matched),
                            "from_me": 1,
                            "timestamp": datetime.utcnow().isoformat(),
                            **({"wa_message_id": wa_id} if wa_id else {}),
                            "status": "sent",
                        }
                        await self.db_manager.upsert_message(synthetic_audio)
                        await self.redis_manager.cache_message(sender, synthetic_audio)
                        await self.connection_manager.send_to_user(sender, {"type": "message_sent", "data": synthetic_audio})
                    except Exception:
                        pass
                # Only send pending images on explicit confirm BTN1 (by text matching)
                try:
                    tnorm = _norm_ar_btn(title)
                    if tnorm in {"تاكيد الطلب", "تأكيد الطلب"}:
                        try:
                            # small delay to ensure previous audio send settles in WA
                            await asyncio.sleep(0.5)
                        except Exception:
                            pass
                        await self._send_pending_variant_media(sender)
                except Exception:
                    pass
            except Exception:
                pass
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
            # If customer sends an audio after order confirmation, try sending pending variant images
            try:
                await self._send_pending_variant_media(sender)
            except Exception:
                pass
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
        
        # Persist first, then broadcast to ensure durability even if clients are offline
        # Remove "id" so SQLite doesn't try to insert the text wa_message_id into INTEGER PK
        db_data = {k: v for k, v in message_obj.items() if k != "id"}
        await self.db_manager.upsert_message(db_data)
        await self.redis_manager.cache_message(sender, db_data)

        # Now deliver to UI and admin dashboards
        await self.connection_manager.send_to_user(sender, {
            "type": "message_received",
            "data": message_obj
        })
        await self.connection_manager.broadcast_to_admins(
            {"type": "message_received", "data": message_obj},
            exclude_user=sender
        )
        
        # Auto-responses
        try:
            if msg_type == "text":
                await self._maybe_auto_reply_with_catalog(sender, message_obj.get("message", ""))
            elif msg_type == "interactive":
                # Default acknowledgement when no special handler above
                await self.process_outgoing_message({
                    "user_id": sender,
                    "type": "text",
                    "from_me": True,
                    "message": "Message reçu. Merci !\nتم استلام ردك، شكرًا لك!",
                    "timestamp": datetime.utcnow().isoformat(),
                })
        except Exception as _exc:
            # Never break incoming flow due to auto-reply errors
            print(f"Auto-reply failed: {_exc}")

    # -------- survey flow --------
    async def send_survey_invite(self, user_id: str) -> None:
        body = (
            "Aidez-nous à nous améliorer et obtenez 15% de réduction sur votre commande.\n"
            "ساعدنا على التحسن واحصل على خصم 15% على طلبك."
        )
        await self.process_outgoing_message({
            "user_id": user_id,
            "type": "buttons",
            "from_me": True,
            "message": body,
            "buttons": [
                {"id": "survey_start_ok", "title": "موافق | OK"},
                {"id": "survey_decline", "title": "غير مهتم | Pas int."},
            ],
            "timestamp": datetime.utcnow().isoformat(),
        })

    async def _handle_survey_interaction(self, user_id: str, reply_id: str, title: str) -> None:
        state = await self.redis_manager.get_survey_state(user_id) or {}
        stage = state.get("stage") or "start"
        uid_digits = _digits_only(user_id)
        is_test = uid_digits in SURVEY_TEST_NUMBERS

        # Start → ask rating
        if reply_id == "survey_start_ok":
            state = {"stage": "rating", "started_at": datetime.utcnow().isoformat()}
            await self.redis_manager.set_survey_state(user_id, state)
            body = (
                "Comment évaluez-vous la performance de notre agent ?\n"
                "كيف تقيم أداء وكيل المحادثة؟"
            )
            sections = [{
                "title": "Rating | التقييم",
                "rows": [
                    {"id": "survey_rate_1", "title": "⭐ 1"},
                    {"id": "survey_rate_2", "title": "⭐⭐ 2"},
                    {"id": "survey_rate_3", "title": "⭐⭐⭐ 3"},
                    {"id": "survey_rate_4", "title": "⭐⭐⭐⭐ 4"},
                    {"id": "survey_rate_5", "title": "⭐⭐⭐⭐⭐ 5"},
                ],
            }]
            await self.process_outgoing_message({
                "user_id": user_id,
                "type": "list",
                "from_me": True,
                "message": body,
                "button_text": "Choisir | اختر",
                "sections": sections,
                "timestamp": datetime.utcnow().isoformat(),
            })
            return

        # Decline → thank you
        if reply_id == "survey_decline":
            await self.redis_manager.clear_survey_state(user_id)
            if not (is_test and SURVEY_TEST_BYPASS_COOLDOWN):
                if is_test and SURVEY_TEST_COOLDOWN_SEC > 0:
                    await self.redis_manager.mark_survey_invited(user_id, window_sec=SURVEY_TEST_COOLDOWN_SEC)
                else:
                    await self.redis_manager.mark_survey_invited(user_id)
            await self.process_outgoing_message({
                "user_id": user_id,
                "type": "text",
                "from_me": True,
                "message": (
                    "Merci pour votre temps. Si vous changez d'avis, écrivez-nous.\n"
                    "شكرًا لوقتك. إذا غيرت رأيك، راسلنا في أي وقت."
                ),
                "timestamp": datetime.utcnow().isoformat(),
            })
            return

        # Rating selected → store and ask improvement
        if reply_id.startswith("survey_rate_"):
            try:
                rating = int(reply_id.split("_")[-1])
            except Exception:
                rating = None
            if not rating:
                return
            state["rating"] = max(1, min(5, rating))
            state["stage"] = "improvement"
            await self.redis_manager.set_survey_state(user_id, state)

            body = (
                "Quel aspect souhaitez-vous que nous améliorions le plus ?\n"
                "ما هو أكثر شيء تريد منا تحسينه؟"
            )
            sections = [{
                "title": "Improve | تحسين",
                "rows": [
                    {"id": "survey_improve_products", "title": "المزيد من المنتجات", "description": "Plus de produits"},
                    {"id": "survey_improve_service", "title": "تحسينات الخدمة", "description": "Améliorations du service"},
                    {"id": "survey_improve_prices", "title": "أسعار ملائمة", "description": "Des prix plus abordables"},
                    {"id": "survey_improve_quality", "title": "جودة أعلى", "description": "Produits de meilleure qualité"},
                ],
            }]
            await self.process_outgoing_message({
                "user_id": user_id,
                "type": "list",
                "from_me": True,
                "message": body,
                "button_text": "Choisir | اختر",
                "sections": sections,
                "timestamp": datetime.utcnow().isoformat(),
            })
            return

        # Improvement selected → thank and summarize
        if reply_id.startswith("survey_improve_"):
            map_ar = {
                "survey_improve_products": "المزيد من المنتجات",
                "survey_improve_service": "تحسينات الخدمة",
                "survey_improve_prices": "أسعار أكثر ملاءمة",
                "survey_improve_quality": "منتجات ذات جودة أعلى",
            }
            map_fr = {
                "survey_improve_products": "Plus de produits",
                "survey_improve_service": "Améliorations du service",
                "survey_improve_prices": "Des prix plus abordables",
                "survey_improve_quality": "Produits de meilleure qualité",
            }
            improvement_ar = map_ar.get(reply_id, title or "")
            improvement_fr = map_fr.get(reply_id, title or "")
            rating = int(state.get("rating") or 0)
            stars = "⭐" * max(1, min(5, rating)) if rating else "—"
            state["improvement"] = reply_id
            state["stage"] = "done"
            await self.redis_manager.set_survey_state(user_id, state, ttl_sec=7 * 24 * 60 * 60)
            if not (is_test and SURVEY_TEST_BYPASS_COOLDOWN):
                if is_test and SURVEY_TEST_COOLDOWN_SEC > 0:
                    await self.redis_manager.mark_survey_invited(user_id, window_sec=SURVEY_TEST_COOLDOWN_SEC)
                else:
                    await self.redis_manager.mark_survey_invited(user_id)

            summary = (
                f"Merci pour votre aide ! Cela nous aidera à nous améliorer.\n"
                f"Évaluation: {stars} ({rating}/5)\n"
                f"Amélioration prioritaire: {improvement_fr}\n\n"
                f"شكرًا لمساعدتك! هذا سيساعدنا على التحسن.\n"
                f"التقييم: {stars} ({rating}/5)\n"
                f"الأولوية في التحسين: {improvement_ar}\n\n"
                f"لقد حصلت على خصم 15% — يرجى إرسال صور المنتجات التي تريدها في طلبك.\n"
                f"Vous bénéficiez de 15% de réduction — envoyez-nous les images des articles souhaités."
            )
            await self.process_outgoing_message({
                "user_id": user_id,
                "type": "text",
                "from_me": True,
                "message": summary,
                "timestamp": datetime.utcnow().isoformat(),
            })
            return

    # ------------------------- auto-reply helpers -------------------------
    def _extract_product_retailer_id(self, text: str) -> Optional[str]:
        """Extract a product/variant id only when explicitly referenced.

        Accepted sources:
        - Explicit pattern like "ID: 123456" (6+ digits)
        - From URLs: variant query, generic id query, or /variants/{id} in path
        """
        try:
            if not text:
                return None
            # 1) Explicit label "ID: <digits>"
            m = re.search(r"\bID\s*[:：]\s*(\d{6,})\b", text, re.IGNORECASE)
            if m:
                return m.group(1)
            # 1.5) Extract from any URL in the text
            try:
                urls = re.findall(r"https?://\S+", text)
            except Exception:
                urls = []
            for u in urls:
                try:
                    parsed = urlparse(u)
                    qs = parse_qs(parsed.query or "")
                    # Shopify-style variant param
                    if "variant" in qs and qs["variant"]:
                        v = qs["variant"][-1]
                        if re.fullmatch(r"\d{6,}", v or ""):
                            return v
                    # Generic id param
                    if "id" in qs and qs["id"]:
                        v = qs["id"][-1]
                        if re.fullmatch(r"\d{6,}", v or ""):
                            return v
                    # Path pattern /variants/{id}
                    m2 = re.search(r"/variants/(\d{6,})(?:/|\b)", parsed.path or "")
                    if m2:
                        return m2.group(1)
                except Exception:
                    continue
            # NOTE: Do not treat bare digit sequences as valid IDs to avoid
            # false positives from casual numbers in normal text. Only explicit
            # "ID:" labels or URLs are accepted.
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
        # Only the QUICK-REPLY BUTTONS are gated by test numbers; catalog matches are for all
        try:
            is_test_number = _digits_only(user_id) in AUTO_REPLY_TEST_NUMBERS
        except Exception:
            is_test_number = False
        # 24h cooldown per user (bypass when an explicit product ID/URL is present)
        try:
            if await self.redis_manager.was_auto_reply_recent(user_id):
                try:
                    has_explicit_id = bool(self._extract_product_retailer_id(text))
                except Exception:
                    has_explicit_id = False
                if not has_explicit_id:
                    return
        except Exception:
            pass
        # 0) If the message has no URL and contains no digits, offer quick-reply buttons
        try:
            has_url = bool(re.search(r"https?://", text or ""))
            has_digit = bool(re.search(r"\d", text or ""))
        except Exception:
            has_url = False
            has_digit = False
        if (not has_url) and (not has_digit) and is_test_number:
            await self.process_outgoing_message({
                "user_id": user_id,
                "type": "buttons",
                "from_me": True,
                "message": (
                    "Veuillez choisir une option :\nJe veux acheter un article\nJe veux vérifier le statut de ma commande\n\n"
                    "اختر خيارًا:\nأريد شراء منتج\nأريد التحقق من حالة طلبي"
                ),
                "buttons": [
                    {"id": "buy_item", "title": "Acheter | شراء"},
                    {"id": "order_status", "title": "Statut | حالة"},
                ],
                "timestamp": datetime.utcnow().isoformat(),
            })
            try:
                await self.redis_manager.mark_auto_reply_sent(user_id)
            except Exception:
                pass
            return
        # 1) Try explicit retailer_id extraction from text
        retailer_id_raw = self._extract_product_retailer_id(text)
        if retailer_id_raw:
            # Resolve to a valid Shopify variant id if needed
            resolved_variant_id: Optional[str] = None
            resolved_variant: Optional[dict] = None
            try:
                resolved_variant_id, resolved_variant = await self._resolve_shopify_variant(str(retailer_id_raw))
            except Exception:
                resolved_variant_id, resolved_variant = None, None
            try:
                products = catalog_manager.get_cached_products()
            except Exception:
                products = []
            if products:
                matched = next((p for p in products if str(p.get("retailer_id")) == str(retailer_id_raw)), None)
            else:
                matched = None

            if matched:
                # Send interactive catalog item; mark to append bilingual prompt after delivery
                await self.process_outgoing_message({
                    "user_id": user_id,
                    "type": "catalog_item",
                    "from_me": True,
                    # UI should carry Shopify variant id for Add to Order if we resolved it
                    "product_retailer_id": str(resolved_variant_id or retailer_id_raw),
                    # Use meta retailer_id for WA interactive send
                    "retailer_id": str(matched.get("retailer_id")),
                    "caption": (resolved_variant or {}).get("title") or matched.get("name") or "",
                    "timestamp": datetime.utcnow().isoformat(),
                    "needs_bilingual_prompt": True,
                })
                try:
                    await self.redis_manager.mark_auto_reply_sent(user_id)
                except Exception:
                    pass
                return
            else:
                # No local catalog match, still try to send interactive product by retailer_id
                # Build caption from Shopify variant if available
                cap = ""
                if resolved_variant:
                    t = resolved_variant.get("title") or ""
                    pr = resolved_variant.get("price") or ""
                    pr_fmt = _format_price_mad(pr) if pr else ""
                    parts: list[str] = []
                    if t:
                        parts.append(t)
                    if pr_fmt:
                        parts.append(pr_fmt)
                    cap = (" - ".join(parts)).strip(" -")
                await self.process_outgoing_message({
                    "user_id": user_id,
                    "type": "catalog_item",
                    "from_me": True,
                    # UI variant id for Add to Order
                    "product_retailer_id": str(resolved_variant_id or retailer_id_raw),
                    "caption": cap,
                    "timestamp": datetime.utcnow().isoformat(),
                    "needs_bilingual_prompt": True,
                })
                try:
                    await self.redis_manager.mark_auto_reply_sent(user_id)
                except Exception:
                    pass
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
        # Removed automatic image auto-reply on name-based match
        return

    async def _send_audio_via_upload(self, to_e164: str, audio_url: str) -> Optional[str]:
        """Download remote audio and upload to WhatsApp, then send as voice note.
        Returns WhatsApp message id on success, or None on failure.
        """
        try:
            import tempfile
            # Prefer signed URL for GCS objects
            fetch_url = audio_url
            try:
                signed = maybe_signed_url_for(audio_url, ttl_seconds=600)
                if signed:
                    fetch_url = signed
            except Exception:
                pass
            data: bytes | None = None
            # Try HTTP download first
            try:
                async with httpx.AsyncClient(timeout=20.0) as client:
                    resp = await client.get(fetch_url)
                    if resp.status_code < 400:
                        data = await resp.aread()
            except Exception:
                data = None
            # If HTTP failed and looks like GCS, try SDK download using service account
            if data is None:
                try:
                    bucket, blob = _parse_gcs_url(audio_url)
                    if blob:
                        with tempfile.NamedTemporaryFile(delete=False, suffix=".ogg") as tmp_local:
                            tmp_path_dl = tmp_local.name
                        # When blob lacks bucket, download uses default bucket
                        download_file_from_gcs(blob if bucket is None else f"{blob}", tmp_path_dl)
                        with open(tmp_path_dl, "rb") as fh:
                            data = fh.read()
                        try:
                            os.remove(tmp_path_dl)
                        except Exception:
                            pass
                except Exception:
                    data = None
            if not data:
                return None
            # Persist downloaded bytes then convert to m4a (robust across WA clients)
            with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as tmp_raw:
                tmp_raw.write(data)
                tmp_raw_path = tmp_raw.name
            # Convert to m4a/aac regardless of source to avoid codec mismatch
            tmp_path = None
            try:
                tmp_path = str(await convert_any_to_m4a(Path(tmp_raw_path)))
            except Exception:
                # Fallback: use raw if conversion failed
                tmp_path = tmp_raw_path
            try:
                media_info = await self._upload_media_to_whatsapp(Path(tmp_path), "audio")
                await asyncio.sleep(0.5)
                res = await self.whatsapp_messenger.send_media_message(
                    to_e164, "audio", media_info.get("id") or "", audio_voice=True
                )
                try:
                    mid = (res or {}).get("messages") or []
                    if isinstance(mid, list) and mid:
                        return str((mid[0] or {}).get("id") or "") or None
                except Exception:
                    pass
                return None
            finally:
                try:
                    if tmp_path and os.path.exists(tmp_path):
                        os.remove(tmp_path)
                except Exception:
                    pass
                try:
                    if tmp_raw_path and os.path.exists(tmp_raw_path):
                        os.remove(tmp_raw_path)
                except Exception:
                    pass
        except Exception:
            return None

    async def _send_pending_variant_media(self, user_id: str) -> None:
        """Send up to 10 cached variant images with Arabic captions, then clear the cache."""
        try:
            # Prefer sending catalog items when enabled
            if ORDER_CONFIRM_SEND_CATALOG:
                try:
                    await self._send_order_variants_as_catalog_items(user_id)
                    return
                except Exception:
                    # Fallback to images below
                    pass
            key = f"pending_variant_media:{user_id}"
            data = await redis_manager.get_json(key)
            items = []
            if isinstance(data, dict):
                items = data.get("items") or []
            try:
                logging.info("variant_media: cache lookup user=%s count=%s", user_id, len(items) if items else 0)
            except Exception:
                pass
            # Fallback: if nothing cached, try to build from customer's last order
            # Priority 1: if we have a recent order_id pinned for this user, build from that exact order
            if not items:
                try:
                    order_ref = await redis_manager.get_json(f"pending_variant_order:{user_id}")
                    order_id = None
                    if isinstance(order_ref, dict):
                        order_id = str(order_ref.get("order_id") or "").strip()
                    if order_id:
                        try:
                            logging.info("variant_media: using pinned order_id=%s for user=%s", order_id, user_id)
                        except Exception:
                            pass
                        from .shopify_integration import admin_api_base, _client_args  # type: ignore
                        import httpx  # type: ignore
                        base = admin_api_base()
                        async with httpx.AsyncClient(timeout=15.0) as client:
                            o_resp = await client.get(f"{base}/orders/{order_id}.json", **_client_args())
                            if o_resp.status_code == 200:
                                order_payload = (o_resp.json() or {}).get("order") or {}
                                line_items = order_payload.get("line_items") or []
                                for li in line_items:
                                    if len(items) >= 10:
                                        break
                                    product_id = li.get("product_id")
                                    variant_id = li.get("variant_id")
                                    image_id = None
                                    if variant_id:
                                        try:
                                            v_resp = await client.get(f"{base}/variants/{variant_id}.json", **_client_args())
                                            if v_resp.status_code == 200:
                                                variant = (v_resp.json() or {}).get("variant") or {}
                                                image_id = variant.get("image_id")
                                                if not product_id:
                                                    product_id = variant.get("product_id")
                                        except Exception:
                                            image_id = None
                                    img_url = None
                                    if product_id:
                                        try:
                                            p_resp = await client.get(f"{base}/products/{product_id}.json", **_client_args())
                                            if p_resp.status_code == 200:
                                                prod = (p_resp.json() or {}).get("product") or {}
                                                if image_id:
                                                    for img in (prod.get("images") or []):
                                                        if str(img.get("id")) == str(image_id) and img.get("src"):
                                                            img_url = img.get("src")
                                                            break
                                                if not img_url:
                                                    img_url = (prod.get("image") or {}).get("src") or (
                                                        (prod.get("images") or [{}])[0].get("src") if (prod.get("images") or []) else None
                                                    )
                                        except Exception:
                                            pass
                                    if not img_url:
                                        continue
                                    qty = li.get("quantity")
                                    try:
                                        qstr = str(int(qty)) if qty is not None else ""
                                    except Exception:
                                        qstr = str(qty or "")
                                    props = {}
                                    try:
                                        for p in (li.get("properties") or []):
                                            n = str(p.get("name") or "").strip().lower()
                                            v = str(p.get("value") or "").strip()
                                            if n:
                                                props[n] = v
                                    except Exception:
                                        props = {}
                                    size = props.get("size") or props.get("المقاس") or None
                                    color = props.get("color") or props.get("اللون") or None
                                    if not (size and color):
                                        vt = (li.get("variant_title") or "").strip()
                                        if vt and "/" in vt and not (size and color):
                                            parts = [s.strip() for s in vt.split("/") if s.strip()]
                                            if len(parts) >= 1 and not size:
                                                size = parts[0]
                                            if len(parts) >= 2 and not color:
                                                color = parts[1]
                                    lines = []
                                    if size:
                                        lines.append(f"المقاس: {size}")
                                    if color:
                                        lines.append(f"اللون: {color}")
                                    if qstr:
                                        lines.append(f"الكمية: {qstr}")
                                    caption = "\n".join(lines)
                                    items.append({"url": img_url, "caption": caption})
                except Exception as exc:
                    try:
                        logging.warning("variant_media: pinned order fallback failed user=%s error=%s", user_id, exc)
                    except Exception:
                        pass
            if not items:
                try:
                    from .shopify_integration import fetch_customer_by_phone, admin_api_base, _client_args  # type: ignore
                    import httpx  # type: ignore
                    cust = await fetch_customer_by_phone(user_id)
                    last = (cust or {}).get("last_order") if isinstance(cust, dict) else None
                    line_items = (last or {}).get("line_items") or []
                    # line_items from fetch_customer_by_phone lacks product/variant ids, so best-effort fetch recent orders directly
                    if not line_items:
                        # Pull most recent order fully by phone
                        # Use search again to get customer_id, then fetch orders with expanded line_items
                        if cust and cust.get("customer_id"):
                            params = {
                                "customer_id": str(cust["customer_id"]),
                                "status": "any",
                                "order": "created_at desc",
                                "limit": 1,
                            }
                            async with httpx.AsyncClient(timeout=12.0) as client:
                                resp = await client.get(f"{admin_api_base()}/orders.json", params=params, **_client_args())
                                if resp.status_code == 200:
                                    orders = (resp.json() or {}).get("orders") or []
                                    if orders:
                                        line_items = (orders[0] or {}).get("line_items") or []
                    # Build entries with image URLs and Arabic captions
                    if line_items:
                        base = admin_api_base()
                        async with httpx.AsyncClient(timeout=12.0) as client:
                            for li in line_items:
                                if len(items) >= 10:
                                    break
                                product_id = li.get("product_id")
                                variant_id = li.get("variant_id")
                                image_id = None
                                if variant_id:
                                    try:
                                        v_resp = await client.get(f"{base}/variants/{variant_id}.json", **_client_args())
                                        if v_resp.status_code == 200:
                                            variant = (v_resp.json() or {}).get("variant") or {}
                                            image_id = variant.get("image_id")
                                            if not product_id:
                                                product_id = variant.get("product_id")
                                    except Exception:
                                        image_id = None
                                img_url = None
                                if product_id:
                                    try:
                                        p_resp = await client.get(f"{base}/products/{product_id}.json", **_client_args())
                                        if p_resp.status_code == 200:
                                            prod = (p_resp.json() or {}).get("product") or {}
                                            if image_id:
                                                for img in (prod.get("images") or []):
                                                    if str(img.get("id")) == str(image_id) and img.get("src"):
                                                        img_url = img.get("src")
                                                        break
                                            if not img_url:
                                                img_url = (prod.get("image") or {}).get("src") or (
                                                    (prod.get("images") or [{}])[0].get("src") if (prod.get("images") or []) else None
                                                )
                                    except Exception:
                                        pass
                                if not img_url:
                                    continue
                                # Arabic caption from size/color/qty if available
                                qty = li.get("quantity")
                                try:
                                    qstr = str(int(qty)) if qty is not None else ""
                                except Exception:
                                    qstr = str(qty or "")
                                props = {}
                                try:
                                    for p in (li.get("properties") or []):
                                        n = str(p.get("name") or "").strip().lower()
                                        v = str(p.get("value") or "").strip()
                                        if n:
                                            props[n] = v
                                except Exception:
                                    props = {}
                                size = props.get("size") or props.get("المقاس") or None
                                color = props.get("color") or props.get("اللون") or None
                                if not (size and color):
                                    vt = (li.get("variant_title") or "").strip()
                                    if vt and "/" in vt and not (size and color):
                                        parts = [s.strip() for s in vt.split("/") if s.strip()]
                                        if len(parts) >= 1 and not size:
                                            size = parts[0]
                                        if len(parts) >= 2 and not color:
                                            color = parts[1]
                                lines = []
                                if size:
                                    lines.append(f"المقاس: {size}")
                                if color:
                                    lines.append(f"اللون: {color}")
                                if qstr:
                                    lines.append(f"الكمية: {qstr}")
                                caption = "\n".join(lines)
                                items.append({"url": img_url, "caption": caption})
                except Exception:
                    items = []
            if not items:
                return
            to = _normalize_ma_phone(user_id)
            try:
                logging.info("variant_media: sending %s images to=%s", len(items[:10]), to)
            except Exception:
                pass
            count = 0
            for it in items[:10]:
                try:
                    url = (it.get("url") or it.get("link") or "").strip()
                    caption = str(it.get("caption") or "")
                except Exception:
                    continue
                if not url:
                    continue
                try:
                    await self.whatsapp_messenger.send_media_message(to=to, media_type="image", media_id_or_url=url, caption=caption)
                    try:
                        logging.info("variant_media: sent image ok to=%s url=%s", to, url)
                    except Exception:
                        pass
                    synthetic_img = {
                        "temp_id": f"temp_{uuid.uuid4().hex}",
                        "user_id": user_id,
                        "message": url,
                        "type": "image",
                        "url": url,
                        "caption": caption,
                        "from_me": 1,
                        "timestamp": datetime.utcnow().isoformat(),
                    }
                    await self.db_manager.upsert_message(synthetic_img)
                    await self.redis_manager.cache_message(user_id, synthetic_img)
                    await self.connection_manager.send_to_user(user_id, {"type": "message_sent", "data": synthetic_img})
                    count += 1
                except Exception:
                    continue
            # Clear the cache after sending
            try:
                if redis_manager.redis_client:
                    await redis_manager.redis_client.delete(key)
            except Exception:
                pass
        except Exception:
            return

    async def _send_order_variants_as_catalog_items(self, user_id: str) -> None:
        """Send order variants as interactive catalog items with captions (size/color/qty).
        Uses pinned order_id when available, otherwise falls back to last order.
        """
        try:
            # Resolve phone and uid
            to = _normalize_ma_phone(user_id)
            uid = _normalize_user_id(to)
            # Try pinned order first
            order_id = None
            try:
                ref = await redis_manager.get_json(f"pending_variant_order:{uid}")
                if isinstance(ref, dict) and ref.get("order_id"):
                    order_id = str(ref.get("order_id")).strip()
            except Exception:
                order_id = None
            from .shopify_integration import admin_api_base, _client_args, fetch_customer_by_phone  # type: ignore
            import httpx  # type: ignore
            base = admin_api_base()
            line_items = []
            async with httpx.AsyncClient(timeout=15.0) as client:
                if order_id:
                    resp = await client.get(f"{base}/orders/{order_id}.json", **_client_args())
                    if resp.status_code == 200:
                        order_payload = (resp.json() or {}).get("order") or {}
                        line_items = order_payload.get("line_items") or []
                if not line_items:
                    cust = await fetch_customer_by_phone(uid)
                    if cust and cust.get("last_order"):
                        # Pull full order by parsing name if possible not supported; fallback to list orders
                        params = {
                            "customer_id": cust.get("customer_id"),
                            "status": "any",
                            "order": "created_at desc",
                            "limit": 1,
                        }
                        r = await client.get(f"{base}/orders.json", params=params, **_client_args())
                        if r.status_code == 200:
                            orders = (r.json() or {}).get("orders") or []
                            if orders:
                                line_items = (orders[0] or {}).get("line_items") or []
            if not line_items:
                return
            sent = 0
            for li in line_items:
                if sent >= 10:
                    break
                variant_id = li.get("variant_id")
                if not variant_id:
                    continue
                # Build Arabic caption
                qty = li.get("quantity")
                try:
                    qstr = str(int(qty)) if qty is not None else ""
                except Exception:
                    qstr = str(qty or "")
                props = {}
                try:
                    for p in (li.get("properties") or []):
                        n = str(p.get("name") or "").strip().lower()
                        v = str(p.get("value") or "").strip()
                        if n:
                            props[n] = v
                except Exception:
                    props = {}
                size = props.get("size") or props.get("المقاس") or None
                color = props.get("color") or props.get("اللون") or None
                if not (size and color):
                    vt = (li.get("variant_title") or "").strip()
                    if vt and "/" in vt and not (size and color):
                        parts = [s.strip() for s in vt.split("/") if s.strip()]
                        if len(parts) >= 1 and not size:
                            size = parts[0]
                        if len(parts) >= 2 and not color:
                            color = parts[1]
                lines = []
                if size:
                    lines.append(f"المقاس: {size}")
                if color:
                    lines.append(f"اللون: {color}")
                if qstr:
                    lines.append(f"الكمية: {qstr}")
                caption = "\n".join(lines)
                try:
                    res = await self.whatsapp_messenger.send_single_catalog_item(to, str(variant_id), caption)
                    # Build synthetic interactive entry for UI
                    synthetic = {
                        "temp_id": f"temp_{uuid.uuid4().hex}",
                        "user_id": uid,
                        "type": "catalog_item",
                        "product_retailer_id": str(variant_id),
                        "caption": caption,
                        "from_me": 1,
                        "timestamp": datetime.utcnow().isoformat(),
                    }
                    # attach WA id if present
                    try:
                        arr = (res or {}).get("messages") or []
                        if isinstance(arr, list) and arr:
                            synthetic["wa_message_id"] = str((arr[0] or {}).get("id") or "")
                            synthetic["status"] = "sent"
                    except Exception:
                        pass
                    await self.db_manager.upsert_message(synthetic)
                    await self.redis_manager.cache_message(uid, synthetic)
                    await self.connection_manager.send_to_user(uid, {"type": "message_sent", "data": synthetic})
                    sent += 1
                    await asyncio.sleep(0.2)
                except Exception:
                    continue
        except Exception:
            return

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
    # Service worker script must never be long-cached, otherwise clients get stuck on old SW
    if path == "/sw.js" or path.endswith("/sw.js"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        return response
    if path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    # Always serve freshest app code to avoid hard refresh requirements
    if path.endswith((".js", ".css", ".map")):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    # Allow long-lived cache for static media assets only (not JS/CSS)
    elif (
        path.startswith("/static/")
        or path.endswith((
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
    try:
        # Safe startup hint about DB backend and pool settings
        from urllib.parse import urlparse
        parsed = urlparse(DATABASE_URL) if DATABASE_URL else None
        port_info = parsed.port if parsed else None
        backend = "postgres" if db_manager.use_postgres else "sqlite"
        print(f"DB init: backend={backend}, db_port={port_info}, pool_min={PG_POOL_MIN}, pool_max={PG_POOL_MAX}")
    except Exception:
        pass
    # Optional: validate access token against Graph if app credentials provided
    try:
        if ACCESS_TOKEN and META_APP_ID and META_APP_SECRET:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    "https://graph.facebook.com/debug_token",
                    params={
                        "input_token": ACCESS_TOKEN,
                        "access_token": f"{META_APP_ID}|{META_APP_SECRET}",
                    },
                )
                if resp.status_code == 200:
                    data = resp.json() or {}
                    d = (data.get("data") or {})
                    if not d.get("is_valid", False):
                        print(f"⚠️ Meta access token appears invalid: {d}")
                else:
                    print(f"⚠️ Token debug request failed: {resp.status_code} {await resp.aread()}\n")
    except Exception as exc:
        print(f"⚠️ Token debug error: {exc}")
    # Connect to Redis only if configured
    if REDIS_URL:
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
    # Ensure conversation_notes table exists for legacy deployments
    try:
        async with db_manager._conn() as db:
            if db_manager.use_postgres:
                await db.execute(
                    "CREATE TABLE IF NOT EXISTS conversation_notes ("
                    "id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, agent_username TEXT, type TEXT DEFAULT 'text', text TEXT, url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
                )
                await db.execute("CREATE INDEX IF NOT EXISTS idx_notes_user_time ON conversation_notes (user_id, created_at)")
            else:
                await db.execute(
                    "CREATE TABLE IF NOT EXISTS conversation_notes ("
                    "id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, agent_username TEXT, type TEXT DEFAULT 'text', text TEXT, url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
                )
                await db.execute("CREATE INDEX IF NOT EXISTS idx_notes_user_time ON conversation_notes (user_id, datetime(created_at))")
                await db.commit()
    except Exception as exc:
        print(f"conversation_notes ensure failed: {exc}")
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

    # Start survey scheduler background loop (requires Redis)
    try:
        if redis_manager.redis_client:
            asyncio.create_task(run_survey_scheduler())
    except Exception as exc:
        print(f"Failed to start survey scheduler: {exc}")

def _parse_iso_ts(ts: str) -> Optional[datetime]:
    try:
        s = str(ts or "").strip()
        if not s:
            return None
        if s.isdigit():
            # seconds epoch
            sec = int(s)
            if len(s) > 10:
                # already ms
                return datetime.fromtimestamp(sec / 1000, tz=timezone.utc)
            return datetime.fromtimestamp(sec, tz=timezone.utc)
        # Normalize Z
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:
        return None

async def _survey_sweep_once() -> None:
    try:
        conversations = await db_manager.get_conversations_with_stats()
    except Exception as exc:
        print(f"survey sweep: failed to list conversations: {exc}")
        return
    now = datetime.utcnow().replace(tzinfo=None)
    for conv in conversations:
        try:
            user_id = conv.get("user_id")
            if not user_id or not isinstance(user_id, str):
                continue
            # Skip internal channels
            if user_id.startswith("team:") or user_id.startswith("agent:") or user_id.startswith("dm:"):
                continue
            uid_digits = _digits_only(user_id)
            is_test = uid_digits in SURVEY_TEST_NUMBERS
            # Only if customer hasn't replied since last agent msg
            unresponded = int(conv.get("unresponded_count") or 0)
            if unresponded != 0:
                continue
            last_agent_ts = await db_manager.get_last_agent_message_time(user_id)
            if not last_agent_ts:
                continue
            dt = _parse_iso_ts(last_agent_ts)
            if not dt:
                continue
            # Make naive for comparison with now
            if dt.tzinfo is not None:
                dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
            threshold = (
                timedelta(seconds=SURVEY_TEST_DELAY_SEC)
                if (is_test and SURVEY_TEST_DELAY_SEC > 0)
                else timedelta(hours=4)
            )
            if (now - dt) < threshold:
                continue
            # Do not re-invite within cooldown window
            if not (is_test and SURVEY_TEST_BYPASS_COOLDOWN) and await redis_manager.was_survey_invited_recent(user_id):
                continue
            # Skip if an invoice was sent in this chat (order exists for this number)
            try:
                if (not (is_test and SURVEY_TEST_IGNORE_INVOICE)) and await db_manager.has_invoice_message(user_id):
                    continue
            except Exception:
                # On error, be safe and skip
                continue
            # Send invite and mark
            try:
                await message_processor.send_survey_invite(user_id)
                if is_test and SURVEY_TEST_BYPASS_COOLDOWN:
                    # no-op; allow rapid retests
                    pass
                elif is_test and SURVEY_TEST_COOLDOWN_SEC > 0:
                    await redis_manager.mark_survey_invited(user_id, window_sec=SURVEY_TEST_COOLDOWN_SEC)
                else:
                    await redis_manager.mark_survey_invited(user_id)
            except Exception as exc:
                print(f"survey invite failed for {user_id}: {exc}")
        except Exception:
            continue

async def run_survey_scheduler() -> None:
    # Sweep every 5 minutes
    while True:
        try:
            await _survey_sweep_once()
        except Exception as exc:
            print(f"survey scheduler loop error: {exc}")
        await asyncio.sleep(300)

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
    # Capture agent identity from query string if provided
    agent_username = None
    try:
        agent_username = websocket.query_params.get("agent")  # type: ignore[attr-defined]
    except Exception:
        agent_username = None
    await connection_manager.connect(websocket, user_id, client_info={"agent": agent_username} if agent_username else None)
    if user_id == "admin":
        await db_manager.upsert_user(user_id, is_admin=1)
    
    try:
        # Send recent messages on connection
        recent_messages = await redis_manager.get_recent_messages(user_id)
        if not recent_messages:
            recent_messages = await db_manager.get_messages(user_id, limit=20)
        if recent_messages:
            # Ensure chronological order for the client by server receive time when available
            try:
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
                recent_messages = sorted(recent_messages, key=lambda m: to_ms(m.get("server_ts") or m.get("timestamp")))
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
        logging.info("WS send_message request user_id=%s type=%s", user_id, message_data.get("type"))
        # Attach agent username from connection metadata if available
        try:
            meta = connection_manager.connection_metadata.get(websocket) or {}
            agent_username = ((meta.get("client_info") or {}) or {}).get("agent")
            if agent_username and not message_data.get("agent_username"):
                message_data["agent_username"] = agent_username
        except Exception:
            pass
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
        # Optional: verify Meta webhook signature when META_APP_SECRET is set
        try:
            if META_APP_SECRET:
                body_bytes = await request.body()
                sig_header = request.headers.get("X-Hub-Signature-256", "")
                expected = hmac.new(META_APP_SECRET.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
                presented = sig_header.split("=", 1)[1] if "=" in sig_header else sig_header
                if not presented or not hmac.compare_digest(presented, expected):
                    _vlog("❌ Invalid webhook signature")
                    return PlainTextResponse("Invalid signature", status_code=401)
                data = json.loads(body_bytes.decode("utf-8") or "{}")
            else:
                data = await request.json()
        except Exception:
            return PlainTextResponse("Bad Request", status_code=400)
        # Early filter by phone_number_id BEFORE verbose logging to avoid noisy logs
        try:
            value = (data.get("entry") or [{}])[0].get("changes", [{}])[0].get("value") or {}
            meta = value.get("metadata") or {}
            incoming_phone_id = str(meta.get("phone_number_id") or "")
            configured_phone_id = str(PHONE_NUMBER_ID or "")
            if (
                incoming_phone_id
                and configured_phone_id
                and configured_phone_id != "your_phone_number_id"
                and incoming_phone_id != configured_phone_id
            ):
                _vlog(
                    f"⏭️ Skipping webhook for phone_number_id {incoming_phone_id} (configured {configured_phone_id})"
                )
                return {"ok": True}
        except Exception:
            pass
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


# ───────────────────────── Internal Notes Upload (no WhatsApp send) ─────────────────────────
@app.post("/notes/upload")
async def upload_note_file(
    file: UploadFile = File(...),
):
    """Upload a note attachment (e.g., audio) and return a public URL, without sending to WhatsApp."""
    try:
        # Ensure media folder exists
        MEDIA_DIR.mkdir(exist_ok=True)

        # Persist upload locally first
        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        suffix = Path(file.filename or "note").suffix or ".bin"
        filename = f"note_{timestamp}_{uuid.uuid4().hex[:8]}{suffix}"
        file_path = MEDIA_DIR / filename

        content = await file.read()
        async with aiofiles.open(file_path, "wb") as f:
            await f.write(content)

        # Upload to Cloud Storage and return the public URL
        try:
            media_url = await upload_file_to_gcs(str(file_path))
        except Exception as exc:
            print(f"GCS upload failed for notes upload (returning local path): {exc}")
            media_url = None

        if media_url:
            return {"url": media_url, "file_path": str(file_path)}
        else:
            # Fallback to serving via local /media mount
            return {"url": f"/media/{filename}", "file_path": str(file_path)}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"❌ Error in /notes/upload: {exc}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}")

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
        agent_username = request.get("agent") or request.get("agent_username")
        if agent_username:
            message_data["agent_username"] = agent_username
        logging.info("/send-message requested user_id=%s type=%s agent=%s", user_id, message_type, agent_username or "")
        
        # Process the message
        result = await message_processor.process_outgoing_message(message_data)
        return {"status": "success", "message": result}
        
    except Exception as e:
        logging.error("Error in /send-message user_id=%s error=%s", request.get("user_id"), e, exc_info=True)
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
async def get_conversations(q: Optional[str] = None, unread_only: bool = False, assigned: Optional[str] = None, tags: Optional[str] = None, unresponded_only: bool = False, limit: int = 200, offset: int = 0):
    """Get conversations with optional filters: q, unread_only, assigned, tags (csv), unresponded_only."""
    try:
        tag_list = [t.strip() for t in tags.split(",")] if tags else None
        conversations = await db_manager.get_conversations_with_stats(q=q, unread_only=unread_only, assigned=assigned, tags=tag_list, limit=max(1, min(limit, 500)), offset=max(0, offset))
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

SESSIONS: dict[str, dict] = {}

@app.post("/auth/login")
async def auth_login(payload: dict = Body(...)):
    if DISABLE_AUTH:
        # Bypass credential checks entirely
        username = (payload.get("username") or "admin").strip() or "admin"
        is_admin = True
    else:
        username = (payload.get("username") or "").strip()
        password = payload.get("password") or ""
        stored = await db_manager.get_agent_password_hash(username)
        if not stored or not verify_password(password, stored):
            raise HTTPException(status_code=401, detail="Invalid credentials")
        # Resolve admin flag for this agent
        is_admin = bool(await db_manager.get_agent_is_admin(username))
    # Prefer stateless, signed token when secret is configured; else fall back to in-memory session
    if AGENT_AUTH_SECRET:
        token = issue_agent_token(username, is_admin)
    else:
        token = uuid.uuid4().hex
        SESSIONS[token] = {"username": username, "is_admin": is_admin, "created_at": datetime.utcnow().isoformat()}
    return {"token": token, "username": username, "is_admin": is_admin}

@app.get("/auth/me")
async def auth_me(request: Request):
    if DISABLE_AUTH:
        # Always allow and treat caller as admin
        return {"username": "admin", "is_admin": True}
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth_header:
        raise HTTPException(status_code=401, detail="Unauthorized")
    parts = auth_header.split()
    token = parts[-1] if parts else ""
    if AGENT_AUTH_SECRET:
        parsed = parse_agent_token(token)
        if not parsed or not parsed.get("username"):
            raise HTTPException(status_code=401, detail="Unauthorized")
        return {"username": parsed["username"], "is_admin": bool(parsed.get("is_admin"))}
    # Fallback for dev without secret: use in-memory session
    session = SESSIONS.get(token)
    if not session:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return {"username": session.get("username"), "is_admin": bool(session.get("is_admin"))}

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

@app.post("/orders/created/log")
async def log_order_created(payload: dict = Body(...)):
    order_id = (payload.get("order_id") or "").strip()
    user_id = (payload.get("user_id") or None)
    agent = (payload.get("agent") or payload.get("agent_username") or None)
    if not order_id:
        raise HTTPException(status_code=400, detail="order_id is required")
    await db_manager.log_order_created(order_id=order_id, user_id=user_id, agent_username=agent)
    # Kick off order confirmation flow in background (only for test number gate)
    try:
        asyncio.create_task(_run_order_confirmation_flow(order_id))
    except Exception:
        pass
    return {"ok": True}

# ---------- Order Confirmation Flow (Test number only) ----------

async def _fetch_order_phone(order_id: str) -> str:
    """Fetch customer's phone from Shopify order."""
    try:
        # Lazy import to avoid hard dependency if Shopify not configured
        from .shopify_integration import admin_api_base, _client_args  # type: ignore
        import httpx as _httpx  # type: ignore
        url = f"{admin_api_base()}/orders/{order_id}.json"
        async with _httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(url, **_client_args())
            if resp.status_code >= 400:
                return ""
            data = resp.json() or {}
            order = data.get("order") or {}
            # Prefer shipping address phone, fallback to customer or billing
            phone = (
                (order.get("shipping_address") or {}).get("phone")
                or (order.get("billing_address") or {}).get("phone")
                or (order.get("customer") or {}).get("phone")
                or order.get("phone")
                or ""
            )
            return str(phone or "").strip()
    except Exception:
        return ""

async def _add_order_tag(order_id: str, tag: str) -> None:
    try:
        from .shopify_integration import admin_api_base, _client_args  # type: ignore
        import httpx as _httpx  # type: ignore
        base = admin_api_base()
        url = f"{base}/orders/{order_id}.json"
        async with _httpx.AsyncClient(timeout=20.0) as client:
            # Get current tags
            resp = await client.get(url, **_client_args())
            if resp.status_code >= 400:
                return
            data = resp.json() or {}
            order = data.get("order") or {}
            current_tags = order.get("tags") or ""
            tags = [t.strip() for t in str(current_tags).split(",") if t and t.strip()]
            if tag not in tags:
                tags.append(tag)
            payload = {"order": {"id": order_id, "tags": ", ".join(tags)}}
            await client.put(url, json=payload, **_client_args())
    except Exception:
        return

def _normalize_ma_phone(phone: str) -> str:
    """Normalize Moroccan phone to E.164 (+212...)."""
    try:
        s = "".join([ch for ch in str(phone or "") if ch.isdigit() or ch == "+"]) or ""
        if not s:
            return ""
        # If already e164
        if s.startswith("+"):
            # Fix common mistake: "+2120XXXXXXXX" -> "+212XXXXXXXX"
            try:
                if s.startswith("+2120") and len(s) >= 5:
                    return "+212" + s[5:]
            except Exception:
                pass
            return s
        # Strip all non-digits, then normalize
        digits = "".join(ch for ch in s if ch.isdigit())
        if digits.startswith("212"):
            return "+" + digits
        if digits.startswith("0"):
            digits = digits[1:]
        # Assume Morocco default
        return "+212" + digits
    except Exception:
        return ""

async def _run_order_confirmation_flow(
    order_id: str,
    template_name_override: Optional[str] = None,
    template_lang_override: Optional[str] = None,
    components_override: list | None = None,
    raw_phone_override: Optional[str] = None,
    extra_image_links: Optional[list[str]] = None,
    audio_url_override: Optional[str] = None,
) -> None:
    """Run order confirmation flow for allowed numbers, with node logs in Redis."""
    TEST_NUMBER_RAW = "0618182056"
    try:
        # Node log structure helper
        flow_key = f"flow_run:order_confirm:{order_id}"
        nodes: list[dict] = []

        def log_node(name: str, input_data: dict | None = None, output: dict | None = None, status: str = "ok", error: str | None = None):
            nodes.append({
                "name": name,
                "status": status,
                "input": input_data or {},
                "output": output or {},
                **({"error": error} if error else {}),
                "ts": datetime.utcnow().isoformat(),
            })

        # Trigger: fetch order phone (or use override from webhook)
        raw_phone = raw_phone_override if raw_phone_override is not None else await _fetch_order_phone(order_id)
        log_node("trigger:order_created", {"order_id": order_id, "raw_phone": raw_phone}, {"started": True})

        # Gate: only proceed if phone matches allowed numbers (env + defaults)
        raw_digits = "".join(ch for ch in str(raw_phone or "") if ch.isdigit())
        candidates: list[str] = []
        # include legacy test number
        try:
            gate_digits = "".join(ch for ch in TEST_NUMBER_RAW if ch.isdigit())
            gate_no0 = gate_digits[1:] if gate_digits.startswith("0") else gate_digits
            gate_e164 = ("212" + gate_no0) if not gate_digits.startswith("212") else gate_digits
            candidates.extend([gate_digits, gate_no0, gate_e164])
        except Exception:
            pass
        for n in list(ORDER_CONFIRM_ALLOWED_NUMBERS or set()):
            try:
                d = "".join(ch for ch in str(n) if ch.isdigit())
                if not d:
                    continue
                candidates.append(d)
                if d.startswith("0"):
                    candidates.append(d[1:])
                if not d.startswith("212"):
                    no0 = d[1:] if d.startswith("0") else d
                    candidates.append("212" + no0)
            except Exception:
                continue
        # Env override: allow all numbers
        if ORDER_CONFIRM_ALLOW_ALL:
            allowed = True
        else:
            allowed = any(raw_digits.endswith(c) for c in candidates if c)
        log_node(
            "gate:allowed_numbers",
            {"raw_digits": raw_digits, "candidates": candidates},
            {"allowed": allowed},
        )
        try:
            logging.info("order_confirm flow: order_id=%s gate_allowed=%s phone_raw=%s", order_id, allowed, str(raw_phone))
        except Exception:
            pass
        if not allowed:
            # Store nodes and return
            await _persist_flow_nodes(flow_key, nodes)
            return
        # Test-gate mode controls whether to skip WA contact checks; disable when allowing all
        is_test_gate = not ORDER_CONFIRM_ALLOW_ALL

        # Normalize phone
        phone_e164 = _normalize_ma_phone(raw_phone)
        log_node("normalize_phone", {"raw": raw_phone}, {"e164": phone_e164})
        if not phone_e164:
            log_node("normalize_phone", {"raw": raw_phone}, status="error", error="Empty normalized phone")
            await _persist_flow_nodes(flow_key, nodes)
            return

        # Check WhatsApp availability (skip for test gate to allow direct send attempt)
        has_wa = True
        if not is_test_gate:
            try:
                contact_res = await messenger.check_whatsapp_contact(phone_e164)
                entry = (contact_res.get("contacts") or [{}])[0] if isinstance(contact_res, dict) else {}
                wa_status = (entry.get("status") or "").lower()
                has_wa = wa_status == "valid" and bool(entry.get("wa_id"))
                log_node("check_whatsapp", {"to": phone_e164}, {"status": wa_status, "has_wa": has_wa})
            except Exception as exc:
                log_node("check_whatsapp", {"to": phone_e164}, status="error", error=str(exc))
                await _persist_flow_nodes(flow_key, nodes)
                return

            # Tag and return if no WhatsApp
            if not has_wa:
                await _add_order_tag(order_id, "no_wtp")
                log_node("tag:no_wtp", {"order_id": order_id}, {"tagged": True})
                await _persist_flow_nodes(flow_key, nodes)
                return
        else:
            log_node("check_whatsapp", {"to": phone_e164, "skipped": True}, {"has_wa": True})

        # Send order confirmation template
        # Allow per-call overrides; else read from DB config; else env vars
        cfg_name = None
        cfg_lang = None
        cfg_components = None
        try:
            cfg_raw = await db_manager.get_setting("order_confirm:template_config")
            if cfg_raw:
                cfg = json.loads(cfg_raw)
                cfg_name = (cfg or {}).get("template_name")
                cfg_lang = (cfg or {}).get("language")
                cfg_components = (cfg or {}).get("components")
        except Exception:
            pass

        template_name = template_name_override or cfg_name or os.getenv("ORDER_CONFIRM_TEMPLATE_NAME", "order_confirmed")
        template_lang = template_lang_override or cfg_lang or os.getenv("ORDER_CONFIRM_TEMPLATE_LANG", "en")
        components = components_override if components_override is not None else cfg_components
        if components is None:
            components_env = os.getenv("ORDER_CONFIRM_TEMPLATE_COMPONENTS", "")
            try:
                if components_env:
                    components = json.loads(components_env)
            except Exception:
                components = None
        try:
            send_res = await messenger.send_template_message(
                to=phone_e164,
                template_name=template_name,
                language=template_lang,
                components=components,
            )
            # Detect Graph API errors and branch accordingly
            if isinstance(send_res, dict) and send_res.get("error"):
                log_node("send_template", {"to": phone_e164, "template": template_name, "language": template_lang}, status="error", error=str(send_res.get("error")))
                try:
                    logging.info("order_confirm flow: template error order_id=%s response=%s", order_id, json.dumps(send_res)[:500])
                except Exception:
                    pass
            else:
                log_node("send_template", {"to": phone_e164, "template": template_name, "language": template_lang}, {"response": send_res})
                try:
                    logging.info("order_confirm flow: sent template ok order_id=%s response=%s", order_id, json.dumps(send_res)[:500])
                except Exception:
                    pass
                await _add_order_tag(order_id, "ok_wtp")
                log_node("tag:ok_wtp", {"order_id": order_id}, {"tagged": True})
                # Best-effort: add a synthetic message to the UI/inbox so agents can see the template was sent
                try:
                    uid = _normalize_user_id(phone_e164)
                    await db_manager.upsert_user(uid)
                    # Extract WhatsApp message id if present in response
                    wa_id = None
                    try:
                        arr = (send_res or {}).get("messages") or []
                        if isinstance(arr, list) and arr:
                            wa_id = str((arr[0] or {}).get("id") or "") or None
                    except Exception:
                        wa_id = None
                    # Extract header media link from components if any
                    header_link = ""
                    body_params: list[str] = []
                    try:
                        for comp in (components or []):
                            t = str((comp or {}).get("type") or "").upper()
                            if t == "HEADER":
                                params = (comp or {}).get("parameters") or []
                                if params and isinstance(params, list):
                                    p0 = params[0] or {}
                                    # handle image/video/document
                                    for k in ("image", "video", "document"):
                                        if k in p0 and isinstance(p0[k], dict):
                                            header_link = str((p0[k] or {}).get("link") or "")
                                            break
                            if t == "BODY":
                                for p in ((comp or {}).get("parameters") or []):
                                    if isinstance(p, dict) and p.get("type") == "text":
                                        body_params.append(str(p.get("text") or ""))
                    except Exception:
                        header_link = header_link or ""
                    synthetic = {
                        "temp_id": f"temp_{uuid.uuid4().hex}",
                        "user_id": uid,
                        "message": f"[Template] {template_name}",
                        "type": "template",
                        "from_me": 1,
                        "timestamp": datetime.utcnow().isoformat(),
                        **({"wa_message_id": wa_id} if wa_id else {}),
                        "status": "sent",
                        "template": {
                            "name": template_name,
                            "language": template_lang,
                            "components": components or [],
                        },
                        **({"template_header_link": header_link} if header_link else {}),
                        **({"template_body_params": body_params} if body_params else {}),
                    }
                    await db_manager.upsert_message(synthetic)
                    await redis_manager.cache_message(uid, synthetic)
                    await connection_manager.send_to_user(uid, {"type": "message_sent", "data": synthetic})
                except Exception:
                    pass
            # Cache extra variant images (do not send yet). They will be sent on confirm.
            try:
                uid = _normalize_user_id(phone_e164)
                items: list[dict] = []
                if isinstance(extra_image_links, list):
                    for link in extra_image_links[:10]:
                        try:
                            if isinstance(link, dict):
                                url = link.get("url") or link.get("link") or ""
                                cap = str(link.get("caption") or "")
                            else:
                                url = str(link)
                                cap = ""
                            if not url:
                                continue
                            items.append({"url": url, "caption": cap})
                        except Exception:
                            continue
                if items:
                    await redis_manager.set_json(f"pending_variant_media:{uid}", {"items": items, "ts": datetime.utcnow().isoformat()}, ttl=3 * 24 * 3600)
                    log_node("cache_variant_media", {"uid": uid, "count": len(items)}, {"cached": True})
                # Also store order id for stronger fallback resolution
                try:
                    await redis_manager.set_json(
                        f"pending_variant_order:{uid}",
                        {"order_id": str(order_id), "ts": datetime.utcnow().isoformat()},
                        ttl=3 * 24 * 3600,
                    )
                except Exception:
                    pass
                # If we still have nothing cached, build from the specific Shopify order line items
                if not items:
                    try:
                        from .shopify_integration import admin_api_base, _client_args  # type: ignore
                        import httpx  # type: ignore
                        base = admin_api_base()
                        async with httpx.AsyncClient(timeout=15.0) as client:
                            o_resp = await client.get(f"{base}/orders/{order_id}.json", **_client_args())
                            if o_resp.status_code == 200:
                                order_payload = (o_resp.json() or {}).get("order") or {}
                                line_items = order_payload.get("line_items") or []
                                entries: list[dict] = []
                                for li in line_items:
                                    if len(entries) >= 10:
                                        break
                                    product_id = li.get("product_id")
                                    variant_id = li.get("variant_id")
                                    image_id = None
                                    if variant_id:
                                        try:
                                            v_resp = await client.get(f"{base}/variants/{variant_id}.json", **_client_args())
                                            if v_resp.status_code == 200:
                                                variant = (v_resp.json() or {}).get("variant") or {}
                                                image_id = variant.get("image_id")
                                                if not product_id:
                                                    product_id = variant.get("product_id")
                                        except Exception:
                                            image_id = None
                                    img_url = None
                                    if product_id:
                                        try:
                                            p_resp = await client.get(f"{base}/products/{product_id}.json", **_client_args())
                                            if p_resp.status_code == 200:
                                                prod = (p_resp.json() or {}).get("product") or {}
                                                if image_id:
                                                    for img in (prod.get("images") or []):
                                                        if str(img.get("id")) == str(image_id) and img.get("src"):
                                                            img_url = img.get("src")
                                                            break
                                                if not img_url:
                                                    img_url = (prod.get("image") or {}).get("src") or (
                                                        (prod.get("images") or [{}])[0].get("src") if (prod.get("images") or []) else None
                                                    )
                                        except Exception:
                                            pass
                                    if not img_url:
                                        continue
                                    # Caption in Arabic: size, color, quantity
                                    qty = li.get("quantity")
                                    try:
                                        qstr = str(int(qty)) if qty is not None else ""
                                    except Exception:
                                        qstr = str(qty or "")
                                    props = {}
                                    try:
                                        for p in (li.get("properties") or []):
                                            n = str(p.get("name") or "").strip().lower()
                                            v = str(p.get("value") or "").strip()
                                            if n:
                                                props[n] = v
                                    except Exception:
                                        props = {}
                                    size = props.get("size") or props.get("المقاس") or None
                                    color = props.get("color") or props.get("اللون") or None
                                    if not (size and color):
                                        vt = (li.get("variant_title") or "").strip()
                                        if vt and "/" in vt and not (size and color):
                                            parts = [s.strip() for s in vt.split("/") if s.strip()]
                                            if len(parts) >= 1 and not size:
                                                size = parts[0]
                                            if len(parts) >= 2 and not color:
                                                color = parts[1]
                                    lines = []
                                    if size:
                                        lines.append(f"المقاس: {size}")
                                    if color:
                                        lines.append(f"اللون: {color}")
                                    if qstr:
                                        lines.append(f"الكمية: {qstr}")
                                    caption = "\n".join(lines)
                                    entries.append({"url": img_url, "caption": caption})
                                if entries:
                                    await redis_manager.set_json(
                                        f"pending_variant_media:{uid}",
                                        {"items": entries, "ts": datetime.utcnow().isoformat()},
                                        ttl=3 * 24 * 3600,
                                    )
                                    log_node("cache_variant_media_from_order", {"uid": uid, "count": len(entries)}, {"cached": True})
                    except Exception:
                        pass
            except Exception:
                pass
        except Exception as exc:
            log_node("send_template", {"to": phone_e164, "template": template_name}, status="error", error=str(exc))
            try:
                logging.warning("order_confirm flow: send template failed order_id=%s error=%s", order_id, str(exc))
            except Exception:
                pass
            # In test mode, reflect failure with no_wtp tag to keep visibility in admin
            if is_test_gate:
                try:
                    await _add_order_tag(order_id, "no_wtp")
                    log_node("tag:no_wtp", {"order_id": order_id}, {"tagged": True})
                except Exception:
                    pass

        # Optional: send audio (test/demo)
        try:
            audio_url = audio_url_override or os.getenv("ORDER_CONFIRM_AUDIO_URL", "")
            if audio_url:
                try:
                    await messenger.send_media_message(to=phone_e164, media_type="audio", media_id_or_url=str(audio_url))
                    log_node("send_audio", {"to": phone_e164, "url": audio_url}, {"ok": True})
                except Exception as exc:
                    log_node("send_audio", {"to": phone_e164, "url": audio_url}, status="error", error=str(exc))
        except Exception:
            pass

        # Persist all nodes
        await _persist_flow_nodes(flow_key, nodes)
    except Exception as exc:
        try:
            # Best-effort log outer error
            flow_key = f"flow_run:order_confirm:{order_id}"
            await _persist_flow_nodes(flow_key, [{"name": "flow:error", "status": "error", "error": str(exc), "ts": datetime.utcnow().isoformat()}])
        except Exception:
            pass

async def _persist_flow_nodes(flow_key: str, nodes: list[dict]):
    try:
        if redis_manager.redis_client:
            await redis_manager.redis_client.setex(flow_key, 24 * 3600, json.dumps({"nodes": nodes}))
            # Also push to recent list
            await redis_manager.redis_client.lpush("flow_run:order_confirm:list", flow_key)
            await redis_manager.redis_client.ltrim("flow_run:order_confirm:list", 0, 49)
        # Persist a bounded history in DB settings for long-term preview
        try:
            order_id = str(flow_key.split(":")[-1]) if flow_key else ""
            summarized_status = (nodes[-1].get("status") if nodes else None) or "ok"
            summarized_name = (nodes[-1].get("name") if nodes else None) or ""
            history_key = "order_confirm:runs"
            raw = await db_manager.get_setting(history_key)
            arr = []
            try:
                arr = json.loads(raw) if raw else []
                if not isinstance(arr, list):
                    arr = []
            except Exception:
                arr = []
            entry = {
                "order_id": order_id,
                "flow_key": flow_key,
                "ts": datetime.utcnow().isoformat(),
                "last": {"name": summarized_name, "status": summarized_status},
            }
            # Drop previous entry for same order_id to avoid duplicates
            arr = [e for e in arr if str(e.get("order_id")) != order_id]
            arr.insert(0, entry)
            # Cap history size
            arr = arr[:200]
            await db_manager.set_setting(history_key, arr)
            # Persist full run under a dedicated key too
            try:
                await db_manager.set_setting(f"order_confirm:run:{order_id}", {"nodes": nodes})
            except Exception:
                pass
        except Exception:
            pass
    except Exception:
        pass

@app.get("/flows/order-confirmation/last")
async def get_last_order_confirmation_runs(limit: int = 20):
    try:
        if not redis_manager.redis_client:
            return []
        keys = await redis_manager.redis_client.lrange("flow_run:order_confirm:list", 0, max(0, int(limit) - 1))
        out: list[dict] = []
        for k in keys:
            key = k.decode() if isinstance(k, (bytes, bytearray)) else str(k)
            raw = await redis_manager.redis_client.get(key)
            if not raw:
                continue
            try:
                parsed = json.loads(raw)
                out.append({"key": key, "summary": (parsed.get("nodes") or [])[-1] if parsed else {}})
            except Exception:
                continue
        return out
    except Exception:
        return []

@app.get("/flows/order-confirmation/{order_id}")
async def get_order_confirmation_run(order_id: str):
    try:
        if not redis_manager.redis_client:
            # Fallback to DB settings
            try:
                raw = await db_manager.get_setting(f"order_confirm:run:{order_id}")
                return json.loads(raw) if raw else {"nodes": []}
            except Exception:
                return {"nodes": []}
        key = f"flow_run:order_confirm:{order_id}"
        raw = await redis_manager.redis_client.get(key)
        if not raw:
            # Fallback to DB settings
            try:
                raw2 = await db_manager.get_setting(f"order_confirm:run:{order_id}")
                return json.loads(raw2) if raw2 else {"nodes": []}
            except Exception:
                return {"nodes": []}
        try:
            return json.loads(raw)
        except Exception:
            # Fallback to DB settings
            try:
                raw2 = await db_manager.get_setting(f"order_confirm:run:{order_id}")
                return json.loads(raw2) if raw2 else {"nodes": []}
            except Exception:
                return {"nodes": []}
    except Exception:
        return {"nodes": []}

@app.get("/flows/order-confirmation/history")
async def get_order_confirmation_history(limit: int = 50):
    try:
        raw = await db_manager.get_setting("order_confirm:runs")
        arr = []
        try:
            arr = json.loads(raw) if raw else []
            if not isinstance(arr, list):
                arr = []
        except Exception:
            arr = []
        return arr[: max(1, min(int(limit), 200))]
    except Exception:
        return []

@app.post("/flows/order-confirmation/test-run")
async def start_order_confirmation_test_run(
    order_id: str = Body("", embed=True),
    phone: str | None = Body(None, embed=True),
    template_name: str | None = Body(None, embed=True),
    language: str | None = Body(None, embed=True),
    components: list | None = Body(None, embed=True),
    extra_image_links: list[str] | None = Body(None, embed=True),
    audio_url: str | None = Body(None, embed=True),
):
    """Trigger a background test run of the order-confirmation flow.

    If `phone` is provided, it overrides the Shopify fetch and will be used as the raw phone.
    """
    try:
        if not order_id:
            raise HTTPException(status_code=400, detail="order_id is required")
        asyncio.create_task(
            _run_order_confirmation_flow(
                order_id=order_id,
                template_name_override=template_name,
                template_lang_override=language,
                components_override=components,
                raw_phone_override=phone,
                extra_image_links=extra_image_links,
                audio_url_override=audio_url,
            )
        )
        return {"ok": True, "queued": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start test run: {exc}")

@app.get("/flows/order-confirmation/template-config")
async def get_order_confirm_template_config():
    try:
        raw = await db_manager.get_setting("order_confirm:template_config")
        return json.loads(raw) if raw else {}
    except Exception:
        return {}

@app.post("/flows/order-confirmation/template-config")
async def set_order_confirm_template_config(payload: dict = Body(...)):
    try:
        name = (payload.get("template_name") or "").strip()
        language = (payload.get("language") or "en").strip()
        components = payload.get("components") or None
        cfg = {"template_name": name, "language": language}
        if components is not None:
            cfg["components"] = components
        await db_manager.set_setting("order_confirm:template_config", cfg)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save template config: {exc}")

@app.post("/shopify/webhooks/orders/create")
async def shopify_orders_create_webhook(payload: dict = Body(...)):
    try:
        # Shopify may post full order JSON
        order = payload.get("order") or payload
        order_id = str(order.get("id") or order.get("order_id") or "").strip()
        if not order_id:
            raise HTTPException(status_code=400, detail="order id missing")
        # Try to get a phone from payload as early input
        phone = (
            (order.get("shipping_address") or {}).get("phone")
            or (order.get("billing_address") or {}).get("phone")
            or (order.get("customer") or {}).get("phone")
            or order.get("phone")
            or None
        )
        asyncio.create_task(_run_order_confirmation_flow(order_id=order_id, raw_phone_override=phone))
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Webhook failed: {exc}")

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

@app.get("/version")
async def get_version():
    try:
        commit = os.getenv("GIT_COMMIT", "")
    except Exception:
        commit = ""
    return {
        "build_id": APP_BUILD_ID,
        "started_at": APP_STARTED_AT,
        **({"commit": commit} if commit else {}),
    }

# After all routes: mount the static folder for any other assets under /static
try:
    app.mount("/static", StaticFiles(directory=str(ROOT_DIR / "frontend" / "build" / "static")), name="static")
except Exception:
    pass

# ----- Agent analytics -----
@app.get("/analytics/agents")
async def get_agents_analytics(start: Optional[str] = None, end: Optional[str] = None):
    return await db_manager.get_all_agents_analytics(start=start, end=end)

@app.get("/analytics/agents/{username}")
async def get_agent_analytics(username: str, start: Optional[str] = None, end: Optional[str] = None):
    return await db_manager.get_agent_analytics(agent_username=username, start=start, end=end)

@app.get("/login", response_class=HTMLResponse)
async def login_page():
    if DISABLE_AUTH:
        return RedirectResponse("/#agent=admin")
    try:
        index_path = ROOT_DIR / "frontend" / "build" / "index.html"
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    except Exception:
        return RedirectResponse("/")

@app.get("/favicon.ico")
async def favicon():
    try:
        fav = ROOT_DIR / "frontend" / "build" / "favicon.ico"
        if fav.exists():
            return FileResponse(str(fav))
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    except Exception:
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

@app.get("/")
async def index_page():
    try:
        build_dir = ROOT_DIR / "frontend" / "build"
        index_path = build_dir / "index.html"
        if not index_path.exists():
            return JSONResponse(status_code=404, content={"detail": "Not Found"})
        html = index_path.read_text(encoding="utf-8")
        return HTMLResponse(content=html)
    except Exception:
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

# Serve hashed main bundle filenames for safety even if HTML references are stale
@app.get("/static/js/{filename}")
async def serve_js(filename: str):
    try:
        js_path = ROOT_DIR / "frontend" / "build" / "static" / "js" / filename
        if js_path.exists():
            return FileResponse(str(js_path))
        # Best-effort: fallback to the current main bundle if name changed
        manifest = ROOT_DIR / "frontend" / "build" / "asset-manifest.json"
        if manifest.exists():
            import json as _json
            data = _json.loads(manifest.read_text(encoding="utf-8"))
            main_rel = (data.get("files", {}) or {}).get("main.js")
            if main_rel:
                target = ROOT_DIR / "frontend" / "build" / main_rel.lstrip("/")
                if target.exists():
                    return FileResponse(str(target))
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    except Exception:
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

@app.get("/static/css/{filename}")
async def serve_css(filename: str):
    try:
        css_path = ROOT_DIR / "frontend" / "build" / "static" / "css" / filename
        if css_path.exists():
            return FileResponse(str(css_path))
        # Fallback to current main css from manifest
        manifest = ROOT_DIR / "frontend" / "build" / "asset-manifest.json"
        if manifest.exists():
            import json as _json
            data = _json.loads(manifest.read_text(encoding="utf-8"))
            main_rel = (data.get("files", {}) or {}).get("main.css")
            if main_rel:
                target = ROOT_DIR / "frontend" / "build" / main_rel.lstrip("/")
                if target.exists():
                    return FileResponse(str(target))
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    except Exception:
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

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
    logging.info("/send-media requested user_id=%s type=%s files=%s caption=%s", user_id, media_type, len(files or []), caption)

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

            # ---------- AUDIO-ONLY: reject non-mono at edge ----------
            if media_type == "audio":
                try:
                    ch = await probe_audio_channels(file_path)
                    if ch and ch != 1:
                        raise HTTPException(status_code=400, detail="Only mono audio is supported for WhatsApp voice notes. Please record in mono and try again.")
                except HTTPException:
                    raise
                except Exception:
                    # If probing fails, continue – conversion will enforce mono
                    pass

            # ---------- AUDIO: always re-encode to OGG/Opus 48k mono ----------
            if media_type == "audio":
                try:
                    ogg_path = await convert_webm_to_ogg(file_path)
                    try:
                        file_path.unlink(missing_ok=True)  # delete original
                    except Exception:
                        pass
                    file_path = ogg_path
                    filename = ogg_path.name
                except Exception as exc:
                    raise HTTPException(status_code=500, detail=f"Audio conversion failed: {exc}")

            # ---------- audio: compute waveform before upload ----------
            audio_waveform: list[int] | None = None
            if media_type == "audio":
                try:
                    audio_waveform = await compute_audio_waveform(file_path, buckets=56)
                except Exception:
                    audio_waveform = None

            # ---------- upload to Google Cloud Storage ----------
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
                **({"waveform": audio_waveform} if audio_waveform else {}),
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
        logging.error("Error in /send-media user_id=%s error=%s", user_id, exc, exc_info=True)
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

            # ---------- AUDIO-ONLY: reject non-mono at edge ----------
            if media_type == "audio":
                try:
                    ch = await probe_audio_channels(file_path)
                    if ch and ch != 1:
                        raise HTTPException(status_code=400, detail="Only mono audio is supported for WhatsApp voice notes. Please record in mono and try again.")
                except HTTPException:
                    raise
                except Exception:
                    pass

            # ---------- AUDIO: always re-encode to OGG/Opus 48k mono ----------
            if media_type == "audio":
                try:
                    ogg_path = await convert_webm_to_ogg(file_path)
                    try:
                        file_path.unlink(missing_ok=True)
                    except Exception:
                        pass
                    file_path = ogg_path
                except Exception as exc:
                    raise HTTPException(status_code=500, detail=f"Audio conversion failed: {exc}")

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
async def refresh_catalog_cache_endpoint(background_tasks: BackgroundTasks):
    # Kick off a background refresh to avoid request timeouts
    background_tasks.add_task(catalog_manager.refresh_catalog_cache)
    return {"status": "started"}


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
    """Proxy/redirect remote audio with Range support.

    Prefer 302 redirect to a short‑lived GCS signed URL when possible (direct CDN
    delivery, best for scale). Fallback to streaming proxy with Range pass-through.
    Important when streaming: keep the upstream httpx response open until done.
    """
    if not url or not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid url")
    try:
        # Try to redirect to a signed GCS URL if applicable (only if object exists)
        signed = maybe_signed_url_for(url, ttl_seconds=600)
        if signed:
            try:
                # Lightweight existence check to avoid redirecting to GCS 403 when bucket is private but URL is wrong
                bucket, blob = _parse_gcs_url(url)
                if bucket and blob:
                    client = _get_client()
                    if client.bucket(bucket).blob(blob).exists():
                        return RedirectResponse(url=signed, status_code=302)
            except Exception:
                # If anything goes wrong, fall back to proxying
                pass

        range_header = request.headers.get("range") or request.headers.get("Range")

        # If the URL is a GCS object and signing failed, stream directly via GCS SDK with auth
        bucket_name, blob_name = _parse_gcs_url(url)
        if bucket_name and blob_name:
            try:
                client_gcs = _get_client()
                bucket = client_gcs.bucket(bucket_name)
                blob = bucket.blob(blob_name)
                # Ensure metadata loaded
                try:
                    blob.reload()
                except Exception:
                    pass
                size = getattr(blob, "size", None)
                ctype = blob.content_type or "audio/ogg"

                # Parse Range header (single range only)
                start = end = None
                if range_header and range_header.lower().startswith("bytes="):
                    try:
                        r = range_header.split("=", 1)[1]
                        s, e = (r.split("-", 1) + [""])[:2]
                        start = int(s) if s else None
                        end = int(e) if e else None
                    except Exception:
                        start = end = None

                if start is not None and size is not None:
                    end = end if end is not None else int(size) - 1
                    data = blob.download_as_bytes(start=start, end=end)
                    headers = {
                        "Accept-Ranges": "bytes",
                        "Content-Range": f"bytes {start}-{end}/{size}",
                        "Content-Length": str(len(data)),
                        "Cache-Control": "public, max-age=86400",
                    }
                    return StarletteResponse(content=data, media_type=ctype, headers=headers, status_code=206)
                else:
                    # Full download (small files) – return 200
                    data = blob.download_as_bytes()
                    headers = {
                        "Accept-Ranges": "bytes",
                        "Content-Length": str(len(data)),
                        "Cache-Control": "public, max-age=86400",
                    }
                    return StarletteResponse(content=data, media_type=ctype, headers=headers, status_code=200)
            except Exception:
                # Fall back to HTTP proxy below
                pass

        fwd_headers = {"User-Agent": "Mozilla/5.0"}
        if range_header:
            fwd_headers["Range"] = range_header

        timeout = httpx.Timeout(connect=10.0, read=120.0, write=120.0, pool=30.0)
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)
        req = client.build_request("GET", url, headers=fwd_headers)
        resp = await client.send(req, stream=True)

        status_code = resp.status_code
        media_type = resp.headers.get("Content-Type", "audio/ogg")
        passthrough = {"Cache-Control": "public, max-age=86400"}
        for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
            v = resp.headers.get(h)
            if v:
                passthrough[h] = v
        if "Accept-Ranges" not in passthrough:
            passthrough["Accept-Ranges"] = "bytes"

        async def body_iter():
            try:
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        yield chunk
            finally:
                try:
                    await resp.aclose()
                finally:
                    await client.aclose()

        return StreamingResponse(body_iter(), status_code=status_code, media_type=media_type, headers=passthrough)
    except Exception as exc:
        print(f"Proxy audio error: {exc}")
        raise HTTPException(status_code=502, detail="Proxy fetch failed")


@app.get("/proxy-image")
async def proxy_image(url: str, w: int | None = None, q: int | None = None):
    """Proxy/redirect images.

    Prefer 302 redirect to signed GCS URL when our bucket; otherwise fetch and
    return bytes (to avoid CORS and allow caching via our domain).
    """
    if not url or not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid url")
    try:
        signed = maybe_signed_url_for(url, ttl_seconds=600)
        # Only redirect to signed URL when not resizing
        if signed and not w:
            try:
                bucket, blob = _parse_gcs_url(url)
                if bucket and blob:
                    client = _get_client()
                    if client.bucket(bucket).blob(blob).exists():
                        return RedirectResponse(url=signed, status_code=302)
            except Exception:
                pass
        # If GCS signed URL isn't available, attempt authenticated fetch via GCS SDK
        bucket_name, blob_name = _parse_gcs_url(url)
        if bucket_name and blob_name:
            try:
                client_gcs = _get_client()
                bucket = client_gcs.bucket(bucket_name)
                blob = bucket.blob(blob_name)
                try:
                    blob.reload()
                except Exception:
                    pass
                data = blob.download_as_bytes()
                ctype = blob.content_type or "image/jpeg"
                # If a thumbnail width is requested, downscale on the fly
                if w and isinstance(w, int) and w > 0:
                    try:
                        quality = int(q) if q is not None else 72
                        quality = max(40, min(92, quality))
                        im = Image.open(io.BytesIO(data))
                        im = im.convert("RGB")
                        # Contain within width, preserve aspect ratio
                        im = ImageOps.contain(im, (int(w), int(w) * 10))
                        buf = io.BytesIO()
                        im.save(buf, format="JPEG", quality=quality, optimize=True)
                        thumb_bytes = buf.getvalue()
                        return StarletteResponse(
                            content=thumb_bytes,
                            media_type="image/jpeg",
                            headers={
                                "Cache-Control": "public, max-age=86400",
                                "Vary": "Accept",
                            },
                        )
                    except Exception:
                        # Fall back to original if resize fails
                        pass
                return StarletteResponse(
                    content=data,
                    media_type=ctype,
                    headers={
                        "Cache-Control": "public, max-age=86400",
                        "Vary": "Accept",
                    },
                )
            except Exception:
                # Fall back to generic HTTP fetch below
                pass
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        media_type = resp.headers.get("Content-Type", "image/jpeg")
        # Forward upstream status code and caching headers to enable proper browser caching/conditional requests
        passthrough = {
            "Cache-Control": resp.headers.get("Cache-Control", "public, max-age=86400"),
            "Vary": resp.headers.get("Vary", "Accept"),
        }
        for h in ("ETag", "Last-Modified", "Content-Length"):
            v = resp.headers.get(h)
            if v:
                passthrough[h] = v
        # If resize requested and content seems image-like, attempt downscale
        if w and isinstance(w, int) and w > 0 and ("image" in media_type or media_type.startswith("application/octet-stream")) and resp.status_code < 400:
            try:
                quality = int(q) if q is not None else 72
                quality = max(40, min(92, quality))
                im = Image.open(io.BytesIO(resp.content))
                im = im.convert("RGB")
                im = ImageOps.contain(im, (int(w), int(w) * 10))
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=quality, optimize=True)
                thumb_bytes = buf.getvalue()
                # Remove upstream length since content length changed
                passthrough.pop("Content-Length", None)
                return StarletteResponse(
                    content=thumb_bytes,
                    media_type="image/jpeg",
                    headers=passthrough,
                    status_code=200,
                )
            except Exception:
                # Fall back to original bytes on failure
                pass
        return StarletteResponse(
            content=resp.content,
            media_type=media_type,
            headers=passthrough,
            status_code=resp.status_code,
        )
    except Exception as exc:
        print(f"Proxy image error: {exc}")
        raise HTTPException(status_code=502, detail="Proxy fetch failed")


@app.get("/proxy-media")
async def proxy_media(url: str, request: StarletteRequest):
    """Generic media proxy for videos/documents with signed redirect when possible.

    - If GCS: redirect to V4 signed URL (302) for direct CDN delivery with Range.
    - Else: stream with Range pass-through like proxy_audio.
    """
    if not url or not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid url")
    try:
        signed = maybe_signed_url_for(url, ttl_seconds=600)
        if signed:
            try:
                bucket, blob = _parse_gcs_url(url)
                if bucket and blob:
                    client_gcs = _get_client()
                    if client_gcs.bucket(bucket).blob(blob).exists():
                        return RedirectResponse(url=signed, status_code=302)
            except Exception:
                pass

        # GCS authenticated streaming fallback
        range_header = request.headers.get("range") or request.headers.get("Range")
        bucket_name, blob_name = _parse_gcs_url(url)
        if bucket_name and blob_name:
            try:
                client_gcs = _get_client()
                bucket = client_gcs.bucket(bucket_name)
                blob = bucket.blob(blob_name)
                try:
                    blob.reload()
                except Exception:
                    pass
                size = getattr(blob, "size", None)
                ctype = blob.content_type or "application/octet-stream"

                start = end = None
                if range_header and range_header.lower().startswith("bytes="):
                    try:
                        r = range_header.split("=", 1)[1]
                        s, e = (r.split("-", 1) + [""])[:2]
                        start = int(s) if s else None
                        end = int(e) if e else None
                    except Exception:
                        start = end = None
                if start is not None and size is not None:
                    end = end if end is not None else int(size) - 1
                    data = blob.download_as_bytes(start=start, end=end)
                    headers = {
                        "Accept-Ranges": "bytes",
                        "Content-Range": f"bytes {start}-{end}/{size}",
                        "Content-Length": str(len(data)),
                        "Cache-Control": "public, max-age=86400",
                    }
                    return StarletteResponse(content=data, media_type=ctype, headers=headers, status_code=206)
                else:
                    data = blob.download_as_bytes()
                    headers = {
                        "Accept-Ranges": "bytes",
                        "Content-Length": str(len(data)),
                        "Cache-Control": "public, max-age=86400",
                    }
                    return StarletteResponse(content=data, media_type=ctype, headers=headers, status_code=200)
            except Exception:
                pass

        # Generic HTTP proxy fallback
        fwd_headers = {"User-Agent": "Mozilla/5.0"}
        if range_header:
            fwd_headers["Range"] = range_header
        timeout = httpx.Timeout(connect=10.0, read=120.0, write=120.0, pool=30.0)
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)
        req = client.build_request("GET", url, headers=fwd_headers)
        resp = await client.send(req, stream=True)

        status_code = resp.status_code
        media_type = resp.headers.get("Content-Type", "application/octet-stream")
        passthrough = {"Cache-Control": "public, max-age=86400"}
        for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
            v = resp.headers.get(h)
            if v:
                passthrough[h] = v
        if "Accept-Ranges" not in passthrough:
            passthrough["Accept-Ranges"] = "bytes"

        async def body_iter():
            try:
                async for chunk in resp.aiter_bytes():
                    if chunk:
                        yield chunk
            finally:
                try:
                    await resp.aclose()
                finally:
                    await client.aclose()

        return StreamingResponse(body_iter(), status_code=status_code, media_type=media_type, headers=passthrough)
    except Exception as exc:
        print(f"Proxy media error: {exc}")
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

        # Encourage browser/proxy caching to avoid repeated refetches
        headers = {
            "Cache-Control": "public, max-age=3600, stale-while-revalidate=60",
            "Vary": "Accept",
        }
        return JSONResponse(content={"url": url, "title": title, "description": description, "image": image}, headers=headers)
    except Exception as exc:
        print(f"Link preview error: {exc}")
        raise HTTPException(status_code=502, detail="Preview fetch failed")

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


# Resolve and cache the WhatsApp Business Account (WABA) ID using the configured phone number id
_WABA_ID_CACHE: Optional[str] = None

async def get_waba_id() -> Optional[str]:
    global _WABA_ID_CACHE
    try:
        if _WABA_ID_CACHE:
            return _WABA_ID_CACHE
        # Allow explicit override via environment
        if WABA_ID_ENV and isinstance(WABA_ID_ENV, str) and WABA_ID_ENV.strip():
            _WABA_ID_CACHE = WABA_ID_ENV.strip()
            return _WABA_ID_CACHE
        if not PHONE_NUMBER_ID or PHONE_NUMBER_ID == "your_phone_number_id":
            return None
        url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{PHONE_NUMBER_ID}"
        params = {"fields": "whatsapp_business_account"}
        headers = await get_whatsapp_headers()
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers, params=params)
            data = resp.json() if resp is not None else {}
        wba = (data or {}).get("whatsapp_business_account") or {}
        waba_id = wba.get("id")
        if isinstance(waba_id, str) and waba_id:
            _WABA_ID_CACHE = waba_id
            return waba_id
        return None
    except Exception:
        return None


@app.get("/whatsapp/templates")
async def list_whatsapp_templates():
    """Return Meta-approved WhatsApp message templates for the configured WABA.

    Response shape: [{ name, status, language, category, quality_score }]
    """
    try:
        waba_id = await get_waba_id()
        if not waba_id:
            raise HTTPException(status_code=500, detail="WABA ID not configured")

        url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{waba_id}/message_templates"
        params = {
            "fields": "name,status,category,language,quality_score,components",
            "limit": 100,
        }
        headers = await get_whatsapp_headers()

        results: list[dict] = []
        async with httpx.AsyncClient(timeout=30.0) as client:
            next_url = url
            next_params = params
            while next_url:
                r = await client.get(next_url, headers=headers, params=next_params if next_params else None)
                payload = r.json() if r is not None else {}
                for t in (payload.get("data") or []):
                    try:
                        results.append({
                            "name": t.get("name"),
                            "status": t.get("status"),
                            "language": t.get("language"),
                            "category": t.get("category"),
                            "quality_score": (t.get("quality_score") or {}).get("score"),
                            "components": t.get("components") or [],
                        })
                    except Exception:
                        continue
                # Graph pagination
                next_url = (payload.get("paging") or {}).get("next")
                next_params = None

        return results
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch templates: {exc}")

@app.get("/whatsapp/config")
async def whatsapp_config():
    """Diagnostic endpoint to inspect WhatsApp env/config detection (non-sensitive)."""
    try:
        detected_waba = await get_waba_id()
        return {
            "has_access_token": bool(ACCESS_TOKEN and ACCESS_TOKEN != "your_access_token_here"),
            "phone_number_id_set": bool(PHONE_NUMBER_ID and PHONE_NUMBER_ID != "your_phone_number_id"),
            "waba_env_present": bool(WABA_ID_ENV),
            "resolved_waba_id": detected_waba or None,
        }
    except Exception as exc:
        return {"error": str(exc)}

# ---------------- Automations storage (simple key/value) -----------------

AUTOMATIONS_KEY = "automations:list"

@app.get("/automations")
async def list_automations():
    try:
        raw = await db_manager.get_setting(AUTOMATIONS_KEY)
        return json.loads(raw) if raw else []
    except Exception:
        return []

@app.post("/automations")
async def save_automations(payload: list[dict] = Body(...)):
    try:
        await db_manager.set_setting(AUTOMATIONS_KEY, payload or [])
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save automations: {exc}")

@app.post("/whatsapp/send-template")
async def send_whatsapp_template(
    to: str = Body(..., embed=True),
    template_name: str = Body(..., embed=True),
    language: str = Body("en", embed=True),
    components: list | None = Body(None, embed=True),
):
    """Send a WhatsApp template with full components to a phone (E.164 or raw).

    Body: { to, template_name, language, components }
    """
    try:
        # Normalize if raw digits provided
        norm = to
        if isinstance(to, str) and to and not to.startswith("+"):
            try:
                digits = "".join(ch for ch in to if ch.isdigit())
                if digits.startswith("212"):
                    norm = "+" + digits
                elif digits.startswith("0"):
                    norm = "+212" + digits[1:]
                else:
                    norm = "+" + digits
            except Exception:
                norm = to
        res = await messenger.send_template_message(
            to=norm,
            template_name=template_name,
            language=language or "en",
            components=components,
        )
        return {"ok": True, "response": res}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Send template failed: {exc}")

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


# ───────────────────────── Conversation Notes API ─────────────────────────
@app.get("/conversations/{user_id}/notes")
async def get_conversation_notes(user_id: str):
    try:
        notes = await db_manager.list_notes(user_id)
        # Attach signed URLs for any GCS-backed media so browser can access
        enriched = []
        for n in notes:
            try:
                url = n.get("url")
                signed = maybe_signed_url_for(url, ttl_seconds=3600) if url else None
                if signed:
                    n = { **n, "signed_url": signed }
            except Exception:
                pass
            enriched.append(n)
        return enriched
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to list notes: {exc}")


@app.post("/conversations/{user_id}/notes")
async def create_conversation_note(
    user_id: str,
    note_type: str = Body("text"),
    text: str | None = Body(None),
    url: str | None = Body(None),
    agent_username: str | None = Body(None),
):
    try:
        payload = {
            "user_id": user_id,
            "type": (note_type or "text").lower(),
            "text": (text or None),
            "url": (url or None),
            "agent_username": agent_username,
            "created_at": datetime.utcnow().isoformat(),
        }
        if payload["type"] not in ("text", "audio"):
            payload["type"] = "text"
        stored = await db_manager.add_note(payload)
        # Include signed_url in the response for immediate playback
        try:
            media_url = stored.get("url")
            signed = maybe_signed_url_for(media_url, ttl_seconds=3600) if media_url else None
            if signed:
                stored = { **stored, "signed_url": signed }
        except Exception:
            pass
        return stored
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to add note: {exc}")


@app.delete("/conversations/notes/{note_id}")
async def delete_conversation_note(note_id: int):
    try:
        await db_manager.delete_note(note_id)
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete note: {exc}")
