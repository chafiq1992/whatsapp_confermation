import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useLayoutEffect,
  memo,
} from "react";
import api from './api';
import { FixedSizeList as List } from "react-window";
import { FiSearch, FiMail, FiMessageSquare, FiUserCheck, FiUser, FiTag } from 'react-icons/fi';
import { Clock3, Check, CheckCheck, XCircle } from 'lucide-react';

// Consistent timezone and date helpers shared with ChatWindow
const CHAT_TZ = 'Africa/Casablanca';
const CHAT_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: CHAT_TZ,
});
const CHAT_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHAT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const CHAT_LONG_DAY_FMT = new Intl.DateTimeFormat(undefined, { timeZone: CHAT_TZ, weekday: 'long' });

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

// WhatsApp-like ticks for status in chat list
const TICK_ICONS = {
  sending:   <Clock3     size={14} className="text-gray-400" />,
  sent:      <Check      size={14} className="text-gray-400" />,
  delivered: <CheckCheck size={14} className="text-gray-400" />,
  read:      <CheckCheck size={14} className="text-blue-500" />,
  failed:    <XCircle    size={14} className="text-red-500" />,
};

const renderTickIcon = (status) => {
  if (!status) return null;
  return TICK_ICONS[String(status)] || null;
};
const getDayKey = (dateLike) => CHAT_DAY_FMT.format(new Date(toMsNormalized(dateLike)));

/* ───────────── Helpers ───────────── */
const getInitials = (name = "") => {
  const [first = "", second = ""] = name.split(" ");
  return (first[0] + second[0]).toUpperCase() || "?";
};

