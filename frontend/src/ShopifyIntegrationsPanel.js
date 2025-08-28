import React, { useState, useEffect } from "react";
import { FaShopify } from "react-icons/fa";
import api from "./api";

export default function ShopifyIntegrationsPanel({ activeUser }) {
  const API_BASE = process.env.REACT_APP_API_BASE || "";

  const [customer, setCustomer] = useState(null);
  const [customersList, setCustomersList] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [selectedAddressIdx, setSelectedAddressIdx] = useState(0);
  const [loading, setLoading] = useState(false);

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
        });
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
        });
      } else {
        setCustomer(null);
        setOrderData(prev => ({ ...prev, phone: activeUser.phone || "" }));
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

  const handleCreateOrder = async () => {
    setErrorMsg("");
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
      market,
    };

    setIsCreating(true);
    try {
      await api.post(`${API_BASE}/create-shopify-order`, orderPayload);
      setSelectedItems([]);
      setErrorMsg("");
      alert("Order created successfully!");
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
            <div className="flex justify-end">
              <button
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 rounded text-sm"
                onClick={() => { window.location.href = '/#/automation-studio'; }}
              >
                Open Automation Studio (new page)
              </button>
            </div>
            {!activeUser?.phone && (
              <p>Select a conversation with a user to fetch Shopify customer info by phone.</p>
            )}
            {activeUser?.phone && loading && <p>Loading customer info...</p>}
            {activeUser?.phone && !loading && (customer || customersList.length > 0) && (
              <>
                {customersList.length > 0 ? (
                  <div className="space-y-2">
                    <div className="text-sm text-gray-300">Multiple customers found for this phone:</div>
                    {customersList.map((c) => (
                      <div key={c.customer_id} className={`p-2 rounded border ${selectedCustomerId===c.customer_id? 'border-green-500':'border-gray-600'}`}>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="customerChoice"
                            checked={selectedCustomerId === c.customer_id}
                            onChange={() => {
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
                            }}
                          />
                          <span className="font-semibold">{c.name || '(no name)'} • {c.phone || ''}</span>
                        </label>
                        {Array.isArray(c.addresses) && c.addresses.length > 0 && (
                          <div className="ml-6 mt-1">
                            <div className="text-xs mb-1">Address:</div>
                            <select
                              className="bg-gray-800 text-white p-1 rounded"
                              value={selectedCustomerId===c.customer_id ? selectedAddressIdx : 0}
                              onChange={(e) => {
                                const idx = Number(e.target.value) || 0;
                                setSelectedCustomerId(c.customer_id);
                                setSelectedAddressIdx(idx);
                                const addr = c.addresses[idx] || {};
                                setOrderData(d => ({
                                  ...d,
                                  address: addr.address1 || "",
                                  city: addr.city || "",
                                  province: addr.province || "",
                                  zip: addr.zip || "",
                                  phone: c.phone || activeUser.phone,
                                  name: c.name || d.name,
                                  email: c.email || d.email,
                                }));
                              }}
                            >
                              {c.addresses.map((a, idx) => (
                                <option key={idx} value={idx}>{a.address1 || ''} {a.city ? `, ${a.city}`: ''}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    <p><strong>Name:</strong> {customer.name}</p>
                    <p><strong>Email:</strong> {customer.email}</p>
                    <p><strong>Phone:</strong> {customer.phone}</p>
                    <p><strong>Address:</strong> {customer.address}</p>
                  </>
                )}
                <hr className="my-2" />
                <p><strong>Total Orders:</strong> {(customer || customersList[0])?.total_orders}</p>
                {(customer || customersList[0])?.last_order && (
                  <div>
                    <p><strong>Last Order Number:</strong> {(customer || customersList[0])?.last_order.order_number}</p>
                    <p><strong>Order Total:</strong> {(customer || customersList[0])?.last_order.total_price}</p>
                    <ul className="ml-4 list-disc">
                      {(customer || customersList[0])?.last_order.line_items.map((li, idx) => (
                        <li key={idx}>
                          {li.quantity} x {li.title} {li.variant_title ? `(${li.variant_title})` : ""}
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
              <label className="block text-xs font-bold">city</label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.city}
                onChange={e => handleOrderDataChange('city', e.target.value)}
                autoComplete="off"
              />
              <label className="block text-xs font-bold">province</label>
              <select
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.province}
                onChange={e => handleOrderDataChange('province', e.target.value)}
              >
                <option value="" disabled>Select province</option>
                 {MOROCCO_PROVINCES.map((prov) => (
                   <option key={prov} value={prov}>{prov}</option>
                 ))}
               </select>
              <label className="block text-xs font-bold">zip</label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.zip}
                onChange={e => handleOrderDataChange('zip', e.target.value)}
                autoComplete="off"
              />
              <label className="block text-xs font-bold">Address</label>
              <input
                className="w-full p-1 rounded bg-gray-800 text-white"
                value={orderData.address}
                onChange={e => handleOrderDataChange('address', e.target.value)}
                autoComplete="off"
              />
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
            {/* Selected items table */}
            <table className="w-full text-xs mt-2">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Variant</th>
                  <th>Qty</th>
                  <th>Discount</th>
                  <th>Remove</th>
                </tr>
              </thead>
              <tbody>
                {selectedItems.map((item, idx) => (
                  <tr key={item.variant.id}>
                    <td>{item.variant.product_title || "--"}</td>
                    <td>{item.variant.title}</td>
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
                    <td>
                      <button
                        type="button"
                        className="text-red-400"
                        onClick={() => removeOrderItem(idx)}
                      >✖</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
          </form>
        )}
      </div>
    </div>
  );
}
