import React, { useEffect, useState, useMemo } from 'react';
import api from './api';
import AutomationStudio from './AutomationStudio';

export default function StudioPage() {
  const [allowed, setAllowed] = useState(false);
  const [list, setList] = useState([]);

  const getFlowIdFromUrl = () => {
    try {
      const hash = window.location.hash || '';
      const m = hash.match(/automation-studio\/(.+)$/);
      if (m && m[1]) return decodeURIComponent(m[1]);
    } catch {}
    try {
      const path = window.location.pathname || '';
      if (path.includes('/automation-studio/')) {
        const part = path.split('/automation-studio/')[1] || '';
        if (part) return decodeURIComponent(part.split('/')[0]);
      }
    } catch {}
    return null;
  };

  const [selectedId, setSelectedId] = useState(getFlowIdFromUrl());
  const selectedAutomation = useMemo(() => list.find(x => x?.id === selectedId) || null, [list, selectedId]);
  const initialFlow = useMemo(() => (selectedAutomation && selectedAutomation.flow) ? selectedAutomation.flow : null, [selectedAutomation]);

  const persist = async (arr) => {
    try { await api.post('/automations', arr); } catch {}
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/auth/me');
        if (res?.data?.is_admin) {
          setAllowed(true);
          try {
            const a = await api.get('/automations');
            const arr = Array.isArray(a.data) ? a.data : [];
            setList(arr);
          } catch {}
        } else {
          window.location.replace('/');
        }
      } catch (e) {
        window.location.replace('/login');
      }
    })();
  }, []);

  useEffect(() => {
    const onHash = () => setSelectedId(getFlowIdFromUrl());
    const onPop = () => setSelectedId(getFlowIdFromUrl());
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  if (!allowed) return null;

  const goHome = () => { window.location.href = '/#/automation-studio'; };
  const openFlow = (id) => { window.location.href = '/#/automation-studio/' + encodeURIComponent(id); };

  const hasOrderConfirmation = list.some(x => x?.id === 'order_confirmation');
  const homeFlows = [
    { id: 'order_confirmation', name: 'Shopify: Order Confirmation' },
    ...list.filter(x => x?.id && x.id !== 'order_confirmation'),
  ];

  // HOME: list flows as cards
  if (!selectedId) {
    return (
      <div className="min-h-screen w-screen bg-white">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="text-2xl font-semibold">Automations</div>
              <div className="text-sm text-gray-500">Choose a flow to open its canvas</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 text-sm bg-gray-800 text-white rounded"
                onClick={() => (window.location.href = '/')}
              >← Back to Inbox</button>
              <button
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded"
                onClick={() => {
                  const name = window.prompt('New automation name?');
                  if (!name) return;
                  const id = name.toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
                  const entry = { id, name, flow: { nodes: [], edges: [] } };
                  const next = [...list, entry];
                  setList(next);
                  persist(next);
                  openFlow(id);
                }}
              >New</button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {homeFlows.map((f) => (
              <div key={f.id} className="border rounded-xl p-4 shadow-sm hover:shadow transition bg-white">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{f.name || f.id}</div>
                    <div className="text-xs text-gray-500">{f.id === 'order_confirmation' ? 'Built-in flow' : 'Custom flow'}</div>
                  </div>
                  {f.id !== 'order_confirmation' && (
                    <div className="flex items-center gap-1">
                      <button
                        className="px-2 py-1 text-xs border rounded"
                        onClick={() => {
                          const name = window.prompt('Rename automation', f.name || f.id);
                          if (!name) return;
                          const next = list.map(x => x.id === f.id ? { ...x, name } : x);
                          setList(next);
                          persist(next);
                        }}
                      >Rename</button>
                      <button
                        className="px-2 py-1 text-xs border rounded text-red-600"
                        onClick={() => {
                          if (!window.confirm('Delete this automation?')) return;
                          const next = list.filter(x => x.id !== f.id);
                          setList(next);
                          persist(next);
                        }}
                      >Delete</button>
                    </div>
                  )}
                </div>
                <div className="mt-4">
                  <button
                    className="w-full px-3 py-2 text-sm bg-blue-600 text-white rounded"
                    onClick={() => openFlow(f.id)}
                  >Open</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // CANVAS: show single flow editor with back button
  return (
    <div className="h-screen w-screen bg-white">
      <div className="h-12 border-b flex items-center justify-between px-3">
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 text-sm border rounded" onClick={goHome}>← All flows</button>
          <div className="font-medium">{selectedAutomation?.name || (selectedId === 'order_confirmation' ? 'Shopify: Order Confirmation' : selectedId)}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-2 py-1 text-sm border rounded"
            onClick={async ()=>{
              try { await persist(list); alert('Automations saved'); } catch { alert('Failed to save'); }
            }}
          >Save</button>
        </div>
      </div>
      <div className="h-[calc(100vh-3rem)]">
        <AutomationStudio
          initialFlow={initialFlow}
          onSaveFlow={async (flow)=>{
            try {
              const existing = [...list];
              const idx = existing.findIndex(x => x?.id === selectedId);
              const entry = { id: selectedId || 'order_confirmation', name: selectedAutomation?.name || (selectedId === 'order_confirmation' ? 'Shopify: Order Confirmation' : selectedId), flow };
              if (idx >= 0) existing[idx] = entry; else existing.push(entry);
              setList(existing);
              await persist(existing);
              alert('Saved');
            } catch { alert('Save failed'); }
          }}
        />
      </div>
    </div>
  );
}


