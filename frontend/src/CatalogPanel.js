import api from "./api";
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";

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
  const abortRef = useRef(null);

  // Selected images (URLs)
  const [selectedImages, setSelectedImages] = useState([]);

  // Pending ops indicator (for optimistic sends)
  const [pendingOperations, setPendingOperations] = useState(new Set());

  // Modal preview state
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  // Fetch sets list
  const fetchSets = async () => {
    setLoadingSets(true);
    try {
      const res = await api.get(`${API_BASE}/catalog-sets`);
      const list = Array.isArray(res.data) ? res.data : [];
      setSets(list);
      if (!selectedSet && list.length > 0) {
        setSelectedSet(list[0].id);
      }
    } catch (err) {
      console.error("Error fetching sets:", err);
      setSets([]);
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

  // Send whole set: send first N thumbnails as separate image messages
  const sendWholeSet = async () => {
    if (!activeUser?.user_id || products.length === 0) return;
    const MAX_SEND = 12;
    const list = products.slice(0, MAX_SEND).map(p => p.images?.[0]?.url).filter(Boolean);
    for (const url of list) {
      sendImageUrl(url);
      await new Promise(r => setTimeout(r, 150));
    }
  };

  // Send selected images (direct links)
  const sendSelectedImages = async () => {
    if (!activeUser?.user_id || selectedImages.length === 0) {
      alert("Please select at least one image.");
      return;
    }
    for (const url of selectedImages) {
      sendImageUrl(url);
      await new Promise(r => setTimeout(r, 150));
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

  // Load products when set or limit changes
  useEffect(() => {
    if (!selectedSet) return;
    fetchProducts(selectedSet, fetchLimit);
  }, [selectedSet, fetchLimit]);

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

  const openLightbox = (index) => {
    setLightboxIndex(index);
    setLightboxOpen(true);
  };
  const closeLightbox = () => setLightboxOpen(false);
  const nextLightbox = () => setLightboxIndex(i => (i + 1) % Math.max(1, products.length));
  const prevLightbox = () => setLightboxIndex(i => (i - 1 + Math.max(1, products.length)) % Math.max(1, products.length));

  return (
    <div className="bg-white border-t border-gray-300 p-3 w-full max-h-[360px] rounded-b-xl shadow-sm flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-blue-700">Catalog</h2>
        <div className="flex items-center gap-2">
          <RefreshCatalogButton onRefresh={fetchSets} />
          <div className={`w-2.5 h-2.5 rounded-full ${isWebSocketConnected ? 'bg-green-500' : 'bg-red-500'}`} title={isWebSocketConnected ? 'Connected' : 'Disconnected'} />
        </div>
      </div>

      {/* Sets row */}
      <div className="flex gap-2 overflow-x-auto pb-2 mb-2 border-b border-gray-200">
        {loadingSets ? (
          <div className="text-xs text-gray-500">Loading sets…</div>
        ) : (
          sets.map(s => (
            <button
              key={s.id}
              className={`px-3 py-1 text-xs rounded-full whitespace-nowrap ${selectedSet === s.id ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-800 hover:bg-gray-300'}`}
              onClick={() => { setSelectedSet(s.id); setFetchLimit(PAGE_SIZE); setSelectedImages([]); }}
              type="button"
            >
              {s.name || s.id}
            </button>
          ))
        )}
      </div>

      {/* Product grid */}
      <div className="flex-1 overflow-y-auto">
        {loadingProducts && products.length === 0 ? (
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="h-20 bg-gray-100 animate-pulse rounded" />
            ))}
          </div>
        ) : products.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-6">No products in this set.</div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {products.map((p, idx) => {
              const url = p.images?.[0]?.url;
              const checked = url && selectedImages.includes(url);
              return (
                <div key={`${p.retailer_id}-${idx}`} className="relative group border rounded overflow-hidden">
                  {/* Checkbox */}
                  {url && (
                    <input
                      type="checkbox"
                      className="absolute top-1 right-1 z-10 scale-110"
                      checked={checked}
                      onChange={() => toggleSelect(url)}
                    />
                  )}
                  {/* Thumbnail */}
                  <button type="button" className="w-full h-20 bg-gray-100 flex items-center justify-center" onClick={() => openLightbox(idx)}>
                    {url ? (
                      <img src={url} alt={p.name} className="w-full h-20 object-cover" loading="lazy" />
                    ) : (
                      <span className="text-xs text-gray-400">No Image</span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {hasMore && (
          <div className="flex justify-center py-2">
            <button className="px-3 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300" disabled={loadingProducts} onClick={() => setFetchLimit(l => l + PAGE_SIZE)}>
              {loadingProducts ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {/* Sticky action bar */}
      <div className="mt-2 pt-2 border-t border-gray-200 flex items-center gap-2">
        <span className="text-xs text-gray-500">Selected: {selectedCount}</span>
        <button className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300" onClick={selectAllVisible}>Select all</button>
        <button className="px-2 py-1 text-xs rounded bg-gray-200 hover:bg-gray-300" onClick={clearSelection}>Clear</button>
        <div className="flex-1" />
        <button className="px-3 py-1 text-xs rounded bg-blue-600 text-white disabled:opacity-50" disabled={!isWebSocketConnected || selectedCount === 0} onClick={sendSelectedImages}>Send selected</button>
        <button className="px-3 py-1 text-xs rounded bg-green-600 text-white disabled:opacity-50" disabled={!isWebSocketConnected || products.length === 0} onClick={sendWholeSet}>Send whole set</button>
      </div>

      {/* Lightbox */}
      {lightboxOpen && products[lightboxIndex] && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
          <div className="relative bg-gray-900 rounded-xl p-3 max-w-[90vw] max-h-[90vh] flex flex-col items-center">
            <button className="absolute top-2 right-2 bg-red-600 text-white rounded px-2 text-xs" onClick={closeLightbox}>Close</button>
            <div className="flex items-center gap-3 mb-2">
              <button className="bg-gray-700 text-white rounded px-2 text-xs" onClick={prevLightbox}>Prev</button>
              <button className="bg-gray-700 text-white rounded px-2 text-xs" onClick={nextLightbox}>Next</button>
              {products[lightboxIndex]?.images?.[0]?.url && (
                <button className="bg-blue-600 text-white rounded px-2 text-xs" onClick={() => toggleSelect(products[lightboxIndex].images[0].url)}>
                  {selectedImages.includes(products[lightboxIndex].images[0].url) ? 'Unselect' : 'Select'}
                </button>
              )}
            </div>
            <div className="max-w-[85vw] max-h-[75vh]">
              {products[lightboxIndex]?.images?.[0]?.url ? (
                <img src={products[lightboxIndex].images[0].url} alt={products[lightboxIndex]?.name} className="max-h-[75vh] max-w-[85vw] object-contain rounded" />
              ) : (
                <div className="text-gray-300 text-sm">No Image</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}