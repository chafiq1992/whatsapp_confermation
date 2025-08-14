// /frontend/src/App.jsx
import React, { useEffect, useState, useRef } from 'react';
import ChatList from './ChatList';
import ChatWindow from './ChatWindow';
import ShopifyIntegrationsPanel from './ShopifyIntegrationsPanel';
import api from './api';
import { loadConversations, saveConversations } from './chatStorage';
import './App.css';

// Read API base from env for production/dev compatibility
// Default to relative paths if not provided
const API_BASE = process.env.REACT_APP_API_BASE || "";

export default function App() {
  const [products, setProducts] = useState([]);
  const [catalogProducts, setCatalogProducts] = useState({});
  const [conversations, setConversations] = useState([]);
  const [activeUser, setActiveUser] = useState(null);

  // WebSocket for chat and a separate one for admin updates
  const wsRef = useRef(null);
  const adminWsRef = useRef(null);

  // Fetch all conversations for chat list
  const fetchConversations = async () => {
    try {
      const res = await api.get(`${API_BASE}/conversations`);
      setConversations(res.data);
      saveConversations(res.data);
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
      const cached = await loadConversations();
      if (cached.length > 0) {
        setConversations(cached);
      }
    }
  };

  // Fetch ALL products in catalog and build a lookup for order message rendering
  const fetchCatalogProducts = async () => {
    try {
      const res = await api.get(`${API_BASE}/catalog-all-products`);
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

  // Load conversations/products on mount
  useEffect(() => {
    loadConversations().then(cached => {
      if (cached.length > 0) {
        setConversations(cached);
      }
    });
    fetchConversations();
    fetchCatalogProducts();
    // You can remove the interval now if using WebSocket for chat!
    // const interval = setInterval(() => {
    //   fetchConversations();
    //   fetchCatalogProducts();
    // }, 5000);
    // return () => clearInterval(interval);
  }, []);

  // Open a persistent WebSocket for admin notifications
  useEffect(() => {
    const wsBase =
      process.env.REACT_APP_WS_URL ||
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/`;
    const ws = new WebSocket(`${wsBase}admin`);
    adminWsRef.current = ws;
    ws.onmessage = () => {
      // Refresh conversations when any new message arrives
      fetchConversations();
    };
    return () => ws.close();
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
    <div className="app-shell">
      {/* LEFT: Chat list */}
      <div className="app-left overflow-y-auto">
        <ChatList
          conversations={conversations}
          setActiveUser={setActiveUser}
          activeUser={activeUser}
        />
      </div>
      {/* MIDDLE: Chat window */}
      <div className="app-center">
        {/* Pass wsRef.current as prop so ChatWindow can send/receive via WebSocket */}
        <ChatWindow
          activeUser={activeUser}
          catalogProducts={catalogProducts}
          ws={wsRef.current}
        />
      </div>
      {/* RIGHT: Shopify "contact info" panel */}
      <div className="app-right overflow-y-auto">
        <ShopifyIntegrationsPanel activeUser={activeUser} />
      </div>
    </div>
  );
}
