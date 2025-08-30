import React, { useEffect, useMemo, useState } from 'react';
import api from './api';

export default function ForwardDialog({ open, onClose, onSelect }) {
  const [channels, setChannels] = useState(['general', 'sales', 'support']);
  const [agents, setAgents] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) return;
    (async () => {
      try { const res = await api.get('/admin/agents'); setAgents(res.data || []); } catch {}
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const ctrl = new AbortController();
    (async () => {
      try {
        setLoading(true);
        const params = {};
        const term = (q || '').trim();
        if (term) params.q = term;
        const res = await api.get('/conversations', { params, signal: ctrl.signal });
        if (!active) return;
        const rows = Array.isArray(res.data) ? res.data : [];
        // Hide internal channels from the forward recents
        setConversations(rows.filter(r => typeof r.user_id === 'string' && !/^dm:|^team:/.test(r.user_id)));
      } catch (e) {
        if (e?.name !== 'CanceledError' && !api.isCancel?.(e)) {
          setConversations([]);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; ctrl.abort(); };
  }, [open, q]);

  const filteredChannels = useMemo(
    () => channels.filter(c => c.toLowerCase().includes(q.toLowerCase())),
    [channels, q]
  );
  const filteredAgents = useMemo(
    () => agents.filter(a => (a.name || a.username || '').toLowerCase().includes(q.toLowerCase())),
    [agents, q]
  );

  const phoneCandidate = useMemo(() => {
    const t = (q || '').trim();
    if (!t) return '';
    // Very loose phone check: at least 6 digits, optional leading + and spaces
    const digits = t.replace(/[^+\d]/g, '');
    if (/^\+?\d{6,}$/.test(digits)) return digits;
    return '';
  }, [q]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-gray-900 text-white rounded-lg p-3 w-[720px] max-w-[95vw]" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2">
          <input
            autoFocus
            className="flex-1 px-2 py-1 bg-gray-800 rounded"
            placeholder="Search chats, numbers, channels, or agents…"
            value={q}
            onChange={e=>setQ(e.target.value)}
          />
          <button className="px-3 py-1 bg-gray-700 rounded" onClick={onClose}>Close</button>
        </div>

        {!!phoneCandidate && (
          <div className="mb-2">
            <button
              className="w-full text-left px-3 py-2 rounded bg-blue-700 hover:bg-blue-600"
              onClick={() => { onSelect && onSelect(phoneCandidate); onClose && onClose(); }}
            >
              ➤ Send to {phoneCandidate}
            </button>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-xs text-gray-400 mb-1">Recent chats</div>
            <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
              {loading && <div className="text-xs text-gray-400 px-2 py-1">Loading…</div>}
              {!loading && conversations.slice(0, 30).map(c => (
                <button
                  key={c.user_id}
                  className="text-left px-2 py-1 rounded bg-gray-800 hover:bg-gray-700"
                  title={c.user_id}
                  onClick={() => { onSelect && onSelect(c.user_id); onClose && onClose(); }}
                >
                  {c.name || c.user_id}
                </button>
              ))}
              {!loading && conversations.length === 0 && (
                <div className="text-xs text-gray-500 px-2 py-1">No chats</div>
              )}
            </div>
          </div>

          <div>
            <div className="text-xs text-gray-400 mb-1">Channels</div>
            <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
              {filteredChannels.map(ch => (
                <button key={ch} className="text-left px-2 py-1 rounded bg-gray-800 hover:bg-gray-700" onClick={()=> { onSelect && onSelect(`team:${ch}`); onClose && onClose(); }}>
                  #{ch}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs text-gray-400 mb-1">Agents</div>
            <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
              {filteredAgents.map(a => (
                <button key={a.username} className="text-left px-2 py-1 rounded bg-gray-800 hover:bg-gray-700" onClick={()=> { onSelect && onSelect(`dm:${a.username}`); onClose && onClose(); }}>
                  @{a.name || a.username}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


