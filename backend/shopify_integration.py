import httpx
import logging
import os
from fastapi import APIRouter, Body, Query, HTTPException

# ================= CONFIG ==================

def _load_store_config() -> tuple[str, str | None, str, str | None]:
    """Return the first set of Shopify credentials found in the environment.

    Environment variables are checked using the prefixes ``SHOPIFY``,
    ``IRRAKIDS`` and ``IRRANOVA``. For each prefix we look for
    ``<prefix>_API_KEY`` and ``<prefix>_PASSWORD`` together with either
    ``<prefix>_STORE_URL`` or ``<prefix>_STORE_DOMAIN``.
    """
    prefixes = [
        "SHOPIFY",
        "IRRAKIDS",
        "IRRANOVA",
    ]

    for prefix in prefixes:
        api_key = os.getenv(f"{prefix}_API_KEY")
        password = os.getenv(f"{prefix}_PASSWORD")
        access_token = os.getenv(f"{prefix}_ACCESS_TOKEN")
        store_url = os.getenv(f"{prefix}_STORE_URL")
        if not store_url:
            domain = os.getenv(f"{prefix}_STORE_DOMAIN")
            if domain:
                store_url = domain if domain.startswith("http") else f"https://{domain}"
        # Prefer token-based auth if provided, else basic auth
        if all([api_key, store_url]) and (password or access_token):
            logging.getLogger(__name__).info("Using Shopify prefix %s", prefix)
            return api_key, password, store_url, access_token

    raise RuntimeError("\u274c\u00a0Missing Shopify environment variables")


try:
    API_KEY, PASSWORD, STORE_URL, ACCESS_TOKEN = _load_store_config()
except Exception as _exc:
    # Defer failure to request time so the router can still be included.
    API_KEY = PASSWORD = STORE_URL = ACCESS_TOKEN = None  # type: ignore[assignment]
    logging.getLogger(__name__).warning("Shopify config missing or invalid: %s", _exc)

API_VERSION = "2023-04"

def admin_api_base() -> str:
    """Return the Admin API base URL or raise 503 if not configured.

    Lazily loads env on first use to allow dynamic configuration in runtime.
    """
    global API_KEY, PASSWORD, STORE_URL, ACCESS_TOKEN
    if not STORE_URL:
        try:
            API_KEY, PASSWORD, STORE_URL, ACCESS_TOKEN = _load_store_config()
        except Exception:
            raise HTTPException(status_code=503, detail="Shopify not configured")
    return f"{STORE_URL}/admin/api/{API_VERSION}"

def _client_args(headers: dict | None = None) -> dict:
    args: dict = {}
    hdrs = dict(headers or {})
    # Prefer Admin API access token. If not provided explicitly, detect token in PASSWORD (shpat_...)
    effective_token = ACCESS_TOKEN or (PASSWORD if isinstance(PASSWORD, str) and PASSWORD.startswith("shpat_") else None)
    if effective_token:
        hdrs["X-Shopify-Access-Token"] = effective_token
        args["headers"] = hdrs
    elif API_KEY and PASSWORD:
        args["auth"] = (API_KEY, PASSWORD)
        if hdrs:
            args["headers"] = hdrs
    return args


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
_auth_mode = "token" if (ACCESS_TOKEN or (PASSWORD and str(PASSWORD).startswith("shpat_"))) else "basic"
logger.info("Shopify auth mode: %s", _auth_mode)

def normalize_phone(phone):
    if not phone:
        return ""
    phone = str(phone).replace(" ", "").replace("-", "")
    if phone.startswith("+"):
        return phone
    if len(phone) == 12 and phone.startswith("212"):
        return "+" + phone
    if len(phone) == 10 and phone.startswith("06"):
        return "+212" + phone[1:]
    return phone

def _split_name(full_name: str) -> tuple[str, str]:
    full = (full_name or "").strip()
    if not full:
        return "", ""
    parts = full.split(" ", 1)
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[1]

# =============== FASTAPI ROUTER ===============
router = APIRouter()

