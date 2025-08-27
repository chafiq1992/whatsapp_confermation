import api from "./api";
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { loadCatalogSets, saveCatalogSets, loadCatalogSetProducts, saveCatalogSetProducts } from "./chatStorage";

const API_BASE = process.env.REACT_APP_API_BASE || "";

export default function CatalogPanel({
  activeUser,
  websocket,
  onMessageSent,
}) {
  // Sets and selection
  const [sets, setSets] = useState([]);
  const [loadingSets, setLoadingSets] = useState(false);
  const [selectedSet, setSelectedSet] = useState(null);

  // Products and pagination
  const PAGE_SIZE = 24;
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [fetchLimit, setFetchLimit] = useState(PAGE_SIZE);
  const gridRef = useRef(null);
  const abortRef = useRef(null);

  // Selected images (URLs)
  const [selectedImages, setSelectedImages] = useState([]);

  // Pending ops indicator (for optimistic sends)
  const [pendingOperations, setPendingOperations] = useState(new Set());

  // Modal state (grid popup)
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");

  // Send mode: 'product' (interactive) or 'image'
  const [sendMode, setSendMode] = useState('product');

  // Temporary status for sending an entire set
  const [sendingSet, setSendingSet] = useState(false);

  // Fetch sets list with SWR (cache first, then refresh)
  const fetchSets = async () => {
    setLoadingSets(true);
    try {
      const cached = await loadCatalogSets();
      if (cached?.length) {
        setSets(cached);
        if (!selectedSet) setSelectedSet(cached[0].id);
      }
    } catch {}
    try {
      const res = await api.get(`${API_BASE}/catalog-sets`);
      const list = Array.isArray(res.data) ? res.data : [];
      setSets(list);
      await saveCatalogSets(list);
      if (!selectedSet && list.length > 0) {
        setSelectedSet(list[0].id);
      }
      // Prefetch top sets into IndexedDB to speed up modal open
      try {
        const top = list.slice(0, 4);
        const concurrency = 2;
        let i = 0;
        const runNext = async () => {
          if (i >= top.length) return;
          const s = top[i++];
          if (!s?.id) return runNext();
          const cachedSet = await loadCatalogSetProducts(s.id);
          if (!cachedSet || cachedSet.length === 0) {
            try {
              const resp = await api.get(`${API_BASE}/catalog-set-products`, { params: { set_id: s.id, limit: PAGE_SIZE } });
              const arr = Array.isArray(resp.data) ? resp.data : [];
              if (arr.length) await saveCatalogSetProducts(s.id, arr);
            } catch {}
          }
          return runNext();
        };
        await Promise.all(Array.from({ length: concurrency }, () => runNext()));
      } catch {}
    } catch (err) {
      console.error("Error fetching sets:", err);
      if (!Array.isArray(sets) || sets.length === 0) setSets([]);
    }
    setLoadingSets(false);
  };

  // Fetch products for current set with increasing limit (simple pagination)
  const fetchProducts = async (setId, limit) => {
    if (!setId) return [];
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoadingProducts(true);
    try {
      const res = await api.get(`${API_BASE}/catalog-set-products`, {
        params: { set_id: setId, limit: limit || PAGE_SIZE },
        signal: controller.signal,
      });
      const list = Array.isArray(res.data) ? res.data : [];
      setProducts(list);
      try { await saveCatalogSetProducts(setId, list); } catch {}
      setHasMore(list.length >= (limit || PAGE_SIZE));
      return list;
    } catch (err) {
      if (err?.name !== "CanceledError") console.error("Error fetching set products:", err);
      setProducts([]);
      setHasMore(false);
      return [];
    } finally {
      setLoadingProducts(false);
    }
  };

  // Infinite scroll handler
  useEffect(() => {
    if (!modalOpen) return;
    const el = gridRef.current;
    if (!el) return;
    const onScroll = () => {
      if (loadingProducts || !hasMore) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
      if (nearBottom) {
        setFetchLimit((l) => l + PAGE_SIZE);
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [modalOpen, loadingProducts, hasMore]);

  const generateTempId = () => `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Send optimistic message via WebSocket
  const sendOptimisticMessage = useCallback((messageData) => {
    if (!websocket || websocket.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not connected');
      return null;
    }

    const tempId = generateTempId();
    const optimisticMessage = {
      id: tempId,
      user_id: activeUser.user_id,
      from_me: true,
      status: 'sending',
      timestamp: new Date().toISOString(),
      temp_id: tempId,
      ...messageData
    };

    // Send via WebSocket for instant UI update
    websocket.send(JSON.stringify({
      type: 'send_message',
      data: optimisticMessage
    }));

    // Track as pending
    setPendingOperations(prev => new Set([...prev, tempId]));

    // Notify parent about optimistic message
    if (onMessageSent) {
      onMessageSent(optimisticMessage);
    }

    return tempId;
  }, [websocket, activeUser?.user_id, onMessageSent]);

  // Send a single image (direct link) via WebSocket
  const sendImageUrl = (url, caption = "") => {
    if (!activeUser?.user_id) return;
    return sendOptimisticMessage({
      type: 'image',
      message: url,
      url,
      caption,
    });
  };

  // Send interactive catalog product (with price/title) via backend
  const sendInteractiveProduct = async (product) => {
    if (!activeUser?.user_id || !product?.retailer_id) return;
    const caption = product?.name && product?.price ? `${product.name} • ${product.price}` : (product?.name || "");
    // Optimistic bubble (text) while interactive sends
    sendOptimisticMessage({ type: 'text', message: caption || 'Product' });
    const body = new URLSearchParams({ user_id: activeUser.user_id, product_retailer_id: String(product.retailer_id), caption });
    try { await api.post(`${API_BASE}/send-catalog-item`, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); } catch {}
  };

  // Send whole set by requesting backend to deliver the selected set
  const sendWholeSet = async () => {
    if (!activeUser?.user_id || !selectedSet) return;

    // Build a caption that mirrors what the customer will see
    const setInfo = sets.find((s) => s.id === selectedSet);
    const captionDetails = [];
    if (setInfo?.name) captionDetails.push(setInfo.name);
    if (setInfo?.item_count) captionDetails.push(`${setInfo.item_count} items`);
    const captionText = captionDetails.length
      ? `Sending entire set: ${captionDetails.join(' • ')}…`
      : 'Sending entire set…';

    // Optimistic bubble before hitting the API
    const tempId = sendOptimisticMessage({ type: 'text', message: captionText });

    setSendingSet(true);
    try {
      await api.post(
        `${API_BASE}/send-catalog-set-all`,
        new URLSearchParams({
          user_id: activeUser.user_id,
          set_id: selectedSet,
          caption: captionDetails.join(' • '),
          temp_id: tempId,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
    } catch (err) {
      console.error('Error sending full set:', err);
    } finally {
      setSendingSet(false);
    }
  };

  const sendEntireCatalog = async () => {
    if (!activeUser?.user_id) return;
    let ids = [];
    try {
      const res = await api.get(`${API_BASE}/catalog-all-products`);
      ids = Array.isArray(res.data)
        ? res.data.map(p => p.retailer_id).filter(Boolean)
        : [];
    } catch (err) {
      console.error('Error fetching catalog:', err);
    }
    sendOptimisticMessage({ type: 'text', message: 'Sending full catalog…' });
    try {
      await api.post(
        `${API_BASE}/send-catalog-all`,
        new URLSearchParams({
          user_id: activeUser.user_id,
          product_ids: JSON.stringify(ids)
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
    } catch {}
  };

  // Send selected images (direct links)
  const sendSelectedImages = async () => {
    if (!activeUser?.user_id || selectedImages.length === 0) {
      alert("Please select at least one image.");
      return;
    }
    if (sendMode === 'product') {
      // Map URLs back to products by first image URL
      const urlToProduct = new Map();
      for (const p of products) {
        const u = p.images?.[0]?.url;
        if (u) urlToProduct.set(u, p);
      }
      const items = selectedImages.map(u => urlToProduct.get(u)).filter(Boolean);
      // Send each as interactive product (fast)
      for (const p of items) {
        await sendInteractiveProduct(p);
        await new Promise(r => setTimeout(r, 30));
      }
    } else {
      for (const url of selectedImages) {
        sendImageUrl(url);
        await new Promise(r => setTimeout(r, 40));
      }
    }
  };

  // Listen for WebSocket message status updates
  useEffect(() => {
    if (!websocket) return;

    const handleMessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'message_status_update') {
          const { temp_id, status } = data.data;
          
          if (temp_id && pendingOperations.has(temp_id)) {
            if (status === 'sent' || status === 'failed') {
              // Remove from pending operations
              setPendingOperations(prev => {
                const newSet = new Set(prev);
                newSet.delete(temp_id);
                return newSet;
              });
            }
          }
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    websocket.addEventListener('message', handleMessage);
    
    return () => {
      websocket.removeEventListener('message', handleMessage);
    };
  }, [websocket, pendingOperations]);

  // Initial load of sets
  useEffect(() => { fetchSets(); }, []);

  // Refresh Catalog Button Component
  function RefreshCatalogButton({ onRefresh }) {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState("");

    const handleRefresh = async () => {
      setLoading(true);
      setResult("");
      try {
        const res = await api.post(`${API_BASE}/refresh-catalog-cache`);
        setResult(`✅ Catalog refreshed: ${res.data.count} products`);
        if (onRefresh) onRefresh();
      } catch (err) {
        console.error('Error refreshing catalog:', err);
        setResult("❌ Error refreshing catalog");
      }
      setLoading(false);
    };

    return (
      <div className="flex items-center gap-2">
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          type="button"
        >
          {loading ? "Refreshing..." : "Refresh Catalog"}
        </button>
        {result && <span className="text-sm">{result}</span>}
      </div>
    );
  }

  const isWebSocketConnected = websocket && websocket.readyState === WebSocket.OPEN;

  // Derived helpers
  const selectedCount = selectedImages.length;
  const toggleSelect = (url) => {
    setSelectedImages(prev => prev.includes(url) ? prev.filter(u => u !== url) : [...prev, url]);
  };
  const selectAllVisible = () => {
    const urls = products.map(p => p.images?.[0]?.url).filter(Boolean);
    setSelectedImages(urls);
  };
  const clearSelection = () => setSelectedImages([]);

  const openSetModal = async (setObj) => {
    setSelectedSet(setObj.id);
    setModalTitle(setObj.name || setObj.id);
    setFetchLimit(PAGE_SIZE);
    setSelectedImages([]);
    setLoadingProducts(true);
    setModalOpen(true);
    // Show cached instantly
    try {
      const cached = await loadCatalogSetProducts(setObj.id);
      if (Array.isArray(cached) && cached.length) setProducts(cached);
    } catch {}
    await fetchProducts(setObj.id, PAGE_SIZE);
  };

  return (
    <div className="bg-white text-black border-t border-gray-300 p-2 w-full max-h-[110px] overflow-hidden rounded-b-xl shadow-sm flex-none">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-blue-700">Catalog</h2>
        <div className="flex items-center gap-2">
          <RefreshCatalogButton onRefresh={fetchSets} />
          <button
            onClick={sendEntireCatalog}
            disabled={!isWebSocketConnected || !activeUser?.user_id}
            className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 disabled:opacity-50"
            type="button"
          >
            Send entire catalog
          </button>
          <div className={`w-2.5 h-2.5 rounded-full ${isWebSocketConnected ? 'bg-green-500' : 'bg-red-500'}`} title={isWebSocketConnected ? 'Connected' : 'Disconnected'} />
        </div>
      </div>

      {sendingSet && (
        <div className="flex items-center mb-2 text-xs text-gray-500">
          <span className="inline-block w-3 h-3 mr-1 border-2 border-gray-300 border-t-transparent rounded-full animate-spin"></span>
          Sending full set…
        </div>
      )}

      {/* Sets grid (2-3 rows, wraps within panel) */}
      <div className="catalog-sets grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 max-h-[84px] overflow-auto">
        {loadingSets ? (
          <div className="text-xs text-gray-500 col-span-full">Loading sets…</div>
        ) : (
          sets.map(s => (
            <button
              key={s.id}
              className="px-2.5 py-1 text-[12px] font-medium rounded border border-gray-300 bg-gray-100 hover:bg-gray-200 text-black truncate shadow-sm"
              title={s.name || s.id}
              onClick={() => openSetModal(s)}
              type="button"
            >
              <span className="truncate inline-block max-w-full text-black">{s.name || s.id}</span>
            </button>
          ))
        )}
      </div>

      {/* Modal popup with grid and actions */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
          <div className="relative bg-white rounded-xl p-3 w-[92vw] max-w-5xl max-h-[88vh] flex flex-col">
            {/* Modal header */}
            <div className="flex items-center gap-2 mb-2">
              <div className="font-semibold text-gray-800 text-sm flex-1 truncate">{modalTitle}</div>
              <span className="text-xs text-gray-500 mr-2">Selected: {selectedCount}</span>
              <div className="flex items-center gap-1 mr-2">
                <span className="text-[11px] text-gray-600">Send as:</span>
                <button className={`px-2 py-0.5 text-[11px] rounded ${sendMode==='product'?'bg-blue-600 text-white':'bg-gray-200 text-black'}`} onClick={()=>setSendMode('product')}>Product</button>
                <button className={`px-2 py-0.5 text-[11px] rounded ${sendMode==='image'?'bg-blue-600 text-white':'bg-gray-200 text-black'}`} onClick={()=>setSendMode('image')}>Image</button>
              </div>
              <button className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300" onClick={selectAllVisible}>Select all</button>
              <button className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300" onClick={clearSelection}>Clear</button>
              <button className="px-2 py-1 text-xs rounded bg-blue-600 text-white disabled:opacity-50" disabled={!isWebSocketConnected || selectedCount === 0} onClick={() => { sendSelectedImages(); setModalOpen(false); }}>Send selected</button>
              <button className="px-2 py-1 text-xs rounded bg-green-600 text-white disabled:opacity-50" disabled={!isWebSocketConnected || products.length === 0} onClick={() => { sendWholeSet(); setModalOpen(false); }}>Send whole set</button>
              <button className="ml-2 px-2 py-1 text-xs rounded bg-red-600 text-white" onClick={() => setModalOpen(false)}>Close</button>
            </div>

            {/* Grid */}
            <div ref={gridRef} className="flex-1 overflow-y-auto">
              {loadingProducts && products.length === 0 ? (
                <div className="grid grid-cols-4 gap-2">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="h-24 bg-gray-100 animate-pulse rounded" />
                  ))}
                </div>
              ) : products.length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-6">No products in this set.</div>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {products.map((p, idx) => {
                    const url = p.images?.[0]?.url;
                    const checked = url && selectedImages.includes(url);
                    return (
                      <div key={`${p.retailer_id}-${idx}`} className="relative group border rounded overflow-hidden">
                        {url && (
                          <input type="checkbox" className="absolute top-1 right-1 z-10 scale-110" checked={checked} onChange={() => toggleSelect(url)} />
                        )}
                        <div className="w-full h-24 bg-gray-100 flex items-center justify-center">
                          {url ? (
                            <img src={url} alt={p.name} className="w-full h-24 object-cover" loading="lazy" />
                          ) : (
                            <span className="text-xs text-gray-400">No Image</span>
                          )}
                        </div>
                        {/* Inline send product button */}
                        <div className="absolute left-1 bottom-1 flex gap-1">
                          <button className="px-1.5 py-0.5 text-[10px] rounded bg-blue-600 text-white" title="Send product" onClick={()=>sendInteractiveProduct(p)}>Product</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {loadingProducts && products.length > 0 && (
                <div className="text-center text-gray-500 text-xs py-2">Loading…</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}