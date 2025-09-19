// /frontend/src/App.jsx
import React, { useEffect, useState, useRef, Suspense } from 'react';
import ChatList from './ChatList';
import InternalChannelsBar from './InternalChannelsBar';
import MiniSidebar from './MiniSidebar';
import AgentHeaderBar from './AgentHeaderBar';
import ChatWindow from './ChatWindow';
import api from './api';
import { loadConversations, saveConversations } from './chatStorage';
import { AudioProvider } from './AudioManager';
import GlobalAudioBar from './GlobalAudioBar';
// Lazy load heavy panels (must be declared after all import declarations)
const AdminDashboard = React.lazy(() => import('./AdminDashboard'));
const ShopifyIntegrationsPanel = React.lazy(() => import('./ShopifyIntegrationsPanel'));

// Read API base from env for production/dev compatibility
// Default to relative paths if not provided
const API_BASE = process.env.REACT_APP_API_BASE || "";

export default function App() {
  const [products, setProducts] = useState([]);
  const [catalogProducts, setCatalogProducts] = useState({});
  const [conversations, setConversations] = useState([]);
  const [activeUser, setActiveUser] = useState(null);
  const [currentAgent, setCurrentAgent] = useState("");
  const [agentInboxMode, setAgentInboxMode] = useState(false);
  const [myAssignedOnly, setMyAssignedOnly] = useState(false);
  const [adminWsConnected, setAdminWsConnected] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showInternalPanel, setShowInternalPanel] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const activeUserRef = useRef(activeUser);

  // WebSocket for chat and a separate one for admin updates
  const wsRef = useRef(null);
  const adminWsRef = useRef(null);

  useEffect(() => {
    activeUserRef.current = activeUser;
  }, [activeUser]);

  // Compute a root font scale to preserve layout while making UI elements smaller
  useEffect(() => {
    const updateScale = () => {
      try {
        const baseWidth = 1200; // design reference width
        const baseHeight = 800; // design reference height
        const scaleW = window.innerWidth / baseWidth;
        const scaleH = window.innerHeight / baseHeight;
        // Keep within sensible bounds to maintain usability
        const scale = Math.min(1, Math.max(0.8, Math.min(scaleW, scaleH)));
        const baseFontPx = 16;
        document.documentElement.style.setProperty('--app-font-size', `${baseFontPx * scale}px`);
      } catch {}
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, []);

  // Clear unread count in chat list when opening a conversation
  useEffect(() => {
    if (!activeUser?.user_id) return;
    setConversations(prev => prev.map(c => c.user_id === activeUser.user_id ? { ...c, unread_count: 0 } : c));
  }, [activeUser?.user_id]);

  // Fetch all conversations for chat list
  const fetchConversations = async () => {
    try {
      setLoadingConversations(true);
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
    finally {
      setLoadingConversations(false);
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

  // Read agent/channel from URL hash for deep links: #agent=alice&assigned=1 | #dm=alice | #team=sales
  useEffect(() => {
    const applyFromHash = () => {
      try {
        const raw = window.location.hash || '';
        const h = raw.startsWith('#') ? raw.slice(1) : raw;
        const params = new URLSearchParams(h);
        const agent = params.get('agent');
        const assigned = params.get('assigned');
        const dm = params.get('dm');
        const team = params.get('team');

        if (agent) {
          setCurrentAgent(agent);
          setAgentInboxMode(true);
        } else {
          setAgentInboxMode(false);
        }
        if (assigned != null) setMyAssignedOnly(assigned === '1' || assigned === 'true');
        if (dm) {
          setActiveUser({ user_id: `dm:${dm}`, name: `@${dm}` });
        } else if (team) {
          setActiveUser({ user_id: `team:${team}`, name: `#${team}` });
        }
      } catch {}
    };
    applyFromHash();
    window.addEventListener('hashchange', applyFromHash);
    return () => window.removeEventListener('hashchange', applyFromHash);
  }, []);

  // Open a persistent WebSocket for admin notifications (with reconnection)
  useEffect(() => {
    let retry = 0;
    let timer = null;
    const wsBase =
      process.env.REACT_APP_WS_URL ||
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/`;

    const connectAdmin = () => {
      const ws = new WebSocket(`${wsBase}admin`);
      adminWsRef.current = ws;
      ws.addEventListener('open', () => {
        retry = 0;
        setAdminWsConnected(true);
        try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch {}
      });
      ws.addEventListener('close', () => {
        setAdminWsConnected(false);
        const delay = Math.min(30000, 1000 * Math.pow(2, retry++)) + Math.floor(Math.random() * 500);
        timer = setTimeout(connectAdmin, delay);
      });
      ws.addEventListener('error', () => {
        setAdminWsConnected(false);
        try { ws.close(); } catch {}
      });
      ws.addEventListener('message', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === "message_received") {
            const msg = data.data || {};
            const userId = msg.user_id;
            const text =
              typeof msg.message === "string"
                ? msg.message
                : msg.caption || msg.type || "";
            const nowIso = new Date().toISOString();
            const msgTime = msg.timestamp || nowIso;
            setConversations((prev) => {
              const idx = prev.findIndex((c) => c.user_id === userId);
              if (idx !== -1) {
                const current = prev[idx];
                const updated = {
                  ...current,
                  last_message: text,
                  last_message_type: msg.type || current.last_message_type,
                  // Always treat an incoming message as latest activity for ordering purposes
                  last_message_time: nowIso,
                  unread_count:
                    activeUserRef.current?.user_id === userId
                      ? current.unread_count
                      : (current.unread_count || 0) + 1,
                };
                return [
                  updated,
                  ...prev.slice(0, idx),
                  ...prev.slice(idx + 1),
                ];
              }
              const newConv = {
                user_id: userId,
                name: msg.name || userId,
                last_message: text,
                last_message_type: msg.type || 'text',
                last_message_time: nowIso,
                unread_count:
                  activeUserRef.current?.user_id === userId ? 0 : 1,
              };
              return [newConv, ...prev];
            });
          }
        } catch (err) {
          console.error("WS message parsing failed", err);
        }
      });
    };

    connectAdmin();
    return () => {
      clearTimeout(timer);
      if (adminWsRef.current) try { adminWsRef.current.close(); } catch {}
      setAdminWsConnected(false);
    };
  }, []);

  // --- Setup WebSocket for messages (with reconnection) ---
  useEffect(() => {
    let retry = 0;
    let timer = null;
    if (!activeUser?.user_id) return;
    if (wsRef.current) try { wsRef.current.close(); } catch {}

    const wsBase =
      process.env.REACT_APP_WS_URL ||
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/`;

    const connectUser = () => {
      const ws = new WebSocket(`${wsBase}${activeUserRef.current?.user_id}`);
      wsRef.current = ws;
      ws.addEventListener('open', () => {
        retry = 0;
        try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch {}
      });
      ws.addEventListener('close', () => {
        const delay = Math.min(30000, 1000 * Math.pow(2, retry++)) + Math.floor(Math.random() * 500);
        timer = setTimeout(connectUser, delay);
      });
      ws.addEventListener('error', () => {
        try { ws.close(); } catch {}
      });
      // No global conversation refetch on every WS event; admins WS updates the list
    };

    connectUser();
    return () => {
      clearTimeout(timer);
      if (wsRef.current) try { wsRef.current.close(); } catch {}
    };
  }, [activeUser?.user_id]);

  // Helper to update tags on a conversation and keep activeUser in sync
  const handleUpdateConversationTags = (userId, tags) => {
    setConversations(prev => prev.map(c => c.user_id === userId ? { ...c, tags } : c));
    if (activeUserRef.current?.user_id === userId) {
      setActiveUser(prev => prev ? { ...prev, tags } : prev);
    }
  };

  return (
    <AudioProvider>
    <div className="flex h-screen bg-gray-900 text-white overflow-hidden" style={{ fontSize: 'var(--app-font-size, 16px)' }}>
      {/* LEFT: Mini sidebar + Agent header + Chat list */}
      <div className="w-[30rem] min-w-[30rem] flex-shrink-0 overflow-hidden flex relative z-0 bg-gray-900">
        <MiniSidebar
          showArchive={showArchive}
          onSetShowArchive={setShowArchive}
          onToggleInternal={() => setShowInternalPanel((v) => !v)}
          onSelectInternalAgent={(username)=> { setActiveUser({ user_id: `dm:${username}`, name: `@${username}` }); setShowInternalPanel(false); }}
          onOpenSettings={() => setShowAdmin(true)}
          onOpenAutomation={() => { window.open('/#/automation-studio', '_blank', 'noopener,noreferrer'); }}
        />
        <div className="flex-1 flex flex-col border-r border-gray-700 bg-gray-900 overflow-y-auto">
          <AgentHeaderBar />
          {/* InternalChannelsBar inline list removed in favor of dropdown on the sidebar icon */}
          <ChatList
            conversations={conversations}
            setActiveUser={setActiveUser}
            activeUser={activeUser}
            wsConnected={adminWsConnected}
            defaultAssignedFilter={(agentInboxMode && currentAgent) ? currentAgent : (myAssignedOnly && currentAgent ? currentAgent : 'all')}
            showArchive={showArchive}
            currentAgent={currentAgent}
            loading={loadingConversations}
            onUpdateConversationTags={handleUpdateConversationTags}
          />
        </div>
      </div>
      {/* MIDDLE: Chat window */}
      <div className="flex-1 overflow-hidden relative z-0 min-w-0">
        {/* Pass wsRef.current as prop so ChatWindow can send/receive via WebSocket */}
        <ChatWindow
          activeUser={activeUser}
          catalogProducts={catalogProducts}
          ws={wsRef.current}
          currentAgent={currentAgent}
          adminWs={adminWsRef.current}
          onUpdateConversationTags={handleUpdateConversationTags}
        />
        {/* Persistent audio bar above composer area */}
        <div className="absolute left-0 right-0 bottom-[88px] px-4">
          <GlobalAudioBar />
        </div>
      </div>
      {/* RIGHT: Shopify "contact info" panel, responsive (hidden on small/medium) */}
      <div className="hidden lg:block lg:w-80 lg:min-w-[18rem] lg:flex-shrink-0 border-l border-gray-700 bg-gray-900 overflow-y-auto">
        <Suspense fallback={<div className="p-3 text-sm text-gray-300">Loading Shopify panel…</div>}>
          <ShopifyIntegrationsPanel activeUser={activeUser} />
        </Suspense>
      </div>
      {showAdmin && (
        <Suspense fallback={<div className="p-3 text-sm text-gray-300">Loading settings…</div>}>
          <AdminDashboard onClose={() => setShowAdmin(false)} />
        </Suspense>
      )}
    </div>
    </AudioProvider>
  );
}
