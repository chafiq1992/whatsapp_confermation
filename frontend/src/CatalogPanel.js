import api from "./api";
import React, { useEffect, useState, useCallback } from "react";

const API_BASE = process.env.REACT_APP_API_BASE || "";

export default function CatalogPanel({
  activeUser,
  websocket, // WebSocket connection from parent
  onMessageSent, // Callback when message is sent optimistically
}) {
  const [sets, setSets] = useState([]);
  const [loadingSets, setLoadingSets] = useState(false);
  const [selectedSet, setSelectedSet] = useState(null);
  const [setProducts, setSetProducts] = useState([]);
  const [loadingSetProducts, setLoadingSetProducts] = useState(false);
  const [selectedImages, setSelectedImages] = useState([]);
  
  // Track pending/optimistic operations
  const [pendingOperations, setPendingOperations] = useState(new Set());

  // Fetch sets (still HTTP since this is catalog management, not messaging)
  const fetchSets = async () => {
    setLoadingSets(true);
    try {
      const res = await api.get(`${API_BASE}/catalog-sets`);
      setSets(res.data || []);
    } catch (err) {
      console.error('Error fetching sets:', err);
      setSets([]);
    }
    setLoadingSets(false);
  };

  // Fetch products in selected set
  const fetchProductsInSet = async (setId) => {
    setSelectedSet(setId);
    setLoadingSetProducts(true);
    try {
      const res = await api.get(`${API_BASE}/catalog-set-products`, {
        params: { set_id: setId } 
      });
      setSetProducts(res.data || []);
    } catch (err) {
      console.error('Error fetching set products:', err);
      setSetProducts([]);
    }
    setLoadingSetProducts(false);
  };

  // Generate unique temp ID for optimistic updates
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

  // Send catalog item via WebSocket with optimistic UI
  const sendCatalogItem = async (item) => {
    if (!activeUser?.user_id) return;

    const messageData = {
      type: 'catalog_item',
      message: `📦 ${item.name || 'Product'}`,
      catalog_item: {
        retailer_id: item.retailer_id,
        name: item.name,
        price: item.price,
        image: item.image
      }
    };

    const tempId = sendOptimisticMessage(messageData);
    
    if (!tempId) {
      alert('Failed to send: WebSocket not connected');
      return;
    }

    try {
      // Background HTTP call to actually send via WhatsApp
      await api.post(
        `${API_BASE}/send-catalog-item`,
        new URLSearchParams({
          user_id: activeUser.user_id,
          product_retailer_id: item.retailer_id,
          temp_id: tempId // Include temp_id for status updates
        }),
        { 
          headers: { "Content-Type": "application/x-www-form-urlencoded" } 
        }
      );
    } catch (err) {
      console.error('Failed to send catalog item:', err);
      // The WebSocket will receive the error status update from backend
    }
  };

  // Send whole set via WebSocket with optimistic UI
  const sendWholeSet = async () => {
    if (!activeUser?.user_id || setProducts.length === 0) return;

    const messageData = {
      type: 'catalog_set',
      message: `📦 Product Set (${setProducts.length} items)`,
      catalog_set: {
        products: setProducts.map(item => ({
          retailer_id: item.retailer_id,
          name: item.name,
          price: item.price,
          image: item.images?.[0]?.url
        }))
      }
    };

    const tempId = sendOptimisticMessage(messageData);
    
    if (!tempId) {
      alert('Failed to send: WebSocket not connected');
      return;
    }

    try {
      await api.post(
        `${API_BASE}/send-catalog-set`,
        new URLSearchParams({
          user_id: activeUser.user_id,
          product_ids: JSON.stringify(setProducts.map(item => item.retailer_id)),
          temp_id: tempId
        }),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" }
        }
      );
    } catch (err) {
      console.error('Failed to send whole set:', err);
    }
  };

  // Send selected images via WebSocket with optimistic UI
  const sendSelectedImages = async () => {
    if (!activeUser?.user_id || selectedImages.length === 0) {
      alert("Please select at least one image.");
      return;
    }

    const selectedProducts = setProducts.filter(
      item => item.images?.[0]?.url && selectedImages.includes(item.images[0].url)
    );

    const messageData = {
      type: 'image_set',
      message: `🖼️ Selected Images (${selectedImages.length} items)`,
      image_set: {
        images: selectedImages,
        prices: selectedProducts.map(item => item.price ? `${item.price} DH` : ''),
        products: selectedProducts
      }
    };

    const tempId = sendOptimisticMessage(messageData);
    
    if (!tempId) {
      alert('Failed to send: WebSocket not connected');
      return;
    }

    try {
      await api.post(
        `${API_BASE}/send-set-images`,
        new URLSearchParams({
          user_id: activeUser.user_id,
          images: JSON.stringify(selectedImages),
          prices: JSON.stringify(
            selectedProducts.map(item => item.price ? `${item.price} DH` : '')
          ),
          temp_id: tempId
        }),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" }
        }
      );
    } catch (err) {
      console.error('Failed to send set images:', err);
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

  useEffect(() => {
    fetchSets();
  }, []);

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

  // Check if WebSocket is connected
  const isWebSocketConnected = websocket && websocket.readyState === WebSocket.OPEN;

  // Hide the CatalogPanel UI entirely as requested
  return null;
  /*
    <div className="bg-white border-t border-gray-300 p-4 w/full max-h-[320px] overflow-y-auto rounded-b-xl shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-bold text-blue-700">Product Catalog Sets</h2>
        <div className="flex items-center gap-2">
          <RefreshCatalogButton onRefresh={fetchSets} />
          {/* WebSocket Status Indicator */}
          <div className={`w-3 h-3 rounded-full ${isWebSocketConnected ? 'bg-green-500' : 'bg-red-500'}`} 
               title={isWebSocketConnected ? 'Connected' : 'Disconnected'} />
        </div>
      </div>

      {/* Show warning if WebSocket is not connected */}
      {!isWebSocketConnected && (
        <div className="bg-yellow-100 border border-yellow-400 text-yellow-700 px-3 py-2 rounded mb-4">
          ⚠️ WebSocket disconnected. Messages may not send properly.
        </div>
      )}

      {loadingSets ? (
        <div className="text-center py-4">Loading sets...</div>
      ) : (
        <div className="flex flex-wrap gap-2 mb-4">
          {sets.map(set => (
            <button
              key={set.id}
              className={`px-3 py-1 rounded transition-colors ${
                selectedSet === set.id 
                  ? 'bg-blue-600 text-white' 
                  : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
              }`}
              onClick={() => {
                fetchProductsInSet(set.id);
                setSelectedImages([]);
              }}
              type="button"
            >
              {set.name || set.id}
            </button>
          ))}
        </div>
      )}

      {/* Products in Set */}
      {selectedSet && (
        <>
          <h3 className="font-semibold mb-2">Products in Set:</h3>
          {setProducts.length > 0 && (
            <div className="sticky top-0 z-10 bg-white pb-2 flex flex-col gap-2">
              <div className="flex gap-2 mb-2">
                <button
                  className="px-2 py-1 bg-blue-200 rounded hover:bg-blue-300 transition-colors"
                  onClick={() => {
                    setSelectedImages(
                      setProducts
                        .map(item => item.images?.[0]?.url)
                        .filter(Boolean)
                    );
                  }}
                  type="button"
                >
                  Select All
                </button>
                <button
                  className="px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 transition-colors"
                  onClick={() => setSelectedImages([])}
                  type="button"
                >
                  Deselect All
                </button>
              </div>
              
              <button
                className="w-full px-4 py-2 bg-green-600 text-white rounded font-semibold hover:bg-green-700 disabled:opacity-50 transition-colors"
                onClick={sendWholeSet}
                disabled={!isWebSocketConnected}
                type="button"
              >
                🚀 Send Whole Set
                {pendingOperations.size > 0 && (
                  <span className="ml-2 text-xs">({pendingOperations.size} pending)</span>
                )}
              </button>
              
              <button
                className="w-full px-4 py-2 bg-blue-600 text-white rounded font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
                onClick={sendSelectedImages}
                disabled={!isWebSocketConnected || selectedImages.length === 0}
                type="button"
              >
                📸 Send Selected Images ({selectedImages.length})
              </button>
            </div>
          )}
          
          <div className="overflow-y-auto" style={{ maxHeight: "160px" }}>
            {loadingSetProducts ? (
              <div className="text-center py-4">Loading products...</div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {setProducts.length === 0 ? (
                  <div className="col-span-2 text-center text-gray-500 py-4">
                    No products in this set.
                  </div>
                ) : (
                  setProducts.map(item => (
                    <div
                      key={item.retailer_id}
                      className="border rounded-lg p-2 flex flex-col items-center relative hover:shadow-md transition-shadow"
                    >
                      {item.images?.[0]?.url && (
                        <input
                          type="checkbox"
                          checked={selectedImages.includes(item.images[0].url)}
                          onChange={e => {
                            const url = item.images[0].url;
                            setSelectedImages(prev =>
                              e.target.checked
                                ? [...prev, url]
                                : prev.filter(imgUrl => imgUrl !== url)
                            );
                          }}
                          className="absolute top-2 right-2 z-10"
                        />
                      )}
                      
                      {item.images?.[0]?.url ? (
                        <img
                          src={item.images[0].url}
                          alt={item.name}
                          className="w-20 h-20 object-cover rounded"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-20 h-20 bg-gray-100 flex items-center justify-center rounded text-xs text-gray-400">
                          No Image
                        </div>
                      )}
                      
                      <div className="font-semibold mt-2 text-center text-sm">
                        {item.name || item.retailer_id}
                      </div>
                      
                      {item.price && (
                        <div className="text-blue-700 font-medium">
                          {item.price} DH
                        </div>
                      )}
                      
                      <button
                        className="mt-2 px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm"
                        onClick={() =>
                          sendCatalogItem({
                            retailer_id: item.retailer_id,
                            name: item.name,
                            price: item.price,
                            image: item.images?.[0]?.url,
                          })
                        }
                        disabled={!isWebSocketConnected}
                        type="button"
                      >
                        Send
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </>
      )}
      
      {!selectedSet && !loadingSets && (
        <div className="text-gray-500 mt-4 text-center py-8">
          Select a set above to view its products.
        </div>
      )}
    </div>
  */
}