const formatTime = (iso) => {
  if (!iso) return "";
  const ms = toMsNormalized(iso);
  const dayKey = getDayKey(ms);
  const todayKey = getDayKey(Date.now());
  const yesterdayKey = getDayKey(Date.now() - 864e5);
  if (dayKey === todayKey) return CHAT_TIME_FMT.format(new Date(ms));
  if (dayKey === yesterdayKey) return "Yesterday";
  return CHAT_LONG_DAY_FMT.format(new Date(ms));
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
  const [assigneeMenuOpen, setAssigneeMenuOpen] = useState(false);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  // Settings modal moved to header; no local settings state here
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const activeUserRef = useRef(activeUser);
  const containerRef = useRef(null);
  const [listHeight, setListHeight] = useState(0);
  const searchDebounceRef = useRef(null);
  // FLIP animation refs for visible rows
  const rowNodesRef = useRef(new Map());
  const prevPositionsRef = useRef(new Map());

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  // Live preview updates are handled in App to keep a single source of truth

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
          if (Array.isArray(res.data)) {
            // Merge server results with App's latest previews to avoid stale downgrades
            const baseById = new Map((Array.isArray(initialConversations) ? initialConversations : []).map(c => [c.user_id, c]));
            const rank = (s) => ({ sending: 0, sent: 1, delivered: 2, read: 3, failed: 99 }[s] ?? -1);
            const merged = res.data.map(s => {
              const b = baseById.get(s.user_id);
              if (!b) return s;
              const sMs = toMsNormalized(s.last_message_time);
              const bMs = toMsNormalized(b.last_message_time);
              if (bMs > sMs) {
                return {
                  ...s,
                  last_message: b.last_message,
                  last_message_type: b.last_message_type,
                  last_message_time: b.last_message_time,
                  last_message_from_me: b.last_message_from_me,
                  last_message_status: b.last_message_status,
                };
              } else if (bMs === sMs) {
                return {
                  ...s,
                  last_message_from_me: (typeof s.last_message_from_me === 'boolean') ? s.last_message_from_me : b.last_message_from_me,
                  last_message_status: (() => {
                    const curr = s.last_message_status;
                    const other = b.last_message_status;
                    if (!curr) return other;
                    if (!other) return curr;
                    return rank(curr) >= rank(other) ? curr : other;
                  })(),
                };
              }
              return s;
            }).map(item => {
              // Ensure unread is zero for currently open conversation
              if (activeUserRef.current?.user_id && item.user_id === activeUserRef.current.user_id) {
                return { ...item, unread_count: 0 };
              }
              return item;
            });
            setConversations(merged);
          }
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
    // Sort by most recent activity (desc), using normalized parsing
    return filtered.sort((a, b) => toMsNormalized(b.last_message_time) - toMsNormalized(a.last_message_time));
  }, [conversations, search, showUnreadOnly, assignedFilter, tagFilters, needsReplyOnly, showArchive]);

  // If search looks like a phone number and not present in list, offer a "new chat" row
  const newChatCandidate = useMemo(() => {
    const raw = String(search || '').trim();
    if (!raw) return null;
    // Accept digits, spaces, hyphens, parentheses, leading +
    const cleaned = raw.replace(/[^\d+]/g, '');
    const digits = cleaned.replace(/\D/g, '');
    // Heuristic: phone-like if at least 8 digits
    if (digits.length < 8) return null;
    // Normalize user_id as digits-only (your backend stores user_id as WA id/phone)
    const candidateId = digits;
    const exists = (Array.isArray(conversations) ? conversations : []).some(c => String(c.user_id || '') === candidateId);
    if (exists) return null;
    const nowIso = new Date().toISOString();
    return {
      __newChat: true,
      user_id: candidateId,
      name: cleaned.startsWith('+') ? cleaned : candidateId,
      last_message: 'Start new chat',
      last_message_type: 'text',
      last_message_time: nowIso,
      last_message_from_me: undefined,
      last_message_status: undefined,
      unread_count: 0,
      unresponded_count: 0,
      tags: [],
    };
  }, [search, conversations]);

  /* ─── Helpers ─── */
  const isOnline = useCallback(
    (id) => onlineUsers.includes(id),
    [onlineUsers]
  );

  // Register DOM node for a conversation row (for FLIP animations)
  const registerRowNode = useCallback((userId, node) => {
    try {
      if (!rowNodesRef.current) rowNodesRef.current = new Map();
      if (node) {
        rowNodesRef.current.set(userId, node);
      } else {
        rowNodesRef.current.delete(userId);
      }
    } catch {}
  }, []);

  // Smoothly animate reorder like WhatsApp (FLIP)
  useLayoutEffect(() => {
    try {
      // Respect reduced motion
      const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const nodes = rowNodesRef.current;
      if (!nodes || nodes.size === 0) return;

      // Measure current positions (LAST)
      const lastPositions = new Map();
      nodes.forEach((node, key) => {
        if (!node || !node.getBoundingClientRect) return;
        // Clear any transient transforms before measuring
        node.style.willChange = '';
        node.style.transform = '';
        node.style.transition = '';
        const rect = node.getBoundingClientRect();
        lastPositions.set(key, rect.top);
      });

      // Compare with previous (FIRST) and animate
      const firstPositions = prevPositionsRef.current || new Map();
      lastPositions.forEach((lastTop, key) => {
        const firstTop = firstPositions.get(key);
        if (typeof firstTop !== 'number') return;
        const dy = firstTop - lastTop;
        if (!dy) return;
        const node = nodes.get(key);
        if (!node) return;
        if (prefersReduced) return;
        try {
          node.style.willChange = 'transform';
          node.style.transform = `translateY(${dy}px)`;
          // Force reflow, then animate to identity
          void node.offsetHeight;
          node.style.transition = 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)';
          node.style.transform = 'translateY(0)';
          const clear = () => {
            node.style.willChange = '';
            node.style.transition = '';
            node.removeEventListener('transitionend', clear);
          };
          node.addEventListener('transitionend', clear);
        } catch {}
      });

      // Update previous positions for next cycle
      prevPositionsRef.current = lastPositions;
    } catch {}
    // Trigger when order changes or container resizes height
  }, [filteredConversations.map(c => c.user_id).join(','), listHeight]);

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
      // Do not navigate with arrows when the user is typing in an input/textarea/contenteditable
      const ae = document.activeElement;
      if (ae && (ae.isContentEditable || ["input","textarea","select"].includes(String(ae.tagName || '').toLowerCase()))) {
        return;
      }
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
        <div className="w-full bg-gray-800/70 border border-gray-700 rounded-xl px-3 py-2 flex items-center gap-1">
          <div className="flex items-center gap-1 flex-1">
            <FiSearch className="text-gray-400" />
            <input
              className="flex-1 bg-transparent placeholder-gray-400 text-white focus:outline-none text-sm"
              placeholder="Search or start new chat"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className={`w-2.5 h-2.5 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`} title={`WebSocket ${wsConnected ? 'connected' : 'disconnected'}`} />
          <div className="h-4 w-px bg-gray-700 mx-0.5" />
          <button
            type="button"
            className={`p-1.5 rounded-lg text-sm ${showUnreadOnly ? 'bg-[#004AAD] text-white' : 'text-gray-300 hover:bg-gray-700'}`}
            title="Unread only"
            onClick={() => setShowUnreadOnly(p => !p)}
          >
            <FiMail />
          </button>
          <button
            type="button"
            className={`p-1.5 rounded-lg text-sm ${needsReplyOnly ? 'bg-yellow-500 text-black' : 'text-gray-300 hover:bg-gray-700'}`}
            title="Needs reply"
            onClick={() => setNeedsReplyOnly(p => !p)}
          >
            <FiMessageSquare />
          </button>
          <button
            type="button"
            className={`p-1.5 rounded-lg text-sm ${(assignedFilter && currentAgent && assignedFilter === currentAgent) ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}
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
          <div className="h-4 w-px bg-gray-700 mx-0.5" />
          <div className="relative">
            <button
              type="button"
              className={`p-1.5 rounded-lg text-sm ${assigneeMenuOpen || (assignedFilter && assignedFilter !== 'all') ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}
              title="Assignee filter"
              onClick={() => setAssigneeMenuOpen(v => !v)}
            >
              <FiUser />
            </button>
            {assigneeMenuOpen && (
              <div className="absolute right-0 mt-2 w-48 bg-gray-900 border border-gray-700 rounded shadow-lg z-20 p-2">
                <button className={`w-full text-left px-2 py-1 rounded ${assignedFilter==='all'?'bg-gray-700 text-white':'text-gray-200 hover:bg-gray-800'}`} onClick={()=>{ setAssignedFilter('all'); setAssigneeMenuOpen(false); }}>All</button>
                <button className={`w-full text-left px-2 py-1 rounded ${assignedFilter==='unassigned'?'bg-gray-700 text-white':'text-gray-200 hover:bg-gray-800'}`} onClick={()=>{ setAssignedFilter('unassigned'); setAssigneeMenuOpen(false); }}>Unassigned</button>
                <div className="h-px bg-gray-700 my-1" />
                <div className="max-h-48 overflow-auto">
                  {agents.map(a => (
                    <button key={a.username} className={`w-full text-left px-2 py-1 rounded ${assignedFilter===a.username?'bg-gray-700 text-white':'text-gray-200 hover:bg-gray-800'}`} onClick={()=>{ setAssignedFilter(a.username); setAssigneeMenuOpen(false); }}>{a.name || a.username}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              className={`p-1.5 rounded-lg text-sm ${tagMenuOpen || tagFilters.length>0 ? 'bg-[#004AAD] text-white' : 'text-gray-300 hover:bg-gray-700'}`}
              title="Tag filters"
              onClick={() => setTagMenuOpen(v => !v)}
            >
              <FiTag />
            </button>
            {tagMenuOpen && (
              <div className="absolute right-0 mt-2 w-56 bg-gray-900 border border-gray-700 rounded shadow-lg z-20 p-2">
                <div className="text-xs text-gray-400 px-2 pb-1">Select tags</div>
                <div className="max-h-56 overflow-auto">
                  {tagOptions.map(opt => {
                    const active = tagFilters.includes(opt.label);
                    return (
                      <button
                        key={opt.label}
                        className={`w-full text-left px-2 py-1 rounded flex items-center gap-2 ${active ? 'bg-gray-700 text-white' : 'text-gray-200 hover:bg-gray-800'}`}
                        onClick={()=>{
                          if (active) {
                            setTagFilters(tagFilters.filter(x => x !== opt.label));
                          } else {
                            setTagFilters([...tagFilters, opt.label]);
                          }
                        }}
                      >
                        <span className="w-5 h-5 rounded-full bg-[#004AAD] text-white flex items-center justify-center text-[10px]">{opt.icon || (opt.label || '').charAt(0).toUpperCase()}</span>
                        <span className="truncate">{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
                {tagFilters.length>0 && (
                  <div className="mt-2 flex justify-between gap-2">
                    <button className="flex-1 px-2 py-1 rounded bg-gray-700 text-white" onClick={()=> setTagFilters([])}>Clear</button>
                    <button className="flex-1 px-2 py-1 rounded bg-blue-600 text-white" onClick={()=> setTagMenuOpen(false)}>Apply</button>
                  </div>
                )}
              </div>
            )}
          </div>
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
      {filteredConversations.length === 0 && !newChatCandidate ? (
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
          {newChatCandidate && (
            <div
              data-row
              data-id={newChatCandidate.user_id}
              className="group flex gap-3 p-4 cursor-pointer bg-blue-900/30 hover:bg-blue-900/40 text-white/90 rounded-xl m-2 border border-blue-800"
              onClick={() => handleSelect(newChatCandidate)}
            >
              <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center font-semibold">+</div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center">
                  <span className="truncate font-medium">{newChatCandidate.name}</span>
                  <span className="text-xs opacity-80">New</span>
                </div>
                <div className="text-xs text-gray-300">Start new chat</div>
              </div>
            </div>
          )}
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
                registerRowNode={registerRowNode}
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
  registerRowNode,
}) {
  const selected = active === conv.user_id;
  const [assignOpen, setAssignOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(conv.assigned_agent || '');
  const [tagsEditOpen, setTagsEditOpen] = useState(false);
  const [tagsInput, setTagsInput] = useState("");
  const [tags, setTags] = useState(conv.tags || []);
  const rowRef = useCallback((el) => {
    try { registerRowNode && registerRowNode(conv.user_id, el); } catch {}
  }, [registerRowNode, conv?.user_id]);
  return (
    <div
      ref={rowRef}
      style={style}
      data-row
      data-id={conv.user_id}
      onClick={() => onSelect(conv)}
      className={`group flex gap-3 p-4 cursor-pointer transition-colors ${
        selected
          ? "bg-gray-900 text-white -mr-px rounded-l-xl rounded-r-none"
          : "bg-gray-800/60 hover:bg-gray-800 text-white/90 rounded-xl"
      }`}
    >
      {/* Avatar */}
      <div className="relative shrink-0">
        {conv.avatar ? (
          <img
            src={conv.avatar}
            alt={conv.name || conv.user_id}
            className={`w-10 h-10 rounded-full object-cover bg-gray-700 ${
              typeof conv.last_message_from_me === 'boolean'
                ? (conv.last_message_from_me ? 'ring-2 ring-green-500' : 'ring-2 ring-blue-500')
                : ''
            }`}
            onError={(e) => { e.currentTarget.src = '/broken-image.png'; }}
            loading="lazy"
          />
        ) : (
          (() => {
            const raw = String(conv.name || '').trim();
            const firstChar = raw.charAt(0);
            const isDigit = /^\d$/.test(firstChar);
            const showIcon = !firstChar || isDigit;
            const initial = showIcon ? '' : firstChar.toUpperCase();
            const colorClass = typeof conv.last_message_from_me === 'boolean'
              ? (conv.last_message_from_me ? 'bg-green-600' : 'bg-blue-600')
              : 'bg-gray-600';
            return (
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold ${colorClass}`}
                aria-label={conv.name || conv.user_id}
              >
                {initial || <FiUser className="opacity-90" />}
              </div>
            );
          })()
        )}
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
          <span className="text-xs opacity-80">
            {formatTime(conv.last_message_time)}
          </span>
        </div>

        {/* Bottom line */}
        <div className="flex items-center justify-between">
          <span className={`truncate text-xs flex-1 flex items-center gap-1 ${selected ? 'text-white/90' : 'text-gray-300'}`}>
            {conv.last_message_from_me && renderTickIcon(conv.last_message_status)}
            {(() => {
              const t = (conv.last_message_type || '').toLowerCase();
              const msg = typeof conv.last_message === 'string' ? conv.last_message : '';
              const AUDIO_EXT_RE = /\.(ogg|opus|mp3|m4a|wav|webm)(\?.*)?$/i;
              const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i;
              const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv)(\?.*)?$/i;
              if (t === 'image') return <><span aria-hidden>🖼️</span><span>Image</span></>;
              if (t === 'audio') return <><span aria-hidden>🎵</span><span>Audio</span></>;
              if (t === 'video') return <><span aria-hidden>🎬</span><span>Video</span></>;
              if (t === 'catalog_item' || t === 'interactive_product') return <><span aria-hidden>🏷️</span><span>Product</span></>;
              if (t === 'catalog_set') return <><span aria-hidden>📦</span><span>Catalog</span></>;
              if (t === 'order') return <><span aria-hidden>🧾</span><span>Order</span></>;
              // Fallback: detect media by URL extension in text
              if (AUDIO_EXT_RE.test(msg)) return <><span aria-hidden>🎵</span><span>Audio</span></>;
              if (IMAGE_EXT_RE.test(msg)) return <><span aria-hidden>🖼️</span><span>Image</span></>;
              if (VIDEO_EXT_RE.test(msg)) return <><span aria-hidden>🎬</span><span>Video</span></>;
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
