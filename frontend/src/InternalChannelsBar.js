import React, { useMemo } from 'react';

export default function InternalChannelsBar({ channels = [], onSelectChannel }) {
  const defaultChannels = useMemo(() => channels.length ? channels : [
    'general', 'sales', 'support'
  ], [channels]);

  return (
    <div className="flex gap-2 p-2 border-b border-gray-800 bg-gray-900 overflow-x-auto">
      {defaultChannels.map((ch) => (
        <button
          key={ch}
          type="button"
          onClick={() => onSelectChannel && onSelectChannel(ch)}
          className="px-3 py-1 rounded-full bg-gray-800 hover:bg-gray-700 text-sm"
          title={`Open #${ch}`}
        >
          #{ch}
        </button>
      ))}
    </div>
  );
}