# --- List products, with optional search query ---
@router.get("/shopify-products")
async def shopify_products(q: str = Query("", description="Search product titles (optional)")):
    params = {"title": q} if q else {}
    endpoint = f"{admin_api_base()}/products.json"
    async with httpx.AsyncClient() as client:
        resp = await client.get(endpoint, params=params, **_client_args())
        resp.raise_for_status()
        products = resp.json().get("products", [])
        # Optionally include product_title for variant for UI display
        for p in products:
            for v in p.get("variants", []):
                v["product_title"] = p["title"]
        return products

# --- Lookup a single variant by ID ---
@router.get("/shopify-variant/{variant_id}")
async def shopify_variant(variant_id: str):
    endpoint = f"{admin_api_base()}/variants/{variant_id}.json"
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(endpoint, **_client_args())
        except httpx.RequestError as e:
            logger.warning("Shopify variant request failed: %s", e)
            raise HTTPException(status_code=502, detail="Shopify unreachable")

        if resp.status_code == 403:
            raise HTTPException(status_code=403, detail="Shopify token lacks read_products scope or app not installed.")
        if resp.status_code == 404:
            raise HTTPException(status_code=404, detail="Variant not found")
        if resp.status_code >= 400:
            detail = ""
            try:
                detail = (resp.text or "").strip()[:300]
            except Exception:
                detail = "Shopify error"
            raise HTTPException(status_code=resp.status_code, detail=detail or "Shopify error")

        variant = (resp.json() or {}).get("variant")
        # Try to fetch product title and resolve variant image for display (best-effort)
        if variant:
            try:
                product_id = variant.get("product_id")
                if product_id:
                    prod_endpoint = f"{admin_api_base()}/products/{product_id}.json"
                    p_resp = await client.get(prod_endpoint, **_client_args())
                    if p_resp.status_code == 200:
                        prod = (p_resp.json() or {}).get("product") or {}
                        variant["product_title"] = prod.get("title", "")
                        # Resolve image URL for the variant
                        image_src = None
                        image_id = variant.get("image_id")
                        images = prod.get("images") or []
                        if image_id and images:
                            try:
                                match = next((img for img in images if str(img.get("id")) == str(image_id)), None)
                                if match and match.get("src"):
                                    image_src = match["src"]
                            except Exception:
                                image_src = None
                        # Fallbacks: product featured image or first image
                        if not image_src:
                            image_src = (prod.get("image") or {}).get("src") or (images[0].get("src") if images else None)
                        if image_src:
                            variant["image_src"] = image_src
            except Exception as e:
                logger.debug("Variant enrichment failed: %s", e)
        return variant or {}

# =============== CUSTOMER BY PHONE ===============
async def fetch_customer_by_phone(phone_number: str):
    try:
        phone_number = normalize_phone(phone_number)
        params = {'query': f'phone:{phone_number}'}
        async with httpx.AsyncClient() as client:
            # Search customer
            search_endpoint = f"{admin_api_base()}/customers/search.json"
            resp = await client.get(search_endpoint, params=params, timeout=10, **_client_args())
            if resp.status_code == 403:
                logger.error("Shopify API 403 on customers/search. Missing read_customers scope for token or app not installed.")
                return {"error": "Forbidden", "detail": "Shopify token lacks read_customers scope or app not installed.", "status": 403}
            data = resp.json()
            customers = data.get('customers', [])

            # Morocco fallback
            if not customers and phone_number.startswith("+212"):
                alt_phone = "0" + phone_number[4:]
                params = {'query': f'phone:{alt_phone}'}
                resp = await client.get(search_endpoint, params=params, timeout=10, **_client_args())
                if resp.status_code == 403:
                    logger.error("Shopify API 403 on customers/search (fallback). Missing read_customers scope.")
                    return {"error": "Forbidden", "detail": "Shopify token lacks read_customers scope or app not installed.", "status": 403}
                data = resp.json()
                customers = data.get('customers', [])

            if not customers:
                logger.warning(f"No customer found for phone number {phone_number}")
                return None

            c = customers[0]
            customer_id = c["id"]

            # Orders: last + count
            order_params = {
                "customer_id": customer_id,
                "status": "any",
                "limit": 1,
                "order": "created_at desc"
            }
            orders_resp = await client.get(f"{admin_api_base()}/orders.json", params=order_params, timeout=10, **_client_args())
            orders_data = orders_resp.json()
            orders_list = orders_data.get('orders', [])

            # Count
            total_orders = c.get('orders_count', 0)

            # Last order details if exists
            last_order = None
            if orders_list:
                o = orders_list[0]
                last_order = {
                    "order_number": o.get("name"),
                    "total_price": o.get("total_price"),
                    "line_items": [
                        {
                            "title": item.get("title"),
                            "variant_title": item.get("variant_title"),
                            "quantity": item.get("quantity")
                        }
                        for item in o.get("line_items", [])
                    ]
                }

            # Build response
            return {
                "customer_id": c["id"],   # <--- ADD THIS LINE
                "name": f"{c.get('first_name', '')} {c.get('last_name', '')}".strip(),
                "email": c.get("email") or "",
                "phone": c.get("phone") or "",
                "address": (c["addresses"][0]["address1"] if c.get("addresses") and c["addresses"] else ""),
                "total_orders": total_orders,
                "last_order": last_order
            }
    except httpx.HTTPStatusError as e:
        logger.exception("HTTP error from Shopify: %s", e)
        return {"error": "HTTP error", "detail": str(e), "status": e.response.status_code if e.response else 500}
    except Exception as e:
        logger.exception(f"Exception occurred: {e}")
        return {"error": str(e), "status": 500}

