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
const Login = React.lazy(() => import('./Login'));

// Read API base from env for production/dev compatibility
// Default to relative paths if not provided
const API_BASE = process.env.REACT_APP_API_BASE || "";

// Normalize timestamps across types and formats; treat naive ISO as UTC
const toMsNormalized = (t) => {
  if (!t) return 0;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  const s = String(t);
  if (/^\d+$/.test(s)) return Number(s) * (s.length <= 10 ? 1000 : 1);
  if (s.includes('T') && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s + 'Z');
    if (!Number.isNaN(ms)) return ms;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? 0 : ms;
};

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
  const [isAdmin, setIsAdmin] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const activeUserRef = useRef(activeUser);

  const isLoginPath = typeof window !== 'undefined' && window.location && window.location.pathname === '/login';

  // WebSocket for chat and a separate one for admin updates
  const wsRef = useRef(null);
  const adminWsRef = useRef(null);

  useEffect(() => {
    activeUserRef.current = activeUser;
  }, [activeUser]);

  // No version banner; backend serves fresh JS/CSS with no-cache headers

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

  // Reflect latest message previews from ChatWindow globally so ChatList stays in sync
  useEffect(() => {
    const handler = (ev) => {
      const d = ev.detail || {};
      if (!d.user_id) return;
      setConversations((prev) => {
        const list = Array.isArray(prev) ? [...prev] : [];
        const idx = list.findIndex((c) => c.user_id === d.user_id);
        const nowIso = new Date().toISOString();
        const incomingIso = d.last_message_time || nowIso;
        const incomingMs = toMsNormalized(incomingIso);
        if (idx === -1) {
          const created = {
            user_id: d.user_id,
            name: d.name || d.user_id,
            last_message: d.last_message || '',
            last_message_type: d.last_message_type || 'text',
            last_message_time: incomingIso,
            last_message_from_me: typeof d.last_message_from_me === 'boolean' ? d.last_message_from_me : undefined,
            last_message_status: d.last_message_status,
            unread_count: activeUserRef.current?.user_id === d.user_id ? 0 : 1,
            tags: [],
          };
          return [created, ...list];
        }
        const updated = { ...list[idx] };
        const prevMs = toMsNormalized(updated.last_message_time || 0);
        const isNewer = incomingMs > prevMs;
        const isSame = incomingMs === prevMs;
        const sameContent = (
          (typeof d.last_message === 'string' ? d.last_message : '') === (typeof updated.last_message === 'string' ? updated.last_message : '') &&
          (d.last_message_type || '') === (updated.last_message_type || '') &&
          (typeof updated.last_message_from_me === 'boolean' ? updated.last_message_from_me : false)
        );

        // Only update preview content/from_me when the incoming event is newer
        if (isNewer) {
          if (d.last_message_type) updated.last_message_type = d.last_message_type;
          if (typeof d.last_message === 'string') updated.last_message = d.last_message;
          if (typeof d.last_message_from_me === 'boolean') updated.last_message_from_me = d.last_message_from_me;
          if (typeof d.last_message_status === 'string') updated.last_message_status = d.last_message_status;
          updated.last_message_time = incomingIso;
        } else {
          const rank = (s) => ({ sending: 0, sent: 1, delivered: 2, read: 3, failed: 99 }[s] ?? -1);
          // For same-timestamp updates, only lift delivery status if it improves
          if (isSame && typeof d.last_message_status === 'string' && updated.last_message_from_me) {
            const curr = updated.last_message_status;
            const next = d.last_message_status;
            if (!curr || rank(next) >= rank(curr)) updated.last_message_status = next;
          }
          // If incoming appears older but refers to the same message from me, still allow status upgrades
          if (!isNewer && !isSame && sameContent && typeof d.last_message_status === 'string') {
            const curr = updated.last_message_status;
            const next = d.last_message_status;
            if (!curr || rank(next) >= rank(curr)) updated.last_message_status = next;
          }
          // Keep the newer timestamp to maintain ordering; do not downgrade preview fields
          updated.last_message_time = new Date(Math.max(prevMs, incomingMs)).toISOString();
        }
        if (activeUserRef.current?.user_id === d.user_id) updated.unread_count = 0;
        const without = list.filter((_, i) => i !== idx);
        return [updated, ...without];
      });
    };
    window.addEventListener('conversation-preview', handler);
    return () => window.removeEventListener('conversation-preview', handler);
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

  // Load conversations/products after auth is ready (or on login page)
  useEffect(() => {
    if (!authReady && !isLoginPath) return;
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
  }, [authReady, isLoginPath]);

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

  // Hydrate currentAgent from localStorage if not set via hash
  useEffect(() => {
    try {
      if (!currentAgent) {
        const saved = localStorage.getItem('agent_username');
        if (saved) setCurrentAgent(saved);
      }
      const savedAdmin = localStorage.getItem('agent_is_admin');
      if (savedAdmin != null) setIsAdmin(savedAdmin === '1' || savedAdmin === 'true');
    } catch {}
  }, []);

  // Validate session with backend and hydrate admin flag
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/auth/me');
        const u = res?.data?.username;
        const a = !!res?.data?.is_admin;
        if (u && !currentAgent) setCurrentAgent(u);
        setIsAdmin(a);
        try { localStorage.setItem('agent_is_admin', a ? '1' : '0'); } catch {}
        setAuthReady(true);
      } catch (e) {
        // Auth disabled or not logged in – proceed without redirect
        setAuthReady(true);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
                // If archived as Done, remove the tag on any new incoming message
                const oldTags = Array.isArray(current.tags) ? current.tags : [];
                const newTags = (msg.from_me ? oldTags : oldTags.filter(t => String(t || '').toLowerCase() !== 'done'));
                const updated = {
                  ...current,
                  last_message: text,
                  last_message_type: msg.type || current.last_message_type,
                  last_message_from_me: Boolean(msg.from_me),
                  last_message_status: (() => {
                    // Only consider status when the last message is from me
                    if (!msg.from_me) return current.last_message_status;
                    const rank = (s) => ({ sending: 0, sent: 1, delivered: 2, read: 3, failed: 99 }[s] ?? -1);
                    const cur = current.last_message_status;
                    const nxt = msg.status;
                    if (typeof nxt !== 'string') return cur;
                    if (!cur) return nxt;
                    return rank(nxt) >= rank(cur) ? nxt : cur;
                  })(),
                  // Always treat an incoming message as latest activity for ordering purposes
                  last_message_time: nowIso,
                  unread_count:
                    activeUserRef.current?.user_id === userId
                      ? current.unread_count
                      : (current.unread_count || 0) + 1,
                  tags: newTags,
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
                last_message_from_me: Boolean(msg.from_me),
                last_message_status: msg.from_me ? (msg.status || undefined) : undefined,
                last_message_time: nowIso,
                unread_count:
                  activeUserRef.current?.user_id === userId ? 0 : 1,
                tags: [],
              };
              return [newConv, ...prev];
            });
          } else if (data.type === 'conversation_assignment_updated') {
            const { user_id: userId, assigned_agent } = data.data || {};
            if (!userId) return;
            setConversations(prev => prev.map(c => c.user_id === userId ? { ...c, assigned_agent } : c));
            if (activeUserRef.current?.user_id === userId) {
              setActiveUser(prev => prev ? { ...prev, assigned_agent } : prev);
            }
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
      const agentQS = currentAgent ? `?agent=${encodeURIComponent(currentAgent)}` : '';
      const ws = new WebSocket(`${wsBase}${activeUserRef.current?.user_id}${agentQS}`);
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

  if (isLoginPath) {
    return (
      <Suspense fallback={<div className="min-h-screen w-full flex items-center justify-center bg-gray-900 text-white">Loading…</div>}>
        <Login onSuccess={(user) => {
          try { localStorage.setItem('agent_username', user || ''); } catch {}
          window.location.replace(`/#agent=${encodeURIComponent(user || '')}`);
        }} />
      </Suspense>
    );
  }

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
          currentAgent={currentAgent}
          isAdmin={isAdmin}
        onStartNewChat={(digits, display) => {
          try {
            const id = String(digits);
            const name = display || id;
            setActiveUser({ user_id: id, name });
            // Ensure Inbox tab
            setShowArchive(false);
          } catch {}
        }}
        />
        <div className="flex-1 flex flex-col border-r border-gray-700 bg-gray-900 overflow-y-auto">
          <AgentHeaderBar />
          {/* InternalChannelsBar inline list removed in favor of dropdown on the sidebar icon */}
          {authReady || isLoginPath ? (
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
          ) : (
            <div className="p-3 text-sm text-gray-300">Checking session…</div>
          )}
        </div>
      </div>
      {/* MIDDLE: Chat window */}
      <div className="flex-1 overflow-hidden relative z-0 min-w-0">
        {/* Pass wsRef.current as prop so ChatWindow can send/receive via WebSocket */}
        {authReady || isLoginPath ? (
          <ChatWindow
            activeUser={activeUser}
            catalogProducts={catalogProducts}
            ws={wsRef.current}
            currentAgent={currentAgent}
            adminWs={adminWsRef.current}
            onUpdateConversationTags={handleUpdateConversationTags}
          />
        ) : null}
        {/* Persistent audio bar above composer area */}
        <div className="absolute left-0 right-0 bottom-[88px] px-4">
          <GlobalAudioBar />
        </div>
      </div>
      {/* RIGHT: Shopify "contact info" panel, responsive (hidden on small/medium) */}
      <div className="hidden lg:block lg:w-80 lg:min-w-[18rem] lg:flex-shrink-0 border-l border-gray-700 bg-gray-900 overflow-y-auto">
        <Suspense fallback={<div className="p-3 text-sm text-gray-300">Loading Shopify panel…</div>}>
          <ShopifyIntegrationsPanel activeUser={activeUser} currentAgent={currentAgent} />
        </Suspense>
      </div>
      {showAdmin && (
        <Suspense fallback={<div className="p-3 text-sm text-gray-300">Loading settings…</div>}>
          <AdminDashboard onClose={() => setShowAdmin(false)} isAdmin={isAdmin} currentAgent={currentAgent} />
        </Suspense>
      )}
    </div>
    </AudioProvider>
  );
}
