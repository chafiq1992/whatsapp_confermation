import asyncio
import pytest
from backend import main
from .utils import bulk_insert_messages


@pytest.fixture
def db_manager(tmp_path, monkeypatch):
    db_path = tmp_path / "db.sqlite"
    dm = main.DatabaseManager(str(db_path))
    asyncio.run(dm.init_db())
    main.db_manager = dm
    main.message_processor.db_manager = dm
    return dm


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def insert_messages():
    def _insert(dm, user_id: str, count: int, start_index: int = 1):
        asyncio.run(bulk_insert_messages(dm, user_id, count, start_index))
    return _insert
