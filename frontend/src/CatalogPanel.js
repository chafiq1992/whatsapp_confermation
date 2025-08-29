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
  const requestIdRef = useRef(0);

  // Selected images (URLs)
  const [selectedImages, setSelectedImages] = useState([]);

  // Pending ops indicator (for optimistic sends)
  const [pendingOperations, setPendingOperations] = useState(new Set());

  // Modal state (grid popup)
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMode, setModalMode] = useState('products'); // 'folders' | 'products'
  const [folderSets, setFolderSets] = useState([]); // sets shown as folders in folder view
  const [activeFilter, setActiveFilter] = useState(null); // 'girls' | 'boys' | 'all'

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
    const reqId = ++requestIdRef.current;
    try {
      const res = await api.get(`${API_BASE}/catalog-set-products`, {
        params: { set_id: setId, limit: limit || PAGE_SIZE },
        signal: controller.signal,
      });
      const list = Array.isArray(res.data) ? res.data : [];
      // Only update if this is the latest request and the same set is still selected
      if (reqId === requestIdRef.current && selectedSet === setId) {
        setProducts(list);
        setHasMore(list.length >= (limit || PAGE_SIZE));
      }
      try { await saveCatalogSetProducts(setId, list); } catch {}
      return list;
    } catch (err) {
      if (err?.name !== "CanceledError") console.error("Error fetching set products:", err);
      if (reqId === requestIdRef.current && selectedSet === setId) {
        // Preserve existing items; just stop further pagination on error
        setHasMore(false);
      }
      return [];
    } finally {
      if (reqId === requestIdRef.current) {
        setLoadingProducts(false);
      }
    }
  };

  // Infinite scroll handler
  useEffect(() => {
    if (!modalOpen || modalMode !== 'products') return;
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
  }, [modalOpen, modalMode, loadingProducts, hasMore]);

  // Re-fetch more products when fetchLimit increases
  useEffect(() => {
    if (!modalOpen || modalMode !== 'products' || !selectedSet) return;
    fetchProducts(selectedSet, fetchLimit);
  }, [fetchLimit]);

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

  // Send interactive catalog product instantly via WebSocket
  const sendInteractiveProduct = async (product) => {
    if (!activeUser?.user_id || !product?.retailer_id) return;
    const caption = product?.name && product?.price ? `${product.name} • ${product.price}` : (product?.name || "");
    sendOptimisticMessage({
      type: 'catalog_item',
      message: caption || 'Product',
      product_retailer_id: String(product.retailer_id),
      caption,
    });
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

  // Removed legacy "Send entire catalog" action per product requirements

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
    setModalMode('products');
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

  // Helpers: filter sets by prefix (case-insensitive)
  const filterSetsByPrefix = (prefix) => {
    const p = String(prefix || '').trim().toLowerCase();
    return sets.filter(s => (s?.name || s?.id || '').toString().toLowerCase().startsWith(p));
  };

  // Open folder view modal for a filter (girls/boys/all)
  const openFolderModal = async (filter) => {
    setActiveFilter(filter);
    const title = filter === 'girls' ? 'Girls' : filter === 'boys' ? 'Boys' : 'All Sets';
    setModalTitle(title);
    setModalMode('folders');
    setSelectedImages([]);
    setProducts([]);
    setModalOpen(true);

    const fsets = filter === 'all' ? sets.filter(s => s?.id) : filterSetsByPrefix(filter);
    setFolderSets(fsets);

    // Prefetch first few sets in the background for instant entry
    try {
      const top = fsets.slice(0, 4);
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
  };

  const enterFolder = async (setObj) => {
    await openSetModal(setObj);
  };

  return (
    <div className="bg-white text-black border-t border-gray-300 p-2 w-full max-h-[110px] overflow-hidden rounded-b-xl shadow-sm flex-none">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-blue-700">Catalog</h2>
        <div className="flex items-center gap-2">
          <RefreshCatalogButton onRefresh={fetchSets} />
          <div className={`w-2.5 h-2.5 rounded-full ${isWebSocketConnected ? 'bg-green-500' : 'bg-red-500'}`} title={isWebSocketConnected ? 'Connected' : 'Disconnected'} />
        </div>
      </div>

      {sendingSet && (
        <div className="flex items-center mb-2 text-xs text-gray-500">
          <span className="inline-block w-3 h-3 mr-1 border-2 border-gray-300 border-t-transparent rounded-full animate-spin"></span>
          Sending full set…
        </div>
      )}

      {/* Filter buttons: Girls / Boys / All */}
      <div className="catalog-sets grid grid-cols-3 gap-2 max-h-[84px]">
        {loadingSets ? (
          <div className="text-xs text-gray-500 col-span-full">Loading sets…</div>
        ) : sets.length === 0 ? (
          <div className="text-xs text-gray-600 col-span-full flex items-center gap-2">
            <span>No sets available.</span>
            <button className="px-2 py-1 bg-gray-200 rounded" onClick={fetchSets} type="button">Retry</button>
          </div>
        ) : (
          <>
            <button
              className="px-3 py-2 text-sm font-semibold rounded bg-pink-600 text-white hover:bg-pink-700 shadow-sm"
              type="button"
              onClick={() => openFolderModal('girls')}
            >
              Girls
            </button>
            <button
              className="px-3 py-2 text-sm font-semibold rounded bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
              type="button"
              onClick={() => openFolderModal('boys')}
            >
              Boys
            </button>
            <button
              className="px-3 py-2 text-sm font-semibold rounded bg-gray-800 text-white hover:bg-black shadow-sm"
              type="button"
              onClick={() => openFolderModal('all')}
            >
              All
            </button>
          </>
        )}
      </div>

      {/* Modal popup with grid and actions */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center">
          <div className="relative bg-white rounded-xl p-3 w-[92vw] max-w-5xl max-h-[88vh] flex flex-col">
            {/* Modal header */}
            <div className="flex items-center gap-2 mb-2">
              {modalMode === 'products' && (
                <button className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300" onClick={() => { setModalMode('folders'); setProducts([]); setSelectedImages([]); }}>
                  ← Back
                </button>
              )}
              <div className="font-semibold text-gray-800 text-sm flex-1 truncate">{modalTitle}</div>
              {modalMode === 'products' ? (
                <>
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
                </>
              ) : (
                <span className="text-xs text-gray-500">Select a set</span>
              )}
              <button className="ml-2 px-2 py-1 text-xs rounded bg-red-600 text-white" onClick={() => setModalOpen(false)}>Close</button>
            </div>

            {/* Grid */}
            <div ref={gridRef} className="flex-1 min-h-0 overflow-y-auto">
              {modalMode === 'folders' ? (
                <div className="grid grid-cols-4 gap-3">
                  {folderSets.length === 0 ? (
                    <div className="text-center text-gray-500 text-sm py-6 col-span-4">No sets found.</div>
                  ) : (
                    folderSets.map((s) => (
                      <button
                        key={s.id}
                        className="relative border rounded p-3 bg-gray-50 hover:bg-gray-100 text-left"
                        title={s.name || s.id}
                        onClick={() => enterFolder(s)}
                        type="button"
                      >
                        <div className="w-10 h-7 mb-2 bg-yellow-300 rounded-sm" />
                        <div className="text-xs font-medium text-gray-800 truncate">{s.name || s.id}</div>
                      </button>
                    ))
                  )}
                </div>
              ) : (
                <>
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
                                <img
                                  src={url}
                                  data-src={url}
                                  alt={p.name}
                                  className="w-full h-24 object-cover"
                                  loading="lazy"
                                  onError={(e) => {
                                    const el = e.currentTarget;
                                    if (el.dataset.fallback === '1') return;
                                    el.dataset.fallback = '1';
                                    const original = el.getAttribute('data-src') || el.src;
                                    el.src = `${API_BASE}/proxy-image?url=${encodeURIComponent(original)}`;
                                  }}
                                />
                              ) : (
                                <span className="text-xs text-gray-400">No Image</span>
                              )}
                            </div>
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
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}