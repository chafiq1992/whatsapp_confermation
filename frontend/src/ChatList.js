import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  memo,
} from "react";
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

/* ───────────── Component ───────────── */
function ChatList({
  conversations = [],
  setActiveUser,
  activeUser,
  onlineUsers = [],
}) {
  /* ─── Local state ─── */
  const [search, setSearch] = useState("");
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  /* ─── Derived data (memoised) ─── */
  const filteredConversations = useMemo(() => {
    const list = Array.isArray(conversations) ? conversations : [];
    return list.filter((c) => {
      const txt = (c.name || c.user_id || "").toLowerCase();
      const matches = txt.includes(search.toLowerCase());
      const unreadOK = !showUnreadOnly || c.unread_count > 0;
      return matches && unreadOK;
    });
  }, [conversations, search, showUnreadOnly]);

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
      {/* Top-bar */}
      <div className="flex gap-2 p-2">
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
            />
          ))}
        </div>
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
}) {
  const selected = active === conv.user_id;
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
        {conv.avatar ? (
          <img
            src={conv.avatar}
            alt={conv.name || conv.user_id}
            className="w-10 h-10 rounded-full object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gray-600 text-white flex items-center justify-center font-bold">
            {getInitials(conv.name || conv.user_id)}
          </div>
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
          <span className="text-xs text-gray-400">
            {formatTime(conv.last_message_time)}
          </span>
        </div>

        {/* Bottom line */}
        <div className="flex items-center justify-between">
          <span className="truncate text-xs text-gray-300 flex-1">
            {conv.last_message || "No messages yet"}
          </span>
          <div className="flex gap-1 ml-2">
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
          </div>
        </div>
      </div>
    </div>
  );
});

export default ChatList;
