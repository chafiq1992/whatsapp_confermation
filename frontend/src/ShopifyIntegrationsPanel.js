import React, { useState, useEffect, useMemo, useRef } from "react";
import { FaShopify } from "react-icons/fa";
import api from "./api";
import { saveCart, loadCart } from "./chatStorage";
import html2canvas from "html2canvas";

// Lightweight confetti (no dependency) using canvas burst
function fireConfettiBurst() {
  try {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '9999';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
    };
    resize();
    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    const colors = ['#26ccff', '#a25afd', '#ff5e7e', '#88ff5a', '#fcff42', '#ffa62d', '#ff36ff'];
    const pieces = [];
    const count = Math.min(180, Math.floor((window.innerWidth + window.innerHeight) / 8));
    for (let i = 0; i < count; i++) {
      pieces.push({
        x: (Math.random() * canvas.width),
        y: -Math.random() * canvas.height * 0.2,
        r: 3 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        vy: 2 + Math.random() * 3,
        vx: (Math.random() - 0.5) * 4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
      });
    }

    let running = true;
    const start = performance.now();
    function tick(t) {
      if (!running) return;
      const elapsed = t - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of pieces) {
        p.vy += 0.03; // gravity
        p.x += p.vx * dpr;
        p.y += p.vy * dpr;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.r, -p.r, p.r * 2, p.r * 2);
        ctx.restore();
      }
      if (elapsed < 1700) {
        requestAnimationFrame(tick);
      } else {
        running = false;
        window.removeEventListener('resize', onResize);
        document.body.removeChild(canvas);
      }
    }
    requestAnimationFrame(tick);
  } catch {}
}

