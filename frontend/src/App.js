// /frontend/src/App.jsx
import React, { useEffect, useState, useRef } from 'react';
import ChatList from './ChatList';
import ChatWindow from './ChatWindow';
import ShopifyIntegrationsPanel from './ShopifyIntegrationsPanel';
import axios from 'axios';

// Read API base from env for production/dev compatibility
// Default to relative paths if not provided
const API_BASE = process.env.REACT_APP_API_BASE || "";

export default function App() {
  const [products, setProducts] = useState([]);
  const [catalogProducts, setCatalogProducts] = useState({});
  const [conversations, setConversations] = useState([]);
  const [activeUser, setActiveUser] = useState(null);

  // WebSocket for chat
  const wsRef = useRef(null);

  // Fetch all conversations for chat list
  const fetchConversations = async () => {
    try {
      const res = await axios.get(`${API_BASE}/conversations`);
      setConversations(res.data);
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    }
  };

  // Fetch ALL products in catalog and build a lookup for order message rendering
  const fetchCatalogProducts = async () => {
    try {
      const res = await axios.get(`${API_BASE}/catalog-all-products`);
      const allProducts = res.data || [];

      // Only keep in-stock items
      const inStockProducts = allProducts.filter(p => Number(p.available_quantity) > 0);

      // Build the lookup only for in-stock products
      const lookup = {};
      inStockProducts.forEach(prod => {
        lookup[String(prod.retailer_id)] = {
          name: prod.name,
          image: prod.images?.[0]?.url,
          price: prod.price,
        };
      });

      setCatalogProducts(lookup);
      setProducts(inStockProducts);
    } catch (err) {
      setCatalogProducts({});
      console.error('Failed to fetch catalog products:', err);
    }
  };

  // Load conversations/products on mount, and whenever a new message is received (optional)
  useEffect(() => {
    fetchConversations();
    fetchCatalogProducts();
    // You can remove the interval now if using WebSocket for chat!
    // const interval = setInterval(() => {
    //   fetchConversations();
    //   fetchCatalogProducts();
    // }, 5000);
    // return () => clearInterval(interval);
  }, []);

  // --- Setup WebSocket for messages ---
  useEffect(() => {
    if (!activeUser?.user_id) return;
    // Close previous WebSocket if any
    if (wsRef.current) wsRef.current.close();

    // Connect to backend WebSocket for the selected user
    const wsBase =
      process.env.REACT_APP_WS_URL ||
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/`;
    const ws = new WebSocket(`${wsBase}${activeUser.user_id}`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      // Optionally: fetchConversations() here to refresh chat list on connect
    };
    ws.onclose = () => {
      console.log('WebSocket disconnected');
    };
    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    // If you want to listen for incoming messages here and update chat list:
    ws.onmessage = (event) => {
      // Example: refresh conversations list on any new message
      // You can make this smarter by updating state only as needed
      fetchConversations();
    };

    return () => {
      if (ws) ws.close();
    };
  }, [activeUser?.user_id]);

  return (
    <div className="flex h-screen bg-gray-900 text-white">
      {/* LEFT: Chat list */}
      <div className="w-1/3 border-r border-gray-700 overflow-y-auto">
        <ChatList
          conversations={conversations}
          setActiveUser={setActiveUser}
          activeUser={activeUser}
        />
      </div>
      {/* MIDDLE: Chat window */}
      <div className="flex-1">
        {/* Pass wsRef.current as prop so ChatWindow can send/receive via WebSocket */}
        <ChatWindow
          activeUser={activeUser}
          catalogProducts={catalogProducts}
          ws={wsRef.current}
        />
      </div>
      {/* RIGHT: Shopify "contact info" panel, always visible */}
      <div className="w-96 border-l border-gray-800 bg-gray-900">
        <ShopifyIntegrationsPanel activeUser={activeUser} />
      </div>
    </div>
  );
}