# =========== FASTAPI ENDPOINT: SEARCH CUSTOMER ============
@router.get("/search-customer")
async def search_customer(phone_number: str):
    """
    Fetch customer and order info by phone.
    """
    data = await fetch_customer_by_phone(phone_number)
    if not data:
        raise HTTPException(status_code=404, detail="Customer not found")
    if isinstance(data, dict) and data.get("status") == 403:
        raise HTTPException(status_code=403, detail=data.get("detail") or "Forbidden")
    if isinstance(data, dict) and data.get("error"):
        raise HTTPException(status_code=int(data.get("status", 500)), detail=data.get("detail") or data.get("error"))
    return data


# =========== FASTAPI ENDPOINT: SEARCH MULTIPLE CUSTOMERS ============
def _candidate_phones(raw: str) -> list[str]:
    """Generate possible normalized phone variants for broader matching."""
    if not raw:
        return []
    raw = str(raw).strip().replace(" ", "").replace("-", "")
    candidates: set[str] = set()
    # Base normalized
    base = normalize_phone(raw)
    if base:
        candidates.add(base)
    # Try stripping plus
    if base.startswith("+"):
        candidates.add(base[1:])
    # Morocco specific: +212XXXXXXXXX -> 0XXXXXXXXX
    if base.startswith("+212") and len(base) >= 5:
        candidates.add("0" + base[4:])
        candidates.add(base[4:])  # 212XXXXXXXXX
    # If raw starts with 06/07 etc, make +212 variant
    if len(raw) == 10 and raw.startswith("0"):
        candidates.add("+212" + raw[1:])
        candidates.add("212" + raw[1:])
    # If provided already w/o plus but 212 prefix
    if raw.startswith("212"):
        candidates.add("+" + raw)
        candidates.add("0" + raw[3:])
    # Deduplicate
    return [c for c in candidates if c]


