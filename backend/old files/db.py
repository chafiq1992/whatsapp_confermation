import sqlite3
import threading
from datetime import datetime
from typing import List, Dict, Any, Optional

# ────────────────────────────────────────────────────────────
# A single-process, thread-safe SQLite helper
# ────────────────────────────────────────────────────────────

_STATUS_ORDER = {
    "sending": 0,
    "sent": 1,
    "delivered": 2,
    "read": 3,
    "failed": 99,
}

class DatabaseManager:
    def __init__(self, db_path: str = "messages.db"):
        # • file-based so data survives process restarts
        # • check_same_thread=False because FastAPI + WebSocket runs workers/threads
        self.conn = sqlite3.connect(
            db_path, check_same_thread=False, detect_types=sqlite3.PARSE_DECLTYPES
        )
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self._init_schema()

    # ───── schema ─────
    def _init_schema(self) -> None:
        with self.conn:
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id         TEXT    NOT NULL,
                    temp_id         TEXT    UNIQUE,          -- browser optimistic id
                    wa_message_id   TEXT    UNIQUE,          -- Meta id
                    message         TEXT,
                    type            TEXT    NOT NULL,        -- text | image | audio | …
                    status          TEXT    DEFAULT 'sending',
                    from_me         INTEGER DEFAULT 0,       -- bool as 0/1
                    caption         TEXT,
                    price           TEXT,
                    url             TEXT,
                    media_path      TEXT,
                    timestamp       TEXT    NOT NULL         -- ISO8601
                );
                """
            )
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_user_time ON messages(user_id, timestamp)"
            )

    # ───── helpers ─────
    def _row_to_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        d["from_me"] = bool(d["from_me"])
        return d

    # insert OR upgrade in one call
    def upsert_message(self, data: Dict[str, Any]) -> None:
        """
        If temp_id or wa_message_id already exists, update that row (status upgrade,
        add wa_message_id, etc.). Otherwise insert a new row.
        """
        with self.lock, self.conn:
            cur = self.conn.cursor()

            # 1. is it already there?
            row = None
            if data.get("wa_message_id"):
                cur.execute(
                    "SELECT * FROM messages WHERE wa_message_id=?",
                    (data["wa_message_id"],),
                )
                row = cur.fetchone()
            if not row and data.get("temp_id"):
                cur.execute(
                    "SELECT * FROM messages WHERE temp_id=?", (data["temp_id"],)
                )
                row = cur.fetchone()

            # 2. decide whether we are allowed to override status
            if row:
                current_status = row["status"]
                new_status = data.get("status", current_status)
                if _STATUS_ORDER.get(new_status, 0) < _STATUS_ORDER.get(
                    current_status, 0
                ):
                    # lower-rank status – ignore
                    return

                # merge
                merged = {**dict(row), **data}
                placeholders = ",".join(f"{k}=?" for k in merged.keys())
                cur.execute(
                    f"UPDATE messages SET {placeholders} WHERE id=?",
                    (*merged.values(), row["id"]),
                )
            else:
                # 3. fresh insert
                cols = ", ".join(data.keys())
                qs = ", ".join("?" for _ in data)
                cur.execute(f"INSERT INTO messages ({cols}) VALUES ({qs})", tuple(data.values()))

    def get_messages(
        self, user_id: str, limit: int = 1000
    ) -> List[Dict[str, Any]]:
        with self.lock, self.conn:
            cur = self.conn.execute(
                """
                SELECT * FROM messages
                WHERE user_id=?
                ORDER BY datetime(timestamp)
                LIMIT ?
                """,
                (user_id, limit),
            )
            return [self._row_to_dict(r) for r in cur.fetchall()]