export default function ShopifyIntegrationsPanel({ activeUser, currentAgent }) {
  const API_BASE = process.env.REACT_APP_API_BASE || "";

  const [customer, setCustomer] = useState(null);
  const [customersList, setCustomersList] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [selectedAddressIdx, setSelectedAddressIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [orders, setOrders] = useState([]);
  const [newOrderTag, setNewOrderTag] = useState("");
  const [newOrderNote, setNewOrderNote] = useState("");
  const ordersCooldownRef = useRef(0);
  const fetchOrdersWithCooldown = async (customerId) => {
    if (!customerId) return;
    const now = Date.now();
    if (now < (ordersCooldownRef.current || 0)) {
      return;
    }
    try {
      const res = await api.get(`${API_BASE}/shopify-orders`, { params: { customer_id: customerId, limit: 50 } });
      setOrders(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        const retryAfterHeader = Number(err?.response?.headers?.["retry-after"]) || 0;
        const retryAfterBody = Number(err?.response?.data?.retry_after) || 0;
        const backoffSec = Math.max(retryAfterHeader, retryAfterBody, 5);
        ordersCooldownRef.current = Date.now() + backoffSec * 1000;
      }
      setOrders([]);
    }
  };

  const normalizePhone = (phone) => {
    if (!phone) return "";
    if (phone.startsWith("+")) return phone;
    if (phone.length === 12 && phone.startsWith("212")) return "+" + phone;
    if (phone.length === 10 && phone.startsWith("06")) return "+212" + phone.slice(1);
    return phone;
  }; 

  // Collapsible sections
  const [showInfo, setShowInfo] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

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
  const [variantPreview, setVariantPreview] = useState(null);
  const [variantSuggestions, setVariantSuggestions] = useState([]);
  const variantSuggestOpenRef = useRef(false);
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

  // Minimal city → province/zip mapping (extend as needed)
  const CITY_LOOKUP = useMemo(() => ({
    "casablanca": { province: "Casablanca-Settat", zip: "20000" },
    "rabat": { province: "Rabat-Salé-Kénitra", zip: "10000" },
    "marrakech": { province: "Marrakech-Safi", zip: "40000" },
    "fes": { province: "Fès-Meknès", zip: "30000" },
    "fès": { province: "Fès-Meknès", zip: "30000" },
    "meknes": { province: "Fès-Meknès", zip: "50000" },
    "meknès": { province: "Fès-Meknès", zip: "50000" },
    "tanger": { province: "Tanger-Tétouan-Al Hoceïma", zip: "90000" },
    "agadir": { province: "Souss-Massa", zip: "80000" },
    "oujda": { province: "Oriental", zip: "60000" },
    "beni mellal": { province: "Beni Mellal-Khénifra", zip: "23000" },
    "tétouan": { province: "Tanger-Tétouan-Al Hoceïma", zip: "93000" },
    "tetouan": { province: "Tanger-Tétouan-Al Hoceïma", zip: "93000" },
    "laâyoune": { province: "Laâyoune-Sakia El Hamra", zip: "70000" },
    "laayoune": { province: "Laâyoune-Sakia El Hamra", zip: "70000" },
    "dakhla": { province: "Dakhla-Oued Ed-Dahab", zip: "73000" },
    "safi": { province: "Marrakech-Safi", zip: "46000" },
    "kénitra": { province: "Rabat-Salé-Kénitra", zip: "14000" },
    "kenitra": { province: "Rabat-Salé-Kénitra", zip: "14000" },
    "sale": { province: "Rabat-Salé-Kénitra", zip: "11000" },
    "salé": { province: "Rabat-Salé-Kénitra", zip: "11000" },
  }), []);

  // Auto-fill province/zip when city changes
  useEffect(() => {
    const c = (orderData.city || "").trim().toLowerCase();
    if (!c) return;
    const match = CITY_LOOKUP[c];
    if (!match) return;
    setOrderData(d => ({
      ...d,
      province: match.province,
      zip: match.zip,
    }));
  }, [orderData.city, CITY_LOOKUP]);

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
        fetchOrdersWithCooldown(first.customer_id);
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
          fetchOrdersWithCooldown(c.customer_id);
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

  // Live preview for Variant ID input + suggestions (debounced)
  useEffect(() => {
    const raw = String(variantIdInput || "").trim();
    if (!raw) { setVariantPreview(null); setVariantSuggestions([]); return; }
    if (!/^\d{3,}$/.test(raw)) { setVariantPreview(null); setVariantSuggestions([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await api.get(`${API_BASE}/shopify-variant/${raw}`);
        setVariantPreview(res?.data || null);
      } catch { setVariantPreview(null); }
      // Suggestions via products query
      try {
        const pr = await api.get(`${API_BASE}/shopify-products?q=${encodeURIComponent(raw)}`);
        const prods = Array.isArray(pr.data) ? pr.data : [];
        const items = [];
        const score = (qstr, v, p) => {
          try {
            const s = String(qstr).toLowerCase();
            const id = String(v.id || "");
            const sku = String(v.sku || "").toLowerCase();
            const vt = String(v.title || "").toLowerCase();
            const pt = String(p.title || v.product_title || "").toLowerCase();
            let sc = 0;
            if (id.startsWith(raw)) sc += 1000 - Math.min(999, Math.max(0, id.length - raw.length));
            if (id.includes(raw)) sc += 400;
            if (sku.startsWith(s)) sc += 350;
            if (vt.startsWith(s)) sc += 300;
            if (vt.includes(s)) sc += 120;
            if (pt.startsWith(s)) sc += 80;
            if (pt.includes(s)) sc += 40;
            return sc;
          } catch { return 0; }
        };
        prods.forEach(p => {
          (p.variants || []).forEach(v => {
            items.push({
              id: v.id,
              title: v.title,
              product_title: v.product_title || p.title,
              price: v.price,
              image_src: (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || v.image_src || "",
              __score: score(raw, v, p),
              __variant: v,
            });
          });
        });
        items.sort((a,b)=> b.__score - a.__score);
        setVariantSuggestions(items.slice(0, 10));
      } catch { setVariantSuggestions([]); }
    }, 450);
    return () => clearTimeout(t);
  }, [variantIdInput, API_BASE]);

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
    orderName,
    createdAtDisplay,
    isPaid,
    paymentMethod,
    subtotal,
    totalDiscount,
    total,
    currency,
    // Optional single-item fallback fields (used if items not provided)
    productImageUrl,
    productTitle,
    productVariantTitle,
    qty,
    moreCount,
    // New: full items array to render all variants
    items = [],
    addressName,
    address1,
    address2,
    city,
    provinceCode,
    zip,
  }) => {
    const itemsHtml = Array.isArray(items) && items.length > 0
      ? `
        <div class="section-title">Items</div>
        ${items.map((it) => `
          <div class="product">
            <div class="thumb">
              ${it.image ? `<img src="${it.image}" crossorigin="anonymous" alt="${(it.title || 'Item').replace(/[/\\]/g,'-')}" />` : `<img src="https://cdn.shopify.com/s/images/admin/no-image-compact-1.gif" alt="No image" />`}
            </div>
            <div class="prod-info">
              <div class="prod-title">${it.title || ''}</div>
              ${it.variant ? `<div class="prod-variant">${it.variant}</div>` : ''}
              <div class="chips">
                <span class="chip">Qty ×${Number(it.qty || 1)}</span>
                ${Number(it.lineTotal || 0) > 0 ? `<span class="chip">${Number(it.lineTotal).toFixed(2)} ${currency}</span>` : ''}
              </div>
            </div>
          </div>
        `).join('')}
      `
      : `
        <div class="section-title">Item</div>
        <div class="product">
          <div class="thumb">
            ${productImageUrl ? `<img src="${productImageUrl}" crossorigin="anonymous" alt="${productTitle || 'Item'}" />` : `<img src="https://cdn.shopify.com/s/images/admin/no-image-compact-1.gif" alt="No image" />`}
          </div>
          <div class="prod-info">
            <div class="prod-title">${productTitle || ''}</div>
            ${productVariantTitle ? `<div class="prod-variant">${productVariantTitle}</div>` : ''}
            <div class="chips">
              <span class="chip">Qty ×${qty}</span>
              ${moreCount > 0 ? `<span class="chip">+${moreCount} more</span>` : ''}
            </div>
          </div>
        </div>
      `;

    return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Buy Ticket — ${orderName}</title>
  <style>
    :root{
      --brand:#004AAD;             /* irrakids blue */
      --accent:#6A7CFF;            /* secondary blue */
      --ink:#e5e7eb;               /* text */
      --muted:#9ca3af;             /* secondary text */
      --card:#0f1722;              /* single-color card background */
      --width: 320px;
    }

    *{box-sizing:border-box}
    body{margin:0; padding:24px; background:transparent; font:14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; color:var(--ink)}

    .wrap{display:flex; justify-content:center}

    .ticket{width:var(--width); position:relative; border-radius:20px; overflow:hidden; 
            background:var(--card);
    }

    /* Remove scallops/notches for WhatsApp-native look */

    .inner{padding:18px 18px 16px; position:relative}

    .emblem{display:flex; align-items:center; justify-content:center; margin:8px 0 10px}
    .halo{width:52px; height:52px; border-radius:999px; background:radial-gradient(closest-side, rgba(0,74,173,.35), rgba(0,74,173,.08) 60%, transparent 65%);
          display:grid; place-items:center;}
    .check{width:34px; height:34px; border-radius:999px; background:linear-gradient(180deg, #3f82ff, var(--brand)); box-shadow:0 6px 14px rgba(0,74,173,.45) inset, 0 2px 10px rgba(0,0,0,.25); display:grid; place-items:center}
    .check svg{width:18px; height:18px; color:white}

    h1{margin:6px 0 6px; text-align:center; font-size:18px; letter-spacing:.2px; font-weight:800}

    .rule{height:1px; background:repeating-linear-gradient(90deg, rgba(255,255,255,.16) 0 7px, transparent 7px 14px); margin:10px 0}

    .kv{display:flex; justify-content:space-between; gap:10px; padding:6px 0; align-items:center}
    .kv .k{color:var(--muted)}
    .kv .v{color:var(--ink); font-weight:700; text-align:right}

    .summary{margin-top:4px}
    .row{display:flex; justify-content:space-between; padding:6px 0}
    .row.sub, .row.dis{color:var(--muted)}

    .total{display:flex; justify-content:space-between; align-items:center; margin-top:10px; padding:10px 12px; border-radius:14px;
           background:linear-gradient(145deg, rgba(255,255,255,.06), rgba(255,255,255,.04)); font-weight:900; font-size:16px;}

    /* Product + Address blocks */
    .section-title{font-weight:800; font-size:12px; letter-spacing:.6px; text-transform:uppercase; color:var(--accent); margin:6px 0 6px}

    .product{display:flex; gap:10px; align-items:flex-start; padding:6px 0}
    .thumb{width:60px; height:60px; border-radius:10px; overflow:hidden; flex:0 0 auto; box-shadow:0 4px 10px rgba(0,0,0,.25)}
    .thumb img{width:100%; height:100%; object-fit:cover; display:block}
    .prod-info{flex:1}
    .prod-title{font-weight:700; font-size:13px}
    .prod-variant{color:var(--muted); font-size:12px; margin-top:2px}
    .chips{margin-top:6px; display:flex; gap:6px; flex-wrap:wrap}
    .chip{font-size:11px; font-weight:800; color:#fff; background:linear-gradient(180deg, #6f85ff, var(--accent)); padding:2px 8px; border-radius:999px}

    .address{padding:6px 0}
    .addr-name{font-weight:700; font-size:13px}
    .addr-lines{color:var(--muted); font-size:12px; line-height:1.35; margin-top:2px}

    .foot{padding:10px 0 4px; text-align:center; color:var(--muted); font-size:11px}

    .no-print{text-align:center; margin-top:10px}
    .btn{padding:8px 12px; border-radius:10px; border:0; background:#1f6feb; color:#fff; font-weight:700; cursor:pointer}

    @media print{
      body{background:none; padding:0}
      .ticket{box-shadow:none}
      .no-print{display:none !important}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="ticket" role="document" aria-label="Payment Ticket">
      <div class="inner">
        <div class="emblem">
          <div class="halo">
            <div class="check" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5"/>
              </svg>
            </div>
          </div>
        </div>
        <h1>
          ${isPaid ? "Payment Success" : "Order Placed"}
        </h1>

        <div class="rule" aria-hidden="true"></div>

        ${itemsHtml}

        <!-- Address -->
        <div class="section-title">Customer</div>
        <div class="address">
          <div class="addr-name">${addressName}</div>
          <div class="addr-lines">
            ${address1 || ''}${address2 ? `, ${address2}` : ''}<br/>
            ${city || ''}${provinceCode ? `, ${provinceCode}` : ''}${zip ? ` ${zip}` : ''}
          </div>
        </div>

        <div class="rule" aria-hidden="true"></div>

        <div class="kv"><span class="k">Reference number</span><span class="v">${orderName}</span></div>
        <div class="kv"><span class="k">Date &amp; time</span><span class="v">${createdAtDisplay}</span></div>
        <div class="kv"><span class="k">Payment method</span>
          <span class="v">${paymentMethod}</span>
        </div>

        <div class="rule" aria-hidden="true"></div>

        <div class="rule" aria-hidden="true"></div>

        <div class="summary">
          <div class="row sub"><span>Subtotal</span><span>${subtotal} ${currency}</span></div>
          ${totalDiscount > 0 ? `<div class="row dis"><span>Discount</span><span>-${totalDiscount} ${currency}</span></div>` : ''}
          ${totalDiscount > 0 ? `<div class="rule" aria-hidden="true"></div>` : ''}
          <div class="total"><span>Total</span><span style="font-size:18px">${total} ${currency}</span></div>
        </div>

        <div class="foot">Thank you for your purchase</div>
      </div>
    </div>
  </div>

  <div class="no-print"><button class="btn" onclick="window.print()">Print</button></div>
</body>
</html>`;
  };

  const generateAndSendOrderLabel = async (creationResult) => {
    try {
      if (!activeUser?.user_id) return;

      const fullName = (orderData?.name || "").trim();
      const [first = "", last = ""] = fullName.split(" ", 2);
      const itemsCount = (selectedItems || []).length;
      const subtotal = (selectedItems || []).reduce((acc, it) => {
        const price = Number(it?.variant?.price || 0);
        const qty = Number(it?.quantity || 1);
        return acc + price * qty;
      }, 0);
      const totalDiscount = (selectedItems || []).reduce((acc, it) => acc + Number(it?.discount || 0), 0);
      const total = Math.max(0, Number((subtotal - totalDiscount).toFixed(2)));

      const createdAtDate = new Date();
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const dd = String(createdAtDate.getDate()).padStart(2, '0');
      const mmm = months[createdAtDate.getMonth()];
      let hh = createdAtDate.getHours();
      const mm = String(createdAtDate.getMinutes()).padStart(2, '0');
      const ampm = hh >= 12 ? 'PM' : 'AM';
      hh = hh % 12; if (hh === 0) hh = 12;
      const createdAtDisplay = `${dd} ${mmm} ${createdAtDate.getFullYear()}, ${String(hh).padStart(2,'0')}:${mm} ${ampm}`;

      const isCOD = (paymentTerm || "").toLowerCase().includes("receipt") || (deliveryOption || "").toLowerCase().includes("cod");
      const isPaid = (paymentTerm || "").toLowerCase() === "paid";
      const paymentMethod = isCOD ? "Cash on Delivery" : (isPaid ? "Paid" : "—");

      const orderName =
        (creationResult?.order_admin_link ? creationResult.order_admin_link.split("/").pop() : "") ||
        (creationResult?.draft_order_id ? `Draft #${creationResult.draft_order_id}` : `Order ${new Date().toISOString().slice(0,10)}`);

      // Build full items list for the label (show each variant with image and details)
      const items = (selectedItems || []).map((it) => {
        const priceNum = Number(it?.variant?.price || 0);
        const qtyNum = Number(it?.quantity || 1);
        const discountNum = Number(it?.discount || 0);
        const lineTotal = Math.max(0, priceNum * qtyNum - discountNum);
        return {
          image: it?.variant?.image_src || "",
          title: it?.variant?.product_title || it?.variant?.title || "",
          variant: it?.variant?.title || "",
          qty: qtyNum,
          lineTotal,
        };
      });

      const html = buildOrderLabelHtml({
        orderName,
        createdAtDisplay,
        isPaid,
        paymentMethod,
        subtotal: Number(subtotal.toFixed(2)),
        totalDiscount: Number(totalDiscount.toFixed(2)),
        total,
        currency: "MAD",
        items,
        addressName: fullName || "",
        address1: orderData?.address || "",
        address2: "",
        city: orderData?.city || "",
        provinceCode: orderData?.province || "",
        zip: orderData?.zip || "",
      });

      const container = document.createElement("div");
      container.style.position = "fixed";
      container.style.left = "-10000px";
      container.style.top = "0";
      container.style.zIndex = "-1";
      container.innerHTML = html;
      document.body.appendChild(container);

      const ticketEl = container.querySelector(".ticket") || container;
      const canvas = await html2canvas(ticketEl, { scale: 2, backgroundColor: null, useCORS: true });

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
      const arabicCaption = [
        `هذه فاتورتك \uD83D\uDCC4`,
        `تم تأكيد طلبك: ${orderName}`,
        `يرجى مراجعة الفاتورة بعناية: عنوانك ورقم هاتفك والمنتجات والمقاس واللون حتى يصلك طلبك بسرعة وبدون أي مشاكل.`,
        `شكراً لتسوقك معنا \u2764\uFE0F`
      ].join("\n");
      fd.append("caption", arabicCaption);

      await api.post(`${API_BASE}/send-media`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      // Follow-up warning will be sent by backend as a reply after delivery

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
    // Clear search and hide dropdown after selecting a variant
    setProductSearch("");
    setProducts([]);
  };

  // Update line item
  const handleItemChange = (idx, field, value) => {
    setSelectedItems(items =>
      items.map((item, i) => {
        if (i !== idx) return item;
        let next = value;
        if (field === "quantity") {
          const num = Number.isFinite(Number(value)) ? Math.max(1, Math.floor(Number(value))) : 1;
          next = num;
        } else if (field === "discount") {
          const num = Number(value);
          // Allow decimals; clamp to >= 0 and round to 2dp to avoid 99.99000000000001
          const clamped = Number.isFinite(num) ? Math.max(0, num) : 0;
          next = Math.round(clamped * 100) / 100;
        }
        return { ...item, [field]: next };
      })
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
        discount: Math.round((Number(item.discount) || 0) * 100) / 100,
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
      fireConfettiBurst();
      // Generate the label and send it as image to the customer (best-effort)
      await generateAndSendOrderLabel(res?.data);
      // Log order creation for agent analytics (best-effort)
      try {
        const orderId = (res?.data?.order_id || res?.data?.draft_order_id || "").toString();
        if (orderId) {
          await api.post(`${API_BASE}/orders/created/log`, {
            order_id: orderId,
            user_id: activeUser?.user_id || undefined,
            agent: currentAgent || undefined,
          });
        }
      } catch {}
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
            {activeUser?.phone && loading && (
              <div className="space-y-2" aria-live="polite">
                <div className="h-4 bg-gray-600 rounded animate-pulse" />
                <div className="h-4 bg-gray-600 rounded animate-pulse w-2/3" />
                <div className="h-4 bg-gray-600 rounded animate-pulse w-1/2" />
              </div>
            )}
            {activeUser?.phone && !loading && (customer || customersList.length > 0) && (
              <>
                {customersList.length > 0 ? (
                  <div className="space-y-2">
                    <div className="text-sm text-gray-300">Select customer for this phone:</div>
                    <select
                      id="customer-select"
                      name="customer_id"
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
                        fetchOrdersWithCooldown(c.customer_id);
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
                          <label htmlFor="address-select" className="text-xs mb-1 block">Select address:</label>
                          <select
                            id="address-select"
                            name="address_index"
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
                          <label htmlFor="address-select-single" className="text-xs mb-1 block">Select address:</label>
                          <select
                            id="address-select-single"
                            name="address_index"
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
                    <ul className="space-y-1 max-h-80 overflow-auto pr-1">
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
                    {/* Latest Order Tags */}
                    {orders.length > 0 && (
                      <div className="mt-2">
                        <div className="font-semibold mb-1">Latest Order Tags</div>
                        <div className="flex flex-wrap gap-1 mb-2">
                          {Array.isArray(orders[0].tags) && orders[0].tags.length > 0 ? (
                            orders[0].tags.map((t, i) => (
                              <span key={`${t}-${i}`} className="text-xs bg-gray-600 text-white rounded-full inline-flex items-center">
                                <span className="px-2 py-0.5">{t}</span>
                                <button
                                  type="button"
                                  className="px-1 py-0.5 text-white hover:bg-gray-700 rounded-r"
                                  aria-label={`Remove tag ${t}`}
                                  onClick={async () => {
                                    try {
                                      const latest = orders[0];
                                      await api.delete(`${API_BASE}/shopify-orders/${latest.id}/tags`, { data: { tag: t } });
                                      setOrders(prev => {
                                        const next = Array.isArray(prev) ? [...prev] : [];
                                        if (next.length > 0) {
                                          const tags = (Array.isArray(next[0].tags) ? next[0].tags : []).filter(x => x !== t);
                                          next[0] = { ...next[0], tags };
                                        }
                                        return next;
                                      });
                                    } catch {}
                                  }}
                                >×</button>
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-gray-400">No tags yet.</span>
                          )}
                        </div>
                        <div className="flex gap-2">
                          <input
                            className="flex-1 p-1 rounded bg-gray-800 text-white text-xs"
                            placeholder="Add a tag"
                            value={newOrderTag}
                            onChange={e => setNewOrderTag(e.target.value)}
                          />
                          <button
                            type="button"
                            className="px-2 py-1 bg-blue-600 rounded text-white text-xs"
                            onClick={async () => {
                              const value = (newOrderTag || "").trim();
                              if (!value || orders.length === 0) return;
                              try {
                                const latest = orders[0];
                                await api.post(`${API_BASE}/shopify-orders/${latest.id}/tags`, { tag: value });
                                setOrders(prev => {
                                  const next = Array.isArray(prev) ? [...prev] : [];
                                  if (next.length > 0) {
                                    const tags = Array.isArray(next[0].tags) ? [...next[0].tags] : [];
                                    if (!tags.includes(value)) tags.push(value);
                                    next[0] = { ...next[0], tags };
                                  }
                                  return next;
                                });
                                setNewOrderTag("");
                              } catch {}
                            }}
                          >Add</button>
                        </div>
                      </div>
                    )}

                    {/* Latest Order Notes */}
                    {orders.length > 0 && (
                      <div className="mt-3">
                        <div className="font-semibold mb-1">Latest Order Notes</div>
                        {orders[0].note ? (
                          <div className="text-xs bg-gray-900 border border-gray-700 rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto">
                            {orders[0].note}
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400">No notes yet.</div>
                        )}
                        <div className="mt-2 flex gap-2 items-end">
                          <textarea
                            className="flex-1 p-2 rounded bg-gray-800 text-white text-xs h-16"
                            placeholder="Add a note"
                            value={newOrderNote}
                            onChange={e => setNewOrderNote(e.target.value)}
                          />
                          <button
                            type="button"
                            className="px-2 py-1 bg-blue-600 rounded text-white text-xs h-8 self-end"
                            onClick={async () => {
                              const value = (newOrderNote || "").trim();
                              if (!value || orders.length === 0) return;
                              try {
                                const latest = orders[0];
                                const res = await api.post(`${API_BASE}/shopify-orders/${latest.id}/note`, { note: value });
                                const finalNote = res?.data?.note || value;
                                setOrders(prev => {
                                  const next = Array.isArray(prev) ? [...prev] : [];
                                  if (next.length > 0) {
                                    next[0] = { ...next[0], note: finalNote };
                                  }
                                  return next;
                                });
                                setNewOrderNote("");
                              } catch {}
                            }}
                          >Add Note</button>
                          <button
                            type="button"
                            className="px-2 py-1 bg-gray-600 hover:bg-gray-700 rounded text-white text-xs h-8"
                            onClick={async () => {
                              try {
                                const latest = orders[0];
                                await api.delete(`${API_BASE}/shopify-orders/${latest.id}/note`);
                                setOrders(prev => {
                                  const next = Array.isArray(prev) ? [...prev] : [];
                                  if (next.length > 0) next[0] = { ...next[0], note: "" };
                                  return next;
                                });
                              } catch {}
                            }}
                          >Clear Note</button>
                        </div>
                      </div>
                    )}
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
                      id="customer-search"
                      name="customer_search"
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
                              fetchOrdersWithCooldown(c.customer_id);
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
              <label htmlFor="order-name" className="block text-xs font-bold">Name</label>
              <input
                id="order-name"
                name="name"
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.name}
                onChange={e => handleOrderDataChange('name', e.target.value)}
                autoComplete="off"
                placeholder="Customer name"
                title="Customer full name"
              />
              <label htmlFor="order-email" className="block text-xs font-bold">Email</label>
              <input
                id="order-email"
                name="email"
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.email}
                onChange={e => handleOrderDataChange('email', e.target.value)}
                autoComplete="off"
                placeholder="customer@example.com"
                title="Customer email (optional)"
              />
              <label htmlFor="order-phone" className="block text-xs font-bold">Phone</label>
              <input
                id="order-phone"
                name="phone"
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.phone}
                onChange={e => handleOrderDataChange('phone', e.target.value)}
                autoComplete="off"
                placeholder="+212..."
                title="Customer phone number"
              />
              <label htmlFor="order-city" className="block text-xs font-bold">City <span className="text-red-400">*</span></label>
              <input
                id="order-city"
                name="city"
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.city}
                onChange={e => handleOrderDataChange('city', e.target.value)}
                autoComplete="off"
                required
                placeholder="City"
                title="Shipping city"
              />
              <label htmlFor="order-province" className="block text-xs font-bold">Province <span className="text-red-400">*</span></label>
              <select
                id="order-province"
                name="province"
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.province}
                onChange={e => handleOrderDataChange('province', e.target.value)}
                required
                title="Province/Region"
              >
                <option value="" disabled>Select province</option>
                 {MOROCCO_PROVINCES.map((prov) => (
                   <option key={prov} value={prov}>{prov}</option>
                 ))}
               </select>
              <label htmlFor="order-zip" className="block text-xs font-bold">ZIP <span className="text-red-400">*</span></label>
              <input
                id="order-zip"
                name="zip"
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.zip}
                onChange={e => handleOrderDataChange('zip', e.target.value)}
                autoComplete="off"
                required
                placeholder="Postal code"
                title="Postal/ZIP code"
              />
              <label htmlFor="order-address" className="block text-xs font-bold">Address <span className="text-red-400">*</span></label>
              <input
                id="order-address"
                name="address"
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.address}
                onChange={e => handleOrderDataChange('address', e.target.value)}
                autoComplete="off"
                required
                placeholder="Street address"
                title="Shipping street address"
              />
              {/* Optional note and image URL (collapsed by default) */}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-gray-300">Additional details</summary>
                <div className="mt-2 space-y-1">
                  <label htmlFor="order-note" className="block text-xs font-bold">Order note (timeline text)</label>
                  <textarea
                    id="order-note"
                    name="order_note"
                    className="w-full p-1 rounded bg-gray-800 text-white"
                    rows={3}
                    placeholder="e.g. Customer requested gift wrap."
                    value={orderData.order_note}
                    onChange={e => handleOrderDataChange('order_note', e.target.value)}
                  />
                  <label htmlFor="order-image-url" className="block text-xs font-bold">Image URL (will be saved in note)</label>
                  <input
                    id="order-image-url"
                    name="order_image_url"
                    className="w-full p-1 rounded bg-gray-800 text-white"
                    placeholder="https://..."
                    value={orderData.order_image_url}
                    onChange={e => handleOrderDataChange('order_image_url', e.target.value)}
                    autoComplete="off"
                    title="Optional image URL for order note"
                  />
                  {orderData.order_image_url && (
                    <div className="mt-2">
                      <div className="text-xs text-gray-300 mb-1">Preview:</div>
                      <img
                        src={orderData.order_image_url}
                        alt="Order reference"
                        className="w-24 h-24 object-cover rounded border border-gray-600 bg-gray-900"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        loading="lazy"
                      />
                    </div>
                  )}
                </div>
              </details>
            </div>
            {/* Product search and add section */}
            <hr className="my-2" />
            <h3 className="font-bold text-lg mb-2">Add products</h3>
            <div className="relative">
              <input
                id="product-search"
                name="product_search"
                value={productSearch}
                onChange={e => setProductSearch(e.target.value)}
                placeholder="Search products…"
                className="p-1 rounded bg-gray-800 text-white w-full"
                autoComplete="off"
              />
              {(() => {
                const q = String(productSearch || '').trim().toLowerCase();
                if (!q || products.length === 0) return null;
                const items = [];
                const score = (qstr, v, p) => {
                  try {
                    const s = String(qstr).toLowerCase();
                    const sku = String(v.sku || '').toLowerCase();
                    const vt = String(v.title || '').toLowerCase();
                    const pt = String(p.title || v.product_title || '').toLowerCase();
                    let sc = 0;
                    if (sku.startsWith(s)) sc += 400;
                    if (vt.startsWith(s)) sc += 350;
                    if (pt.startsWith(s)) sc += 300;
                    if (vt.includes(s)) sc += 120;
                    if (pt.includes(s)) sc += 80;
                    return sc;
                  } catch { return 0; }
                };
                products.forEach(p => {
                  (p.variants || []).forEach(v => {
                    items.push({
                      id: v.id,
                      title: v.title,
                      product_title: v.product_title || p.title,
                      price: v.price,
                      image_src: (p.image && p.image.src) || (p.images && p.images[0] && p.images[0].src) || v.image_src || '',
                      __score: score(q, v, p),
                      __variant: v,
                    });
                  });
                });
                const top = items.filter(i => i.__score > 0).sort((a,b)=> b.__score - a.__score).slice(0, 10);
                if (!top.length) return null;
                return (
                  <div className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-auto bg-gray-900 border border-gray-600 rounded shadow-lg">
                    <ul className="divide-y divide-gray-800">
                      {top.map(s => (
                        <li key={s.id} className="p-2 flex items-center gap-2">
                          {s.image_src ? (
                            <img src={s.image_src} alt={s.title || 'Variant'} className="w-8 h-8 rounded object-cover" />
                          ) : (
                            <div className="w-8 h-8 rounded bg-gray-700 text-white grid place-items-center">🛒</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-white truncate" title={s.product_title || s.title}>{s.product_title || s.title}</div>
                            <div className="text-xs text-gray-300 truncate">{s.title} • {Number(s.price||0).toFixed(2)} MAD</div>
                          </div>
                          <button
                            type="button"
                            className="text-xs bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded"
                            onMouseDown={(e)=>{ e.preventDefault(); handleAddVariant(s.__variant); setProductSearch(''); setProducts([]); }}
                          >Add</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}
              {!!productSearch && products.length > 0 && (
                <div className="absolute z-20 left-0 right-0 mt-1 max-h-64 overflow-auto bg-gray-900 border border-gray-600 rounded shadow-lg">
                  <ul className="divide-y divide-gray-700">
                    {products.map((product) => (
                      <li key={product.id} className="p-2">
                        <div className="font-semibold text-sm text-white truncate" title={product.title}>{product.title}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(product.variants || []).map((variant) => (
                            <button
                              type="button"
                              key={variant.id}
                              className="text-xs border border-gray-600 text-gray-200 hover:bg-gray-800 px-2 py-1 rounded"
                              onClick={() => handleAddVariant(variant)}
                              title={variant.title}
                            >
                              {variant.title} • {variant.price} MAD
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="mt-2">
              <input
                id="variant-id"
                name="variant_id"
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
              {variantSuggestions.length > 0 && (
                <div className="relative">
                  <div className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto bg-gray-900 border border-gray-700 rounded shadow-lg">
                    <ul className="divide-y divide-gray-800">
                      {variantSuggestions.map(s => (
                        <li key={s.id} className="p-2 flex items-center gap-2">
                          {s.image_src ? (
                            <img src={s.image_src} alt={s.title || 'Variant'} className="w-8 h-8 rounded object-cover" />
                          ) : (
                            <div className="w-8 h-8 rounded bg-gray-700 text-white grid place-items-center">🛒</div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-white truncate" title={s.product_title || s.title}>{s.product_title || s.title}</div>
                            <div className="text-xs text-gray-300 truncate">{s.title} • ID {String(s.id).slice(-8)} • {Number(s.price||0).toFixed(2)} MAD</div>
                          </div>
                          <button
                            type="button"
                            className="text-xs bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded"
                            onMouseDown={(e)=>{ e.preventDefault(); handleAddVariant(s.__variant); setVariantIdInput(''); setVariantPreview(null); setVariantSuggestions([]); }}
                          >Add</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {variantPreview && (
                <div className="mt-2 p-2 bg-gray-800 border border-gray-700 rounded flex items-center gap-2">
                  {variantPreview.image_src ? (
                    <img src={variantPreview.image_src} alt={variantPreview.title || "Variant"} className="w-10 h-10 object-cover rounded" />
                  ) : (
                    <div className="w-10 h-10 rounded bg-gray-600 flex items-center justify-center">🛒</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white truncate" title={variantPreview.product_title || variantPreview.title}>
                      {variantPreview.product_title || variantPreview.title}
                    </div>
                    <div className="text-xs text-gray-300 truncate">
                      ID: {variantPreview.id} • {Number(variantPreview.price || 0).toFixed(2)} MAD
                    </div>
                  </div>
                  <button
                    type="button"
                    className="text-xs bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded"
                    onClick={() => {
                      handleAddVariant(variantPreview);
                      setVariantIdInput("");
                      setVariantPreview(null);
                    }}
                  >
                    Add
                  </button>
                </div>
              )}
            </div>
            {/* Selected items table with images and pricing */}
            <div className="w-full overflow-x-auto mt-2">
            <table className="text-xs min-w-[560px] table-fixed">
              <thead>
                <tr>
                  <th className="text-left w-[160px]">Item</th>
                  <th className="w-[160px]">Variant</th>
                  <th className="w-[80px]">Price</th>
                  <th className="w-[70px]">Qty</th>
                  <th className="w-[90px]">Discount</th>
                  <th className="w-[90px]">Subtotal</th>
                  <th className="w-[70px]">Remove</th>
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
                          {/* Hide product title to avoid overflow; show compact details instead */}
                          <div className="text-[11px] text-gray-300 truncate max-w-[120px]">ID: {String(item.variant.id).slice(-8)}</div>
                          {item.variant.sku && (
                            <div className="text-[11px] text-gray-400 truncate max-w-[120px]">SKU: {item.variant.sku}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="truncate" title={item.variant.title}>{item.variant.title}</td>
                    <td className="text-center whitespace-nowrap">{priceNum.toFixed(2)} MAD</td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={e => handleItemChange(idx, "quantity", Number(e.target.value))}
                        className="w-14 bg-gray-800 text-white p-1"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={item.discount}
                        onChange={e => handleItemChange(idx, "discount", Number(e.target.value))}
                        className="w-16 bg-gray-800 text-white p-1"
                        placeholder="MAD"
                      />
                    </td>
                    <td className="text-center font-semibold whitespace-nowrap">{subtotal.toFixed(2)} MAD</td>
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
            </div>
            {selectedItems.length > 0 && (
              <div className="mt-2 text-right font-bold text-sm">
                {(() => {
                  const totalRaw = selectedItems.reduce((sum, item) => {
                    const p = Number(item.variant.price || 0);
                    const q = Number(item.quantity || 1);
                    const d = Number(item.discount || 0);
                    return sum + Math.max(0, p * q - d);
                  }, 0);
                  const total = (Math.round(totalRaw * 100) / 100).toFixed(2);
                  return <span>Total: {total} MAD</span>;
                })()}
              </div>
            )}
            {/* Delivery Option */}
            <div className="mt-2">
              <label htmlFor="delivery-option" className="block font-bold text-xs mb-1">Delivery</label>
              <select
                id="delivery-option"
                name="delivery"
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
                {Array.isArray(lastResult.warnings) && lastResult.warnings.length > 0 && (
                  <ul className="mt-1 text-yellow-300 list-disc list-inside">
                    {lastResult.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
