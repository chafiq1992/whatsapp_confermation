import React, { useEffect, useState } from 'react';
import api from './api';

export default function InternalChannelsBar({ channels = [], onSelectChannel, onSelectAgent, excludeAgent, compact = false }) {
  const [agents, setAgents] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/admin/agents');
        setAgents(res.data || []);
      } catch {}
    })();
  }, []);

  return (
    <div className={compact ? "flex gap-1 p-1 bg-gray-800/80 rounded-full overflow-x-auto" : "flex gap-2 p-2 border-b border-gray-800 bg-gray-900 overflow-x-auto"}>
      {agents
        .filter(a => {
          if (!excludeAgent) return true;
          const ex = String(excludeAgent).toLowerCase();
          const uname = String(a.username || '').toLowerCase();
          const name = String(a.name || '').toLowerCase();
          return uname !== ex && name !== ex;
        })
        .map(a => (
        <button
          key={a.username}
          type="button"
          onClick={() => onSelectAgent && onSelectAgent(a.username)}
          className={compact ? "px-2 py-0.5 rounded-full bg-gray-700 hover:bg-gray-600 text-xs" : "px-3 py-1 rounded-full bg-gray-800 hover:bg-gray-700 text-sm"}
          title={`DM @${a.name || a.username}`}
        >
          @{a.name || a.username}
        </button>
      ))}
    </div>
  );
}


