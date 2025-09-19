import api from "./api";
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { FiRefreshCw } from "react-icons/fi";
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
  const fetchInFlightRef = useRef(false);
  const fetchLimitTimerRef = useRef(null);

  // Selected images (URLs)
  const [selectedImages, setSelectedImages] = useState([]);

  // Pending ops indicator (for optimistic sends)
  const [pendingOperations, setPendingOperations] = useState(new Set());
  // Outbox for queued sends when WS is unavailable
  const [sendQueue, setSendQueue] = useState([]);

  // Modal state (grid popup)
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMode, setModalMode] = useState('products'); // 'folders' | 'products'
  const [folderSets, setFolderSets] = useState([]); // sets shown as folders in folder view
  const [activeFilter, setActiveFilter] = useState(null); // 'girls' | 'boys' | 'all'

  // All selections send as images (product toggle removed per requirements)

  // Temporary status for sending an entire set
  const [sendingSet, setSendingSet] = useState(false);
  const autoLoadAttemptsRef = useRef(0);

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
      // Only update if this is the latest request (avoid stale overwrites)
      if (reqId === requestIdRef.current) {
        setProducts(list);
        setHasMore(list.length >= (limit || PAGE_SIZE));
        // Prefetch first few images to render instantly
        try {
          const urls = (list || []).slice(0, 12).map(p => p?.images?.[0]?.url).filter(Boolean);
          urls.forEach(u => { const img = new Image(); img.decoding = 'async'; img.loading = 'eager'; img.src = u; });
        } catch {}
      }
      try { await saveCatalogSetProducts(setId, list); } catch {}
      return list;
    } catch (err) {
      if (err?.name !== "CanceledError") console.error("Error fetching set products:", err);
      if (reqId === requestIdRef.current) {
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

  // Infinite scroll handler (debounced increment)
  useEffect(() => {
    if (!modalOpen || modalMode !== 'products') return;
    const el = gridRef.current;
    if (!el) return;
    const onScroll = () => {
      if (loadingProducts || !hasMore || fetchInFlightRef.current) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
      if (nearBottom) {
        if (fetchLimitTimerRef.current) clearTimeout(fetchLimitTimerRef.current);
        fetchLimitTimerRef.current = setTimeout(() => {
          setFetchLimit((l) => l + PAGE_SIZE);
        }, 200);
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => { el.removeEventListener('scroll', onScroll); if (fetchLimitTimerRef.current) clearTimeout(fetchLimitTimerRef.current); };
  }, [modalOpen, modalMode, loadingProducts, hasMore]);

  // Re-fetch more products when fetchLimit increases; guard to one request at a time
  useEffect(() => {
    if (!modalOpen || modalMode !== 'products' || !selectedSet) return;
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    Promise.resolve(fetchProducts(selectedSet, fetchLimit)).finally(() => { fetchInFlightRef.current = false; });
  }, [fetchLimit]);

  // Auto-load more until scroll is available (bounded attempts; debounced)
  useEffect(() => {
    if (!modalOpen || modalMode !== 'products') return;
    const el = gridRef.current;
    if (!el) return;
    const canScroll = el.scrollHeight > el.clientHeight + 20;
    if (!canScroll && hasMore && products.length >= fetchLimit && autoLoadAttemptsRef.current < 6) {
      autoLoadAttemptsRef.current += 1;
      if (fetchLimitTimerRef.current) clearTimeout(fetchLimitTimerRef.current);
      fetchLimitTimerRef.current = setTimeout(() => setFetchLimit((l) => l + PAGE_SIZE), 150);
    }
  }, [products, hasMore, modalOpen, modalMode, fetchLimit]);

  const generateTempId = () => `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Send optimistic message via WebSocket
  const sendOptimisticMessage = useCallback((messageData) => {
    const tempId = generateTempId();
    const payload = {
      id: tempId,
      temp_id: tempId,
      user_id: activeUser.user_id,
      from_me: true,
      status: 'sending',
      timestamp: new Date().toISOString(),
      ...messageData,
    };

    // Notify UI immediately
    setPendingOperations(prev => new Set([...prev, tempId]));
    if (onMessageSent) onMessageSent(payload);

    // Try WS first; if not available, fall back to HTTP and queue for WS flush later
    const wsOpen = websocket && websocket.readyState === WebSocket.OPEN;
    if (wsOpen) {
      try {
        websocket.send(JSON.stringify({ type: 'send_message', data: payload }));
      } catch (e) {
        // If WS send fails, enqueue and try HTTP best-effort
        setSendQueue(q => [...q, payload]);
        try {
          api.post(`${API_BASE}/send-message`, {
            user_id: activeUser.user_id,
            type: payload.type,
            message: payload.message,
            ...(payload.url ? { url: payload.url } : {}),
            ...(payload.caption ? { caption: payload.caption } : {}),
            ...(payload.product_retailer_id ? { product_retailer_id: String(payload.product_retailer_id) } : {}),
            temp_id: tempId,
          }).catch(() => {});
        } catch {}
      }
    } else {
      // Queue for WS flush and attempt HTTP send in the background
      setSendQueue(q => [...q, payload]);
      try {
        api.post(`${API_BASE}/send-message`, {
          user_id: activeUser.user_id,
          type: payload.type,
          message: payload.message,
          ...(payload.url ? { url: payload.url } : {}),
          ...(payload.caption ? { caption: payload.caption } : {}),
          ...(payload.product_retailer_id ? { product_retailer_id: String(payload.product_retailer_id) } : {}),
          temp_id: tempId,
        }).catch(() => {});
      } catch {}
    }

    return tempId;
  }, [websocket, activeUser?.user_id, onMessageSent]);

  // Flush queued messages when WebSocket reconnects
  useEffect(() => {
    if (!websocket) return;
    const handleOpen = () => {
      setSendQueue(q => {
        try {
          q.forEach(item => {
            try { websocket.send(JSON.stringify({ type: 'send_message', data: item })); } catch {}
          });
        } catch {}
        return [];
      });
    };
    websocket.addEventListener('open', handleOpen);
    return () => {
      try { websocket.removeEventListener('open', handleOpen); } catch {}
    };
  }, [websocket]);

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
      product_retailer_id: String(product.retailer_id || product.product_retailer_id || product.id),
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
    const baseDetails = captionDetails.join(' • ');
    const captionText = captionDetails.length
      ? `Envoi de l'ensemble complet : ${baseDetails}…\nإرسال المجموعة كاملة: ${baseDetails}…`
      : `Envoi de l'ensemble complet…\nإرسال المجموعة كاملة…`;

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

  // Send selected items strictly as images
  const sendSelectedImages = async () => {
    if (!activeUser?.user_id || selectedImages.length === 0) {
      alert("Please select at least one image.");
      return;
    }
    for (const url of selectedImages) {
      sendImageUrl(url);
      await new Promise(r => setTimeout(r, 40));
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

  // Minimal refresh catalog control (icon button)
  function RefreshCatalogButton({ onRefresh }) {
    const [loading, setLoading] = useState(false);
    const [ok, setOk] = useState(false);

    const handleRefresh = async () => {
      setLoading(true);
      setOk(false);
      try {
        const res = await api.post(`${API_BASE}/refresh-catalog-cache`);
        // Optionally re-fetch sets to reflect any changes after refresh
        try { await fetchSets(); } catch {}
        if (onRefresh) onRefresh(res?.data);
        setOk(true);
      } catch (err) {
        console.error('Error refreshing catalog:', err);
      } finally {
        // brief success indicator
        setTimeout(() => setOk(false), 1500);
        setLoading(false);
      }
    };

    return (
      <button
        onClick={handleRefresh}
        disabled={loading}
        className={`p-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 transition-colors ${loading ? 'opacity-70' : ''}`}
        type="button"
        title={loading ? 'Syncing…' : 'Sync catalog'}
        aria-label="Sync catalog"
      >
        <FiRefreshCw className={`${loading ? 'animate-spin' : ''} ${ok ? 'text-green-400' : ''}`} />
      </button>
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
    autoLoadAttemptsRef.current = 0;
    setSelectedImages([]);
    setLoadingProducts(true);
    setModalOpen(true);
    try { if (gridRef.current) gridRef.current.scrollTop = 0; } catch {}
    // Show cached instantly
    try {
      const cached = await loadCatalogSetProducts(setObj.id);
      if (Array.isArray(cached) && cached.length) setProducts(cached);
    } catch {}
    await fetchProducts(setObj.id, PAGE_SIZE);
  };

  // Keep grid scrolled to top on first render of products after opening
  useEffect(() => {
    if (!modalOpen || modalMode !== 'products') return;
    try {
      if (gridRef.current && products.length > 0) {
        requestAnimationFrame(() => { try { gridRef.current.scrollTop = 0; } catch {} });
      }
    } catch {}
  }, [modalOpen, modalMode, products.length]);

  // Helpers: filter sets by prefix (case-insensitive)
  const filterSetsByPrefix = (prefix) => {
    const p = String(prefix || '').trim().toLowerCase();
    const has = (txt) => (txt || '').toString().toLowerCase().includes(p);
    return sets.filter(s => has(s?.name) || has(s?.id));
  };

  // Sorting helpers for folder view: order by age ranges, then shoes sizes
  const _extractSortKey = (rawName) => {
    const name = (rawName || '').toString().toLowerCase();
    // Identify shoes categories (EN/FR keywords)
    const isShoes = /(shoe|shoes|chauss|sneaker)/i.test(name);
    // Age: months ranges like "0-3 mois" or "3-6 months"
    const rgxRangeMonths = /(\d+)\s*[-–]\s*(\d+)\s*(mois|months?)/i;
    const rgxSingleMonths = /(\d+)\s*(mois|months?)/i;
    const rgxRangeYears = /(\d+)\s*[-–]\s*(\d+)\s*(ans|years?)/i;
    const rgxSingleYears = /(\d+)\s*(ans|years?)/i;

    const toNum = (x) => { const n = Number(x); return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER; };
    const toMonths = (n) => n * 1;
    const yearsToMonths = (n) => n * 12;

    let category = 2; // 0 = age, 1 = shoes, 2 = other
    let numeric = Number.MAX_SAFE_INTEGER;

    // Try age ranges first (months then years), using lower bound for ordering
    let m;
    if ((m = name.match(rgxRangeMonths))) {
      category = 0; numeric = toMonths(toNum(m[1]));
    } else if ((m = name.match(rgxSingleMonths))) {
      category = 0; numeric = toMonths(toNum(m[1]));
    } else if ((m = name.match(rgxRangeYears))) {
      category = 0; numeric = yearsToMonths(toNum(m[1]));
    } else if ((m = name.match(rgxSingleYears))) {
      category = 0; numeric = yearsToMonths(toNum(m[1]));
    } else if (isShoes) {
      category = 1;
      // Extract first reasonable size number from name
      const sizeMatch = name.match(/\b(\d{1,2})\b/);
      numeric = sizeMatch ? toNum(sizeMatch[1]) : Number.MAX_SAFE_INTEGER;
    }

    return [category, numeric, name];
  };

  const sortFolderSets = (arr) => {
    return [...arr].sort((a, b) => {
      const ka = _extractSortKey(a?.name || a?.id);
      const kb = _extractSortKey(b?.name || b?.id);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
    });
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

    let fsets = filter === 'all' ? sets.filter(s => s?.id) : filterSetsByPrefix(filter);
    if (filter === 'girls' || filter === 'boys') {
      fsets = sortFolderSets(fsets);
    }
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
    <div className="bg-gray-900 text-white border-t border-gray-800 p-2 w-full max-h-[110px] overflow-hidden rounded-b-xl shadow-sm flex-none">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-200">Catalog</h2>
        <div className="flex items-center gap-2">
          <RefreshCatalogButton onRefresh={() => { /* no-op; sets reloaded inside */ }} />
          <div className={`w-2.5 h-2.5 rounded-full ${isWebSocketConnected ? 'bg-green-500' : 'bg-red-500'}`} title={isWebSocketConnected ? 'Connected' : 'Disconnected'} />
          <div className="text-xs text-gray-400">WS</div>
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
          <div className="text-xs text-gray-400 col-span-full flex items-center gap-2">
            <span>No sets available.</span>
            <button className="px-2 py-1 bg-gray-800 border border-gray-700 text-gray-200 rounded hover:bg-gray-700" onClick={fetchSets} type="button">Retry</button>
          </div>
        ) : (
          <>
            <button
              className="px-3 py-2 text-sm rounded bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700"
              type="button"
              onClick={() => openFolderModal('girls')}
            >
              Girls
            </button>
            <button
              className="px-3 py-2 text-sm rounded bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700"
              type="button"
              onClick={() => openFolderModal('boys')}
            >
              Boys
            </button>
            <button
              className="px-3 py-2 text-sm rounded bg-gray-800 text-gray-200 hover:bg-gray-700 border border-gray-700"
              type="button"
              onClick={() => openFolderModal('all')}
            >
              All
            </button>
          </>
        )}
      </div>

      {/* Modal popup with grid and actions */}
      {modalOpen && createPortal(
        <div className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center">
          <div className="relative bg-white rounded-xl p-4 w-[96vw] max-w-6xl max-h-[90vh] flex flex-col shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center gap-3 mb-3">
              {modalMode === 'products' && (
                <button className="px-3 py-2 text-sm rounded bg-gray-200 hover:bg-gray-300" onClick={() => { setModalMode('folders'); setProducts([]); setSelectedImages([]); }}>
                  ← Back
                </button>
              )}
              <div className="font-semibold text-gray-800 text-base flex-1 truncate">{modalTitle}</div>
              {modalMode === 'products' ? (
                <>
                  <span className="text-sm text-gray-700 mr-2">Selected: {selectedCount}</span>
                  <button className="px-3 py-2 text-sm rounded bg-gray-200 hover:bg-gray-300" onClick={selectAllVisible}>Select all</button>
                  <button className="px-3 py-2 text-sm rounded bg-gray-200 hover:bg-gray-300" onClick={clearSelection}>Clear</button>
                  <button className="px-3 py-2 text-sm rounded bg-blue-600 text-white disabled:opacity-50" disabled={!isWebSocketConnected || selectedCount === 0} onClick={() => { sendSelectedImages(); setModalOpen(false); }}>Send selected</button>
                  <button className="px-3 py-2 text-sm rounded bg-green-600 text-white" onClick={() => { sendWholeSet(); setModalOpen(false); }}>Send whole set</button>
                </>
              ) : (
                <span className="text-sm text-gray-700">Select a set</span>
              )}
              <button className="ml-2 px-3 py-2 text-sm rounded bg-red-600 text-white" onClick={() => setModalOpen(false)}>Close</button>
            </div>

            {/* Grid (ensure scroll area) */}
            <div ref={gridRef} className="flex-1 min-h-0 overflow-y-auto pr-1 h-[72vh]">
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
                    <div className="grid grid-cols-4 gap-3">
                      {products.map((p, idx) => {
                        const url = p.images?.[0]?.url;
                        const checked = url && selectedImages.includes(url);
                        return (
                          <div key={`${p.retailer_id}-${idx}`} className="relative group border rounded overflow-hidden">
                            {url && (
                              <input type="checkbox" className="absolute top-2 right-2 z-10 scale-150 cursor-pointer" checked={checked} onChange={() => toggleSelect(url)} />
                            )}
                            <div className="w-full h-32 bg-gray-100 flex items-center justify-center">
                              {url ? (
                                <img
                                  src={url}
                                  data-src={url}
                                  alt={p.name}
                                  className="w-full h-32 object-cover"
                                  loading="lazy"
                                  decoding="async"
                                  onError={(e) => {
                                    const el = e.currentTarget;
                                    const step = Number(el.dataset.fbstep || '0');
                                    if (step === 0) {
                                      el.dataset.fbstep = '1';
                                      const original = el.getAttribute('data-src') || el.src;
                                      el.src = `${API_BASE}/proxy-image?url=${encodeURIComponent(original)}`;
                                    } else if (step === 1) {
                                      el.dataset.fbstep = '2';
                                      el.src = '/broken-image.png';
                                    }
                                  }}
                                />
                              ) : (
                                <span className="text-xs text-gray-400">No Image</span>
                              )}
                            </div>
                            {/* Quick action: send as catalog item (interactive product) */}
                            <div className="p-2 flex items-center justify-between bg-white">
                              <div className="text-xs text-gray-700 truncate pr-2" title={p.name}>{p.name}</div>
                              <button
                                type="button"
                                className="text-xs px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700"
                                onClick={() => { sendInteractiveProduct(p); setModalOpen(false); }}
                                title="Send as catalog product"
                              >
                                Send Product
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {loadingProducts && products.length > 0 && (
                    <div className="text-center text-gray-600 text-sm py-3">Loading…</div>
                  )}
                  {!loadingProducts && hasMore && (
                    <div className="flex justify-center py-3">
                      <button
                        type="button"
                        className="px-4 py-2 text-sm rounded bg-gray-200 hover:bg-gray-300"
                        onClick={() => setFetchLimit((l) => l + PAGE_SIZE)}
                        title="Load more items"
                      >
                        Load more
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}