import json
from fastapi.testclient import TestClient
from backend import main

client = TestClient(main.app)


def test_order_flow(tmp_path, monkeypatch):
    order_id = "order123"

    # Use temporary DB to isolate
    db_path = tmp_path / "test.db"
    monkeypatch.setattr(main, "DB_PATH", str(db_path))
    main.db_manager = main.DatabaseManager(str(db_path))
    main.message_processor.db_manager = main.db_manager

    with TestClient(main.app) as client:
        main.db_manager = main.DatabaseManager(str(db_path))
        client.app.dependency_overrides = {}
        main.db_manager.init_db = main.db_manager.init_db
        import asyncio
        asyncio.run(main.db_manager.init_db())

        resp = client.post(f"/orders/{order_id}/delivered")
        assert resp.status_code == 200
        assert resp.json()["status"] == main.ORDER_STATUS_PAYOUT

        resp = client.get("/payouts")
        assert any(o["order_id"] == order_id for o in resp.json())

        resp = client.post(f"/payouts/{order_id}/mark-paid")
        assert resp.status_code == 200
        assert resp.json()["status"] == main.ORDER_STATUS_ARCHIVED

        resp = client.get("/payouts")
        assert not any(o["order_id"] == order_id for o in resp.json())

        resp = client.get("/archive")
        assert any(o["order_id"] == order_id for o in resp.json())
