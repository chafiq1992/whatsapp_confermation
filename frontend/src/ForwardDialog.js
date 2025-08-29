import React, { useEffect, useState } from 'react';
import api from './api';

export default function ForwardDialog({ open, onClose, onSelect }) {
  const [channels, setChannels] = useState(['general', 'sales', 'support']);
  const [agents, setAgents] = useState([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) return;
    (async () => {
      try { const res = await api.get('/admin/agents'); setAgents(res.data || []); } catch {}
    })();
  }, [open]);

  const filteredChannels = channels.filter(c => c.toLowerCase().includes(q.toLowerCase()));
  const filteredAgents = agents.filter(a => (a.name || a.username || '').toLowerCase().includes(q.toLowerCase()));

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-gray-900 text-white rounded-lg p-3 w-[520px] max-w-[90vw]" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2">
          <input
            autoFocus
            className="flex-1 px-2 py-1 bg-gray-800 rounded"
            placeholder="Search channels or agents…"
            value={q}
            onChange={e=>setQ(e.target.value)}
          />
          <button className="px-3 py-1 bg-gray-700 rounded" onClick={onClose}>Close</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-gray-400 mb-1">Channels</div>
            <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
              {filteredChannels.map(ch => (
                <button key={ch} className="text-left px-2 py-1 rounded bg-gray-800 hover:bg-gray-700" onClick={()=> onSelect && onSelect(`team:${ch}`)}>
                  #{ch}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-400 mb-1">Agents</div>
            <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
              {filteredAgents.map(a => (
                <button key={a.username} className="text-left px-2 py-1 rounded bg-gray-800 hover:bg-gray-700" onClick={()=> onSelect && onSelect(`dm:${a.username}`)}>
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


