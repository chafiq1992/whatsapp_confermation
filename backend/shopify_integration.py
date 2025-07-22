import httpx
import logging
import os
from fastapi import APIRouter, Body, Query

# ================= CONFIG ==================

def _load_store_config() -> tuple[str, str, str]:
    """Return the first set of Shopify credentials found in the environment."""
    prefixes = [
        "SHOPIFY",
        "IRRAKIDS",
        "IRRANOVA",
    ]

    for prefix in prefixes:
        api_key = os.getenv(f"{prefix}_API_KEY")
        password = os.getenv(f"{prefix}_PASSWORD")
        store_url = os.getenv(f"{prefix}_STORE_URL")
        if all([api_key, password, store_url]):
            return api_key, password, store_url

    raise RuntimeError("\u274c\u00a0Missing Shopify environment variables")


API_KEY, PASSWORD, STORE_URL = _load_store_config()
API_VERSION = "2023-04"

SEARCH_ENDPOINT = f"{STORE_URL}/admin/api/{API_VERSION}/customers/search.json"
ORDERS_ENDPOINT = f"{STORE_URL}/admin/api/{API_VERSION}/orders.json"
ORDER_COUNT_ENDPOINT = f"{STORE_URL}/admin/api/{API_VERSION}/orders/count.json"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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

# =============== FASTAPI ROUTER ===============
router = APIRouter()

# --- List products, with optional search query ---
@router.get("/shopify-products")
async def shopify_products(q: str = Query("", description="Search product titles (optional)")):
    params = {"title": q} if q else {}
    endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/products.json"
    async with httpx.AsyncClient() as client:
        resp = await client.get(endpoint, auth=(API_KEY, PASSWORD), params=params)
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
        resp = await client.get(endpoint, auth=(API_KEY, PASSWORD))
        resp.raise_for_status()
        variant = resp.json().get("variant")
        # Try to fetch product title for display
        if variant:
            product_id = variant.get("product_id")
            prod_endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/products/{product_id}.json"
            p_resp = await client.get(prod_endpoint, auth=(API_KEY, PASSWORD))
            if p_resp.status_code == 200:
                prod = p_resp.json().get("product")
                variant["product_title"] = prod.get("title", "")
        return variant

# =============== CUSTOMER BY PHONE ===============
async def fetch_customer_by_phone(phone_number: str):
    try:
        phone_number = normalize_phone(phone_number)
        params = {'query': f'phone:{phone_number}'}
        async with httpx.AsyncClient() as client:
            # Search customer
            resp = await client.get(
                SEARCH_ENDPOINT,
                auth=(API_KEY, PASSWORD),
                params=params,
                timeout=10
            )
            data = resp.json()
            customers = data.get('customers', [])

            # Morocco fallback
            if not customers and phone_number.startswith("+212"):
                alt_phone = "0" + phone_number[4:]
                params = {'query': f'phone:{alt_phone}'}
                resp = await client.get(
                    SEARCH_ENDPOINT,
                    auth=(API_KEY, PASSWORD),
                    params=params,
                    timeout=10
                )
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
            orders_resp = await client.get(
                ORDERS_ENDPOINT,
                auth=(API_KEY, PASSWORD),
                params=order_params,
                timeout=10
            )
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
    except Exception as e:
        logger.exception(f"Exception occurred: {e}")
        return {"error": str(e)}

# =========== FASTAPI ENDPOINT: SEARCH CUSTOMER ============
@router.get("/search-customer")
async def search_customer(phone_number: str):
    """
    Fetch customer and order info by phone.
    """
    data = await fetch_customer_by_phone(phone_number)
    if data:
        return data
    else:
        return {"message": "Customer not found"}, 404

@router.get("/shopify-shipping-options")
async def get_shipping_options():
    endpoint = f"{STORE_URL}/admin/api/{API_VERSION}/shipping_zones.json"
    async with httpx.AsyncClient() as client:
        resp = await client.get(endpoint, auth=(API_KEY, PASSWORD))
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
    order_block = {}
    if data.get("customer_id"):
        order_block["customer_id"] = data["customer_id"]
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
            **order_block
        }
    }
    DRAFT_ORDERS_ENDPOINT = f"{STORE_URL}/admin/api/{API_VERSION}/draft_orders.json"
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            DRAFT_ORDERS_ENDPOINT,
            json=draft_order_payload,
            auth=(API_KEY, PASSWORD)
        )
        resp.raise_for_status()
        draft_data = resp.json()
        draft_id = draft_data["draft_order"]["id"]

        # Return admin link for easy manual completion
        admin_url = f"https://{STORE_URL.replace('https://', '')}/admin/draft_orders/{draft_id}"
        return {
            "ok": True,
            "draft_order_id": draft_id,
            "shopify_admin_link": admin_url,
            "message": (
                "Draft order created. Open the link in Shopify admin, and click 'Create order' with 'Payment due later' when customer pays."
            )
        }