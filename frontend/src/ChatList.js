import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  memo,
} from "react";
import api from './api';
import { FixedSizeList as List } from "react-window";
import { FiSearch, FiMail, FiMessageSquare, FiUserCheck, FiUser } from 'react-icons/fi';

/* ───────────── Helpers ───────────── */
const getInitials = (name = "") => {
  const [first = "", second = ""] = name.split(" ");
  return (first[0] + second[0]).toUpperCase() || "?";
};

const formatTime = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();

  const isSameDay =
    date.toDateString() === now.toDateString() ? "today" : null;
  const isYesterday =
    date.toDateString() ===
    new Date(now.setDate(now.getDate() - 1)).toDateString()
      ? "yesterday"
      : null;

  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Casablanca' }).format(date);
  if (isSameDay) return time;
  if (isYesterday) return "Yesterday";
  return date.toLocaleDateString();
};

const WS_BASE =
  process.env.REACT_APP_WS_URL ||
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/`;

/* ───────────── Component ───────────── */
function ChatList({
  conversations: initialConversations = [],
  setActiveUser,
  activeUser,
  onlineUsers = [],
  defaultAssignedFilter: defaultAssignedFilterProp,
  wsConnected = false,
  showArchive = false,
  currentAgent = '',
  loading = false,
  onUpdateConversationTags,
}) {
  /* ─── Local state ─── */
  const [search, setSearch] = useState("");
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [conversations, setConversations] = useState(initialConversations);
  // wsConnected is now controlled by parent App via admin WS
  const [agents, setAgents] = useState([]);
  const [assignedFilter, setAssignedFilter] = useState('all'); // 'all' | 'unassigned' | username
  const [tagOptions, setTagOptions] = useState([]);
  const [selectedTagFilter, setSelectedTagFilter] = useState("");
  const [tagFilters, setTagFilters] = useState([]);
  // Settings modal moved to header; no local settings state here
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const activeUserRef = useRef(activeUser);
  const containerRef = useRef(null);
  const [listHeight, setListHeight] = useState(0);
  const searchDebounceRef = useRef(null);

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  // Live preview updates from ChatWindow
  useEffect(() => {
    const handler = (ev) => {
      const d = ev.detail || {};
      if (!d.user_id) return;
      setConversations(prev => {
        const list = Array.isArray(prev) ? [...prev] : [];
        const idx = list.findIndex(c => c.user_id === d.user_id);
        const nowIso = new Date().toISOString();
        if (idx === -1) {
          // If conversation not present locally, create a minimal one
          const created = {
            user_id: d.user_id,
            name: d.name || d.user_id,
            last_message: d.last_message || '',
            last_message_type: d.last_message_type || 'text',
            last_message_time: d.last_message_time || nowIso,
            unread_count: 0,
          };
          return [created, ...list];
        }
        const updated = { ...list[idx] };
        if (d.last_message_type) updated.last_message_type = d.last_message_type;
        if (typeof d.last_message === 'string') updated.last_message = d.last_message;
        updated.last_message_time = d.last_message_time || updated.last_message_time || nowIso;
        // Move to top like WhatsApp
        const without = list.filter((_, i) => i !== idx);
        return [updated, ...without];
      });
    };
    window.addEventListener('conversation-preview', handler);
    return () => window.removeEventListener('conversation-preview', handler);
  }, []);

  useEffect(() => {
    activeUserRef.current = activeUser;
  }, [activeUser]);

  // Measure available height for the virtualized list to avoid window-based assumptions
  useEffect(() => {
    if (!containerRef.current) return;
    let rafId = null;
    const update = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setListHeight(containerRef.current ? (containerRef.current.clientHeight || 0) : 0);
      });
    };
    update();
    let ro;
    try {
      ro = new ResizeObserver(update);
      ro.observe(containerRef.current);
    } catch {}
    return () => {
      try { if (rafId) cancelAnimationFrame(rafId); } catch {}
      try { ro && ro.disconnect(); } catch {}
    };
  }, [containerRef.current]);

  // Load agents for filters and assignment tabs
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/admin/agents');
        setAgents(res.data || []);
      } catch (e) {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    if (defaultAssignedFilterProp) setAssignedFilter(defaultAssignedFilterProp);
  }, [defaultAssignedFilterProp]);

  // Load tag options from settings
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/admin/tag-options');
        if (Array.isArray(res.data)) setTagOptions(res.data);
      } catch (e) {
        // ignore
      }
    })();
  }, []);

  // Optionally fetch filtered conversations from backend for scalability (debounced)
  useEffect(() => {
    const controller = new AbortController();
    const run = () => {
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      if (showUnreadOnly) params.set('unread_only', 'true');
      if (assignedFilter && assignedFilter !== 'all') params.set('assigned', assignedFilter);
      if (tagFilters.length) params.set('tags', tagFilters.join(','));
      if (needsReplyOnly) params.set('unresponded_only', 'true');
      if (showArchive) params.set('archived', '1');
      (async () => {
        try {
          const res = await api.get(`/conversations?${params.toString()}`, { signal: controller.signal });
          if (Array.isArray(res.data)) setConversations(res.data);
        } catch (e) {
          // network errors fall back to client filtering of existing list
        }
      })();
    };
    // Debounce only for keystrokes/filter toggles; immediate on mount/first calls is fine
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(run, 350);
    return () => { clearTimeout(searchDebounceRef.current); controller.abort(); };
  }, [search, showUnreadOnly, assignedFilter, tagFilters, needsReplyOnly, showArchive]);

  // Admin WebSocket handled in App; avoid duplicate WS here to prevent double updates

  /* ─── Derived data (memoised) ─── */
  const filteredConversations = useMemo(() => {
    const list = Array.isArray(conversations) ? conversations : [];
    const filtered = list.filter((c) => {
      // Hide internal team and DM conversations from the chat list
      const uid = String(c.user_id || '');
      if (uid.startsWith('dm:') || uid.startsWith('team:')) return false;
      const txt = (c.name || c.user_id || "").toLowerCase();
      const matches = txt.includes(search.toLowerCase());
      const unreadOK = !showUnreadOnly || c.unread_count > 0;
      const assignedOK =
        assignedFilter === 'all' ||
        (assignedFilter === 'unassigned' && !c.assigned_agent) ||
        c.assigned_agent === assignedFilter;
      const tagsOK = tagFilters.length === 0 || (c.tags || []).some(t => tagFilters.includes(t));
      const needsReplyOK = !needsReplyOnly || (c.unresponded_count || 0) > 0;
      const isDone = (c.tags || []).some(t => String(t || '').toLowerCase() === 'done');
      const archiveOK = showArchive ? isDone : !isDone;
      return matches && unreadOK && assignedOK && tagsOK && needsReplyOK && archiveOK;
    });
    // Sort by most recent activity (desc), like WhatsApp
    const toMs = (t) => {
      if (!t) return 0;
      const s = String(t);
      const ms = Date.parse(s);
      return Number.isNaN(ms) ? 0 : ms;
    };
    return filtered.sort((a, b) => toMs(b.last_message_time) - toMs(a.last_message_time));
  }, [conversations, search, showUnreadOnly, assignedFilter, tagFilters, needsReplyOnly, showArchive]);

  /* ─── Helpers ─── */
  const isOnline = useCallback(
    (id) => onlineUsers.includes(id),
    [onlineUsers]
  );

  const handleSelect = useCallback(
    (conv) =>
      setActiveUser({
        user_id: conv.user_id,
        name: conv.name,
        phone: conv.phone ?? conv.user_id,
        avatar: conv.avatar,
        ...conv,
      }),
    [setActiveUser]
  );

  /* ─── Keyboard ↓↑ navigation (optional, remove if unused) ─── */
  const listRef = useRef(null);
  useEffect(() => {
    const handleKeys = (e) => {
      if (!["ArrowUp", "ArrowDown", "Enter"].includes(e.key)) return;
      e.preventDefault();
      const els = listRef.current?.querySelectorAll("[data-row]");
      if (!els?.length) return;

      const index = [...els].findIndex(
        (n) => n.dataset.id === activeUser?.user_id
      );
      let next = index;
      if (e.key === "ArrowDown") next = Math.min(index + 1, els.length - 1);
      if (e.key === "ArrowUp") next = Math.max(index - 1, 0);
      if (e.key === "Enter") return;
      els[next]?.click();
    };
    window.addEventListener("keydown", handleKeys);
    return () => window.removeEventListener("keydown", handleKeys);
  }, [activeUser]);

  /* ─── Render ─── */
  return (
    <div className="w-full h-full flex flex-col min-w-72">
      <div className="p-2 sticky top-0 z-10 bg-gray-900">
        <div className="w-full bg-gray-800/70 border border-gray-700 rounded-xl px-3 py-2 flex items-center gap-2">
          <div className="flex items-center gap-2 flex-1">
            <FiSearch className="text-gray-400" />
            <input
              className="flex-1 bg-transparent placeholder-gray-400 text-white focus:outline-none text-sm"
              placeholder="Search or start new chat"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className={`w-2.5 h-2.5 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`} title={`WebSocket ${wsConnected ? 'connected' : 'disconnected'}`} />
          <div className="h-4 w-px bg-gray-700 mx-1" />
          <button
            type="button"
            className={`p-2 rounded-lg text-sm ${showUnreadOnly ? 'bg-[#004AAD] text-white' : 'text-gray-300 hover:bg-gray-700'}`}
            title="Unread only"
            onClick={() => setShowUnreadOnly(p => !p)}
          >
            <FiMail />
          </button>
          <button
            type="button"
            className={`p-2 rounded-lg text-sm ${needsReplyOnly ? 'bg-yellow-500 text-black' : 'text-gray-300 hover:bg-gray-700'}`}
            title="Needs reply"
            onClick={() => setNeedsReplyOnly(p => !p)}
          >
            <FiMessageSquare />
          </button>
          <button
            type="button"
            className={`p-2 rounded-lg text-sm ${(assignedFilter && currentAgent && assignedFilter === currentAgent) ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}
            title="My assigned only"
            onClick={() => {
              if (assignedFilter === currentAgent) {
                setAssignedFilter('all');
              } else {
                setAssignedFilter(currentAgent || 'all');
              }
            }}
          >
            <FiUserCheck />
          </button>
          <div className="h-4 w-px bg-gray-700 mx-1" />
          <select
            className="bg-transparent text-sm text-gray-200 rounded-md px-2 py-1 focus:outline-none hover:bg-gray-700"
            value={assignedFilter}
            onChange={(e) => setAssignedFilter(e.target.value)}
            title="Filter by assignee"
          >
            <option value="all">All</option>
            <option value="unassigned">Unassigned</option>
            {agents.map(a => (
              <option key={a.username} value={a.username}>{a.name || a.username}</option>
            ))}
          </select>
          <select
            className="bg-transparent text-sm text-gray-200 rounded-md px-2 py-1 focus:outline-none hover:bg-gray-700"
            value={selectedTagFilter}
            onChange={(e) => {
              const val = e.target.value;
              setSelectedTagFilter(val);
              if (val && !tagFilters.includes(val)) {
                setTagFilters([...tagFilters, val]);
                setTimeout(() => setSelectedTagFilter(''), 0);
              }
            }}
            title="Filter by tag"
          >
            <option value="">Tags…</option>
            {tagOptions.map(opt => (
              <option key={opt.label} value={opt.label}>
                {`${opt.icon ? opt.icon + ' ' : ''}${opt.label}`}
              </option>
            ))}
          </select>
        </div>
        {tagFilters.length > 0 && (
          <div className="mt-2 flex gap-2 flex-wrap">
            {tagFilters.map(t => (
              <div key={t} className="flex items-center gap-1 bg-gray-800/70 border border-gray-700 rounded-full px-2 py-0.5 text-xs text-gray-200">
                <span className="w-5 h-5 rounded-full bg-[#004AAD] text-white flex items-center justify-center text-[10px]">
                  {(() => {
                    const opt = tagOptions.find(o => (o.label || '').toLowerCase() === (t || '').toLowerCase());
                    return opt?.icon || (t || '').charAt(0).toUpperCase();
                  })()}
                </span>
                <span className="pr-1">{t}</span>
                <button onClick={() => setTagFilters(tagFilters.filter(x => x !== t))} className="hover:text-white" title="Remove">✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Empty states */}
      {filteredConversations.length === 0 ? (
        loading ? (
          <div className="flex-1 p-3 space-y-3" aria-live="polite">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <div className="w-10 h-10 rounded-full bg-gray-800 animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-gray-800 rounded w-1/2 animate-pulse" />
                  <div className="h-3 bg-gray-800 rounded w-2/3 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400 select-none">
            <span className="text-5xl mb-2">💬</span>
            {conversations.length === 0
              ? "No conversations yet"
              : search
              ? `No chat matches “${search}”`
              : "No unread conversations"}
          </div>
        )
      ) : (
        /* Chat list */
        <div ref={(el)=>{ listRef.current = el; containerRef.current = el; }} className="flex-1 overflow-y-auto divide-y divide-gray-800">
          <List
            height={Math.max(200, listHeight)}
            itemCount={filteredConversations.length}
            itemSize={80}
            width={'100%'}
            className=""
            overscanCount={12}
            useIsScrolling
            itemKey={(index) => filteredConversations[index]?.user_id || `row_${index}`}
          >
            {({ index, style }) => (
              <ConversationRow
                style={style}
                conv={filteredConversations[index]}
                onSelect={handleSelect}
                active={activeUser?.user_id}
                isOnline={isOnline}
                agents={agents}
                tagOptions={tagOptions}
                onUpdateConversationTags={onUpdateConversationTags}
              />
            )}
          </List>
        </div>
      )}
      {/* Settings/Automation controls moved to header */}
    </div>
  );
}

/* ───────────── Single row (memoised) ───────────── */
const ConversationRow = memo(function Row({
  conv,
  onSelect,
  active,
  isOnline,
  style, // only used by react-window
  agents = [],
  tagOptions = [],
  onUpdateConversationTags,
}) {
  const selected = active === conv.user_id;
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(conv.assigned_agent || '');
  const [tagsEditOpen, setTagsEditOpen] = useState(false);
  const [tagsInput, setTagsInput] = useState("");
  const [tags, setTags] = useState(conv.tags || []);
  return (
    <div
      style={style}
      data-row
      data-id={conv.user_id}
      onClick={() => onSelect(conv)}
      className={`group flex gap-3 p-4 cursor-pointer hover:bg-gray-800 ${
        selected ? "bg-[#004AAD] text-white" : ""
      }`}
    >
      {/* Avatar */}
      <div className="relative shrink-0">
        <img
          src={conv.avatar || '/broken-image.png'}
          alt={conv.name || conv.user_id}
          className="w-10 h-10 rounded-full object-cover bg-gray-700"
          onError={(e) => { e.currentTarget.src = '/broken-image.png'; }}
          loading="lazy"
        />
        {isOnline(conv.user_id) && (
          <span
            className="absolute -right-0.5 -bottom-0.5 w-3 h-3 bg-green-500 border-2 border-gray-900 rounded-full"
            title="Online"
          />
        )}
      </div>

      {/* Text block */}
      <div className="flex-1 min-w-0">
        {/* Top line */}
        <div className="flex justify-between items-center">
          <span className="truncate font-medium">
            {conv.name || conv.user_id}
          </span>
          <span className="text-xs text-gray-400">
            {formatTime(conv.last_message_time)}
          </span>
        </div>

        {/* Bottom line */}
        <div className="flex items-center justify-between">
          <span className="truncate text-xs text-gray-300 flex-1 flex items-center gap-1">
            {(() => {
              const t = (conv.last_message_type || '').toLowerCase();
              if (t === 'image') return <><span aria-hidden>🖼️</span><span>Image</span></>;
              if (t === 'audio') return <><span aria-hidden>🎵</span><span>Audio</span></>;
              if (t === 'video') return <><span aria-hidden>🎬</span><span>Video</span></>;
              if (t === 'catalog_item' || t === 'interactive_product') return <><span aria-hidden>🏷️</span><span>Product</span></>;
              if (t === 'catalog_set') return <><span aria-hidden>📦</span><span>Catalog</span></>;
              if (t === 'order') return <><span aria-hidden>🧾</span><span>Order</span></>;
              return conv.last_message || "No messages yet";
            })()}
          </span>
          <div className="flex gap-2 ml-2 items-center">
            {selectedAgent && (
              <span className="px-3 py-1.5 bg-indigo-600 text-white rounded-full text-base flex items-center gap-1">
                <FiUser className="opacity-90" />
                {agents.find(a => a.username === selectedAgent)?.name || selectedAgent}
              </span>
            )}
            {(tags || []).slice(0,3).map(t => (
              <span key={t} className="w-8 h-8 rounded-full bg-[#004AAD] text-white flex items-center justify-center text-sm ring-2 ring-white/20">
                {(() => {
                  const opt = tagOptions.find(o => (o.label || '').toLowerCase() === (t || '').toLowerCase());
                  return opt?.icon || (t || '').charAt(0).toUpperCase();
                })()}
              </span>
            ))}
            {!!conv.unread_count && (
              <span
                className="bg-green-600 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center"
                title={`${conv.unread_count} unread`}
              >
                {conv.unread_count > 99 ? "99+" : conv.unread_count}
              </span>
            )}
            {!!conv.unresponded_count && (
              <span
                className="bg-yellow-400 text-black text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center"
                title={`${conv.unresponded_count} waiting reply`}
              >
                {conv.unresponded_count > 99 ? "99+" : conv.unresponded_count}
              </span>
            )}
            <div className="relative">
              <button
                className="px-2 py-1 bg-gray-700 text-white rounded"
                onClick={(e) => { e.stopPropagation(); setAssignOpen(!assignOpen); }}
                title="Assign / Tags"
              >▾</button>
              {assignOpen && (
                <div className="absolute right-0 mt-2 w-64 bg-gray-900 border border-gray-700 rounded shadow-lg z-10 p-2" onClick={(e) => e.stopPropagation()}>
                  <div className="mb-2">
                    <label className="text-xs text-gray-400">Assign to</label>
                    <div className="flex gap-2 mt-1">
                      <select className="flex-1 bg-gray-800 text-white p-2 rounded" value={selectedAgent} onChange={(e)=>{ const v = e.target.value; setSelectedAgent(v); (async ()=>{ try { await api.post(`/conversations/${conv.user_id}/assign`, { agent: v || null }); } catch(e) {} })(); setAssignOpen(false); }}>
                        <option value="">Unassigned</option>
                        {agents.map(a => (
                          <option key={a.username} value={a.username}>{a.name || a.username}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-400">Tags</label>
                    <div className="flex gap-2 mt-1 items-center">
                      <select
                        className="flex-1 bg-gray-800 text-white p-2 rounded"
                        value={tagsInput}
                        onChange={(e)=>{
                          const val = e.target.value;
                          setTagsInput(val);
                          if (val && !tags.includes(val)) {
                            const newTags = [...tags, val];
                            setTags(newTags);
                            setTagsInput('');
                            (async ()=>{
                              try {
                                await api.post(`/conversations/${conv.user_id}/tags`, { tags: newTags });
                                try { typeof onUpdateConversationTags === 'function' && onUpdateConversationTags(conv.user_id, newTags); } catch {}
                              } catch(e) {}
                            })();
                            setAssignOpen(false);
                          }
                        }}
                      >
                        <option value="">Select a tag…</option>
                        {tagOptions.map(opt => (
                          <option key={opt.label} value={opt.label}>
                            {`${opt.icon ? opt.icon + ' ' : ''}${opt.label}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2 flex-wrap mt-2 items-center">
                      {tags.map(t => (
                        <div key={t} className="flex items-center gap-1">
                          <span className="w-8 h-8 rounded-full bg-gray-700 text-white flex items-center justify-center text-sm ring-2 ring-white/10">
                            {(() => {
                              const opt = tagOptions.find(o => (o.label || '').toLowerCase() === (t || '').toLowerCase());
                              return opt?.icon || (t || '').charAt(0).toUpperCase();
                            })()}
                          </span>
                          <button onClick={() => {
                            const newTags = tags.filter(x => x !== t);
                            setTags(newTags);
                            (async ()=>{
                              try {
                                await api.post(`/conversations/${conv.user_id}/tags`, { tags: newTags });
                                try { typeof onUpdateConversationTags === 'function' && onUpdateConversationTags(conv.user_id, newTags); } catch {}
                              } catch(e) {}
                            })();
                            setAssignOpen(false);
                          }} className="text-xs text-gray-300 hover:text-white">✕</button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            
          </div>
        </div>
      </div>
    </div>
  );
});

export default ChatList;
