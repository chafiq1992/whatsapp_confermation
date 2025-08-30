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


API_KEY, PASSWORD, STORE_URL, ACCESS_TOKEN = _load_store_config()
API_VERSION = "2023-04"

SEARCH_ENDPOINT = f"{STORE_URL}/admin/api/{API_VERSION}/customers/search.json"
ORDERS_ENDPOINT = f"{STORE_URL}/admin/api/{API_VERSION}/orders.json"
ORDER_COUNT_ENDPOINT = f"{STORE_URL}/admin/api/{API_VERSION}/orders/count.json"
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


async def search_products(query: str) -> list[dict]:
    """Search Shopify products by title."""
    endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/products.json"
    params = {"title": query}
    async with httpx.AsyncClient() as client:
        resp = await client.get(endpoint, params=params, **_client_args())
        resp.raise_for_status()
        data = resp.json()
    products: list[dict] = []
    domain = STORE_URL.replace("https://", "").replace("http://", "")
    for p in data.get("products", []):
        products.append(
            {
                "title": p["title"],
                "variants": [
                    {
                        "title": v["title"],
                        "price": v["price"],
                        "qty": v["inventory_quantity"],
                    }
                    for v in p.get("variants", [])
                ],
                "image": (p.get("image") or {}).get("src", "N/A"),
                "url": f"https://{domain}/products/{p['handle']}",
            }
        )
    return products


async def shopify_search_products(query: str) -> list[dict]:
    """Alias for :func:`search_products` for backward compatibility."""
    return await search_products(query)


async def get_product_info_by_link(url: str):
    """Fetch product details from Shopify using a product URL."""
    handle = url.rstrip("/").split("/")[-1]
    endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/products.json"
    async with httpx.AsyncClient() as client:
        resp = await client.get(endpoint, params={"handle": handle}, **_client_args())
        resp.raise_for_status()
        products = resp.json().get("products", [])
    if not products:
        return None
    p = products[0]
    sizes = [v.get("title") for v in p.get("variants", [])]
    colors: list[str] = []
    for opt in p.get("options", []):
        if opt.get("name", "").lower() == "color":
            colors = opt.get("values", [])
            break
    return {
        "name": p.get("title"),
        "available_sizes": sizes,
        "price": p.get("variants", [{}])[0].get("price"),
        "colors": colors,
    }


async def get_customer_by_phone(phone: str):
    """Return customer info by phone number or ``None`` if not found."""
    data = await fetch_customer_by_phone(phone)
    if not data or isinstance(data, dict) and data.get("error"):
        return None
    return {
        "customer_id": data.get("customer_id"),
        "name": data.get("name"),
        "email": data.get("email"),
        "phone": data.get("phone"),
        "total_orders": data.get("total_orders", 0),
    }


async def get_customer_profile_by_whatsapp_id(user_id: str):
    """Compatibility wrapper using WhatsApp user ID (phone)."""
    return await get_customer_by_phone(user_id)


async def get_last_order_for_customer(user_id: str):
    """Fetch the most recent order for a customer identified by WhatsApp ID."""
    profile = await get_customer_profile_by_whatsapp_id(user_id)
    if not profile:
        return None
    params = {
        "customer_id": profile["customer_id"],
        "status": "any",
        "limit": 1,
        "order": "created_at desc",
    }
    async with httpx.AsyncClient() as client:
        resp = await client.get(ORDERS_ENDPOINT, params=params, **_client_args())
        resp.raise_for_status()
        orders = resp.json().get("orders", [])
    if not orders:
        return None
    o = orders[0]
    return {
        "status": o.get("fulfillment_status") or o.get("financial_status"),
        "items": [
            f"{item.get('title')} - {item.get('variant_title', '')}".strip()
            for item in o.get("line_items", [])
        ],
        "order_date": o.get("created_at"),
    }


async def get_order_status_for_customer(phone: str):
    """Return the most recent order status for a customer phone number."""
    return await get_last_order_for_customer(phone)

# =============== FASTAPI ROUTER ===============
router = APIRouter()

# --- List products, with optional search query ---
@router.get("/shopify-products")
async def shopify_products(q: str = Query("", description="Search product titles (optional)")):
    params = {"title": q} if q else {}
    endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/products.json"
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
    endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/variants/{variant_id}.json"
    async with httpx.AsyncClient() as client:
        resp = await client.get(endpoint, **_client_args())
        resp.raise_for_status()
        variant = resp.json().get("variant")
        # Try to fetch product title and resolve variant image for display
        if variant:
            product_id = variant.get("product_id")
            prod_endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/products/{product_id}.json"
            p_resp = await client.get(prod_endpoint, **_client_args())
            if p_resp.status_code == 200:
                prod = p_resp.json().get("product") or {}
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
        return variant