@router.get("/search-customers-all")
async def search_customers_all(phone_number: str):
    """
    Return all Shopify customers matching multiple phone normalizations.
    Each customer includes minimal profile and primary address if available.
    """
    cand = _candidate_phones(phone_number)
    if not cand:
        return []
    results_by_id: dict[str, dict] = {}
    async with httpx.AsyncClient() as client:
        for pn in cand:
            params = {'query': f'phone:{pn}'}
            resp = await client.get(f"{admin_api_base()}/customers/search.json", params=params, timeout=10, **_client_args())
            if resp.status_code == 403:
                raise HTTPException(status_code=403, detail="Shopify token lacks read_customers scope or app not installed.")
            customers = resp.json().get('customers', [])
            for c in customers:
                cid = str(c.get("id"))
                if cid in results_by_id:
                    continue
                # Build compact customer payload
                primary_addr = (c.get("addresses") or [{}])[0] or {}
                results_by_id[cid] = {
                    "customer_id": c.get("id"),
                    "name": f"{c.get('first_name', '')} {c.get('last_name', '')}".strip(),
                    "email": c.get("email") or "",
                    "phone": c.get("phone") or "",
                    "addresses": [
                        {
                            "address1": a.get("address1", ""),
                            "city": a.get("city", ""),
                            "province": a.get("province", ""),
                            "zip": a.get("zip", ""),
                            "phone": a.get("phone", ""),
                            "name": (a.get("name") or f"{c.get('first_name','')} {c.get('last_name','')}").strip(),
                        }
                        for a in (c.get("addresses") or [])
                    ],
                    "primary_address": {
                        "address1": primary_addr.get("address1", ""),
                        "city": primary_addr.get("city", ""),
                        "province": primary_addr.get("province", ""),
                        "zip": primary_addr.get("zip", ""),
                        "phone": primary_addr.get("phone", ""),
                    },
                    "total_orders": c.get("orders_count", 0),
                }
        # Optionally fetch last order for each (best-effort)
        for cid, entry in results_by_id.items():
            order_params = {
                "customer_id": entry["customer_id"],
                "status": "any",
                "limit": 1,
                "order": "created_at desc",
            }
            try:
                orders_resp = await client.get(f"{admin_api_base()}/orders.json", params=order_params, timeout=10, **_client_args())
                orders_list = orders_resp.json().get('orders', [])
                if orders_list:
                    o = orders_list[0]
                    entry["last_order"] = {
                        "order_number": o.get("name"),
                        "total_price": o.get("total_price"),
                        "line_items": [
                            {
                                "title": li.get("title"),
                                "variant_title": li.get("variant_title"),
                                "quantity": li.get("quantity"),
                            }
                            for li in o.get("line_items", [])
                        ],
                    }
            except Exception:
                continue

    return list(results_by_id.values())

@router.get("/shopify-orders")
async def shopify_orders(customer_id: str, limit: int = 50):
    """Return recent orders for a Shopify customer (admin-simplified list)."""
    params = {
        "customer_id": customer_id,
        "status": "any",
        "order": "created_at desc",
        "limit": max(1, min(int(limit), 250)),
    }
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(f"{admin_api_base()}/orders.json", params=params, timeout=15, **_client_args())
            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After")
                detail = {"error": "rate_limited", "message": "Shopify rate limit reached", "retry_after": retry_after}
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=429, content=detail)
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 429:
                retry_after = exc.response.headers.get("Retry-After")
                detail = {"error": "rate_limited", "message": "Shopify rate limit reached", "retry_after": retry_after}
                from fastapi.responses import JSONResponse
                return JSONResponse(status_code=429, content=detail)
            raise

        orders = resp.json().get("orders", [])
        domain = admin_api_base().replace("https://", "").replace("http://", "").split("/admin/api", 1)[0]
        simplified = []
        for o in orders:
            # Shopify REST Admin API returns order.tags as a comma-separated string; expose as an array
            tags_str = o.get("tags") or ""
            tags_arr = [t.strip() for t in str(tags_str).split(",") if t and t.strip()]
            simplified.append({
                "id": o.get("id"),
                "order_number": o.get("name"),
                "created_at": o.get("created_at"),
                "financial_status": o.get("financial_status"),
                "fulfillment_status": o.get("fulfillment_status"),
                "total_price": o.get("total_price"),
                "currency": o.get("currency"),
                "admin_url": f"https://{domain}/admin/orders/{o.get('id')}",
                "tags": tags_arr,
                "note": o.get("note") or "",
            })
        return simplified

