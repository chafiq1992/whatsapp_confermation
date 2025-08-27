import json
from fastapi.testclient import TestClient

from backend import main

client = TestClient(main.app)

async def fake_send_catalog_products(to, ids):
    fake_send_catalog_products.called = (to, ids)
    return ["ok"]

async def fake_send_single_catalog_item(to, rid, caption=""):
    fake_send_single_catalog_item.called = (to, rid)
    return {"ok": True}


def test_send_catalog_set_uses_lookup(monkeypatch):
    async def fake_lookup_phone(uid):
        return "+123"

    monkeypatch.setattr(main, "lookup_phone", fake_lookup_phone)
    monkeypatch.setattr(main.messenger, "send_catalog_products", fake_send_catalog_products)
    resp = client.post("/send-catalog-set", data={"user_id": "U1", "product_ids": json.dumps(["a", "b"])})
    assert resp.status_code == 200
    assert fake_send_catalog_products.called == ("+123", ["a", "b"])


def test_send_catalog_set_fallback(monkeypatch):
    async def fake_lookup_phone(uid):
        return None

    monkeypatch.setattr(main, "lookup_phone", fake_lookup_phone)
    monkeypatch.setattr(main.messenger, "send_catalog_products", fake_send_catalog_products)
    resp = client.post("/send-catalog-set", data={"user_id": "U2", "product_ids": json.dumps(["x"])})
    assert resp.status_code == 200
    assert fake_send_catalog_products.called == ("U2", ["x"])


def test_send_catalog_item_uses_lookup(monkeypatch):
    async def fake_lookup_phone(uid):
        return "+999"

    monkeypatch.setattr(main, "lookup_phone", fake_lookup_phone)
    monkeypatch.setattr(main.messenger, "send_single_catalog_item", fake_send_single_catalog_item)
    resp = client.post("/send-catalog-item", data={"user_id": "U3", "product_retailer_id": "pid"})
    assert resp.status_code == 200
    assert fake_send_single_catalog_item.called == ("+999", "pid")


def test_send_catalog_item_fallback(monkeypatch):
    async def fake_lookup_phone(uid):
        return None

    monkeypatch.setattr(main, "lookup_phone", fake_lookup_phone)
    monkeypatch.setattr(main.messenger, "send_single_catalog_item", fake_send_single_catalog_item)
    resp = client.post("/send-catalog-item", data={"user_id": "U4", "product_retailer_id": "pid2"})
    assert resp.status_code == 200
    assert fake_send_single_catalog_item.called == ("U4", "pid2")


def test_send_catalog_all_uses_lookup(monkeypatch):
    async def fake_lookup_phone(uid):
        return "+123"

    monkeypatch.setattr(main, "lookup_phone", fake_lookup_phone)
    monkeypatch.setattr(
        main.catalog_manager,
        "get_cached_products",
        lambda: [{"retailer_id": "a"}, {"retailer_id": "b"}],
    )
    monkeypatch.setattr(main.messenger, "send_catalog_products", fake_send_catalog_products)
    resp = client.post("/send-catalog-all", data={"user_id": "U1"})
    assert resp.status_code == 200
    assert fake_send_catalog_products.called == ("+123", ["a", "b"])


def test_send_catalog_all_fallback(monkeypatch):
    async def fake_lookup_phone(uid):
        return None

    monkeypatch.setattr(main, "lookup_phone", fake_lookup_phone)
    monkeypatch.setattr(
        main.catalog_manager,
        "get_cached_products",
        lambda: [{"retailer_id": "x"}],
    )
    monkeypatch.setattr(main.messenger, "send_catalog_products", fake_send_catalog_products)
    resp = client.post("/send-catalog-all", data={"user_id": "U2"})
    assert resp.status_code == 200
    assert fake_send_catalog_products.called == ("U2", ["x"])


def test_send_catalog_set_all_uses_lookup(monkeypatch):
    async def fake_lookup_phone(uid):
        return "+321"

    monkeypatch.setattr(main, "lookup_phone", fake_lookup_phone)

    async def fake_get_products_for_set(set_id, limit=60):
        return [{"retailer_id": "a"}, {"retailer_id": "b"}]

    monkeypatch.setattr(main.CatalogManager, "get_products_for_set", fake_get_products_for_set)
    monkeypatch.setattr(main.messenger, "send_catalog_products", fake_send_catalog_products)

    resp = client.post(
        "/send-catalog-set-all",
        data={"user_id": "U5", "set_id": "S1"},
    )

    assert resp.status_code == 200
    assert fake_send_catalog_products.called == ("+321", ["a", "b"])


def test_send_catalog_set_all_chunks(monkeypatch):
    async def fake_lookup_phone(uid):
        return None

    monkeypatch.setattr(main, "lookup_phone", fake_lookup_phone)

    products = [{"retailer_id": str(i)} for i in range(31)]

    async def fake_get_products_for_set(set_id, limit=60):
        return products

    monkeypatch.setattr(main.CatalogManager, "get_products_for_set", fake_get_products_for_set)

    calls = []

    async def fake_make_request(endpoint, data):
        calls.append(data["multi_product"]["products"])
        return {"ok": True}

    monkeypatch.setattr(main.messenger, "_make_request", fake_make_request)
    monkeypatch.setattr(main.config, "RATE_LIMIT_DELAY", 0)

    resp = client.post(
        "/send-catalog-set-all", data={"user_id": "U6", "set_id": "S2"}
    )

    assert resp.status_code == 200
    assert len(calls) == 2
    assert len(calls[0]) == 30
    assert len(calls[1]) == 1


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
