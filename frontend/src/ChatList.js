import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  memo,
} from "react";
import api from './api';
import AdminDashboard from './AdminDashboard';
// ⬇︎ uncomment if you want huge-list virtualization
// import { FixedSizeList as List } from "react-window";
//  npm i react-window  ← install once

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

  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
}) {
  /* ─── Local state ─── */
  const [search, setSearch] = useState("");
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [conversations, setConversations] = useState(initialConversations);
  const [wsConnected, setWsConnected] = useState(false);
  const [agents, setAgents] = useState([]);
  const [assignedFilter, setAssignedFilter] = useState('all'); // 'all' | 'unassigned' | username
  const [tagOptions, setTagOptions] = useState([]);
  const [selectedTagFilter, setSelectedTagFilter] = useState("");
  const [tagFilters, setTagFilters] = useState([]);
  const [showAdmin, setShowAdmin] = useState(false);
  const [needsReplyOnly, setNeedsReplyOnly] = useState(false);
  const activeUserRef = useRef(activeUser);

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  useEffect(() => {
    activeUserRef.current = activeUser;
  }, [activeUser]);

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

  // Optionally fetch filtered conversations from backend for scalability
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (showUnreadOnly) params.set('unread_only', 'true');
    if (assignedFilter && assignedFilter !== 'all') params.set('assigned', assignedFilter);
    if (tagFilters.length) params.set('tags', tagFilters.join(','));
    if (needsReplyOnly) params.set('unresponded_only', 'true');
    (async () => {
      try {
        const res = await api.get(`/conversations?${params.toString()}`, { signal: controller.signal });
        if (Array.isArray(res.data)) setConversations(res.data);
      } catch (e) {
        // network errors fall back to client filtering of existing list
      }
    })();
    return () => controller.abort();
  }, [search, showUnreadOnly, assignedFilter, tagFilters, needsReplyOnly]);

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}admin`);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'message_received') {
          const msg = data.data || {};
          const userId = msg.user_id;
          const text =
            typeof msg.message === 'string'
              ? msg.message
              : msg.caption || msg.type || '';
          const time = msg.timestamp || new Date().toISOString();
          setConversations((prev) => {
            const idx = prev.findIndex((c) => c.user_id === userId);
            if (idx !== -1) {
              const current = prev[idx];
              const updated = {
                ...current,
                last_message: text,
                last_message_time: time,
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
              last_message_time: time,
              unread_count:
                activeUserRef.current?.user_id === userId ? 0 : 1,
            };
            return [newConv, ...prev];
          });
        }
      } catch (err) {
        console.error('WS message parsing failed', err);
      }
    };
    return () => ws.close();
  }, []);

  /* ─── Derived data (memoised) ─── */
  const filteredConversations = useMemo(() => {
    const list = Array.isArray(conversations) ? conversations : [];
    return list.filter((c) => {
      const txt = (c.name || c.user_id || "").toLowerCase();
      const matches = txt.includes(search.toLowerCase());
      const unreadOK = !showUnreadOnly || c.unread_count > 0;
      const assignedOK =
        assignedFilter === 'all' ||
        (assignedFilter === 'unassigned' && !c.assigned_agent) ||
        c.assigned_agent === assignedFilter;
      const tagsOK = tagFilters.length === 0 || (c.tags || []).some(t => tagFilters.includes(t));
      const needsReplyOK = !needsReplyOnly || (c.unresponded_count || 0) > 0;
      return matches && unreadOK && assignedOK && tagsOK && needsReplyOK;
    });
  }, [conversations, search, showUnreadOnly, assignedFilter, tagFilters, needsReplyOnly]);

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
    <div className="w-full h-full flex flex-col">
      {/* Top-bar */
      }
      <div className="flex flex-col gap-2 p-2">
        <div className="flex gap-2 items-center">
          <input
            className="flex-1 p-2 bg-gray-100 rounded focus:ring focus:ring-blue-500 text-black"
            placeholder="Search or start new chat"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className={`px-3 rounded text-sm font-medium ${
              showUnreadOnly
                ? "bg-[#004AAD] text-white"
                : "bg-gray-300 text-gray-800"
            }`}
            onClick={() => setShowUnreadOnly((p) => !p)}
          >
            Unread
          </button>
          <button
            className={`px-3 rounded text-sm font-medium ${
              needsReplyOnly
                ? "bg-yellow-500 text-black"
                : "bg-gray-300 text-gray-800"
            }`}
            onClick={() => setNeedsReplyOnly((p) => !p)}
            title="Conversations needing reply"
          >
            Needs reply
          </button>
          <div
            className={`w-3 h-3 rounded-full ${
              wsConnected ? 'bg-green-500' : 'bg-red-500'
            }`}
            title={`WebSocket ${wsConnected ? 'connected' : 'disconnected'}`}
          ></div>
        </div>
        <div className="flex gap-2 items-center">
          <select
            className="p-2 bg-gray-100 rounded text-black"
            value={assignedFilter}
            onChange={(e) => setAssignedFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="unassigned">Unassigned</option>
            {agents.map(a => (
              <option key={a.username} value={a.username}>{a.name || a.username}</option>
            ))}
          </select>
          <div className="flex items-center gap-2 flex-1">
            <select
              className="flex-1 p-2 bg-gray-100 rounded text-black"
              value={selectedTagFilter}
              onChange={(e) => setSelectedTagFilter(e.target.value)}
            >
              <option value="">Select tag to filter…</option>
              {tagOptions.map(opt => (
                <option key={opt.label} value={opt.label}>
                  {`${opt.icon ? opt.icon + ' ' : ''}${opt.label}`}
                </option>
              ))}
            </select>
            <button
              className="px-2 py-2 bg-blue-600 text-white rounded"
              onClick={() => {
                if (selectedTagFilter && !tagFilters.includes(selectedTagFilter)) {
                  setTagFilters([...tagFilters, selectedTagFilter]);
                  setSelectedTagFilter("");
                }
              }}
            >Add</button>
            <div className="flex gap-1 flex-wrap">
              {tagFilters.map(t => (
                <span key={t} className="px-2 py-1 bg-blue-600 text-white rounded-full text-xs flex items-center gap-1">
                  {(() => {
                    const opt = tagOptions.find(o => (o.label || '').toLowerCase() === (t || '').toLowerCase());
                    return `${opt?.icon ? opt.icon + ' ' : ''}${t}`;
                  })()}
                  <button onClick={() => setTagFilters(tagFilters.filter(x => x !== t))} className="ml-1">✕</button>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Empty states */}
      {filteredConversations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400 select-none">
          <span className="text-5xl mb-2">💬</span>
          {conversations.length === 0
            ? "No conversations yet"
            : search
            ? `No chat matches “${search}”`
            : "No unread conversations"}
        </div>
      ) : (
        /* Chat list */
        <div ref={listRef} className="flex-1 overflow-y-auto divide-y divide-gray-800">
          {/* 👉 if you installed react-window, swap the <div> for virtualized <List> :
                <List
                  height={window.innerHeight - 110}
                  itemCount={filteredConversations.length}
                  itemSize={72}
                  width="100%"
                >
                  {({ index, style }) => (
                    <ConversationRow
                      style={style}
                      conv={filteredConversations[index]}
                      onSelect={handleSelect}
                      active={activeUser?.user_id}
                      isOnline={isOnline}
                    />
                  )}
                </List>
            */}
          {filteredConversations.map((c) => (
            <ConversationRow
              key={c.user_id}
              conv={c}
              onSelect={handleSelect}
              active={activeUser?.user_id}
              isOnline={isOnline}
              agents={agents}
              tagOptions={tagOptions}
            />
          ))}
        </div>
      )}
      {/* Bottom-left settings */}
      <div className="p-2 border-t border-gray-800">
        <button
          className="px-3 py-2 rounded bg-gray-200 text-gray-800 hover:bg-gray-300"
          onClick={() => setShowAdmin(true)}
          title="Admin settings"
        >
          ⚙️ Settings
        </button>
      </div>
      {showAdmin && (
        <AdminDashboard onClose={() => setShowAdmin(false)} />
      )}
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
      className={`flex gap-3 p-4 cursor-pointer hover:bg-gray-800 transition-colors ${
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
          <span className="truncate text-xs text-gray-300 flex-1">
            {conv.last_message || "No messages yet"}
          </span>
          <div className="flex gap-2 ml-2 items-center">
            {selectedAgent && (
              <span className="px-2.5 py-1 bg-indigo-600 text-white rounded-full text-sm">
                {agents.find(a => a.username === selectedAgent)?.name || selectedAgent}
              </span>
            )}
            {(tags || []).slice(0,3).map(t => (
              <span key={t} className="px-2.5 py-1 bg-gray-700 text-white rounded-full text-sm">
                {(() => {
                  const opt = tagOptions.find(o => (o.label || '').toLowerCase() === (t || '').toLowerCase());
                  return `${opt?.icon ? opt.icon + ' ' : ''}${t}`;
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
                className="px-2 py-1 bg-gray-600 text-white rounded"
                onClick={(e) => { e.stopPropagation(); setAssignOpen(!assignOpen); }}
                title="Assign / Tags"
              >⋯</button>
              {assignOpen && (
                <div className="absolute right-0 mt-2 w-64 bg-gray-900 border border-gray-700 rounded shadow-lg z-10 p-2" onClick={(e) => e.stopPropagation()}>
                  <div className="mb-2">
                    <label className="text-xs text-gray-400">Assign to</label>
                    <div className="flex gap-2 mt-1">
                      <select className="flex-1 bg-gray-800 text-white p-2 rounded" value={selectedAgent} onChange={(e)=>{ const v = e.target.value; setSelectedAgent(v); (async ()=>{ try { await api.post(`/conversations/${conv.user_id}/assign`, { agent: v || null }); } catch(e) {} })(); }}>
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
                            (async ()=>{ try { await api.post(`/conversations/${conv.user_id}/tags`, { tags: newTags }); } catch(e) {} })();
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
                    <div className="flex gap-1 flex-wrap mt-2">
                      {tags.map(t => (
                        <span key={t} className="px-2 py-0.5 bg-gray-700 rounded-full text-xs flex items-center gap-1">
                          {(() => {
                            const opt = tagOptions.find(o => (o.label || '').toLowerCase() === (t || '').toLowerCase());
                            return `${opt?.icon ? opt.icon + ' ' : ''}${t}`;
                          })()}
                          <button onClick={() => {
                            const newTags = tags.filter(x => x !== t);
                            setTags(newTags);
                            (async ()=>{ try { await api.post(`/conversations/${conv.user_id}/tags`, { tags: newTags }); } catch(e) {} })();
                          }}>✕</button>
                        </span>
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
