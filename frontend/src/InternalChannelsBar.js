import React, { useEffect, useState } from 'react';
import { HiUserCircle } from 'react-icons/hi2';
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
    <div className={compact ? "flex gap-2 p-2 bg-gray-800/80 rounded-full overflow-x-auto" : "flex gap-3 p-3 border-b border-gray-800 bg-gray-900 overflow-x-auto"}>
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
          className={compact ? "px-3 py-1 rounded-full bg-gray-700 hover:bg-gray-600 text-sm flex items-center gap-1" : "px-4 py-2 rounded-full bg-gray-800 hover:bg-gray-700 text-base flex items-center gap-2"}
          title={`DM @${a.name || a.username}`}
        >
          <HiUserCircle className={compact ? "text-lg" : "text-2xl"} />
          @{a.name || a.username}
        </button>
      ))}
    </div>
  );
}


