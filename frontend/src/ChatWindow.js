import React, { useEffect, useState, useRef, useCallback, Suspense, useMemo, useLayoutEffect } from 'react';
import api from './api';
import MessageBubble from './MessageBubble';
import ForwardDialog from './ForwardDialog';
import useAudioRecorder from './useAudioRecorder';
import { Virtuoso } from 'react-virtuoso';
import { saveMessages, loadMessages } from './chatStorage';
import Composer from './Composer';
const TemplatesDialog = React.lazy(() => import('./TemplatesDialog'));
const CatalogPanel = React.lazy(() => import("./CatalogPanel"));
const MemoMessageBubble = React.memo(MessageBubble);
const NotesDialog = React.lazy(() => import('./NotesDialog'));

// API and WebSocket endpoints
const API_BASE = process.env.REACT_APP_API_BASE || '';
const WS_BASE =
  process.env.REACT_APP_WS_URL ||
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/`;

// Ensure UI never downgrades delivery state if events arrive out of order
const STATUS_RANK = { sending: 0, sent: 1, delivered: 2, read: 3, failed: 99 };

// Small debounce helper to limit rapid calls (e.g., typing indicator)
function debounce(fn, wait) {
  let t = null;
  return function debounced(...args) {
    const ctx = this;
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(ctx, args), wait);
  };
}

const sortByTime = (list = []) => {
  // Normalize timestamps across types; treat naive ISO as UTC for consistency
  const toMs = (t) => {
    if (!t) return 0;
    if (t instanceof Date) return t.getTime();
    if (typeof t === 'number') return t;
    const s = String(t);
    if (/^\d+$/.test(s)) return Number(s) * (s.length <= 10 ? 1000 : 1);
    // If ISO-like and missing timezone (no 'Z' or +/-), assume UTC
    if (s.includes('T') && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
      const ms = Date.parse(s + 'Z');
      if (!Number.isNaN(ms)) return ms;
    }
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? 0 : ms;
  };
  return [...list].sort((a, b) => {
    const aMs = toMs(a.server_ts || a.timestamp);
    const bMs = toMs(b.server_ts || b.timestamp);
    if (aMs !== bMs) return aMs - bMs;
    // If timestamps are equal, always place customer's message (from_me=false) before ours (from_me=true)
    if (Boolean(a.from_me) !== Boolean(b.from_me)) {
      return a.from_me ? 1 : -1;
    }
    // Tie-breaker using client-side monotonic ts if available
    const aCt = a.client_ts || 0;
    const bCt = b.client_ts || 0;
    if (aCt !== bCt) return aCt - bCt;
    // Final tie-break on temp_id/id to keep stable ordering
    const ak = a.temp_id || a.id || '';
    const bk = b.temp_id || b.id || '';
    return String(ak).localeCompare(String(bk));
  });
};

//


// Generate temporary message ID for optimistic UI
function generateTempId() {
  return `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Group consecutive images; support both url and message (blob) fields
function groupConsecutiveImages(messages) {
  const grouped = [];
  let i = 0;
  while (i < messages.length) {
    const curr = messages[i];
    const isImg = curr.type === 'image' && (typeof curr.url === 'string' || typeof curr.message === 'string');
    if (isImg) {
      const group = [curr];
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        const isNextImg = next.type === 'image' && (typeof next.url === 'string' || typeof next.message === 'string');
        if (!isNextImg || next.from_me !== curr.from_me) break;
        group.push(next);
        j++;
      }
      if (group.length > 1) {
        grouped.push({
          ...group[0],
          message: group.map(im => ({ type: 'image', message: im.url || im.message, caption: im.caption, price: im.price })),
        });
      } else {
        grouped.push(curr);
      }
      i = j;
      continue;
    }
    grouped.push(curr);
    i++;
  }
  return grouped;
}

