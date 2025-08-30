import React, { useEffect, useState } from 'react';
import api from './api';

export default function InternalChannelsBar({ channels = [], onSelectChannel, onSelectAgent, excludeAgent }) {
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
    <div className="flex gap-2 p-2 border-b border-gray-800 bg-gray-900 overflow-x-auto">
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
          className="px-3 py-1 rounded-full bg-gray-800 hover:bg-gray-700 text-sm"
          title={`DM @${a.name || a.username}`}
        >
          @{a.name || a.username}
        </button>
      ))}
    </div>
  );
}


