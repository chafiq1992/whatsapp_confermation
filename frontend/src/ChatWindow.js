import React, { useEffect, useState, useRef, useCallback } from 'react';
import api from './api';
import MessageBubble from './MessageBubble';
import ForwardDialog from './ForwardDialog';
import useAudioRecorder from './useAudioRecorder';
import EmojiPicker from 'emoji-picker-react';
import CatalogPanel from "./CatalogPanel";
import { saveMessages, loadMessages } from './chatStorage';

// API and WebSocket endpoints
const API_BASE = process.env.REACT_APP_API_BASE || '';
const WS_BASE =
  process.env.REACT_APP_WS_URL ||
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/`;

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
    const aMs = toMs(a.timestamp);
    const bMs = toMs(b.timestamp);
    if (aMs !== bMs) return aMs - bMs;
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

// Helper: format seconds as mm:ss for audio recording timer
function formatTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}


// Generate temporary message ID for optimistic UI
function generateTempId() {
  return `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Your existing grouping function (unchanged)
function groupConsecutiveImages(messages) {
  const grouped = [];
  let i = 0;
  while (i < messages.length) {
    if (
      messages[i].type === "image" &&
      typeof messages[i].message === "string"
    ) {
      const group = [messages[i]];
      let j = i + 1;
      while (
        j < messages.length &&
        messages[j].type === "image" &&
        typeof messages[j].message === "string" &&
        messages[j].from_me === messages[i].from_me
      ) {
        group.push(messages[j]);
        j++;
      }
      if (group.length > 1) {
        grouped.push({
          ...group[0],
          message: group.map(imgMsg => ({
            type: "image",
            message: imgMsg.message,
          })),
        });
      } else {
        grouped.push(messages[i]);
      }
      i = j;
    } else {
      grouped.push(messages[i]);
      i++;
    }
  }
  return grouped;
}

