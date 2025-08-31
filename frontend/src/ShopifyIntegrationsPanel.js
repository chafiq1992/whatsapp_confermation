import React, { useState, useEffect, useMemo } from "react";
import { FaShopify } from "react-icons/fa";
import api from "./api";
import { saveCart, loadCart } from "./chatStorage";
import html2canvas from "html2canvas";

export default function ShopifyIntegrationsPanel({ activeUser }) {
  const API_BASE = process.env.REACT_APP_API_BASE || "";

  const [customer, setCustomer] = useState(null);
  const [customersList, setCustomersList] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [selectedAddressIdx, setSelectedAddressIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState([]);

  const normalizePhone = (phone) => {
    if (!phone) return "";
    if (phone.startsWith("+")) return phone;
    if (phone.length === 12 && phone.startsWith("212")) return "+" + phone;
    if (phone.length === 10 && phone.startsWith("06")) return "+212" + phone.slice(1);
    return phone;
  }; 

  // Collapsible sections
  const [showInfo, setShowInfo] = useState(true);
  const [showCreate, setShowCreate] = useState(true);

  // Order details state
  const [orderData, setOrderData] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    province: "",
    zip: "",
    order_note: "",
    order_image_url: "",
    complete_now: false,
  });

  // Automation Studio navigates to separate page

  // Product search & selection
  const [productSearch, setProductSearch] = useState("");
  const [products, setProducts] = useState([]);
  const [variantIdInput, setVariantIdInput] = useState("");
  const [selectedItems, setSelectedItems] = useState([]);
  const [shippingOptions, setShippingOptions] = useState([]);
  const [deliveryOption, setDeliveryOption] = useState("");
  const [paymentTerm, setPaymentTerm] = useState("due_on_receipt");
  const [market] = useState("Moroccan market");
  const [isCreating, setIsCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [lastResult, setLastResult] = useState(null);

  // Customer search and creation options
  const [customerSearchInput, setCustomerSearchInput] = useState("");
  const [customerSearchResults, setCustomerSearchResults] = useState([]);
  const [isSearchingCustomers, setIsSearchingCustomers] = useState(false);
  const [createCustomerIfMissing, setCreateCustomerIfMissing] = useState(true);

  const MOROCCO_PROVINCES = [
    'Marrakech-Safi','Casablanca-Settat','Rabat-Salé-Kénitra','Fès-Meknès','Tanger-Tétouan-Al Hoceïma',
    'Drâa-Tafilalet','Souss-Massa','Beni Mellal-Khénifra','Oriental','Guelmim-Oued Noun',
    'Laâyoune-Sakia El Hamra',"Dakhla-Oued Ed-Dahab"
  ];

  // Fetch shipping methods on mount
  useEffect(() => {
    api.get(`${API_BASE}/shopify-shipping-options`)
      .then(res => {
        setShippingOptions(res.data);
        if (res.data.length) setDeliveryOption(res.data[0].name);
      }).catch(() => setShippingOptions([]));
  }, [API_BASE]);

  // Fetch customer info
  useEffect(() => {
    if (!activeUser?.phone) {
      setCustomer(null);
      setCustomersList([]);
      setSelectedCustomerId(null);
      setSelectedAddressIdx(0);
      setOrderData({
        name: "",
        email: "",
        phone: activeUser?.phone || "",
        address: "",
        city: "",
        province: "",
        zip: "",
        order_note: "",
        order_image_url: "",
        complete_now: false,
      });
      return;
    }
    setLoading(true);
    setErrorMsg("");
    Promise.all([
      api.get(`${API_BASE}/search-customer?phone_number=${encodeURIComponent(activeUser.phone)}`)
        .catch(() => null),
      api.get(`${API_BASE}/search-customers-all?phone_number=${encodeURIComponent(activeUser.phone)}`)
        .catch(() => ({ data: [] })),
    ]).then(([single, multi]) => {
      const list = Array.isArray(multi?.data) ? multi.data : [];
      setCustomersList(list);
      if (list.length > 0) {
        const first = list[0];
        setSelectedCustomerId(first.customer_id);
        setSelectedAddressIdx(0);
        setCustomer(first);
        const addr = (first.primary_address || first.addresses?.[0] || {});
        setOrderData({
          name: first.name || "",
          email: first.email || "",
          phone: first.phone || activeUser.phone,
          address: addr.address1 || "",
          city: addr.city || "",
          province: addr.province || "",
          zip: addr.zip || "",
          order_note: "",
          order_image_url: "",
          complete_now: false,
        });
        // Fetch orders list
        api.get(`${API_BASE}/shopify-orders`, { params: { customer_id: first.customer_id, limit: 50 } })
          .then(res => setOrders(Array.isArray(res.data) ? res.data : []))
          .catch(() => setOrders([]));
      } else if (single?.data) {
        const c = single.data;
        setCustomer(c);
        setOrderData({
          name: c.name || "",
          email: c.email || "",
          phone: c.phone || activeUser.phone,
          address: c.address || "",
          city: c.city || "",
          province: c.province || "",
          zip: c.zip || "",
          order_note: "",
          order_image_url: "",
          complete_now: false,
        });
        if (c.customer_id) {
          api.get(`${API_BASE}/shopify-orders`, { params: { customer_id: c.customer_id, limit: 50 } })
            .then(res => setOrders(Array.isArray(res.data) ? res.data : []))
            .catch(() => setOrders([]));
        } else {
          setOrders([]);
        }
      } else {
        setCustomer(null);
        setOrderData(prev => ({ ...prev, phone: activeUser.phone || "" }));
        setOrders([]);
      }
    }).catch((err) => {
      const detail = err?.response?.data?.detail || err?.message || "";
      if (err?.response?.status === 403) {
        setErrorMsg("Shopify permissions error: token lacks read_customers scope or app not installed.");
      } else if (detail) {
        setErrorMsg(String(detail));
      }
    }).finally(() => setLoading(false));
  }, [activeUser, API_BASE]);

  // Product search with debounce
  useEffect(() => {
    if (!productSearch) {
      setProducts([]);
      return;
    }
    const timeoutId = setTimeout(async () => {
      try {
        const res = await api.get(`${API_BASE}/shopify-products?q=${encodeURIComponent(productSearch)}`);
        setProducts(res.data || []);
      } catch {
        setProducts([]);
      }
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [productSearch, API_BASE]);

  // Add product by variant id
  const addByVariantId = async (variantId, quantity = 1) => {
    if (!variantId) return;
    try {
      const res = await api.get(`${API_BASE}/shopify-variant/${variantId}`);
      if (res.data) {
        setSelectedItems(items => [
          ...items,
          { variant: res.data, quantity: Number(quantity) || 1, discount: 0 },
        ]);
      }
    } catch {
      setErrorMsg("Variant not found.");
    }
  };

  // ---- Build and send order label (PNG) from template ----
  const computeTotalPrice = useMemo(() => {
    return (items) => {
      try {
        const sum = (items || []).reduce((acc, it) => {
          const price = Number(it?.variant?.price || 0);
          const qty = Number(it?.quantity || 1);
          const discount = Number(it?.discount || 0);
          return acc + (price * qty) - discount;
        }, 0);
        return Math.max(0, Number(sum.toFixed(2)));
      } catch {
        return 0;
      }
    };
  }, []);

  const buildOrderLabelHtml = ({
    shopName,
    orderName,
    createdAt,
    totalPrice,
    isCOD,
    customerFirst,
    customerLast,
    city,
    phone,
    itemsCount,
    fulfillmentStatus,
  }) => {
    const codBadge = isCOD ? '<span class="cod">COD</span>' : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Buy Ticket — ${orderName}</title>
  <style>
    :root{
      --brand:#004AAD;
      --ink:#111827;
      --muted:#6b7280;
      --paper:#ffffff;
      --bg:#f3f4f6;
      --width:76mm;
    }
    *{box-sizing:border-box}
    body{margin:0; padding:24px; background:var(--bg); font:14px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial}
    .ticket{ width:var(--width); margin:0 auto; background:var(--paper); color:var(--ink);
             border-radius:16px; border:1px solid #e5e7eb; position:relative; overflow:hidden;
             box-shadow:0 8px 24px rgba(0,0,0,.08); }
    .ticket::before{ content:""; position:absolute; inset:0 auto 0 0; width:14px;
      background:
        linear-gradient(-45deg, transparent 7px, var(--paper) 7px) top left/14px 14px repeat-y,
        linear-gradient( 45deg, transparent 7px, var(--paper) 7px) bottom left/14px 14px repeat-y;
      background-color:var(--brand);
      box-shadow: inset -1px 0 0 rgba(0,0,0,.06); }
    .perf{ position:absolute; top:0; left:18px; bottom:0; width:2px;
           background: repeating-linear-gradient(transparent 0 6px, rgba(0,0,0,.14) 6px 8px); }
    .inner{ padding:16px 16px 16px 26px; }
    .head{ display:flex; align-items:center; justify-content:space-between; gap:8px; padding-bottom:8px; border-bottom:1px dashed #e5e7eb; }
    .brand{ display:flex; align-items:center; gap:10px; }
    .logo{ width:36px; height:36px; border-radius:10px; background:var(--brand); }
    .store{ font-weight:800; letter-spacing:.2px; }
    .badge{ display:inline-block; padding:2px 8px; border-radius:999px; background:#eef2ff; color:var(--brand); font-weight:700; font-size:11px; }
    .meta{ text-align:right; font-size:12px; color:var(--muted); }
    .focus{ text-align:center; padding:10px 0 4px; }
    .price{ display:inline-block; padding:10px 14px; border-radius:12px; font-weight:900; font-size:18px;
            background:linear-gradient(135deg, rgba(0,74,173,.08), rgba(0,74,173,.16)); }
    .cod{ display:inline-block; margin-left:8px; padding:2px 8px; border-radius:8px; font-size:11px; font-weight:800; color:#fff; background:var(--brand); }
    .block{ padding:10px 0; border-bottom:1px dashed #e5e7eb; }
    .title{ font-weight:800; color:var(--brand); font-size:12px; letter-spacing:.7px; text-transform:uppercase; margin-bottom:6px; }
    .row{ display:flex; justify-content:space-between; gap:10px; font-size:13px; }
    .row span:first-child{ color:var(--muted); }
    .foot{ text-align:center; color:var(--muted); font-size:11px; padding-top:8px; }
    .brandline{ height:6px; background: repeating-linear-gradient(90deg, var(--brand) 0 12px, transparent 12px 20px); opacity:.5; margin-top:8px; border-radius:0 0 0 12px; }
    .no-print{ text-align:center; margin-top:10px; }
    .btn{ padding:8px 12px; border-radius:10px; border:0; background:var(--brand); color:white; font-weight:700; cursor:pointer; }
    @media print{ body{background:none; padding:0} .ticket{box-shadow:none} .no-print{display:none !important} }
  </style>
</head>
<body>
  <div class="ticket" role="document" aria-label="Buy Ticket">
    <div class="perf" aria-hidden="true"></div>
    <div class="inner">
      <div class="head">
        <div class="brand">
          <div class="logo" aria-hidden="true"></div>
          <div>
            <div class="store">${shopName || "Your Store"}</div>
            <div class="badge">Buy Ticket</div>
          </div>
        </div>
        <div class="meta">
          <div><b>${orderName}</b></div>
          <div>${createdAt}</div>
        </div>
      </div>
      <div class="focus">
        <span class="price">${totalPrice}</span>
        ${codBadge}
      </div>
      <div class="block">
        <div class="title">Customer</div>
        <div class="row"><span>Name</span><span>${customerFirst} ${customerLast}</span></div>
        <div class="row"><span>City</span><span>${city}</span></div>
        <div class="row"><span>Phone</span><span>${phone}</span></div>
      </div>
      <div class="block" style="border-bottom:0">
        <div class="title">Order</div>
        <div class="row"><span>Items</span><span>${itemsCount} item${itemsCount === 1 ? "" : "s"}</span></div>
        <div class="row"><span>Status</span><span>${fulfillmentStatus}</span></div>
      </div>
      <div class="brandline" aria-hidden="true"></div>
      <div class="foot">Thank you for your purchase ✨</div>
      <div class="no-print"><button class="btn" onclick="window.print()">Print</button></div>
      <p class="no-print" style="color:var(--muted); font-size:11px; margin-top:8px">Tip: change <code>--width</code> for your paper size (e.g., 80mm or 100mm).</p>
    </div>
  </div>
</body>
</html>`;
  };

  const generateAndSendOrderLabel = async (creationResult) => {
    try {
      if (!activeUser?.user_id) return;

      const fullName = (orderData?.name || "").trim();
      const [first = "", last = ""] = fullName.split(" ", 2);
      const itemsCount = (selectedItems || []).length;
      const totalPrice = computeTotalPrice(selectedItems);
      const createdAt = new Date().toISOString().slice(0, 16).replace("T", " ");
      const isCOD = (paymentTerm || "").toLowerCase().includes("receipt") || (deliveryOption || "").toLowerCase().includes("cod");

      const orderName =
        (creationResult?.order_admin_link ? creationResult.order_admin_link.split("/").pop() : "") ||
        (creationResult?.draft_order_id ? `Draft #${creationResult.draft_order_id}` : `Order ${new Date().toISOString().slice(0,10)}`);

      const html = buildOrderLabelHtml({
        shopName: "Shopify Store",
        orderName,
        createdAt,
        totalPrice: `${totalPrice}`,
        isCOD,
        customerFirst: first,
        customerLast: last,
        city: orderData?.city || "",
        phone: orderData?.phone || "",
        itemsCount,
        fulfillmentStatus: "Unfulfilled",
      });

      const container = document.createElement("div");
      container.style.position = "fixed";
      container.style.left = "-10000px";
      container.style.top = "0";
      container.style.zIndex = "-1";
      container.innerHTML = html;
      document.body.appendChild(container);

      const ticketEl = container.querySelector(".ticket") || container;
      const canvas = await html2canvas(ticketEl, { scale: 2, backgroundColor: null });

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
      if (!blob) {
        document.body.removeChild(container);
        return;
      }
      const file = new File([blob], `order_label_${Date.now()}.png`, { type: "image/png" });

      const fd = new FormData();
      fd.append("user_id", activeUser.user_id);
      fd.append("media_type", "image");
      fd.append("files", file, file.name);
      fd.append("caption", `Order ${orderName}`);

      await api.post(`${API_BASE}/send-media`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      document.body.removeChild(container);
    } catch {
      // best-effort, do not block order creation UX
    }
  };

  const handleAddByVariantId = async () => {
    if (!variantIdInput) return;
    await addByVariantId(variantIdInput, 1);
    setVariantIdInput("");
  };

  const handleAddVariant = variant => {
    setSelectedItems(items => [...items, { variant, quantity: 1, discount: 0 }]);
  };

  // Update line item
  const handleItemChange = (idx, field, value) => {
    setSelectedItems(items =>
      items.map((item, i) => i === idx ? { ...item, [field]: value } : item)
    );
  };

  // Remove line item
  const removeOrderItem = idx => {
    setSelectedItems(items => items.filter((_, i) => i !== idx));
  };

  // Listen for "add-to-order" events dispatched from message bubbles
  useEffect(() => {
    const handler = (e) => {
      const detail = e?.detail || {};
      const variantId = detail.variantId || detail.productId || detail.id;
      const quantity = detail.quantity || 1;
      if (variantId) {
        addByVariantId(String(variantId), Number(quantity) || 1);
      }
    };
    window.addEventListener("add-to-order", handler);
    return () => window.removeEventListener("add-to-order", handler);
  }, [addByVariantId]);

  // Load saved cart for this conversation (2-hour TTL enforced in storage)
  useEffect(() => {
    if (!activeUser?.user_id) return;
    let mounted = true;
    loadCart(activeUser.user_id).then(items => {
      if (!mounted) return;
      setSelectedItems(Array.isArray(items) ? items : []);
    }).catch(() => setSelectedItems([]));
    return () => { mounted = false; };
  }, [activeUser?.user_id]);

  // Persist cart on every change
  useEffect(() => {
    if (!activeUser?.user_id) return;
    saveCart(activeUser.user_id, selectedItems).catch(() => {});
  }, [selectedItems, activeUser?.user_id]);

  const handleCreateOrder = async () => {
    setErrorMsg("");
    setLastResult(null);
    if (
      !orderData.address?.trim() ||
      !orderData.city?.trim() ||
      !orderData.province?.trim() ||
      !orderData.zip?.trim()
    ) {
      setErrorMsg("Please fill all shipping address fields (address, city, province, zip)!");
      return;
    }
    if (!selectedItems.length) {
      setErrorMsg("Please select at least one product/variant.");
      return;
    }
    const safePhone = normalizePhone(orderData.phone);
    const orderPayload = {
      ...orderData,
      phone: safePhone,
      items: selectedItems.map(item => ({
        variant_id: item.variant.id,
        title: item.variant.title,
        quantity: Number(item.quantity) || 1,
        discount: Number(item.discount) || 0,
      })),
      delivery: deliveryOption,
      payment_term: paymentTerm,
      ...(customer?.customer_id ? { customer_id: customer.customer_id } : {}),
      create_customer_if_missing: !!createCustomerIfMissing,
      market,
    };

    setIsCreating(true);
    try {
      const res = await api.post(`${API_BASE}/create-shopify-order`, orderPayload);
      setSelectedItems([]);
      try { if (activeUser?.user_id) await saveCart(activeUser.user_id, []); } catch {}
      setErrorMsg("");
      setLastResult(res?.data || null);
      alert("Order created successfully!");
      // Generate the label and send it as image to the customer (best-effort)
      await generateAndSendOrderLabel(res?.data);
    } catch (e) {
      setErrorMsg("Error creating order.");
    } finally {
      setIsCreating(false);
    }
  };

  // Handle customer input changes
  const handleOrderDataChange = (field, value) => {
    setOrderData(data => ({ ...data, [field]: value }));
  };

  return (
    <div className="p-4 h-full flex flex-col">
      {/* Contact Info COLLAPSIBLE */}
      <div className="mb-2">
        <button
          className="w-full flex justify-between items-center bg-gray-800 px-4 py-2 rounded-t text-lg font-bold"
          onClick={() => setShowInfo(v => !v)}
        >
          <span className="flex items-center"><FaShopify className="mr-2 text-green-400" />Contact Information</span>
          <span>{showInfo ? "▲" : "▼"}</span>
        </button>
        {showInfo && (
          <div className="bg-gray-700 p-4 space-y-2 rounded-b shadow-inner">
            {!activeUser?.phone && (
              <p>Select a conversation with a user to fetch Shopify customer info by phone.</p>
            )}
            {activeUser?.phone && loading && <p>Loading customer info…</p>}
            {activeUser?.phone && !loading && (customer || customersList.length > 0) && (
              <>
                {customersList.length > 0 ? (
                  <div className="space-y-2">
                    <div className="text-sm text-gray-300">Select customer for this phone:</div>
                    <select
                      className="w-full bg-gray-800 text-white p-2 rounded"
                      value={selectedCustomerId || ''}
                      onChange={(e) => {
                        const id = e.target.value;
                        const c = customersList.find(x => String(x.customer_id) === String(id));
                        if (!c) return;
                        setSelectedCustomerId(c.customer_id);
                        setSelectedAddressIdx(0);
                        setCustomer(c);
                        const addr = (c.primary_address || c.addresses?.[0] || {});
                        setOrderData(d => ({
                          ...d,
                          name: c.name || "",
                          email: c.email || "",
                          phone: c.phone || activeUser.phone,
                          address: addr.address1 || "",
                          city: addr.city || "",
                          province: addr.province || "",
                          zip: addr.zip || "",
                        }));
                        api.get(`${API_BASE}/shopify-orders`, { params: { customer_id: c.customer_id, limit: 50 } })
                          .then(res => setOrders(Array.isArray(res.data) ? res.data : []))
                          .catch(() => setOrders([]));
                      }}
                    >
                      {customersList.map((c) => (
                        <option key={c.customer_id} value={c.customer_id}>
                          {(c.name || '(no name)')} • {(c.phone || '')}
                        </option>
                      ))}
                    </select>
                    {Array.isArray(customer?.addresses) && customer.addresses.length > 0 && (
                      <details>
                        <summary className="cursor-pointer text-xs text-gray-300">Addresses ({customer.addresses.length})</summary>
                        <div className="mt-1">
                          <div className="text-xs mb-1">Select address:</div>
                          <select
                            className="bg-gray-800 text-white p-1 rounded"
                            value={selectedAddressIdx}
                            onChange={(e) => {
                              const idx = Number(e.target.value) || 0;
                              setSelectedAddressIdx(idx);
                              const addr = customer.addresses[idx] || {};
                              setOrderData(d => ({
                                ...d,
                                address: addr.address1 || "",
                                city: addr.city || "",
                                province: addr.province || "",
                                zip: addr.zip || "",
                              }));
                            }}
                          >
                            {customer.addresses.map((a, idx) => (
                              <option key={idx} value={idx}>{a.address1 || ''} {a.city ? `, ${a.city}`: ''}</option>
                            ))}
                          </select>
                        </div>
                      </details>
                    )}
                  </div>
                ) : (
                  <>
                    <p><strong>Name:</strong> {customer.name}</p>
                    <p><strong>Email:</strong> {customer.email}</p>
                    <p><strong>Phone:</strong> {customer.phone}</p>
                    {Array.isArray(customer.addresses) && customer.addresses.length > 0 ? (
                      <details>
                        <summary className="cursor-pointer">Addresses ({customer.addresses.length})</summary>
                        <div className="ml-4 mt-1">
                          <div className="text-xs mb-1">Select address:</div>
                          <select
                            className="bg-gray-800 text-white p-1 rounded"
                            value={selectedAddressIdx}
                            onChange={(e) => {
                              const idx = Number(e.target.value) || 0;
                              setSelectedAddressIdx(idx);
                              const addr = customer.addresses[idx] || {};
                              setOrderData(d => ({
                                ...d,
                                address: addr.address1 || "",
                                city: addr.city || "",
                                province: addr.province || "",
                                zip: addr.zip || "",
                              }));
                            }}
                          >
                            {customer.addresses.map((a, idx) => (
                              <option key={idx} value={idx}>{a.address1 || ''} {a.city ? `, ${a.city}`: ''}</option>
                            ))}
                          </select>
                        </div>
                      </details>
                    ) : (
                      <p><strong>Address:</strong> {customer.address}</p>
                    )}
                  </>
                )}
                <hr className="my-2" />
                <p><strong>Total Orders:</strong> {(customer || customersList[0])?.total_orders}</p>
                {/* Orders list */}
                {Array.isArray(orders) && orders.length > 0 && (
                  <div className="mt-2">
                    <div className="font-semibold mb-1">Orders</div>
                    <ul className="space-y-1 max-h-40 overflow-auto pr-1">
                      {orders.map((o) => (
                        <li key={o.id} className="text-sm flex justify-between gap-2 border-b border-gray-600 py-1">
                          <div className="min-w-0">
                            <a
                              href={o.admin_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-300 hover:underline truncate inline-block"
                              title="Open in Shopify admin"
                            >
                              {o.order_number}
                            </a>
                            <div className="text-xs text-gray-300">
                              {new Date(o.created_at).toLocaleString()} • {o.financial_status || 'unpaid'}{o.fulfillment_status ? ` • ${o.fulfillment_status}` : ''}
                            </div>
                          </div>
                          <div className="text-right text-sm whitespace-nowrap">
                            {o.total_price} {o.currency || ''}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {/* Copy address to clipboard for quick reply */}
                {customer.address && (
                  <button
                    className="mt-2 bg-blue-500 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded"
                    onClick={() => {
                      navigator.clipboard.writeText(customer.address + (customer.city ? `, ${customer.city}` : ""));
                      alert("Address copied to clipboard!");
                    }}
                  >
                    Copy address
                  </button>
                )}
              </>
            )}
            {activeUser?.phone && !loading && !customer && (
              <>
                {errorMsg ? (
                  <p className="text-yellow-300">{errorMsg}</p>
                ) : (
                  <p className="text-red-400">No customer found.</p>
                )}
                {/* Search bar for other numbers/emails */}
                <div className="mt-2 p-2 bg-gray-800 rounded">
                  <div className="text-xs text-gray-300 mb-1">Search customers by phone or email (different from WhatsApp):</div>
                  <div className="flex gap-2">
                    <input
                      className="flex-1 p-1 rounded bg-gray-900 text-white"
                      placeholder="Enter phone or email"
                      value={customerSearchInput}
                      onChange={e => setCustomerSearchInput(e.target.value)}
                    />
                    <button
                      className="px-2 py-1 bg-blue-600 rounded text-white"
                      onClick={async () => {
                        if (!customerSearchInput.trim()) return;
                        setIsSearchingCustomers(true);
                        setCustomerSearchResults([]);
                        try {
                          const res = await api.get(`${API_BASE}/search-customers-all?phone_number=${encodeURIComponent(customerSearchInput.trim())}`);
                          const list = Array.isArray(res.data) ? res.data : [];
                          setCustomerSearchResults(list);
                        } catch {
                          setCustomerSearchResults([]);
                        } finally {
                          setIsSearchingCustomers(false);
                        }
                      }}
                      type="button"
                    >Search</button>
                  </div>
                  {isSearchingCustomers && <div className="text-xs text-gray-400 mt-1">Searching…</div>}
                  {customerSearchResults.length > 0 && (
                    <ul className="mt-2 space-y-1 max-h-40 overflow-auto pr-1">
                      {customerSearchResults.map((c) => (
                        <li key={c.customer_id} className="flex justify-between items-center gap-2 bg-gray-900 p-2 rounded">
                          <div className="min-w-0">
                            <div className="font-semibold text-sm truncate">{c.name || "(no name)"}</div>
                            <div className="text-xs text-gray-300 truncate">{c.phone || c.email || ""}</div>
                          </div>
                          <button
                            className="px-2 py-1 bg-green-600 rounded text-white text-xs whitespace-nowrap"
                            type="button"
                            onClick={() => {
                              setCustomer(c);
                              setSelectedCustomerId(c.customer_id);
                              setSelectedAddressIdx(0);
                              const addr = (c.primary_address || c.addresses?.[0] || {});
                              setOrderData(d => ({
                                ...d,
                                name: c.name || "",
                                email: c.email || "",
                                phone: c.phone || orderData.phone,
                                address: addr.address1 || "",
                                city: addr.city || "",
                                province: addr.province || "",
                                zip: addr.zip || "",
                              }));
                              setCustomerSearchResults([]);
                              setCustomerSearchInput("");
                              api.get(`${API_BASE}/shopify-orders`, { params: { customer_id: c.customer_id, limit: 50 } })
                                .then(res => setOrders(Array.isArray(res.data) ? res.data : []))
                                .catch(() => setOrders([]));
                            }}
                          >Select</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* CREATE ORDER COLLAPSIBLE */}
      <div>
        <button
          className="w-full flex justify-between items-center bg-gray-800 px-4 py-2 rounded-t text-lg font-bold"
          onClick={() => setShowCreate(v => !v)}
        >
          <span>Create an Order</span>
          <span>{showCreate ? "▲" : "▼"}</span>
        </button>
        {showCreate && (
          <form
            className="bg-gray-700 p-4 rounded-b shadow-inner space-y-2"
            onSubmit={e => { e.preventDefault(); handleCreateOrder(); }}
            autoComplete="off"
          >
            {/* Error message */}
            {errorMsg && (
              <div className="bg-red-500 text-white px-2 py-1 rounded mb-2">{errorMsg}</div>
            )}
            <div className="space-y-1">
              {/* ... All your address and customer fields, as in your code ... */}
              <label className="block text-xs font-bold">Name</label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.name}
                onChange={e => handleOrderDataChange('name', e.target.value)}
                autoComplete="off"
              />
              <label className="block text-xs font-bold">Email</label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.email}
                onChange={e => handleOrderDataChange('email', e.target.value)}
                autoComplete="off"
              />
              <label className="block text-xs font-bold">Phone</label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.phone}
                onChange={e => handleOrderDataChange('phone', e.target.value)}
                autoComplete="off"
              />
              <label className="block text-xs font-bold">City <span className="text-red-400">*</span></label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.city}
                onChange={e => handleOrderDataChange('city', e.target.value)}
                autoComplete="off"
                required
              />
              <label className="block text-xs font-bold">Province <span className="text-red-400">*</span></label>
              <select
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.province}
                onChange={e => handleOrderDataChange('province', e.target.value)}
                required
              >
                <option value="" disabled>Select province</option>
                 {MOROCCO_PROVINCES.map((prov) => (
                   <option key={prov} value={prov}>{prov}</option>
                 ))}
               </select>
              <label className="block text-xs font-bold">ZIP <span className="text-red-400">*</span></label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.zip}
                onChange={e => handleOrderDataChange('zip', e.target.value)}
                autoComplete="off"
                required
              />
              <label className="block text-xs font-bold">Address <span className="text-red-400">*</span></label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.address}
                onChange={e => handleOrderDataChange('address', e.target.value)}
                autoComplete="off"
                required
              />
              {/* Optional note and image URL */}
              <label className="block text-xs font-bold mt-2">Order note (timeline text)</label>
              <textarea
                className="w-full p-1 rounded bg-gray-800 text-white"
                rows={3}
                placeholder="e.g. Customer requested gift wrap."
                value={orderData.order_note}
                onChange={e => handleOrderDataChange('order_note', e.target.value)}
              />
              <label className="block text-xs font-bold">Image URL (will be saved in note)</label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                placeholder="https://..."
                value={orderData.order_image_url}
                onChange={e => handleOrderDataChange('order_image_url', e.target.value)}
                autoComplete="off"
              />
              {orderData.order_image_url && (
                <div className="mt-2">
                  <div className="text-xs text-gray-300 mb-1">Preview:</div>
                  <img
                    src={orderData.order_image_url}
                    alt="Order reference"
                    className="w-24 h-24 object-cover rounded border border-gray-600 bg-gray-900"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                </div>
              )}
            </div>
            {/* Product search and add section */}
            <hr className="my-2" />
            <h3 className="font-bold text-lg mb-2">Add products</h3>
            <input
              value={productSearch}
              onChange={e => setProductSearch(e.target.value)}
              placeholder="Search products…"
              className="p-1 rounded bg-gray-800 text-white w-full"
            />
            {products.map((product) => (
              <div key={product.id}>
                <strong>{product.title}</strong>
                <div>
                  {product.variants.map((variant) => (
                    <button
                      type="button"
                      key={variant.id}
                      className="border p-1 m-1 rounded"
                      onClick={() => handleAddVariant(variant)}
                    >
                      {variant.title} • {variant.price} MAD
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="mt-2">
              <input
                value={variantIdInput}
                onChange={e => setVariantIdInput(e.target.value)}
                placeholder="Add by Variant ID"
                className="p-1 rounded bg-gray-800 text-white"
              />
              <button
                type="button"
                className="bg-blue-600 text-white rounded px-2 py-1 ml-2"
                onClick={handleAddByVariantId}
              >
                Add Variant
              </button>
            </div>
            {/* Selected items table with images and pricing */}
            <table className="w-full text-xs mt-2">
              <thead>
                <tr>
                  <th className="text-left">Item</th>
                  <th>Variant</th>
                  <th>Price</th>
                  <th>Qty</th>
                  <th>Discount</th>
                  <th>Subtotal</th>
                  <th>Remove</th>
                </tr>
              </thead>
              <tbody>
                {selectedItems.map((item, idx) => {
                  const img = item.variant.image_src;
                  const priceNum = Number(item.variant.price || 0);
                  const qtyNum = Number(item.quantity || 1);
                  const discountNum = Number(item.discount || 0);
                  const subtotal = Math.max(0, priceNum * qtyNum - discountNum);
                  return (
                  <tr key={item.variant.id} className="align-middle">
                    <td>
                      <div className="flex items-center gap-2">
                        {img ? (
                          <img src={img} alt={item.variant.title} className="w-10 h-10 object-cover rounded" />
                        ) : (
                          <div className="w-10 h-10 rounded bg-gray-600 flex items-center justify-center">🛒</div>
                        )}
                        <div className="min-w-0">
                          <div className="font-semibold truncate max-w-[140px]">{item.variant.product_title || "--"}</div>
                        </div>
                      </div>
                    </td>
                    <td>{item.variant.title}</td>
                    <td className="text-center">{priceNum} MAD</td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={e => handleItemChange(idx, "quantity", Number(e.target.value))}
                        className="w-12 bg-gray-800 text-white p-1"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        value={item.discount}
                        onChange={e => handleItemChange(idx, "discount", Number(e.target.value))}
                        className="w-12 bg-gray-800 text-white p-1"
                        placeholder="MAD"
                      />
                    </td>
                    <td className="text-center font-semibold">{subtotal} MAD</td>
                    <td>
                      <button
                        type="button"
                        className="text-red-400"
                        onClick={() => removeOrderItem(idx)}
                      >✖</button>
                    </td>
                  </tr>
                );})}
              </tbody>
            </table>
            {selectedItems.length > 0 && (
              <div className="mt-2 text-right font-bold text-sm">
                {(() => {
                  const total = selectedItems.reduce((sum, item) => {
                    const p = Number(item.variant.price || 0);
                    const q = Number(item.quantity || 1);
                    const d = Number(item.discount || 0);
                    return sum + Math.max(0, p * q - d);
                  }, 0);
                  return <span>Total: {total} MAD</span>;
                })()}
              </div>
            )}
            {/* Delivery Option */}
            <div className="mt-2">
              <label className="block font-bold text-xs mb-1">Delivery</label>
              <select
                className="bg-gray-800 text-white px-2 py-1 rounded"
                value={deliveryOption}
                onChange={e => setDeliveryOption(e.target.value)}
              >
                {shippingOptions.map(opt =>
                  <option key={opt.id} value={opt.name}>
                    {opt.name} {opt.zone ? `(${opt.zone})` : ""}
                  </option>
                )}
              </select>
            </div>
            {/* Payment Term */}
            <div className="mt-2 flex items-center">
              <input
                id="paymentDueLater"
                type="checkbox"
                checked={paymentTerm === "due_on_receipt"}
                onChange={e => setPaymentTerm(e.target.checked ? "due_on_receipt" : "paid")}
                className="mr-2"
              />
              <label htmlFor="paymentDueLater" className="font-bold text-xs">
                Payment due later
              </label>
            </div>
            {/* Complete Now */}
            <div className="mt-2 flex items-center">
              <input
                id="completeNow"
                type="checkbox"
                checked={orderData.complete_now}
                onChange={e => handleOrderDataChange('complete_now', e.target.checked)}
                className="mr-2"
              />
              <label htmlFor="completeNow" className="font-bold text-xs">
                Complete draft now (creates order as payment pending)
              </label>
            </div>
            {/* Create customer if missing */}
            <div className="mt-2 flex items-center">
              <input
                id="createCustomerIfMissing"
                type="checkbox"
                checked={createCustomerIfMissing}
                onChange={e => setCreateCustomerIfMissing(e.target.checked)}
                className="mr-2"
              />
              <label htmlFor="createCustomerIfMissing" className="font-bold text-xs">
                Create Shopify customer if none found
              </label>
            </div>
            {/* Market */}
            <div className="mt-2 text-xs text-gray-400">
              <span>Market: Moroccan default (auto)</span>
            </div>
            <button
              className={`w-full px-4 py-2 rounded mt-4 font-bold ${
                isCreating ? "bg-gray-400" : "bg-green-600"
              }`}
              type="submit"
              disabled={isCreating}
            >
              {isCreating ? "Creating..." : "Create Shopify Order"}
            </button>

            {lastResult && (
              <div className="mt-3 text-xs bg-gray-800 p-2 rounded">
                <div className="font-bold">Result</div>
                {lastResult.shopify_admin_link && (
                  <div>
                    Draft: <a className="text-blue-300 underline" href={lastResult.shopify_admin_link} target="_blank" rel="noreferrer">Open draft</a>
                  </div>
                )}
                {lastResult.order_admin_link && (
                  <div>
                    Order: <a className="text-blue-300 underline" href={lastResult.order_admin_link} target="_blank" rel="noreferrer">Open order</a>
                  </div>
                )}
                {lastResult.message && (
                  <div className="text-gray-300 mt-1">{lastResult.message}</div>
                )}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
