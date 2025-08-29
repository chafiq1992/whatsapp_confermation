import React, { useEffect, useState } from 'react';
import api from './api';

export default function AgentHeaderBar({ currentAgent, onAgentChange, myAssignedOnly, onToggleMyAssigned }) {
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
    <div className="flex items-center gap-2 p-2 border-b border-gray-800 bg-gray-900">
      <select
        className="flex-1 p-2 bg-gray-100 rounded text-black"
        value={currentAgent || ''}
        onChange={(e)=> onAgentChange && onAgentChange(e.target.value)}
        title="Active agent"
      >
        <option value="">Select agent…</option>
        {agents.map(a => (
          <option key={a.username} value={a.username}>{a.name || a.username}</option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" checked={!!myAssignedOnly} onChange={(e)=> onToggleMyAssigned && onToggleMyAssigned(e.target.checked)} />
        <span>My assigned only</span>
      </label>
    </div>
  );
}


