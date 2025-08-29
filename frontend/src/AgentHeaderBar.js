import React, { useState } from 'react';
import AdminDashboard from './AdminDashboard';

export default function AgentHeaderBar({ currentAgent, onAgentChange, myAssignedOnly, onToggleMyAssigned }) {
  const [showAdmin, setShowAdmin] = useState(false);

  return (
    <div className="flex items-center gap-2 p-2 border-b border-gray-800 bg-gray-900">
      <div className="flex items-center gap-2">
        <button
          className="px-3 py-2 rounded bg-gray-200 text-gray-800 hover:bg-gray-300"
          onClick={() => setShowAdmin(true)}
          title="Admin settings"
          type="button"
        >
          ⚙️ Settings
        </button>
        <button
          className="px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700"
          onClick={() => { window.open('/#/automation-studio', '_blank', 'noopener,noreferrer'); }}
          title="Open Automation Studio"
          type="button"
        >
          🛠️ Automation
        </button>
      </div>
      <div className="flex-1" />
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" checked={!!myAssignedOnly} onChange={(e)=> onToggleMyAssigned && onToggleMyAssigned(e.target.checked)} />
        <span>My assigned only</span>
      </label>
      {showAdmin && (
        <AdminDashboard onClose={() => setShowAdmin(false)} />
      )}
    </div>
  );
}