function ChatWindow({ activeUser, ws, currentAgent, adminWs, onUpdateConversationTags }) {
  const [messages, setMessages] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHitIndexes, setSearchHitIndexes] = useState([]);
  const [activeHitIdx, setActiveHitIdx] = useState(-1);
  const [pendingQueues, setPendingQueues] = useState({});
  const [sendingQueues, setSendingQueues] = useState({});
  const [unreadSeparatorIndex, setUnreadSeparatorIndex] = useState(null);
  const [replyTarget, setReplyTarget] = useState(null);
  const [catalogProducts, setCatalogProducts] = useState({});
  const [isTypingOther, setIsTypingOther] = useState(false);
  const MESSAGE_LIMIT = 50;
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const conversationIdRef = useRef(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [highlightedIds, setHighlightedIds] = useState(new Set());
  const highlightTimeoutsRef = useRef(new Map());
  const forwardPayloadRef = useRef(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesCount, setNotesCount] = useState(0);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const messagesRef = useRef([]);
  // Track the in-flight initial HTTP fetch so we can cancel it once WS delivers data
  const initialFetchControllerRef = useRef(null);

  // Helper to merge and deduplicate messages by stable identifiers
  const mergeAndDedupe = useCallback((prevList, incomingList) => {
    const byKey = new Map();
    const add = (m) => {
      const key = m.wa_message_id || m.id || m.temp_id || `${m.timestamp}-${m.message}`;
      // last write wins so newer incoming updates replace older
      byKey.set(key, m);
    };
    (prevList || []).forEach(add);
    (incomingList || []).forEach(add);
    return sortByTime([...byKey.values()]);
  }, []);

  // Reset state immediately on conversation change, then hydrate from cache
  useEffect(() => {
    const openHandler = (ev) => {
      const uid = ev?.detail?.user_id;
      if (!uid || uid !== activeUser?.user_id) return;
      setNotesOpen(true);
    };
    window.addEventListener('open-notes', openHandler);
    return () => window.removeEventListener('open-notes', openHandler);
  }, [activeUser?.user_id]);

  // Fetch notes count on conversation change
  useEffect(() => {
    const uid = activeUser?.user_id;
    if (!uid) { setNotesCount(0); return; }
    (async () => {
      try {
        const res = await api.get(`/conversations/${uid}/notes`);
        setNotesCount(Array.isArray(res.data) ? res.data.length : 0);
      } catch {
        setNotesCount(0);
      }
    })();
  }, [activeUser?.user_id]);

  // Live update notes count when notes are added/removed
  useEffect(() => {
    const uid = activeUser?.user_id;
    if (!uid) return;
    const onAdded = (ev) => { try { if (ev?.detail?.user_id === uid) setNotesCount((n) => n + 1); } catch {} };
    const onDeleted = (ev) => { try { if (ev?.detail?.user_id === uid) setNotesCount((n) => Math.max(0, n - 1)); } catch {} };
    window.addEventListener('note-added', onAdded);
    window.addEventListener('note-deleted', onDeleted);
    return () => {
      try {
        window.removeEventListener('note-added', onAdded);
        window.removeEventListener('note-deleted', onDeleted);
      } catch {}
    };
  }, [activeUser?.user_id]);

  useEffect(() => {
    const uid = activeUser?.user_id;
    if (!uid) return;
    setIsInitialLoading(true);
    conversationIdRef.current = uid;
    setMessages([]);
    setOffset(0);
    setHasMore(true);
    setUnreadSeparatorIndex(null);
    setAllowSmoothScroll(false);
    hasInitialisedScrollRef.current = false;
    justOpenedRef.current = true;
    // First, hydrate from cache for instant UX
    loadMessages(uid).then((msgs) => {
      if (conversationIdRef.current !== uid) return; // ignore stale
      if (Array.isArray(msgs) && msgs.length > 0) {
        setMessages(sortByTime(msgs));
      }
    });
    // Then kick off network fetch with cancellation
    const controller = new AbortController();
    initialFetchControllerRef.current = controller;
    fetchMessages({ offset: 0 }, controller.signal, uid);
    return () => {
      try { controller.abort(); } catch {}
      if (initialFetchControllerRef.current === controller) {
        initialFetchControllerRef.current = null;
      }
    };
  }, [activeUser?.user_id, /* stable */]);
  
  // Track last received timestamp for resume on reconnect
  const lastTimestampRef = useRef(null);

  // Max concurrent image uploads (WhatsApp style)
  const MAX_CONCURRENT_UPLOADS = 3;

  const fileInputRef = useRef();
  const messagesEndRef = useRef(null);
  const listRef = useRef(null);
  const [listHeight, setListHeight] = useState(0);
  const canvasRef = useRef();
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const typingTimeoutRef = useRef(null);
  const lastTypingSentRef = useRef(0);
  const sendTypingFalseDebounced = useRef(
    debounce(() => {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'typing', is_typing: false }));
        }
      } catch {}
    }, 1200)
  );
  const [allowSmoothScroll, setAllowSmoothScroll] = useState(false);
  const hasInitialisedScrollRef = useRef(false);
  const justOpenedRef = useRef(false);
  const lastVisibleStartIndexRef = useRef(0);
  const [firstItemIndex, setFirstItemIndex] = useState(0);
  // Throttle list height updates to avoid frequent re-mounts (prevents audio flicker while typing)
  const layoutLastHeightRef = useRef(0);
  const layoutLastUpdateTsRef = useRef(0);
  const lastPreviewRef = useRef({ user_id: null, time: null, message: null, type: null });

  // Insert date separators like WhatsApp Business
  // Normalize timestamps and group by day in a single, consistent timezone to avoid flicker
  const CHAT_TZ = 'Africa/Casablanca';
  const dayFormatter = useMemo(() => new Intl.DateTimeFormat('en-CA', {
    timeZone: CHAT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }), []);
  const weekdayFormatter = useMemo(() => new Intl.DateTimeFormat(undefined, {
    timeZone: CHAT_TZ,
    weekday: 'long',
  }), []);

  const toMsNormalized = useCallback((t) => {
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
  }, []);

  const getDayKey = useCallback((dateLike) => {
    const ms = toMsNormalized(dateLike);
    return dayFormatter.format(new Date(ms)); // YYYY-MM-DD in CHAT_TZ
  }, [dayFormatter, toMsNormalized]);

  const formatDayLabel = useCallback((dateLike) => {
    const dayKey = getDayKey(dateLike);
    const todayKey = getDayKey(Date.now());
    const yesterdayKey = getDayKey(Date.now() - 864e5);
    if (dayKey === todayKey) return 'Today';
    if (dayKey === yesterdayKey) return 'Yesterday';
    return weekdayFormatter.format(new Date(toMsNormalized(dateLike)));
  }, [getDayKey, weekdayFormatter, toMsNormalized]);

  const withDateSeparators = (list = []) => {
    const result = [];
    let lastDay = '';
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const baseTs = m.server_ts || m.timestamp;
      const dayKey = getDayKey(baseTs);
      if (dayKey !== lastDay) {
        const unique = String(m.wa_message_id || m.id || m.temp_id || m.client_ts || baseTs || i);
        result.push({ __separator: true, label: formatDayLabel(baseTs), key: `sep_${dayKey}_${unique}` });
        lastDay = dayKey;
      }
      result.push(m);
    }
    return result;
  };

  const groupedMessages = useMemo(() => withDateSeparators(groupConsecutiveImages(messages)), [messages]);
  const groupedLenRef = useRef(0);
  useEffect(() => { groupedLenRef.current = groupedMessages.length; }, [groupedMessages.length]);
  const groupedMessagesRef = useRef([]);
  useEffect(() => { groupedMessagesRef.current = groupedMessages; }, [groupedMessages]);

  // Scroll to a referenced message and flash-highlight it briefly
  useEffect(() => {
    const handler = (ev) => {
      try {
        const targetId = String(ev?.detail?.id || '');
        if (!targetId) return;
        const idx = groupedMessagesRef.current.findIndex((m) => m && !m.__separator && (
          String(m.wa_message_id || '') === targetId || String(m.id || '') === targetId || String(m.temp_id || '') === targetId
        ));
        if (idx >= 0) {
          try { listRef.current?.scrollToIndex(idx); } catch {}
        }
        // Add highlight and schedule removal
        setHighlightedIds((prev) => {
          const next = new Set(prev);
          next.add(targetId);
          return next;
        });
        const old = highlightTimeoutsRef.current.get(targetId);
        if (old) { try { clearTimeout(old); } catch {} }
        const t = setTimeout(() => {
          setHighlightedIds((prev) => {
            const next = new Set(prev);
            next.delete(targetId);
            return next;
          });
          highlightTimeoutsRef.current.delete(targetId);
        }, 2000);
        highlightTimeoutsRef.current.set(targetId, t);
      } catch {}
    };
    window.addEventListener('scroll-to-message', handler);
    return () => window.removeEventListener('scroll-to-message', handler);
  }, []);

  const getItemKeyAtIndex = useCallback((index) => {
    const msg = groupedMessages[index];
    if (!msg) return `row_${index}`;
    // Prefer temp_id for outgoing (stable); then id (stable for incoming); then wa_message_id
    return msg.__separator ? msg.key : (msg.temp_id || msg.id || msg.wa_message_id || `${msg.timestamp}_${index}`);
  }, [groupedMessages]);

  // Helpers for current user's pendingImages queue state
  const getUserId = () => activeUser?.user_id || "";
  const getPendingImages = () => pendingQueues[getUserId()] || [];
  const setPendingImages = (fnOrArr) =>
    setPendingQueues(prev => {
      const userId = getUserId();
      const oldQueue = prev[userId] || [];
      let newQueue = typeof fnOrArr === "function" ? fnOrArr(oldQueue) : fnOrArr;
      return { ...prev, [userId]: newQueue };
    });
  const isUploading = !!sendingQueues[getUserId()];

  // Attach listeners to provided WebSocket and request resume on open
  useEffect(() => {
    if (!ws || !activeUser?.user_id) return;
    const uid = activeUser.user_id;

    const handleOpen = () => {
      try {
        const last = lastTimestampRef.current;
        if (last) {
          ws.send(JSON.stringify({ type: 'resume_since', since: last, limit: 500 }));
        }
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {}
    };

    const handleMessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'recent_messages') {
          if (conversationIdRef.current !== uid) return;
          const list = Array.isArray(data.data) ? data.data : [];
          setMessages(prev => mergeAndDedupe(prev, list));
          setOffset(list.length);
          setHasMore(list.length > 0);
          // WS delivered initial data – stop showing skeleton and cancel HTTP fallback
          setIsInitialLoading(false);
          try { initialFetchControllerRef.current?.abort(); } catch {}
          initialFetchControllerRef.current = null;
        } else if (data.type === 'conversation_history') {
          setMessages(prev => mergeAndDedupe(prev, Array.isArray(data.data) ? data.data : []));
          // Any history received implies we can end initial loading
          setIsInitialLoading(false);
        } else if (data.type === 'message_sent') {
          setMessages(prev => {
            const idx = prev.findIndex(m => (m.temp_id && m.temp_id === data.data.temp_id) || (m.id && m.id === data.data.id));
            if (idx !== -1) {
              const updated = [...prev];
              const incoming = data.data || {};
              const prevStatus = prev[idx]?.status;
              const nextStatus = incoming.status;
              let merged = { ...prev[idx], ...incoming };
              if (
                prevStatus &&
                nextStatus &&
                (STATUS_RANK[nextStatus] ?? -1) < (STATUS_RANK[prevStatus] ?? -1)
              ) {
                merged.status = prevStatus;
              }
              updated[idx] = merged;
              return sortByTime(updated);
            }
            return mergeAndDedupe(prev, [data.data]);
          });
        } else if (data.type === 'message_received') {
          setMessages(prev => {
            const incoming = data.data || {};
            if (incoming.from_me) {
              // Try to merge into the earliest optimistic placeholder of same type
              const idx = prev.findIndex(m => m.from_me && !m.wa_message_id && (m.status === 'sending' || m.status === 'sent') && m.type === incoming.type);
              if (idx !== -1) {
                const updated = [...prev];
                let mergedCandidate = { ...updated[idx], ...incoming };
                const prevStatus = updated[idx]?.status;
                const nextStatus = incoming.status;
                if (
                  prevStatus &&
                  nextStatus &&
                  (STATUS_RANK[nextStatus] ?? -1) < (STATUS_RANK[prevStatus] ?? -1)
                ) {
                  mergedCandidate.status = prevStatus;
                }
                updated[idx] = sortByTime([mergedCandidate])[0];
                return sortByTime(updated);
              }
            }
            return mergeAndDedupe(prev, [incoming]);
          });
        } else if (data.type === 'message_status_update') {
          setMessages(prev => sortByTime(prev.map(msg => {
            const matchesTemp = data.data.temp_id && msg.temp_id === data.data.temp_id;
            const matchesWa = data.data.wa_message_id && msg.wa_message_id === data.data.wa_message_id;
            if (matchesTemp || matchesWa) {
              const incoming = data.data || {};
              const incomingStatus = incoming.status;
              const currentStatus = msg.status;
              // Keep existing id to preserve stable React keys
              let next = { ...msg, id: msg.id };
              // If incoming is a downgrade, merge all but status
              if (
                incomingStatus &&
                currentStatus &&
                (STATUS_RANK[incomingStatus] ?? -1) < (STATUS_RANK[currentStatus] ?? -1)
              ) {
                const { status, ...rest } = incoming;
                next = { ...next, ...rest };
              } else {
                next = { ...next, ...incoming };
              }
              return next;
            }
            return msg;
          })));
        } else if (data.type === 'reaction_update') {
          const { target_wa_message_id, emoji, action } = data.data || {};
          if (!target_wa_message_id || !emoji) return;
          setMessages(prev => sortByTime(prev.map(m => {
            const matches = (m.wa_message_id && m.wa_message_id === target_wa_message_id) || (m.id && m.id === target_wa_message_id);
            if (!matches) return m;
            const summary = { ...(m.reactionsSummary || {}) };
            const prevCount = Number(summary[emoji] || 0);
            const nextCount = action === 'remove' ? Math.max(0, prevCount - 1) : prevCount + 1;
            if (nextCount <= 0) {
              delete summary[emoji];
            } else {
              summary[emoji] = nextCount;
            }
            return { ...m, reactionsSummary: summary };
          })));
        } else if (data.type === 'messages_marked_read') {
          const ids = (data.data && Array.isArray(data.data.message_ids)) ? data.data.message_ids : [];
          setMessages(prev => sortByTime(prev.map(msg => {
            if (msg.from_me) return msg;
            if (ids.length === 0) {
              return { ...msg, status: 'read' };
            }
            const matches = (msg.wa_message_id && ids.includes(msg.wa_message_id)) || (msg.id && ids.includes(msg.id));
            return matches ? { ...msg, status: 'read' } : msg;
          })));
        } else if (data.type === 'typing') {
          try {
            const who = data.data?.user_id;
            const isTyping = !!data.data?.is_typing;
            if (who && activeUser?.user_id && who === activeUser.user_id) {
              setIsTypingOther(isTyping);
              if (isTyping) setTimeout(() => setIsTypingOther(false), 4000);
            }
          } catch {}
        }
      } catch (e) {
        console.error('WS parse error', e);
      }
    };

    ws.addEventListener('open', handleOpen);
    ws.addEventListener('message', handleMessage);

    const pingInterval = setInterval(() => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }
      } catch {}
    }, 30000);

    return () => {
      ws.removeEventListener('open', handleOpen);
      ws.removeEventListener('message', handleMessage);
      clearInterval(pingInterval);
    };
  }, [ws, activeUser?.user_id]);

  // On conversation open, proactively mark everything as read (server will broadcast update)
  useEffect(() => {
    const uid = activeUser?.user_id;
    if (!uid) return;
    try {
      // Fire-and-forget HTTP call to mark conversation as read
      api.post(`${API_BASE}/conversations/${uid}/mark-read`)
        .catch(() => {});
    } catch {}
  }, [activeUser?.user_id]);

  // Track latest timestamp whenever messages change
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    const newest = (messages[messages.length - 1]?.server_ts) || messages[messages.length - 1]?.timestamp;
    if (newest) lastTimestampRef.current = newest;
    messagesRef.current = messages;
  }, [messages]);

  // Broadcast latest message preview to ChatList when messages update
  useEffect(() => {
    try {
      const uid = activeUser?.user_id;
      if (!uid || messages.length === 0) return;
      if (justOpenedRef.current) { justOpenedRef.current = false; return; }
      const last = messages[messages.length - 1];
      const preview = typeof last.message === 'string' ? last.message : (last.caption || '');
      const t = last.type || 'text';
      const time = last.server_ts || last.timestamp || new Date().toISOString();
      const fromMe = Boolean(last.from_me);
      const status = last.status || undefined;
      const prev = lastPreviewRef.current || {};
      if (prev.user_id === uid && prev.time === time && prev.message === preview && prev.type === t && prev.from_me === fromMe && prev.status === status) return;
      lastPreviewRef.current = { user_id: uid, time, message: preview, type: t, from_me: fromMe, status };
      window.dispatchEvent(new CustomEvent('conversation-preview', { detail: { user_id: uid, last_message: preview, last_message_type: t, last_message_time: time, last_message_from_me: fromMe, last_message_status: status } }));
    } catch {}
  }, [messages, activeUser?.user_id]);

  // Also listen to admin-wide WebSocket for instant updates to active chat
  useEffect(() => {
    if (!adminWs || !activeUser?.user_id) return;
    const uid = activeUser.user_id;
    const handleAdmin = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message_received' && data.data?.user_id === uid) {
          setMessages(prev => mergeAndDedupe(prev, [data.data]));
        }
      } catch {}
    };
    adminWs.addEventListener('message', handleAdmin);
    return () => {
      try { adminWs.removeEventListener('message', handleAdmin); } catch {}
    };
  }, [adminWs, activeUser?.user_id]);

  // Update search hits when query or messages change
  useEffect(() => {
    const q = String(searchQuery || '').trim().toLowerCase();
    if (!q) { setSearchHitIndexes([]); setActiveHitIdx(-1); return; }
    const hits = [];
    groupedMessages.forEach((m, idx) => {
      if (m.__separator) return;
      const txt = (typeof m.message === 'string' ? m.message : m.caption || '').toLowerCase();
      if (txt.includes(q)) hits.push(idx);
    });
    setSearchHitIndexes(hits);
    setActiveHitIdx(hits.length ? 0 : -1);
  }, [searchQuery, messages]);

  // Cleanup queues and revoke URLs for all except active user on conversation change
  useEffect(() => {
    Object.entries(pendingQueues).forEach(([userId, queue]) => {
      if (userId !== activeUser?.user_id && Array.isArray(queue)) {
        queue.forEach(img => img && img.url && URL.revokeObjectURL(img.url));
      }
    });
    setPendingQueues(prev => {
      const newObj = {};
      if (activeUser && prev[activeUser.user_id]) {
        newObj[activeUser.user_id] = prev[activeUser.user_id].filter(img => img && img.url);
      }
      return newObj;
    });
  }, [activeUser]);

  // (Consolidated into the conversation-change effect above)

  // Load catalog products
  useEffect(() => {
    async function fetchAllProducts() {
      try {
        // Use cached endpoint for instant load
        const res = await api.get(`${API_BASE}/catalog-all-products`);
        const lookup = {};
        (res.data || []).forEach(prod => {
          lookup[String(prod.retailer_id)] = {
            name: prod.name,
            image: prod.images?.[0]?.url,
            price: prod.price,
          };
        });
        setCatalogProducts(lookup);
      } catch (error) {
        console.error('Failed to fetch catalog products:', error);
      }
    }
    fetchAllProducts();
  }, []);

  // Fallback: fetch messages via HTTP if WebSocket fails (stabilised reference)
  const fetchMessages = useCallback(async ({ offset: off = 0, append = false } = {}, signal, uidParam) => {
    const uid = uidParam || activeUser?.user_id;
    if (!uid) return [];
    try {
      const current = messagesRef.current || [];
      // Prefer cursor-based fetch
      const oldest = (append && current.length > 0) ? current[0]?.timestamp : null;
      const newest = (!append && current.length > 0) ? current[current.length - 1]?.timestamp : null;
      const params = new URLSearchParams();
      const initialLoad = !append && current.length === 0;
      if (!append && newest) params.set('since', newest);
      // On first load for a conversation, force-fetch recent history via 'since' to bypass any caches
      if (initialLoad && !newest) {
        const sinceMs = Date.now() - (48 * 60 * 60 * 1000); // last 48 hours
        params.set('since', new Date(sinceMs).toISOString());
      }
      if (append && oldest) params.set('before', oldest);
      // Always pass limit; if neither since/before present, backend will use legacy offset
      const limitForRequest = initialLoad ? Math.max(200, MESSAGE_LIMIT) : MESSAGE_LIMIT;
      params.set('limit', String(limitForRequest));
      // If we didn't set since/before, include offset explicitly
      if (!params.has('since') && !params.has('before')) params.set('offset', String(off));
      const url = `${API_BASE}/messages/${uid}?${params.toString()}`;
      let res = await api.get(url, { signal });
      let data = res.data;
      // Fallback: if initial since-based request returned nothing, try legacy offset=0 to load older history
      const attemptedSinceOrBefore = params.has('since') || params.has('before');
      if ((!Array.isArray(data) || data.length === 0) && !append && attemptedSinceOrBefore) {
        try {
          const legacy = new URLSearchParams();
          legacy.set('offset', String(0));
          legacy.set('limit', String(Math.max(200, MESSAGE_LIMIT)));
          const legacyUrl = `${API_BASE}/messages/${uid}?${legacy.toString()}`;
          res = await api.get(legacyUrl, { signal });
          data = res.data;
        } catch {}
      }
      if (!Array.isArray(data) || data.length === 0) {
        // No data from server, fall back to cached messages (do not kill hasMore prematurely on initial load)
        const cached = await loadMessages(uid);
        if (cached.length > 0) {
          setMessages(prev => (conversationIdRef.current !== uid)
            ? prev
            : (append ? mergeAndDedupe(prev, cached) : sortByTime(cached))
          );
          if (append) setHasMore(false);
        } else {
          // Keep hasMore true on first load so the user can pull older history
          if (!append) setHasMore(true);
        }
        setIsInitialLoading(false);
        return cached;
      }
      setMessages(prev => (conversationIdRef.current !== uid)
        ? prev
        : (append ? mergeAndDedupe(prev, data) : sortByTime(data))
      );
      try { saveMessages(uid, (append ? mergeAndDedupe(messagesRef.current, data) : data)); } catch {}
      const firstUnreadIndex = data.findIndex(msg => !msg.from_me && (msg.status !== 'read'));
      setUnreadSeparatorIndex(firstUnreadIndex !== -1 ? firstUnreadIndex : null);
      if (append) {
        setOffset(off + data.length);
        setHasMore(data.length >= MESSAGE_LIMIT);
      } else {
        setOffset(data.length);
        setHasMore(data.length > 0);
      }
      setIsInitialLoading(false);
      return data;
    } catch (err) {
      if (api.isCancel(err) || err.name === 'CanceledError') return [];
      console.error("Failed to fetch messages", err);
      // Error while fetching, fall back to cached messages
      const cached = await loadMessages(uid);
      if (cached.length > 0) {
        setMessages(prev => (conversationIdRef.current !== uid)
          ? prev
          : (append ? mergeAndDedupe(prev, cached) : sortByTime(cached))
        );
        setHasMore(false);
      }
      setIsInitialLoading(false);
      return cached;
    }
  }, [activeUser?.user_id, MESSAGE_LIMIT, mergeAndDedupe]);

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    const before = groupedLenRef.current || 0;
    try {
      await fetchMessages({ offset, append: true });
    } finally {
      requestAnimationFrame(() => {
        const after = groupedLenRef.current || 0;
        const delta = Math.max(0, after - before);
        if (delta > 0) setFirstItemIndex((v) => v + delta);
        setLoadingOlder(false);
      });
    }
  }, [offset, loadingOlder, hasMore, fetchMessages]);
  
  const sendMessageViaWebSocket = ({ message, type, caption, price }) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const temp_id = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const messageObj = {
      id: temp_id,
      temp_id,
      user_id: activeUser.user_id,
      message,
      type,
      from_me: true,
      status: "sending",
      timestamp: new Date().toISOString(),
      client_ts: Date.now(),
      // Include caption and price if provided
      ...(caption && { caption }),
      ...(price && { price })
    };
    if (replyTarget && (replyTarget.wa_message_id || replyTarget.id)) {
      messageObj.reply_to = replyTarget.wa_message_id || replyTarget.id;
    }

    // Optimistically add to UI
    setMessages(prev => sortByTime([...prev, messageObj]));

    // Immediately reflect in chat list
    try {
      const previewText = typeof message === 'string' ? message : (caption || type || '');
      window.dispatchEvent(new CustomEvent('conversation-preview', { detail: {
        user_id: activeUser.user_id,
        last_message: previewText,
        last_message_type: type || 'text',
        last_message_time: messageObj.timestamp,
        last_message_from_me: true,
        last_message_status: messageObj.status,
      }}));
    } catch {}

    // Send through WebSocket
    ws.send(
      JSON.stringify({
        type: "send_message",
        data: messageObj,
      })
    );
    setReplyTarget(null);
  };

  
  const sendOrderMessage = (orderData) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendMessageViaWebSocket({
        message: typeof orderData === 'string' ? orderData : JSON.stringify(orderData),
        type: 'order' // Use 'order' type instead of 'text'
      });
    }
  };
  // (Text sending handled by Composer via onSendText)

  // Audio recording handlers
  const handleAudioFile = async (file) => {
    if (!activeUser || !file) return alert("No active user or audio file!");
    
    // Optimistic audio bubble
    const temp_id = generateTempId();
    const optimistic = {
      id: temp_id,
      temp_id,
      user_id: activeUser.user_id,
      type: 'audio',
      from_me: true,
      status: 'sending',
      timestamp: new Date().toISOString(),
      client_ts: Date.now(),
      url: URL.createObjectURL(file),
    };
    setMessages(prev => sortByTime([...prev, optimistic]));

    const formData = new FormData();
    formData.append('files', file);
    formData.append('user_id', activeUser.user_id);
    formData.append('media_type', 'audio');
    formData.append('temp_id', temp_id);
    const tryOnce = async () => {
      const res = await api.post(`${API_BASE}/send-media-async`, formData);
      const first = Array.isArray(res?.data?.messages) ? res.data.messages[0] : null;
      const serverUrl = (first && (first.media_url || first.result?.url)) || res?.data?.url || res?.data?.file_path;
      const waId = first?.result?.wa_message_id || res?.data?.wa_message_id;
      setMessages(prev => prev.map(m => m.temp_id === temp_id ? (() => {
        const isDowngrade = m.status && (STATUS_RANK[m.status] ?? -1) > (STATUS_RANK['sent'] ?? -1);
        const base = { ...m, ...(waId ? { id: waId } : {}), ...(serverUrl ? { url: serverUrl } : {}) };
        return isDowngrade ? base : { ...base, status: 'sent' };
      })() : m));
      try { if (optimistic.url && optimistic.url.startsWith('blob:')) URL.revokeObjectURL(optimistic.url); } catch {}
    };
    try {
      try {
        await tryOnce();
      } catch (e1) {
        await new Promise(r => setTimeout(r, 800));
        await tryOnce();
      }
    } catch (err) {
      console.error("Audio upload error:", err);
      setMessages(prev => prev.map(m => m.temp_id === temp_id ? { ...m, status: 'failed' } : m));
      alert("Audio upload failed");
    }
  };

  const {
    isRecording,
    recordingTime,
    startRecording,
    stopRecording,
    cancelRecording,
    setCanvasRef
  } = useAudioRecorder(activeUser?.user_id, handleAudioFile);

  useEffect(() => {
    if (isRecording && canvasRef.current) setCanvasRef(canvasRef.current);
  }, [isRecording]);

  const NEAR_BOTTOM_PX = 200;

  const runWithSmoothScroll = (fn) => {
    try {
      setAllowSmoothScroll(true);
      requestAnimationFrame(() => {
        try { fn(); } catch {}
        setTimeout(() => { try { setAllowSmoothScroll(false); } catch {} }, 160);
      });
    } catch {}
  };

  const scrollToBottom = () => {
    runWithSmoothScroll(() => {
      try { listRef.current?.scrollToIndex(groupedMessages.length - 1); } catch {}
    });
  };

  const scrollToHit = (hitListIndex) => {
    if (hitListIndex < 0 || hitListIndex >= searchHitIndexes.length) return;
    const childIndex = searchHitIndexes[hitListIndex];
    runWithSmoothScroll(() => {
      try { listRef.current?.scrollToIndex(childIndex); } catch {}
    });
  };

  // Stable callbacks to avoid re-rendering bubbles unnecessarily
  const handleReply = useCallback((m) => setReplyTarget(m), []);
  const handleReact = useCallback((m, emoji) => {
    try {
      const targetId = m.wa_message_id || m.id;
      if (!targetId || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'react', target_wa_message_id: targetId, emoji }));
    } catch {}
  }, [ws]);
  const handleForward = useCallback((forwardMsg) => {
    const originalType = forwardMsg.type || 'text';
    const isMedia = originalType === 'image' || originalType === 'audio' || originalType === 'video';
    let messageValue = '';
    let urlValue = '';
    if (isMedia) {
      urlValue = (forwardMsg.url && typeof forwardMsg.url === 'string') ? forwardMsg.url : '';
      if (urlValue) {
        messageValue = urlValue;
      } else if (typeof forwardMsg.message === 'string') {
        const raw = forwardMsg.message;
        if (/^https?:\/\//i.test(raw)) {
          messageValue = raw;
        } else if (/^\/?media\//i.test(raw) || /^\/?app\/media\//i.test(raw) || raw.startsWith('/media/')) {
          const base = (process.env.REACT_APP_API_BASE || '').replace(/\/$/, '');
          messageValue = `${base}${raw.startsWith('/') ? '' : '/'}${raw.replace(/^\/app\//, '')}`;
        } else {
          messageValue = raw;
        }
      } else {
        messageValue = forwardMsg.caption || '[media]';
      }
    } else {
      messageValue = typeof forwardMsg.message === 'string' ? forwardMsg.message : (forwardMsg.caption || '[message]');
    }
    const payload = { message: messageValue, type: isMedia ? originalType : (originalType || 'text') };
    if (isMedia && urlValue) payload.url = urlValue;
    forwardPayloadRef.current = payload;
    setForwardOpen(true);
  }, []);

  useEffect(() => {
    // Show jump prompt when new messages arrive and we're not at bottom
    setShowJumpToLatest(!isNearBottomRef.current);
  }, [messages]);

  useEffect(() => {
    const el = messagesEndRef.current;
    if (!el) return;
    let rafId = null;
    const update = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const h = el.clientHeight || 0;
        const now = Date.now();
        const diff = Math.abs(h - layoutLastHeightRef.current);
        // Only update when height actually changes meaningfully and not more often than every 120ms
        if (diff > 4 && (now - layoutLastUpdateTsRef.current > 120)) {
          layoutLastHeightRef.current = h;
          layoutLastUpdateTsRef.current = now;
          setListHeight(h);
        }
      });
    };
    // Initial measurement
    layoutLastHeightRef.current = el.clientHeight || 0;
    setListHeight(layoutLastHeightRef.current);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      try { if (rafId) cancelAnimationFrame(rafId); } catch {}
      try { ro.disconnect(); } catch {}
    };
  }, []);

  // After initial load per conversation, scroll to the latest message once
  useEffect(() => {
    if (!isInitialLoading && groupedMessages.length > 0 && !hasInitialisedScrollRef.current) {
      hasInitialisedScrollRef.current = true;
      requestAnimationFrame(() => {
        try { listRef.current?.scrollToIndex(groupedMessages.length - 1); } catch {}
      });
    }
  }, [isInitialLoading, groupedMessages.length]);

  // Virtuoso auto-measures; no manual resize batching or top sentinels needed

  // Persist messages to IndexedDB whenever they change
  useEffect(() => {
    if (!activeUser?.user_id) return;
    saveMessages(activeUser.user_id, messages);
  }, [messages, activeUser?.user_id]);

  // Mark incoming messages as read when they appear
  useEffect(() => {
    if (!activeUser?.user_id) return;
    try {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    } catch {}
    const unreadIds = messages
      .filter(m => !m.from_me && m.status !== 'read' && m.wa_message_id)
      .map(m => m.wa_message_id);
    if (unreadIds.length === 0) return;

    setMessages(prev =>
      prev.map(m =>
        !m.from_me && unreadIds.includes(m.wa_message_id)
          ? { ...m, status: 'read' }
          : m
      )
    );

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: 'mark_as_read', message_ids: unreadIds })
      );
    } else {
      api.post(
        `${API_BASE}/conversations/${activeUser.user_id}/mark-read`,
        unreadIds
      ).catch(() => {});
    }
  }, [messages, activeUser?.user_id, ws]);

  // (Composer handles typing events and textarea behaviour)

  // Listen to forwarded messages and open a simple picker UI
  useEffect(() => {
    const handler = (ev) => {
      const payload = ev.detail || {};
      const text = payload.message;
      const type = payload.type || 'text';
      const url = payload.url;
      const out = { message: text, type };
      if (url) out.url = url;
      forwardPayloadRef.current = out;
      setForwardOpen(true);
    };
    window.addEventListener('forward-message', handler);
    return () => window.removeEventListener('forward-message', handler);
  }, [ws]);

  // File handling functions remain the same
  const handleFiles = (files, options = {}) => {
    const newItems = Array.from(files).map(file => ({
      file,
      url: URL.createObjectURL(file),
      progress: 0,
      status: "idle",
      error: null,
      // Allow passing caption/price metadata
      caption: options.caption,
      price: options.price
    }));
    setPendingImages(prev => [...prev, ...newItems]);
  };


  const handlePaste = e => {
    const items = e.clipboardData?.items || [];
    const files = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length) handleFiles(files);
  };

  const handleFileInputChange = e => {
    handleFiles(e.target.files);
    e.target.value = "";
  };

  const handleDrop = e => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const removePendingImage = index => {
    setPendingImages(images =>
      images.filter((img, i) => {
        if (i === index && img && img.url) URL.revokeObjectURL(img.url);
        return i !== index;
      })
    );
  };

  const clearPendingImages = () => {
    getPendingImages().forEach(img => img && img.url && URL.revokeObjectURL(img.url));
    setPendingImages([]);
  };

  // Upload worker with WebSocket awareness
  const uploadWorker = (idx) =>
    new Promise(async (resolve) => {
      setPendingImages(oldImgs => {
        let copy = [...oldImgs];
        if (!copy[idx]) return copy;
        copy[idx] = { ...copy[idx], status: "queued", progress: 0, error: null };
        return copy;
      });
      
      let imgObj = (getPendingImages() || [])[idx];
      if (!imgObj) return resolve({ success: false, idx });
      // Create an optimistic message for this image immediately
      const temp_id = generateTempId();
      imgObj.temp_id = temp_id;
      try {
        const optimisticMsg = {
          id: temp_id,
          temp_id,
          user_id: getUserId(),
          type: 'image',
          from_me: true,
          status: 'sending',
          timestamp: new Date().toISOString(),
          client_ts: Date.now(),
          // Use local blob URL in url field so renderer relies on single source
          url: imgObj.url,
        };
        setMessages(prev => sortByTime([...prev, optimisticMsg]));
      } catch {}
      
      const formData = new FormData();
      formData.append('files', imgObj.file);
      formData.append("user_id", getUserId());
      formData.append("media_type", "image");
      // Pass through temp_id so backend can update the same optimistic bubble
      formData.append("temp_id", temp_id);
      // Optional metadata
      if (imgObj.caption) formData.append("caption", imgObj.caption);
      if (imgObj.price) formData.append("price", imgObj.price);
      
      try {
        const response = await api.post(`${API_BASE}/send-media-async`, formData, {
          onUploadProgress: (e) => {
            setPendingImages(images => {
              let copy = [...images];
              if (!copy[idx]) return copy;
              copy[idx] = { ...copy[idx], progress: Math.round((e.loaded / e.total) * 100), status: "uploading" };
              return copy;
            });
          }
        });
        
        // Extract media URL from response (GCS url)
        setPendingImages(images => {
          let copy = [...images];
          if (!copy[idx]) return copy;
          const first = Array.isArray(response?.data?.messages) ? response.data.messages[0] : null;
          const finalUrl = (first && (first.media_url || first.result?.url)) || response.data?.url || response.data?.file_path;
          copy[idx] = { 
            ...copy[idx], 
            progress: 100, 
            status: "done",
            // Replace with server URL if available
            url: finalUrl || copy[idx].url,
          };
          return copy;
        });
        // Update the optimistic message with final URL (if available) and mark as sent
        try {
          const first = Array.isArray(response?.data?.messages) ? response.data.messages[0] : null;
          const finalUrl = (first && (first.media_url || first.result?.url)) || response.data?.url || response.data?.file_path || '';
          const oldLocalUrl = imgObj.url;
          setMessages(prev => prev.map(m => m.temp_id === temp_id ? (() => {
            const isDowngrade = m.status && (STATUS_RANK[m.status] ?? -1) > (STATUS_RANK['sent'] ?? -1);
            const base = { ...m, ...(finalUrl ? { url: finalUrl } : {}) };
            return isDowngrade ? base : { ...base, status: 'sent' };
          })() : m));
          // Only revoke the blob URL once we have a durable URL; otherwise keep it alive until WS update arrives
          if (finalUrl) {
            try { if (oldLocalUrl && oldLocalUrl.startsWith('blob:')) URL.revokeObjectURL(oldLocalUrl); } catch {}
          }
        } catch {}
        
        resolve({ success: true, idx });
      } catch (err) {
        setPendingImages(images => {
          let copy = [...images];
          if (!copy[idx]) return copy;
          copy[idx] = { ...copy[idx], status: "error", error: (err?.message || "Upload failed") };
          return copy;
        });
        // Mark optimistic message as failed
        try {
          setMessages(prev => prev.map(m => m.temp_id === temp_id ? { ...m, status: 'failed' } : m));
        } catch {}
        resolve({ success: false, idx });
      }
    });

  const sendPendingImages = async () => {
    const userId = getUserId();
    const images = getPendingImages();
    if (images.length === 0 || !userId) return;
    setSendingQueues(queues => ({ ...queues, [userId]: true }));

    let queueIdx = images
      .map((img, i) => (img && (img.status === "idle" || img.status === "error") ? i : null))
      .filter(idx => idx !== null);

    if (queueIdx.length === 0) {
      setSendingQueues(queues => ({ ...queues, [userId]: false }));
      return;
    }

    let inProgress = 0;
    const runNext = async () => {
      if (queueIdx.length === 0) return;
      const idx = queueIdx.shift();
      inProgress++;
      await uploadWorker(idx);
      inProgress--;
      if (queueIdx.length > 0) runNext();
    };
    
    const starters = [];
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS && i < queueIdx.length; i++) {
      starters.push(runNext());
    }
    await Promise.all(starters);

    setTimeout(() => {
      setPendingImages(imgs => {
        (imgs || []).forEach(img =>
          (img.status === "done" || img.status === "error") && img.url && URL.revokeObjectURL(img.url)
        );
        const failed = (imgs || []).filter(img => img && img.status === "error");
        // WebSocket will handle real-time updates, no need to fetchMessages
        return failed;
      });
      setSendingQueues(queues => ({ ...queues, [userId]: false }));
    }, 600);
  };

  const pendingImages = getPendingImages();

  return (
    <div
      className="relative flex flex-col h-full"
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
      onPaste={handlePaste}
    >
      <div className="p-2 bg-gray-800 border-b border-gray-700 flex items-center justify-between gap-2">
        <strong className="px-2">{activeUser?.name || activeUser?.user_id}</strong>
        {/* Search box */}
        <div className="flex items-center gap-1 flex-1 max-w-[420px]">
          <input
            className="flex-1 px-2 py-1 bg-gray-700 text-white rounded"
            placeholder="Search in conversation"
            value={searchQuery}
            onChange={(e)=>setSearchQuery(e.target.value)}
          />
          <span className="text-xs text-gray-300 min-w-[70px] text-center">
            {searchHitIndexes.length ? `${activeHitIdx+1}/${searchHitIndexes.length}` : ''}
          </span>
          <button
            className="px-2 py-1 bg-gray-700 text-white rounded disabled:opacity-50"
            disabled={searchHitIndexes.length===0}
            onClick={()=>{ const next = (activeHitIdx - 1 + searchHitIndexes.length) % searchHitIndexes.length; setActiveHitIdx(next); scrollToHit(next); }}
            title="Previous"
          >↑</button>
          <button
            className="px-2 py-1 bg-gray-700 text-white rounded disabled:opacity-50"
            disabled={searchHitIndexes.length===0}
            onClick={()=>{ const next = (activeHitIdx + 1) % searchHitIndexes.length; setActiveHitIdx(next); scrollToHit(next); }}
            title="Next"
          >↓</button>
        </div>
        <div className="flex items-center space-x-2">
          {/* Notes button */}
          {activeUser?.user_id && (
            <button
              className="relative px-2 py-1 bg-blue-700 text-white rounded"
              onClick={() => {
                try {
                  const uid = activeUser?.user_id;
                  if (!uid) return;
                  window.dispatchEvent(new CustomEvent('open-notes', { detail: { user_id: uid } }));
                } catch {}
              }}
              title="Conversation notes"
            >
              Notes
              {notesCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] leading-[18px] text-center">
                  {notesCount}
                </span>
              )}
            </button>
          )}
          {(() => {
            const isDone = (activeUser?.tags || []).some(t => String(t || '').toLowerCase() === 'done');
            const userId = activeUser?.user_id;
            const toggleDone = async () => {
              if (!userId) return;
              try {
                const current = Array.isArray(activeUser?.tags) ? activeUser.tags : [];
                const newTags = isDone
                  ? current.filter(t => String(t || '').toLowerCase() !== 'done')
                  : [...current, 'done'];
                await api.post(`/conversations/${userId}/tags`, { tags: newTags });
                if (typeof onUpdateConversationTags === 'function') {
                  onUpdateConversationTags(userId, newTags);
                }
              } catch (e) {}
            };
            return (
              <button
                className={`px-2 py-1 rounded ${isDone ? 'bg-yellow-600 text-black' : 'bg-green-600 text-white'}`}
                onClick={toggleDone}
                title={isDone ? 'Clear Done (move back to Inbox)' : 'Mark as Done (Archive)'}
              >
                {isDone ? '↩︎ Clear Done' : '✓ Done'}
              </button>
            );
          })()}
          <div className={`w-3 h-3 rounded-full ${
            ws && ws.readyState === WebSocket.OPEN ? 'bg-green-500' : 'bg-red-500'
          }`} title={`WebSocket ${ws && ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'}`}></div>
          <span className="text-xs text-gray-400">
            {ws && ws.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>
      
      {/* WhatsApp-like PREVIEW/QUEUE for this conversation */}
      {Array.isArray(pendingImages) && pendingImages.filter(img => img && img.url).length > 0 && (
        <div className="flex gap-2 px-4 pt-2 items-center flex-wrap">
          {pendingImages.filter(img => img && img.url).map((img, i) => (
            <div key={i} className="relative group flex flex-col items-center">
              <img
                src={img.url}
                alt="Preview"
                className="rounded-xl max-w-[110px] opacity-70 border border-dashed border-blue-400"
              />
              {img.status === "idle" && <div className="text-xs text-gray-400">Queued</div>}
              {img.status === "queued" && (
                <div className="text-xs text-gray-400">Waiting...</div>
              )}
              {img.status === "uploading" && (
                <div className="h-2 w-full bg-gray-300 mt-1 rounded overflow-hidden">
                  <div
                    className="h-2 bg-blue-500 transition-all"
                    style={{ width: `${img.progress}%` }}
                  ></div>
                </div>
              )}
              {img.status === "done" && <div className="text-xs text-green-600">Uploaded</div>}
              {img.status === "error" && (
                <div className="text-xs text-red-400">
                  Error
                  <button
                    className="ml-1 text-xs text-blue-400 underline"
                    onClick={() => {
                      setPendingImages(images => {
                        let arr = Array.isArray(images) ? [...images] : [];
                        arr[i] = { ...arr[i], status: "idle", progress: 0, error: null };
                        return arr;
                      });
                    }}
                  >Retry</button>
                </div>
              )}
              <button
                type="button"
                className="absolute top-0 right-0 bg-red-500 text-white rounded-full px-1 py-0.5 opacity-80 text-xs"
                onClick={() => removePendingImage(i)}
                tabIndex={-1}
                aria-label="Remove image"
                disabled={img.status === 'uploading' || img.status === 'queued'}
              >x</button>
            </div>
          ))}
          <button
            className="ml-2 px-4 py-2 bg-blue-600 text-white rounded"
            onClick={sendPendingImages}
            disabled={isUploading || pendingImages.length < 1 || pendingImages.every(img => img.status!=="idle" && img.status!=="error")}
          >
            {isUploading ? "Uploading..." : `Send ${pendingImages.length} Image${pendingImages.length > 1 ? 's' : ''}`}
          </button>
          <button
            className="ml-1 px-2 py-1 bg-gray-600 text-white rounded"
            onClick={clearPendingImages}
            disabled={isUploading}
            title="Clear selection"
          >Clear</button>
        </div>
      )}
      
      <div className="flex-1 overflow-hidden p-3 pb-8 bg-gray-900 relative" ref={messagesEndRef}>
        {loadingOlder && (
          <div className="absolute top-2 left-0 right-0 flex justify-center" aria-live="polite">
            <span className="px-2 py-0.5 text-xs rounded bg-gray-700 text-gray-200 border border-gray-600">Loading…</span>
          </div>
        )}
        {isInitialLoading ? (
          <div className="absolute inset-0 p-4 space-y-4 animate-pulse">
            <div className="h-4 bg-gray-800 rounded w-1/3" />
            <div className="h-20 bg-gray-800 rounded w-2/3" />
            <div className="h-4 bg-gray-800 rounded w-1/2 ml-auto" />
            <div className="h-16 bg-gray-800 rounded w-5/12 ml-auto" />
            <div className="h-4 bg-gray-800 rounded w-1/3" />
          </div>
        ) : (
          listHeight > 0 && (
          <Virtuoso
            key={activeUser?.user_id || 'chat'}
            ref={listRef}
            style={{ height: listHeight, width: '100%' }}
            data={groupedMessages}
            initialTopMostItemIndex={Math.max(0, groupedMessages.length - 1)}
            firstItemIndex={firstItemIndex}
            increaseViewportBy={{ top: 400, bottom: 600 }}
            className={`${allowSmoothScroll ? 'scroll-smooth' : ''}`}
            followOutput={atBottom ? 'smooth' : false}
            atBottomStateChange={(isBottom) => {
              atBottomRef.current = isBottom;
              setAtBottom(isBottom);
              isNearBottomRef.current = isBottom;
              setIsNearBottom(isBottom);
              if (isBottom && showJumpToLatest) setShowJumpToLatest(false);
            }}
            startReached={() => { if (hasMore && !loadingOlder) loadOlderMessages(); }}
            rangeChanged={({ startIndex }) => { lastVisibleStartIndexRef.current = startIndex; }}
            computeItemKey={(index, row) => {
              if (!row) return `row_${index}`;
              return row.__separator ? row.key : (row.temp_id || row.id || row.wa_message_id || `${row.timestamp}_${index}`);
            }}
            itemContent={(index, msg) => {
              const isTextMsg = !!(msg && !msg.__separator && (msg.type === 'text' || msg.type === 'catalog_item' || msg.type === 'catalog_set'));
              if (msg && msg.__separator) {
                return (
                  <div className="flex justify-center my-2">
                    <span className="px-3 py-1 text-xs rounded-full bg-gray-700 text-gray-200 border border-gray-600">{msg.label}</span>
                  </div>
                );
              }
              return (
                <div className="space-y-1.5">
                  {index === unreadSeparatorIndex && (
                    <div className="text-center text-xs text-gray-400 my-2">Unread Messages</div>
                  )}
                  <MemoMessageBubble
                    msg={msg}
                    self={(function() {
                      if (msg.from_me) return true;
                      try {
                        const isDm = typeof activeUser?.user_id === 'string' && activeUser.user_id.startsWith('dm:');
                        if (!isDm) return false;
                        const agentLower = String(currentAgent || '').toLowerCase();
                        const sender = String(msg.agent || msg.sender || msg.from || msg.name || '').toLowerCase();
                        return agentLower && sender && agentLower === sender;
                      } catch { return false; }
                    })()}
                    catalogProducts={catalogProducts}
                    highlightQuery={isTextMsg ? searchQuery : ''}
                    quotedMessage={(function(){
                      try {
                        const qid = msg.reply_to;
                        if (!qid) return null;
                        return messages.find(m => (m.wa_message_id && m.wa_message_id === qid) || (m.id && m.id === qid)) || null;
                      } catch { return null; }
                    })()}
                    onReply={handleReply}
                    onReact={handleReact}
                    onForward={handleForward}
                    rowKey={getItemKeyAtIndex(index)}
                    highlighted={(() => { try { const id = msg.wa_message_id || msg.id || msg.temp_id; return id ? highlightedIds.has(String(id)) : false; } catch { return false; } })()}
                  />
                </div>
              );
            }}
          />
          ))}
        {unreadSeparatorIndex != null && (
          <button
            className="absolute right-4 top-4 px-3 py-1 rounded-full bg-gray-800 text-white border border-gray-600 shadow hover:bg-gray-700"
            onClick={() => { runWithSmoothScroll(() => { try { listRef.current?.scrollToIndex(unreadSeparatorIndex); } catch {} }); }}
            title="Jump to first unread"
          >
            Unread ↑
          </button>
        )}
      </div>
      
      {activeUser && (
        <div className="p-2 border-t border-gray-700 bg-gray-800 flex flex-col space-y-2 relative">
          {showJumpToLatest && !isNearBottom && (
            <div className="absolute -top-8 left-0 right-0 flex justify-center" aria-live="polite">
              <button
                className="px-3 py-1 rounded-full bg-blue-600 text-white shadow hover:bg-blue-500"
                onClick={() => { scrollToBottom(); setShowJumpToLatest(false); setIsNearBottom(true); isNearBottomRef.current = true; }}
                title="Jump to latest messages"
              >
                New messages ↓
              </button>
            </div>
          )}
          {isTypingOther && (
            <div className="-mt-1 text-xs text-gray-300" aria-live="polite">Typing…</div>
          )}
          {replyTarget && (
            <div className="flex items-center justify-between bg-gray-700 text-white px-2 py-1 rounded">
              <div className="text-xs truncate max-w-[80%]">
                <span className="opacity-70 mr-1">Replying to:</span>
                <span className="font-semibold">
                  {(() => {
                    const t = replyTarget;
                    const label = t.type;
                    if (label === 'text') return String(t.message).slice(0, 80);
                    if (label === 'image') return 'Image';
                    if (label === 'audio') return 'Audio';
                    if (label === 'video') return 'Video';
                    return label || 'Message';
                  })()}
                </span>
              </div>
              <button
                className="ml-2 px-2 py-0.5 bg-gray-600 rounded text-xs"
                onClick={() => setReplyTarget(null)}
              >Cancel</button>
            </div>
          )}
          <Composer
            isRecording={isRecording}
            recordingTime={recordingTime}
            startRecording={startRecording}
            stopRecording={stopRecording}
            cancelRecording={cancelRecording}
            canvasRef={canvasRef}
            onSendText={(val) => {
              if (!val || !val.trim()) return;
              const prev = val;
              if (ws && ws.readyState === WebSocket.OPEN) {
                sendMessageViaWebSocket({ message: prev, type: 'text' });
              } else {
                (async () => {
                  const temp_id = generateTempId();
                  const optimistic = {
                    id: temp_id,
                    temp_id,
                    user_id: activeUser.user_id,
                    message: prev,
                    type: 'text',
                    from_me: true,
                    status: 'sending',
                    timestamp: new Date().toISOString(),
                    client_ts: Date.now(),
                  };
                  if (replyTarget && (replyTarget.wa_message_id || replyTarget.id)) {
                    optimistic.reply_to = replyTarget.wa_message_id || replyTarget.id;
                  }
                  setMessages(p => sortByTime([...p, optimistic]));
                  try {
                    const res = await api.post(`${API_BASE}/send-message`, {
                      user_id: activeUser.user_id,
                      type: 'text',
                      message: prev,
                      from_me: true,
                      agent: currentAgent || undefined,
                      ...(optimistic.reply_to ? { reply_to: optimistic.reply_to } : {})
                    });
                    setMessages(p => p.map(m => m.temp_id === temp_id ? (() => {
                      const isDowngrade = m.status && (STATUS_RANK[m.status] ?? -1) > (STATUS_RANK['sent'] ?? -1);
                      const base = { ...m, ...(res?.data?.wa_message_id ? { id: res.data.wa_message_id } : {}) };
                      return isDowngrade ? base : { ...base, status: 'sent' };
                    })() : m));
                  } catch (err) {
                    setMessages(p => p.map(m => m.temp_id === temp_id ? { ...m, status: 'failed' } : m));
                  }
                })();
              }
            }}
            onTypingStart={() => {
              try {
                const now = Date.now();
                if (ws && ws.readyState === WebSocket.OPEN && now - lastTypingSentRef.current > 1200) {
                  ws.send(JSON.stringify({ type: 'typing', is_typing: true }));
                  lastTypingSentRef.current = now;
                }
              } catch {}
            }}
            onTypingStop={() => {
              try { sendTypingFalseDebounced.current(); } catch {}
            }}
            onClickAttach={() => { try { fileInputRef.current?.click(); } catch {} }}
            onFileInputChange={handleFileInputChange}
            fileInputRef={fileInputRef}
            isUploading={isUploading}
            pendingImages={pendingImages}
            removePendingImage={removePendingImage}
            sendPendingImages={sendPendingImages}
            clearPendingImages={clearPendingImages}
            onOpenTemplates={() => setTemplatesOpen(true)}
          />
        </div>
      )}
      
      <Suspense fallback={<div className="p-2 text-sm text-gray-400">Loading catalog…</div>}>
        <CatalogPanel
          activeUser={activeUser}
          websocket={ws}
          onMessageSent={(optimistic) => {
            const enriched = { ...optimistic, client_ts: optimistic.client_ts || Date.now() };
            setMessages(prev => sortByTime([...prev, enriched]));
          }}
        />
      </Suspense>
      <ForwardDialog
        open={forwardOpen}
        onClose={()=> setForwardOpen(false)}
        onSelect={(target) => {
          const payload = forwardPayloadRef.current || {};
          if (!target || !payload.message) { setForwardOpen(false); return; }
          try {
            if (ws && ws.readyState === WebSocket.OPEN) {
              const temp_id = `temp_${Date.now()}_${Math.random().toString(36).substr(2,5)}`;
              const messageObj = {
                id: temp_id,
                temp_id,
                user_id: target,
                message: payload.message,
                type: payload.type || 'text',
                from_me: true,
                status: 'sending',
                timestamp: new Date().toISOString(),
              };
              if (payload.url && typeof payload.url === 'string') {
                messageObj.url = payload.url;
              }
              ws.send(JSON.stringify({ type: 'send_message', data: messageObj }));
              // Reflect immediately in chat list for the target conversation
              try {
                const previewText = typeof payload.message === 'string' ? payload.message : (payload.caption || messageObj.type || '');
                window.dispatchEvent(new CustomEvent('conversation-preview', { detail: {
                  user_id: target,
                  last_message: previewText,
                  last_message_type: messageObj.type,
                  last_message_time: messageObj.timestamp,
                  last_message_from_me: true,
                  last_message_status: 'sending',
                }}));
              } catch {}
            } else {
              // HTTP fallback: pass the best available message value (URL for media)
              api.post(`${API_BASE}/send-message`, { user_id: target, message: payload.message, type: payload.type || 'text', agent: currentAgent || undefined });
              // Fallback preview
              try {
                const ts = new Date().toISOString();
                const previewText = typeof payload.message === 'string' ? payload.message : (payload.caption || (payload.type || ''));
                window.dispatchEvent(new CustomEvent('conversation-preview', { detail: {
                  user_id: target,
                  last_message: previewText,
                  last_message_type: payload.type || 'text',
                  last_message_time: ts,
                  last_message_from_me: true,
                  last_message_status: 'sent',
                }}));
              } catch {}
            }
          } catch {}
          setForwardOpen(false);
        }}
      />
      <Suspense fallback={null}>
        <TemplatesDialog
          open={templatesOpen}
          onClose={() => setTemplatesOpen(false)}
          toUserId={activeUser?.user_id}
          onSelectTemplate={(tpl) => {
            try {
              if (!tpl || !tpl.name) return;
              // For now just insert the template name as text; sending a template can be added next.
              if (ws && ws.readyState === WebSocket.OPEN) {
                sendMessageViaWebSocket({ message: `Template: ${tpl.name}`, type: 'text' });
              } else if (activeUser?.user_id) {
                api.post(`${API_BASE}/send-message`, { user_id: activeUser.user_id, type: 'text', message: `Template: ${tpl.name}`, from_me: true, agent: currentAgent || undefined });
              }
            } catch {}
            setTemplatesOpen(false);
          }}
        />
      </Suspense>
      <Suspense fallback={null}>
        <NotesDialog
          open={notesOpen}
          onClose={() => setNotesOpen(false)}
          userId={activeUser?.user_id}
          currentAgent={currentAgent}
        />
      </Suspense>
    </div>
  );
}

const areEqual = (prevProps, nextProps) => {
  const prevId = prevProps.activeUser?.user_id || '';
  const nextId = nextProps.activeUser?.user_id || '';
  return (
    prevId === nextId &&
    prevProps.ws === nextProps.ws &&
    prevProps.adminWs === nextProps.adminWs &&
    prevProps.currentAgent === nextProps.currentAgent &&
    prevProps.onUpdateConversationTags === nextProps.onUpdateConversationTags
  );
};

export default React.memo(ChatWindow, areEqual);