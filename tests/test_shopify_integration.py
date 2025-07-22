import importlib
import sys
import types


def _ensure_stub_modules(monkeypatch):
    if 'fastapi' not in sys.modules:
        class DummyRouter:
            def get(self, *a, **k):
                def wrapper(fn):
                    return fn
                return wrapper

            def post(self, *a, **k):
                def wrapper(fn):
                    return fn
                return wrapper

        fastapi = types.SimpleNamespace(
            APIRouter=lambda *a, **k: DummyRouter(),
            Body=lambda *a, **k: None,
            Query=lambda *a, **k: None,
        )
        monkeypatch.setitem(sys.modules, 'fastapi', fastapi)
    if 'httpx' not in sys.modules:
        httpx = types.ModuleType('httpx')
        class AsyncClient:
            pass
        httpx.AsyncClient = AsyncClient
        monkeypatch.setitem(sys.modules, 'httpx', httpx)


def test_store_domain_loaded(monkeypatch):
    monkeypatch.setenv("IRRAKIDS_API_KEY", "key")
    monkeypatch.setenv("IRRAKIDS_PASSWORD", "pw")
    monkeypatch.setenv("IRRAKIDS_STORE_DOMAIN", "store.myshopify.com")
    # Ensure other prefixes do not interfere
    monkeypatch.delenv("SHOPIFY_API_KEY", raising=False)
    monkeypatch.delenv("SHOPIFY_PASSWORD", raising=False)
    monkeypatch.delenv("SHOPIFY_STORE_URL", raising=False)
    monkeypatch.delenv("SHOPIFY_STORE_DOMAIN", raising=False)

    _ensure_stub_modules(monkeypatch)

    sys.modules.pop('backend.shopify_integration', None)
    module = importlib.import_module('backend.shopify_integration')
    assert module.API_KEY == "key"
    assert module.STORE_URL == "https://store.myshopify.com"