@router.post("/shopify-orders/{order_id}/tags")
async def add_order_tag(order_id: str, body: dict = Body(...)):
    """Add a tag to a Shopify order. Requires write_orders scope.

    Body: { "tag": "..." }
    Returns: { ok: true, order_id, tags: [..] }
    """
    tag = (body or {}).get("tag")
    tag = (tag or "").strip()
    if not tag:
        raise HTTPException(status_code=400, detail="Missing tag")

    base = admin_api_base()
    async with httpx.AsyncClient() as client:
        # Fetch current tags first to avoid overwriting
        get_resp = await client.get(f"{base}/orders/{order_id}.json", timeout=15, **_client_args())
        if get_resp.status_code == 404:
            raise HTTPException(status_code=404, detail="Order not found")
        if get_resp.status_code == 403:
            raise HTTPException(status_code=403, detail="Shopify token lacks read_orders scope or app not installed.")
        get_resp.raise_for_status()
        order_obj = (get_resp.json() or {}).get("order") or {}
        current_tags_str = order_obj.get("tags") or ""
        current_tags = [t.strip() for t in str(current_tags_str).split(",") if t and t.strip()]
        if tag not in current_tags:
            current_tags.append(tag)

        update_payload = {"order": {"id": int(str(order_id)), "tags": ", ".join(current_tags)}}
        put_resp = await client.put(f"{base}/orders/{order_id}.json", json=update_payload, timeout=15, **_client_args())
        if put_resp.status_code == 403:
            raise HTTPException(status_code=403, detail="Shopify token lacks write_orders scope or app not installed.")
        put_resp.raise_for_status()
        updated_order = (put_resp.json() or {}).get("order") or {}
        tags_str = updated_order.get("tags") or ", ".join(current_tags)
        tags_arr = [t.strip() for t in str(tags_str).split(",") if t and t.strip()]
        return {"ok": True, "order_id": updated_order.get("id") or order_id, "tags": tags_arr}

@router.delete("/shopify-orders/{order_id}/tags")
async def remove_order_tag(order_id: str, body: dict = Body(...)):
    """Remove a tag from a Shopify order. Requires write_orders scope.

    Body: { "tag": "..." }
    Returns: { ok: true, order_id, tags: [..] }
    """
    tag = (body or {}).get("tag")
    tag = (tag or "").strip()
    if not tag:
        raise HTTPException(status_code=400, detail="Missing tag")

    base = admin_api_base()
    async with httpx.AsyncClient() as client:
        get_resp = await client.get(f"{base}/orders/{order_id}.json", timeout=15, **_client_args())
        if get_resp.status_code == 404:
            raise HTTPException(status_code=404, detail="Order not found")
        if get_resp.status_code == 403:
            raise HTTPException(status_code=403, detail="Shopify token lacks read_orders scope or app not installed.")
        get_resp.raise_for_status()
        order_obj = (get_resp.json() or {}).get("order") or {}
        current_tags_str = order_obj.get("tags") or ""
        current_tags = [t.strip() for t in str(current_tags_str).split(",") if t and t.strip()]
        next_tags = [t for t in current_tags if t.lower() != tag.lower()]

        update_payload = {"order": {"id": int(str(order_id)), "tags": ", ".join(next_tags)}}
        put_resp = await client.put(f"{base}/orders/{order_id}.json", json=update_payload, timeout=15, **_client_args())
        if put_resp.status_code == 403:
            raise HTTPException(status_code=403, detail="Shopify token lacks write_orders scope or app not installed.")
        put_resp.raise_for_status()
        updated_order = (put_resp.json() or {}).get("order") or {}
        tags_str = updated_order.get("tags") or ", ".join(next_tags)
        tags_arr = [t.strip() for t in str(tags_str).split(",") if t and t.strip()]
        return {"ok": True, "order_id": updated_order.get("id") or order_id, "tags": tags_arr}