# =============== CUSTOMER BY PHONE ===============
async def fetch_customer_by_phone(phone_number: str):
    try:
        phone_number = normalize_phone(phone_number)
        params = {'query': f'phone:{phone_number}'}
        async with httpx.AsyncClient() as client:
            # Search customer
            resp = await client.get(SEARCH_ENDPOINT, params=params, timeout=10, **_client_args())
            if resp.status_code == 403:
                logger.error("Shopify API 403 on customers/search. Missing read_customers scope for token or app not installed.")
                return {"error": "Forbidden", "detail": "Shopify token lacks read_customers scope or app not installed.", "status": 403}
            data = resp.json()
            customers = data.get('customers', [])

            # Morocco fallback
            if not customers and phone_number.startswith("+212"):
                alt_phone = "0" + phone_number[4:]
                params = {'query': f'phone:{alt_phone}'}
                resp = await client.get(SEARCH_ENDPOINT, params=params, timeout=10, **_client_args())
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
            orders_resp = await client.get(ORDERS_ENDPOINT, params=order_params, timeout=10, **_client_args())
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
            resp = await client.get(SEARCH_ENDPOINT, params=params, timeout=10, **_client_args())
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
                orders_resp = await client.get(ORDERS_ENDPOINT, params=order_params, timeout=10, **_client_args())
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
        resp = await client.get(ORDERS_ENDPOINT, params=params, timeout=15, **_client_args())
        resp.raise_for_status()
        orders = resp.json().get("orders", [])
        domain = STORE_URL.replace("https://", "").replace("http://", "")
        simplified = []
        for o in orders:
            simplified.append({
                "id": o.get("id"),
                "order_number": o.get("name"),
                "created_at": o.get("created_at"),
                "financial_status": o.get("financial_status"),
                "fulfillment_status": o.get("fulfillment_status"),
                "total_price": o.get("total_price"),
                "currency": o.get("currency"),
                "admin_url": f"https://{domain}/admin/orders/{o.get('id')}",
            })
        return simplified

@router.get("/shopify-shipping-options")
async def get_shipping_options():
    endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/shipping_zones.json"
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
    # not `customer_id` at the root of draft_order.
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

    if customer_id:
        order_block["customer"] = {"id": customer_id}
    else:
        order_block["customer"] = {
            "first_name": data.get("name", ""),
            "email": data.get("email", ""),
            "phone": normalize_phone(data.get("phone", ""))
        }
    shipping_address = {
        "address1": data.get("address", ""),
        "city": data.get("city", ""),
        "province": data.get("province", ""),
        "zip": data.get("zip", ""),
        "country": "Morocco",
        "country_code": "MA",
        "name": data.get("name", ""),
        "phone": normalize_phone(data.get("phone", "")),
    }
    draft_order_payload = {
        "draft_order": {
            "line_items": [
                {
                    "variant_id": item["variant_id"],
                    "quantity": int(item["quantity"]),
                    **(
                        {
                            "applied_discount": {
                                "amount": str(item.get("discount", 0)),
                                "value_type": "fixed_amount",
                                "title": "Item discount"
                            }
                        } if float(item.get("discount", 0)) > 0 else {}
                    )
                }
                for item in data.get("items", [])
            ],
            "shipping_address": shipping_address,
            "shipping_lines": shipping_lines,
            "email": data.get("email", ""),
            "phone": normalize_phone(data.get("phone", "")),
            **({"note": order_note} if order_note else {}),
            **({"note_attributes": note_attributes} if note_attributes else {}),
            **order_block
        }
    }
    DRAFT_ORDERS_ENDPOINT = f"{STORE_URL}/admin/api/{API_VERSION}/draft_orders.json"
    async with httpx.AsyncClient() as client:
        resp = await client.post(DRAFT_ORDERS_ENDPOINT, json=draft_order_payload, **_client_args())
        resp.raise_for_status()
        draft_data = resp.json()
        draft_id = draft_data["draft_order"]["id"]

        # Draft admin URL
        domain = STORE_URL.replace("https://", "").replace("http://", "")
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
                )
            }

        # Complete the draft order (payment pending)
        COMPLETE_ENDPOINT = f"{STORE_URL}/admin/api/{API_VERSION}/draft_orders/{draft_id}/complete.json"
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
            metafields_endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/orders/{order_id}/metafields.json"
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
        }