export default function ChatWindow({ activeUser, ws, currentAgent, adminWs, onUpdateConversationTags }) {
  const [messages, setMessages] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHitIndexes, setSearchHitIndexes] = useState([]);
  const [activeHitIdx, setActiveHitIdx] = useState(-1);
  const [text, setText] = useState("");
  const [pendingQueues, setPendingQueues] = useState({});
  const [sendingQueues, setSendingQueues] = useState({});
  const [unreadSeparatorIndex, setUnreadSeparatorIndex] = useState(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [catalogProducts, setCatalogProducts] = useState({});
  const MESSAGE_LIMIT = 50;
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const conversationIdRef = useRef(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const forwardPayloadRef = useRef(null);

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
    const uid = activeUser?.user_id;
    if (!uid) return;
    conversationIdRef.current = uid;
    setMessages([]);
    setOffset(0);
    setHasMore(true);
    setUnreadSeparatorIndex(null);
    loadMessages(uid).then((msgs) => {
      if (conversationIdRef.current !== uid) return; // ignore stale
      if (Array.isArray(msgs) && msgs.length > 0) {
        setMessages(sortByTime(msgs));
      }
    });
  }, [activeUser?.user_id]);
  
  // Track last received timestamp for resume on reconnect
  const lastTimestampRef = useRef(null);

  // Max concurrent image uploads (WhatsApp style)
  const MAX_CONCURRENT_UPLOADS = 3;

  const fileInputRef = useRef();
  const inputRef = useRef();
  const messagesEndRef = useRef(null);
  const canvasRef = useRef();

  // Insert date separators like WhatsApp Business
  const formatDayLabel = (date) => {
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    const isSame = (a,b)=> a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
    if (isSame(d, today)) return 'Today';
    if (isSame(d, yesterday)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  };

  const withDateSeparators = (list = []) => {
    const result = [];
    let lastDay = '';
    for (const m of list) {
      const dayKey = new Date(m.timestamp).toDateString();
      if (dayKey !== lastDay) {
        result.push({ __separator: true, label: formatDayLabel(m.timestamp), key: `sep_${dayKey}` });
        lastDay = dayKey;
      }
      result.push(m);
    }
    return result;
  };

  const groupedMessages = withDateSeparators(groupConsecutiveImages(messages));

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
        } else if (data.type === 'conversation_history') {
          setMessages(prev => mergeAndDedupe(prev, Array.isArray(data.data) ? data.data : []));
        } else if (data.type === 'message_sent') {
          setMessages(prev => {
            const idx = prev.findIndex(m => (m.temp_id && m.temp_id === data.data.temp_id) || (m.id && m.id === data.data.id));
            if (idx !== -1) {
              const updated = [...prev];
              updated[idx] = { ...prev[idx], ...data.data };
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
                updated[idx] = sortByTime([{ ...updated[idx], ...incoming }])[0];
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
              const merged = { ...msg, ...data.data };
              // If final wa_message_id arrives, promote id to stable WA id to stabilise keys
              if (data.data.wa_message_id) {
                merged.id = data.data.wa_message_id;
              }
              return merged;
            }
            return msg;
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
      api.post(`${API_BASE}/conversations/${uid}/mark-read`, {})
        .catch(() => {});
    } catch {}
  }, [activeUser?.user_id]);

  // Track latest timestamp whenever messages change
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    const newest = messages[messages.length - 1]?.timestamp;
    if (newest) lastTimestampRef.current = newest;
  }, [messages]);

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

  useEffect(() => {
    if (!activeUser?.user_id) return;
    const uid = activeUser.user_id;
    const controller = new AbortController();
    setOffset(0);
    setHasMore(true);
    fetchMessages({ offset: 0 }, controller.signal, uid);
    return () => controller.abort();
  }, [activeUser?.user_id]);

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

  // Fallback: fetch messages via HTTP if WebSocket fails
  const fetchMessages = async ({ offset: off = 0, append = false } = {}, signal, uidParam) => {
    const uid = uidParam || activeUser?.user_id;
    if (!uid) return [];
    try {
      const res = await api.get(
        `${API_BASE}/messages/${uid}?offset=${off}&limit=${MESSAGE_LIMIT}`,
        { signal }
      );
      const data = res.data;
      if (!Array.isArray(data) || data.length === 0) {
        // No data from server, fall back to cached messages
        const cached = await loadMessages(uid);
        if (cached.length > 0) {
          setMessages(prev => (conversationIdRef.current !== uid)
            ? prev
            : (append ? mergeAndDedupe(prev, cached) : sortByTime(cached))
          );
          setHasMore(false);
        }
        return cached;
      }
      setMessages(prev => (conversationIdRef.current !== uid)
        ? prev
        : (append ? mergeAndDedupe(prev, data) : sortByTime(data))
      );
      const firstUnreadIndex = data.findIndex(msg => !msg.from_me && !msg.read);
      setUnreadSeparatorIndex(firstUnreadIndex !== -1 ? firstUnreadIndex : null);
      if (append) {
        setOffset(off + data.length);
      } else {
        setOffset(data.length);
      }
      setHasMore(data.length >= MESSAGE_LIMIT);
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
      return cached;
    }
  };

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !hasMore) return;
    const container = messagesEndRef.current;
    if (!container) return;
    setLoadingOlder(true);
    setPreserveScroll(true);
    const prevHeight = container.scrollHeight;
    const prevTop = container.scrollTop;
    try {
      await fetchMessages({ offset, append: true });
    } finally {
      requestAnimationFrame(() => {
        const newHeight = container.scrollHeight;
        container.scrollTop = newHeight - prevHeight + prevTop;
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

    // Optimistically add to UI
    setMessages(prev => sortByTime([...prev, messageObj]));

    // Send through WebSocket
    ws.send(
      JSON.stringify({
        type: "send_message",
        data: messageObj,
      })
    );
  };

  
  const sendOrderMessage = (orderData) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendMessageViaWebSocket({
        message: typeof orderData === 'string' ? orderData : JSON.stringify(orderData),
        type: 'order' // Use 'order' type instead of 'text'
      });
    }
  };
  // Send text message with optimistic UI
  const sendMessage = async () => {
    if (!text.trim()) return;
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Use WebSocket with optimistic UI
      sendMessageViaWebSocket({
        message: text,
        type: 'text'
      });
      setText('');
      setShowEmojiPicker(false);
      inputRef.current?.focus();
    } else {
      // Fallback to HTTP with optimistic UI as well
      const temp_id = generateTempId();
      const optimistic = {
        id: temp_id,
        temp_id,
        user_id: activeUser.user_id,
        message: text,
        type: 'text',
        from_me: true,
        status: 'sending',
        timestamp: new Date().toISOString(),
        client_ts: Date.now(),
      };
      setMessages(prev => sortByTime([...prev, optimistic]));
      const toSend = text;
      setText('');
      setShowEmojiPicker(false);
      inputRef.current?.focus();
      try {
        const res = await api.post(`${API_BASE}/send-message`, {
          user_id: activeUser.user_id,
          type: 'text',
          message: toSend,
          from_me: true
        });
        setMessages(prev => prev.map(m => m.temp_id === temp_id ? { ...m, status: 'sent', ...(res?.data?.wa_message_id ? { id: res.data.wa_message_id } : {}) } : m));
      } catch (err) {
        console.error("Failed to send message:", err);
        setMessages(prev => prev.map(m => m.temp_id === temp_id ? { ...m, status: 'failed' } : m));
      }
    }
  };

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
    try {
      const res = await api.post(`${API_BASE}/send-media`, formData);
      const waId = res?.data?.wa_message_id;
      const serverUrl = res?.data?.url || res?.data?.file_path;
      setMessages(prev => prev.map(m => m.temp_id === temp_id ? { ...m, status: 'sent', ...(waId ? { id: waId } : {}), ...(serverUrl ? { url: serverUrl } : {}) } : m));
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
    if (canvasRef.current) setCanvasRef(canvasRef.current);
  }, [canvasRef.current, activeUser?.user_id]);

  const [preserveScroll, setPreserveScroll] = useState(false);

  const scrollToBottom = () => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollTop = messagesEndRef.current.scrollHeight;
    }
  };

  const scrollToHit = (hitListIndex) => {
    if (hitListIndex < 0 || hitListIndex >= searchHitIndexes.length) return;
    const container = messagesEndRef.current;
    if (!container) return;
    const childIndex = searchHitIndexes[hitListIndex];
    const child = container.children[childIndex];
    if (child) {
      child.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  useEffect(() => {
    if (preserveScroll) {
      setPreserveScroll(false);
      return;
    }
    scrollToBottom();
  }, [messages, preserveScroll]);

  useEffect(() => {
    const container = messagesEndRef.current;
    if (!container) return;
    const handleScroll = () => {
      if (container.scrollTop <= 100 && hasMore && !loadingOlder) {
        loadOlderMessages();
      }
    };
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [hasMore, loadingOlder, loadOlderMessages]);

  // Persist messages to IndexedDB whenever they change
  useEffect(() => {
    if (!activeUser?.user_id) return;
    saveMessages(activeUser.user_id, messages);
  }, [messages, activeUser?.user_id]);

  // Mark incoming messages as read when they appear
  useEffect(() => {
    if (!activeUser?.user_id) return;
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
        { message_ids: unreadIds }
      ).catch(() => {});
    }
  }, [messages, activeUser?.user_id, ws]);

  const handleTextChange = (e) => setText(e.target.value);
  const handleKeyPress = (e) => {
    if (e.key === 'Enter') sendMessage();
  };

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
          // Use local blob URL so it renders instantly
          message: imgObj.url,
        };
        setMessages(prev => sortByTime([...prev, optimisticMsg]));
      } catch {}
      
      const formData = new FormData();
      formData.append('files', imgObj.file);
      formData.append("user_id", getUserId());
      formData.append("media_type", "image");
      
      try {
        const response = await api.post(`${API_BASE}/send-media`, formData, {
          onUploadProgress: (e) => {
            setPendingImages(images => {
              let copy = [...images];
              if (!copy[idx]) return copy;
              copy[idx] = { ...copy[idx], progress: Math.round((e.loaded / e.total) * 100), status: "uploading" };
              return copy;
            });
          }
        });
        
        // Ensure the response includes proper URL structure for MessageBubble
        setPendingImages(images => {
          let copy = [...images];
          if (!copy[idx]) return copy;
          copy[idx] = { 
            ...copy[idx], 
            progress: 100, 
            status: "done",
            // Add URL from response if available
            url: response.data?.url || response.data?.file_path
          };
          return copy;
        });
        // Update the optimistic message with final URL and mark as sent
        try {
          const finalUrl = response.data?.url || response.data?.file_path || '';
          setMessages(prev => prev.map(m => m.temp_id === temp_id ? { ...m, status: 'sent', ...(finalUrl ? { url: finalUrl } : {}) } : m));
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
      className="flex flex-col h-full"
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
      
      <div key={activeUser?.user_id || 'no-user'} className="flex-1 overflow-y-auto p-4 space-y-2 bg-gray-900" ref={messagesEndRef}>
        {groupedMessages.map((msg, index) => (
          msg.__separator ? (
            <div key={msg.key} className="sticky top-2 z-10 flex justify-center my-2">
              <span className="px-3 py-1 text-xs rounded-full bg-gray-700 text-gray-200 border border-gray-600">{msg.label}</span>
            </div>
          ) : (
            <React.Fragment key={msg.id || msg.temp_id || index}>
              {index === unreadSeparatorIndex && (
                <div className="text-center text-xs text-gray-400 my-2">Unread Messages</div>
              )}
              <MessageBubble
                msg={msg}
                self={(function() {
                  // Default to backend-provided flag
                  if (msg.from_me) return true;
                  // Heuristic for internal DMs: align current agent's messages to the right
                  try {
                    const isDm = typeof activeUser?.user_id === 'string' && activeUser.user_id.startsWith('dm:');
                    if (!isDm) return false;
                    const agentLower = String(currentAgent || '').toLowerCase();
                    const sender = String(msg.agent || msg.sender || msg.from || msg.name || '').toLowerCase();
                    return agentLower && sender && agentLower === sender;
                  } catch { return false; }
                })()}
                catalogProducts={catalogProducts}
                highlightQuery={searchQuery}
                onForward={(forwardMsg)=>{
                  // Build a proper forward payload that preserves media links
                  const originalType = forwardMsg.type || 'text';
                  const isMedia = originalType === 'image' || originalType === 'audio' || originalType === 'video';

                  let messageValue = '';
                  let urlValue = '';

                  if (isMedia) {
                    // Prefer explicit url provided by backend (e.g., GCS public link)
                    urlValue = (forwardMsg.url && typeof forwardMsg.url === 'string') ? forwardMsg.url : '';
                    if (urlValue) {
                      messageValue = urlValue;
                    } else if (typeof forwardMsg.message === 'string') {
                      // Fallbacks: if message already an absolute URL use as-is; if it is a local path like /media/..., make it absolute
                      const raw = forwardMsg.message;
                      if (/^https?:\/\//i.test(raw)) {
                        messageValue = raw;
                      } else if (/^\/?media\//i.test(raw) || /^\/app\/media\//i.test(raw) || raw.startsWith('/media/')) {
                        const base = (process.env.REACT_APP_API_BASE || '').replace(/\/$/, '');
                        messageValue = `${base}${raw.startsWith('/') ? '' : '/'}${raw.replace(/^\/app\//, '')}`;
                      } else {
                        // As a last resort, keep the raw string (backend may resolve it)
                        messageValue = raw;
                      }
                    } else {
                      // If no usable media reference, degrade gracefully to a label
                      messageValue = forwardMsg.caption || '[media]';
                    }
                  } else {
                    // Non-media: forward text or a stringified representation
                    messageValue = typeof forwardMsg.message === 'string' ? forwardMsg.message : (forwardMsg.caption || '[message]');
                  }

                  const payload = { message: messageValue, type: isMedia ? originalType : (originalType || 'text') };
                  if (isMedia && urlValue) payload.url = urlValue;
                  forwardPayloadRef.current = payload;
                  setForwardOpen(true);
                }}
              />
            </React.Fragment>
          )
        ))}
      </div>
      
      {activeUser && (
        <div className="p-2 border-t border-gray-700 bg-gray-800 flex flex-col space-y-2 relative">
          {isRecording && (
            <div className="bg-black p-2 rounded text-white flex items-center justify-between">
              <span className="text-green-400">🎙️ Recording... {formatTime(recordingTime)}</span>
              <canvas ref={canvasRef} width={200} height={40} className="mx-2 bg-gray-900 rounded" />
              <button
                onClick={stopRecording}
                className="bg-green-600 px-3 py-1 rounded text-white"
              >
                ✅ Send
              </button>
              <button
                onClick={cancelRecording}
                className="bg-red-600 px-3 py-1 rounded text-white ml-2"
              >
                ❌ Cancel
              </button>
            </div>
          )}
          {showEmojiPicker && (
            <div className="absolute bottom-16 left-2 z-10 bg-white rounded shadow">
              <EmojiPicker onEmojiClick={emojiData => setText((prev) => prev + emojiData.emoji)} />
            </div>
          )}
          <div className="flex items-center">
            <button
              onClick={() => setShowEmojiPicker((prev) => !prev)}
              className="bg-gray-600 text-white px-2 rounded-l"
              disabled={isRecording}
              title="Emoji"
            >
              😊
            </button>
            <input
              ref={inputRef}
              className="flex-1 p-2 bg-gray-700 text-white hover:bg-gray-600 focus:bg-gray-600 transition-colors"
              value={text}
              onChange={handleTextChange}
              onKeyDown={handleKeyPress}
              placeholder="Type your message..."
              disabled={isRecording}
            />
            <button
              onClick={sendMessage}
              className="bg-blue-600 px-4 text-white rounded-r"
              disabled={isRecording || !text.trim()}
            >
              Send
            </button>
            {!isRecording && (
              <>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  ref={fileInputRef}
                  onChange={handleFileInputChange}
                />
                <button
                  className="ml-2 px-2 py-1 bg-gray-700 text-white rounded"
                  onClick={() => fileInputRef.current.click()}
                  disabled={isUploading}
                  title="Attach images"
                  tabIndex={-1}
                >
                  📎
                </button>
                <button
                  onClick={startRecording}
                  className="ml-2 px-2 bg-green-600 text-white rounded"
                  title="Record audio"
                >
                  🎙️
                </button>
              </>
            )}
          </div>
        </div>
      )}
      
      <CatalogPanel
        activeUser={activeUser}
        websocket={ws}
        onMessageSent={(optimistic) => {
          // Ensure optimistic entries are sortable with tie-breakers
          const enriched = { ...optimistic, client_ts: optimistic.client_ts || Date.now() };
          setMessages(prev => sortByTime([...prev, enriched]));
        }}
      />
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
            } else {
              // HTTP fallback: pass the best available message value (URL for media)
              api.post(`${API_BASE}/send-message`, { user_id: target, message: payload.message, type: payload.type || 'text' });
            }
          } catch {}
          setForwardOpen(false);
        }}
      />
    </div>
  );
}