@router.post("/shopify-orders/{order_id}/note")
async def add_order_note(order_id: str, body: dict = Body(...)):
    """Append a note to a Shopify order. Requires write_orders scope.

    Body: { "note": "..." }
    Appends to existing note with a newline.
    Returns: { ok: true, order_id, note: "..." }
    """
    new_note_fragment = (body or {}).get("note")
    new_note_fragment = (new_note_fragment or "").strip()
    if not new_note_fragment:
        raise HTTPException(status_code=400, detail="Missing note")

    base = admin_api_base()
    async with httpx.AsyncClient() as client:
        # Fetch current order to read existing note
        get_resp = await client.get(f"{base}/orders/{order_id}.json", timeout=15, **_client_args())
        if get_resp.status_code == 404:
            raise HTTPException(status_code=404, detail="Order not found")
        if get_resp.status_code == 403:
            raise HTTPException(status_code=403, detail="Shopify token lacks read_orders scope or app not installed.")
        get_resp.raise_for_status()
        order_obj = (get_resp.json() or {}).get("order") or {}
        current_note = (order_obj.get("note") or "").strip()
        combined_note = new_note_fragment if not current_note else f"{current_note}\n{new_note_fragment}"

        update_payload = {"order": {"id": int(str(order_id)), "note": combined_note}}
        put_resp = await client.put(f"{base}/orders/{order_id}.json", json=update_payload, timeout=15, **_client_args())
        if put_resp.status_code == 403:
            raise HTTPException(status_code=403, detail="Shopify token lacks write_orders scope or app not installed.")
        put_resp.raise_for_status()
        updated_order = (put_resp.json() or {}).get("order") or {}
        final_note = (updated_order.get("note") or combined_note)
        return {"ok": True, "order_id": updated_order.get("id") or order_id, "note": final_note}

@router.delete("/shopify-orders/{order_id}/note")
async def delete_order_note(order_id: str):
    """Clear the note on a Shopify order (set to empty). Requires write_orders scope.

    Returns: { ok: true, order_id, note: "" }
    """
    base = admin_api_base()
    async with httpx.AsyncClient() as client:
        update_payload = {"order": {"id": int(str(order_id)), "note": ""}}
        put_resp = await client.put(f"{base}/orders/{order_id}.json", json=update_payload, timeout=15, **_client_args())
        if put_resp.status_code == 403:
            raise HTTPException(status_code=403, detail="Shopify token lacks write_orders scope or app not installed.")
        if put_resp.status_code == 404:
            raise HTTPException(status_code=404, detail="Order not found")
        put_resp.raise_for_status()
        updated_order = (put_resp.json() or {}).get("order") or {}
        return {"ok": True, "order_id": updated_order.get("id") or order_id, "note": ""}

@router.get("/shopify-shipping-options")
async def get_shipping_options():
    endpoint = f"{admin_api_base()}/shipping_zones.json"
    async with httpx.AsyncClient() as client:
        resp = await client.get(endpoint, **_client_args())
        resp.raise_for_status()
        data = resp.json()
        shipping_methods = []
        for zone in data.get("shipping_zones", []):
            # Price-based rates
            for rate in zone.get("price_based_shipping_rates", []):
                shipping_methods.append({
                    "id": rate.get("id"),
                    "name": rate.get("name"),
                    "price": float(rate.get("price", 0)),
                    "zone": zone.get("name"),
                    "type": "price_based"
                })
            # Weight-based rates
            for rate in zone.get("weight_based_shipping_rates", []):
                shipping_methods.append({
                    "id": rate.get("id"),
                    "name": rate.get("name"),
                    "price": float(rate.get("price", 0)),
                    "zone": zone.get("name"),
                    "type": "weight_based"
                })
            # Carrier shipping rates (for completeness)
            for rate in zone.get("carrier_shipping_rate_providers", []):
                shipping_methods.append({
                    "id": rate.get("id"),
                    "name": rate.get("name"),
                    "zone": zone.get("name"),
                    "type": "carrier"
                })
        print("EXTRACTED RATES:", shipping_methods)  # <--- Will now not be empty!
        return shipping_methods

