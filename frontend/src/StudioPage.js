import React from 'react';
import AutomationStudio from './AutomationStudio';

export default function StudioPage() {
  return (
    <div className="h-screen w-screen bg-white">
      <div className="absolute top-2 left-2 z-50">
        <button
          className="px-3 py-1.5 text-sm bg-gray-800 text-white rounded"
          onClick={() => (window.location.href = '/')}
        >
          ← Back to Inbox
        </button>
      </div>
      <AutomationStudio />
    </div>
  );
}


