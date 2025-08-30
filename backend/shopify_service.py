# shopify_service.py
import os
import requests

SHOPIFY_API_KEY = os.getenv("SHOPIFY_API_KEY")
SHOPIFY_API_PW  = os.getenv("SHOPIFY_PASSWORD")     # ← same as integration file
SHOPIFY_STORE   = os.getenv("SHOPIFY_STORE_DOMAIN") # e.g. nouralibas.myshopify.com

if not all([SHOPIFY_API_KEY, SHOPIFY_API_PW, SHOPIFY_STORE]):
    raise RuntimeError("Please set SHOPIFY_API_KEY, SHOPIFY_API_PW, and SHOPIFY_STORE environment variables.")

# Example REST API lookup for a product by handle/tag/keyword:
def shopify_search_products(query):
    """
    Search Shopify products by title.
    """
    url = f"https://{SHOPIFY_API_KEY}:{SHOPIFY_API_PW}@{SHOPIFY_STORE}/admin/api/2023-04/products.json?title={query}"
    response = requests.get(url)
    response.raise_for_status()
    data = response.json()
    products = []
    for p in data.get("products", []):
        products.append({
            "title": p["title"],
            "variants": [
                {"title": v["title"], "price": v["price"], "qty": v["inventory_quantity"]}
                for v in p["variants"]
            ],
            "image": p.get("image", {}).get("src", "N/A"),
            "url": f"https://{SHOPIFY_STORE}/products/{p['handle']}",
        })
    return products

def _normalize_phone(phone: str) -> str:
    """Normalize a phone/WhatsApp identifier to Shopify format."""
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


def get_product_info_by_link(url):
    """Fetch product details from Shopify using a product URL."""
    handle = url.rstrip("/").split("/")[-1]
    api_url = (
        f"https://{SHOPIFY_API_KEY}:{SHOPIFY_API_PW}@{SHOPIFY_STORE}/admin/api/2023-04/products.json"
    )
    resp = requests.get(api_url, params={"handle": handle})
    resp.raise_for_status()
    products = resp.json().get("products", [])
    if not products:
        return None

    p = products[0]
    sizes = [v.get("title") for v in p.get("variants", [])]
    colors = []
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

def get_customer_profile_by_whatsapp_id(user_id):
    """Return basic Shopify customer info for the given WhatsApp user ID."""
    phone = _normalize_phone(user_id)
    endpoint = (
        f"https://{SHOPIFY_API_KEY}:{SHOPIFY_API_PW}@{SHOPIFY_STORE}/admin/api/2023-04/customers/search.json"
    )
    resp = requests.get(endpoint, params={"query": f"phone:{phone}"})
    resp.raise_for_status()
    customers = resp.json().get("customers", [])

    # Try alternate Moroccan format if not found
    if not customers and phone.startswith("+212"):
        alt_phone = "0" + phone[4:]
        resp = requests.get(endpoint, params={"query": f"phone:{alt_phone}"})
        resp.raise_for_status()
        customers = resp.json().get("customers", [])

    if not customers:
        return None

    c = customers[0]
    return {
        "customer_id": c.get("id"),
        "name": f"{c.get('first_name', '')} {c.get('last_name', '')}".strip(),
        "email": c.get("email"),
        "phone": c.get("phone"),
        "total_orders": c.get("orders_count", 0),
    }

def get_last_order_for_customer(user_id):
    """Fetch the most recent order for a customer identified by WhatsApp ID."""
    profile = get_customer_profile_by_whatsapp_id(user_id)
    if not profile:
        return None

    customer_id = profile["customer_id"]
    endpoint = (
        f"https://{SHOPIFY_API_KEY}:{SHOPIFY_API_PW}@{SHOPIFY_STORE}/admin/api/2023-04/orders.json"
    )
    params = {
        "customer_id": customer_id,
        "status": "any",
        "limit": 1,
        "order": "created_at desc",
    }
    resp = requests.get(endpoint, params=params)
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

def search_products(query):
    """
    Search Shopify products by title.
    """
    url = f"https://{SHOPIFY_API_KEY}:{SHOPIFY_API_PW}@{SHOPIFY_STORE}/admin/api/2023-04/products.json?title={query}"
    r = requests.get(url)
    data = r.json()
    products = []
    for p in data.get("products", []):
        products.append({
            "title": p["title"],
            "variants": [
                {"title": v["title"], "price": v["price"], "qty": v["inventory_quantity"]} for v in p["variants"]
            ],
            "image": p["image"]["src"] if p.get("image") else "N/A",
            "url": f"https://{SHOPIFY_STORE}/products/{p['handle']}",
        })
    return products

def get_customer_by_phone(phone):
    """Return customer info by phone number or ``None`` if not found."""
    phone = _normalize_phone(phone)
    endpoint = (
        f"https://{SHOPIFY_API_KEY}:{SHOPIFY_API_PW}@{SHOPIFY_STORE}/admin/api/2023-04/customers/search.json"
    )

    resp = requests.get(endpoint, params={"query": f"phone:{phone}"})
    resp.raise_for_status()
    customers = resp.json().get("customers", [])

    if not customers and phone.startswith("+212"):
        alt_phone = "0" + phone[4:]
        resp = requests.get(endpoint, params={"query": f"phone:{alt_phone}"})
        resp.raise_for_status()
        customers = resp.json().get("customers", [])

    if not customers:
        return None

    c = customers[0]
    return {
        "customer_id": c.get("id"),
        "name": f"{c.get('first_name', '')} {c.get('last_name', '')}".strip(),
        "email": c.get("email"),
        "phone": c.get("phone"),
        "total_orders": c.get("orders_count", 0),
    }

def get_order_status_for_customer(phone):
    """Return the most recent order status for a customer phone number."""
    profile = get_customer_by_phone(phone)
    if not profile:
        return None

    customer_id = profile["customer_id"]
    endpoint = (
        f"https://{SHOPIFY_API_KEY}:{SHOPIFY_API_PW}@{SHOPIFY_STORE}/admin/api/2023-04/orders.json"
    )
    params = {
        "customer_id": customer_id,
        "status": "any",
        "limit": 1,
        "order": "created_at desc",
    }

    resp = requests.get(endpoint, params=params)
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