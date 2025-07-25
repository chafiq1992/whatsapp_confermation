import asyncio
import pytest
from backend.main import DatabaseManager
from contextlib import asynccontextmanager


class FakeConn:
    def __init__(self):
        self.calls = []
        self.fetchrow_results = []
        self.fetch_results = []

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))

    async def fetchrow(self, query, *args):
        self.calls.append(("fetchrow", query, args))
        return self.fetchrow_results.pop(0)

    async def fetch(self, query, *args):
        self.calls.append(("fetch", query, args))
        return self.fetch_results.pop(0)
import aiosqlite

@pytest.mark.asyncio
async def test_upsert_message_saves_url(tmp_path):
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
        "url": "http://example.com/img.jpg",
    })
    msgs = await dm.get_messages("user")
    assert len(msgs) == 1
    msg = msgs[0]
    assert msg["wa_message_id"] == "x1"
    assert msg["url"] == "http://example.com/img.jpg"


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


def test_convert_mixed_placeholders():
    dm = DatabaseManager(db_url="postgresql://")
    q = "UPDATE t SET a=:a, b=? WHERE id=:id AND other=?"
    converted = dm._convert(q)
    assert converted == "UPDATE t SET a=$1, b=$2 WHERE id=$3 AND other=$4"


@pytest.mark.asyncio
async def test_get_user_for_message_postgres(monkeypatch):
    dm = DatabaseManager(db_url="postgresql://")
    conn = FakeConn()
    conn.fetchrow_results.append({"user_id": "u1"})

    @asynccontextmanager
    async def fake_conn():
        yield conn

    monkeypatch.setattr(dm, "_conn", fake_conn)
    res = await dm.get_user_for_message("m1")
    assert res == "u1"
    assert conn.calls[0][0] == "fetchrow"
    assert "$1" in conn.calls[0][1]


@pytest.mark.asyncio
async def test_upsert_message_update_postgres(monkeypatch):
    dm = DatabaseManager(db_url="postgresql://")
    conn = FakeConn()
    conn.fetchrow_results.append({"id": 1, "wa_message_id": "m1", "user_id": "u1", "status": "sent"})

    @asynccontextmanager
    async def fake_conn():
        yield conn

    monkeypatch.setattr(dm, "_conn", fake_conn)

    await dm.upsert_message({"wa_message_id": "m1", "user_id": "u1", "status": "delivered"})

    assert conn.calls[0][0] == "fetchrow"
    assert conn.calls[1][0] == "execute"
    assert conn.calls[1][1].startswith("UPDATE messages SET")
    assert conn.calls[1][2] == ("m1", "u1", "delivered", 1)


@pytest.mark.asyncio
async def test_upsert_user_postgres(monkeypatch):
    dm = DatabaseManager(db_url="postgresql://")
    conn = FakeConn()

    @asynccontextmanager
    async def fake_conn():
        yield conn

    monkeypatch.setattr(dm, "_conn", fake_conn)
    await dm.upsert_user("u1", name="N", phone="P")

    assert conn.calls[0][0] == "execute"
    assert "users.name" in conn.calls[0][1]
    assert "users.phone" in conn.calls[0][1]


@pytest.mark.asyncio
async def test_upsert_user_postgres_admin(monkeypatch):
    dm = DatabaseManager(db_url="postgresql://")
    conn = FakeConn()

    @asynccontextmanager
    async def fake_conn():
        yield conn

    monkeypatch.setattr(dm, "_conn", fake_conn)
    await dm.upsert_user("u2", name="N2", phone="P2", is_admin=1)

    assert conn.calls[0][0] == "execute"
    qry = conn.calls[0][1]
    assert "users.name" in qry and "users.phone" in qry and "EXCLUDED.is_admin" in qry
