import React, { useEffect, useState } from 'react';
import api from './api';
import AutomationStudio from './AutomationStudio';

export default function StudioPage() {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/auth/me');
        if (res?.data?.is_admin) {
          setAllowed(true);
        } else {
          window.location.replace('/');
        }
      } catch (e) {
        window.location.replace('/login');
      }
    })();
  }, []);

  if (!allowed) return null;

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


