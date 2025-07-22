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

def get_product_info_by_link(url):
    # TODO: Lookup in your products db by link, return dict
    # Example mock:
    return {
        "name": "Slippers Batman",
        "available_sizes": [31, 32, 33, 34],
        "price": "115 MAD",
        "colors": ["black", "yellow"]
    }

def get_customer_profile_by_whatsapp_id(user_id):
    # TODO: Lookup in your customers table by WhatsApp id
    # Example mock:
    if user_id == "212612345678":
        return {
            "name": "Fatima",
            "age": 7,
            "gender": "girl",
            "shoe_size": 32
        }
    return None

def get_last_order_for_customer(user_id):
    # TODO: Lookup in your orders table by customer ID
    # Example mock:
    if user_id == "212612345678":
        return {
            "status": "Out for delivery",
            "items": ["Batman slippers - 32", "PAW Patrol socks - 7-8Y"],
            "order_date": "2024-06-14"
        }
    return None

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
    # Implement per your Shopify setup (can use API: /admin/api/2023-04/customers/search.json?query=)
    # Return customer info dict or None
    pass

def get_order_status_for_customer(phone):
    # Implement per your Shopify setup (orders API)
    pass