@router.post("/create-shopify-order")
async def create_shopify_order(data: dict = Body(...)):
    base = admin_api_base()
    warnings: list[str] = []
    shipping_title = data.get("delivery", "Home Delivery")
    shipping_lines = [{
        "title": shipping_title,
        "price": 0.00,
        "code": "STANDARD"
    }]
    # Optional order note and image URL (stored as note and note_attributes)
    order_note = (data.get("order_note") or data.get("note") or "").strip()
    order_image_url = (data.get("order_image_url") or data.get("image_url") or "").strip()
    note_attributes: list[dict] = []
    if order_image_url:
        note_attributes.append({"name": "image_url", "value": order_image_url})
    if order_note:
        note_attributes.append({"name": "note_text", "value": order_note})
    # Attach customer to draft order. Shopify expects `customer` object (with id),
    # not `customer_id` at the root of draft_order. Optionally create the customer first.
    order_block = {}
    customer_id = data.get("customer_id")
    # If no explicit id provided, try to resolve by phone best-effort
    if not customer_id:
        try:
            resolved = await fetch_customer_by_phone(data.get("phone", ""))
            if isinstance(resolved, dict) and resolved.get("customer_id"):
                customer_id = resolved["customer_id"]
        except Exception:
            customer_id = None

    # If still not found, try to resolve by email (Shopify supports email search)
    if not customer_id and (data.get("email") or "").strip():
        try:
            email_q = (data.get("email") or "").strip()
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{base}/customers/search.json", params={"query": f"email:{email_q}"}, timeout=10, **_client_args())
                if resp.status_code == 200:
                    items = (resp.json() or {}).get("customers") or []
                    if items:
                        customer_id = items[0].get("id")
        except Exception:
            pass

    # Optionally create a new Shopify customer if missing
    create_if_missing = bool(data.get("create_customer_if_missing", True))
    if not customer_id and create_if_missing:
        try:
            fn, ln = _split_name(data.get("name", ""))
            customer_payload = {
                "customer": {
                    "first_name": fn or "",
                    "last_name": ln or "",
                    "email": data.get("email") or "",
                    "phone": normalize_phone(data.get("phone", "")),
                    "addresses": [
                        {
                            "first_name": fn or "",
                            "last_name": ln or "",
                            "address1": data.get("address", ""),
                            "city": data.get("city", ""),
                            "province": data.get("province", ""),
                            "zip": data.get("zip", ""),
                            "country": "Morocco",
                            "country_code": "MA",
                            "phone": normalize_phone(data.get("phone", "")),
                            "name": data.get("name", ""),
                        }
                    ],
                }
            }
            CUSTOMERS_ENDPOINT = f"{base}/customers.json"
            async with httpx.AsyncClient() as client:
                c_resp = await client.post(CUSTOMERS_ENDPOINT, json=customer_payload, **_client_args())
                if c_resp.status_code in (201, 200):
                    c_json = c_resp.json() or {}
                    created = (c_json.get("customer") or {})
                    if created.get("id"):
                        customer_id = created["id"]
                elif c_resp.status_code == 403:
                    warnings.append("Shopify token lacks write_customers scope; could not create/link customer.")
                elif c_resp.status_code >= 400:
                    try:
                        err_txt = (c_resp.text or "").strip()
                    except Exception:
                        err_txt = ""
                    if err_txt:
                        warnings.append(f"Customer creation failed: {err_txt[:200]}")
        except Exception as e:
            logger.warning("Failed to auto-create customer: %s", e)

    if customer_id:
        order_block["customer"] = {"id": customer_id}
    else:
        fn, ln = _split_name(data.get("name", ""))
        order_block["customer"] = {
            "first_name": fn,
            "last_name": ln,
            "email": data.get("email", ""),
            "phone": normalize_phone(data.get("phone", ""))
        }

    fn_sa, ln_sa = _split_name(data.get("name", ""))
    shipping_address = {
        "first_name": fn_sa or "",
        "last_name": ln_sa or "",
        "address1": data.get("address", ""),
        "city": data.get("city", ""),
        "province": data.get("province", ""),
        "zip": data.get("zip", ""),
        "country": "Morocco",
        "country_code": "MA",
        "name": data.get("name", ""),
        "phone": normalize_phone(data.get("phone", "")),
    }

    # If we couldn't attach a customer, also persist customer fields in draft note for visibility
    if not customer_id:
        if data.get("name"):
            note_attributes.append({"name": "customer_name", "value": str(data.get("name"))})
        if data.get("phone"):
            note_attributes.append({"name": "customer_phone", "value": normalize_phone(data.get("phone", ""))})
        if data.get("email"):
            note_attributes.append({"name": "customer_email", "value": str(data.get("email"))})
    # Helper to ensure 2-decimal string for amounts
    def _money2(value: float | int | str) -> str:
        try:
            return f"{float(value):.2f}"
        except Exception:
            return "0.00"

    draft_order_payload = {
        "draft_order": {
            "line_items": [
                {
                    "variant_id": item["variant_id"],
                    "quantity": int(item["quantity"]),
                    **(
                        {
                            "applied_discount": {
                                # Shopify accepts amount (fixed) or percentage. Use fixed amount rounded to 2dp.
                                "value": _money2(item.get("discount", 0)),
                                "value_type": "fixed_amount",
                                "amount": _money2(item.get("discount", 0)),
                                "title": "Item discount",
                            }
                        } if float(item.get("discount", 0)) > 0 else {}
                    )
                }
                for item in data.get("items", [])
            ],
            "shipping_address": shipping_address,
            "billing_address": shipping_address,
            "shipping_lines": shipping_lines,
            "email": data.get("email", ""),
            "phone": normalize_phone(data.get("phone", "")),
            **({"note": order_note} if order_note else {}),
            **({"note_attributes": note_attributes} if note_attributes else {}),
            **order_block
        }
    }
    DRAFT_ORDERS_ENDPOINT = f"{base}/draft_orders.json"
    async with httpx.AsyncClient() as client:
        resp = await client.post(DRAFT_ORDERS_ENDPOINT, json=draft_order_payload, **_client_args())
        resp.raise_for_status()
        draft_data = resp.json()
        draft_id = draft_data["draft_order"]["id"]

        # Draft admin URL
        domain = base.replace("https://", "").replace("http://", "").split("/admin/api", 1)[0]
        draft_admin_url = f"https://{domain}/admin/draft_orders/{draft_id}"

        # If not asked to complete now, return draft info
        if not bool(data.get("complete_now")):
            return {
                "ok": True,
                "draft_order_id": draft_id,
                "shopify_admin_link": draft_admin_url,
                "completed": False,
                "message": (
                    "Draft order created. Open the link in Shopify admin, and click 'Create order' with 'Payment due later' when customer pays."
                ),
                **({"warnings": warnings} if warnings else {})
            }

        # Complete the draft order (payment pending)
        COMPLETE_ENDPOINT = f"{base}/draft_orders/{draft_id}/complete.json"
        comp_resp = await client.post(COMPLETE_ENDPOINT, params={"payment_pending": "true"}, **_client_args())
        comp_resp.raise_for_status()
        comp_json = comp_resp.json() or {}
        order_id = (
            (comp_json.get("draft_order") or {}).get("order_id")
            or (comp_json.get("order") or {}).get("id")
        )

        order_admin_link = None
        if order_id:
            order_admin_link = f"https://{domain}/admin/orders/{order_id}"

            # Write metafields if provided
            metafields_endpoint = f"{base}/orders/{order_id}/metafields.json"
            metafields_payloads = []
            if order_image_url:
                metafields_payloads.append({
                    "metafield": {
                        "namespace": "custom",
                        "key": "image_url",
                        "type": "url",
                        "value": order_image_url,
                    }
                })
            if order_note:
                metafields_payloads.append({
                    "metafield": {
                        "namespace": "custom",
                        "key": "note_text",
                        "type": "single_line_text_field",
                        "value": order_note,
                    }
                })
            for payload in metafields_payloads:
                try:
                    mf_resp = await client.post(metafields_endpoint, json=payload, **_client_args())
                    # Do not raise if forbidden; continue best-effort
                    if mf_resp.status_code >= 400:
                        logger.warning("Metafield write failed: %s", mf_resp.text)
                except Exception as e:
                    logger.warning("Metafield write exception: %s", e)

        return {
            "ok": True,
            "completed": True,
            "draft_order_id": draft_id,
            **({"order_id": order_id} if order_id else {}),
            "shopify_admin_link": draft_admin_url,
            **({"order_admin_link": order_admin_link} if order_admin_link else {}),
            "message": "Draft order completed with payment pending." if order_id else "Draft order created, but completion response did not include order id.",
            **({"warnings": warnings} if warnings else {})
        }
