import React from 'react';

export default function AgentHeaderBar({ currentAgent, onAgentChange, myAssignedOnly, onToggleMyAssigned }) {

  return (
    <div className="flex items-center gap-2 p-2 border-b border-gray-800 bg-gray-900">
      <div className="flex items-center gap-2"></div>
      <div className="flex-1" />
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" checked={!!myAssignedOnly} onChange={(e)=> onToggleMyAssigned && onToggleMyAssigned(e.target.checked)} />
        <span>My assigned only</span>
      </label>
    </div>
  );
}


