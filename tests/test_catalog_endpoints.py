import json
from fastapi.testclient import TestClient

from backend import main

client = TestClient(main.app)

async def fake_send_catalog_products(to, ids):
    fake_send_catalog_products.called = (to, ids)
    return ["ok"]

async def fake_send_single_catalog_item(to, rid):
    fake_send_single_catalog_item.called = (to, rid)
    return {"ok": True}


def test_send_catalog_set_uses_lookup(monkeypatch):
    monkeypatch.setattr(main, "lookup_phone", lambda uid: "+123")
    monkeypatch.setattr(main.messenger, "send_catalog_products", fake_send_catalog_products)
    resp = client.post("/send-catalog-set", data={"user_id": "U1", "product_ids": json.dumps(["a", "b"])})
    assert resp.status_code == 200
    assert fake_send_catalog_products.called == ("+123", ["a", "b"])


def test_send_catalog_set_fallback(monkeypatch):
    monkeypatch.setattr(main, "lookup_phone", lambda uid: None)
    monkeypatch.setattr(main.messenger, "send_catalog_products", fake_send_catalog_products)
    resp = client.post("/send-catalog-set", data={"user_id": "U2", "product_ids": json.dumps(["x"])})
    assert resp.status_code == 200
    assert fake_send_catalog_products.called == ("U2", ["x"])


def test_send_catalog_item_uses_lookup(monkeypatch):
    monkeypatch.setattr(main, "lookup_phone", lambda uid: "+999")
    monkeypatch.setattr(main.messenger, "send_single_catalog_item", fake_send_single_catalog_item)
    resp = client.post("/send-catalog-item", data={"user_id": "U3", "product_retailer_id": "pid"})
    assert resp.status_code == 200
    assert fake_send_single_catalog_item.called == ("+999", "pid")


def test_send_catalog_item_fallback(monkeypatch):
    monkeypatch.setattr(main, "lookup_phone", lambda uid: None)
    monkeypatch.setattr(main.messenger, "send_single_catalog_item", fake_send_single_catalog_item)
    resp = client.post("/send-catalog-item", data={"user_id": "U4", "product_retailer_id": "pid2"})
    assert resp.status_code == 200
    assert fake_send_single_catalog_item.called == ("U4", "pid2")


def test_startup_creates_catalog_cache(tmp_path, monkeypatch):
    cache = tmp_path / "cache.json"
    monkeypatch.setattr(main.config, "CATALOG_CACHE_FILE", str(cache))

    async def fake_refresh():
        cache.write_text("[]")
        fake_refresh.called = True
        return 0

    monkeypatch.setattr(main.catalog_manager, "refresh_catalog_cache", fake_refresh)

    with TestClient(main.app):
        import time
        time.sleep(0.01)

    assert cache.exists()
    assert getattr(fake_refresh, "called", False)
