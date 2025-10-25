import React, { useEffect, useState, useMemo } from 'react';
import api from './api';
import AutomationStudio from './AutomationStudio';

export default function StudioPage() {
  const [allowed, setAllowed] = useState(false);
  const [list, setList] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
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
            if (!selectedId && arr.length) setSelectedId(arr[0].id);
          } catch {}
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
      <div className="flex h-full">
        <div className="w-72 border-r p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Automations</div>
            <button
              className="px-2 py-1 text-xs bg-gray-800 text-white rounded"
              onClick={() => setSelectedId('order_confirmation')}
            >Order Confirmation</button>
          </div>
          <div className="text-xs text-gray-500">Click an automation to open canvas</div>
          <div className="flex items-center gap-1 py-1">
            <button
              className="px-2 py-1 text-xs bg-blue-600 text-white rounded"
              onClick={() => {
                const name = prompt('New automation name?');
                if (!name) return;
                const id = name.toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
                const entry = { id, name, flow: { nodes: [], edges: [] } };
                const next = [...list, entry];
                setList(next);
                setSelectedId(id);
                persist(next);
              }}
            >New</button>
            <button
              className="px-2 py-1 text-xs bg-gray-700 text-white rounded disabled:opacity-50"
              disabled={!selectedId}
              onClick={() => {
                if (!selectedId) return;
                const current = list.find(x => x.id === selectedId);
                const name = prompt('Rename automation', current?.name || selectedId);
                if (!name) return;
                const next = list.map(x => x.id === selectedId ? { ...x, name } : x);
                setList(next);
                persist(next);
              }}
            >Rename</button>
            <button
              className="px-2 py-1 text-xs bg-red-600 text-white rounded disabled:opacity-50"
              disabled={!selectedId}
              onClick={() => {
                if (!selectedId) return;
                if (!confirm('Delete this automation?')) return;
                const next = list.filter(x => x.id !== selectedId);
                setList(next);
                setSelectedId(next[0]?.id || null);
                persist(next);
              }}
            >Delete</button>
          </div>
          <div className="space-y-1">
            <button className={`w-full text-left px-2 py-1 rounded ${selectedId==='order_confirmation'?'bg-gray-200':''}`} onClick={()=>setSelectedId('order_confirmation')}>Shopify: Order Confirmation</button>
            {list.filter(x => x?.id && x.id !== 'order_confirmation').map(x => (
              <button key={x.id} className={`w-full text-left px-2 py-1 rounded ${selectedId===x.id?'bg-gray-200':''}`} onClick={()=>setSelectedId(x.id)}>{x.name || x.id}</button>
            ))}
          </div>
          <div className="pt-2 space-y-2">
            <button
              className="px-3 py-1.5 text-sm bg-gray-800 text-white rounded w-full"
              onClick={() => (window.location.href = '/')}
            >
              ← Back to Inbox
            </button>
            <button
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded w-full"
              onClick={async ()=>{
                try {
                  await persist(list);
                  alert('Automations saved');
                } catch { alert('Failed to save'); }
              }}
            >Save</button>
          </div>
        </div>
        <div className="flex-1">
          <AutomationStudio
            initialFlow={initialFlow}
            onSaveFlow={async (flow)=>{
              try {
                const existing = [...list];
                const idx = existing.findIndex(x => x?.id === selectedId);
                const entry = { id: selectedId || 'order_confirmation', name: selectedAutomation?.name || 'Order Confirmation', flow };
                if (idx >= 0) existing[idx] = entry; else existing.push(entry);
                setList(existing);
                await persist(existing);
                alert('Saved');
              } catch { alert('Save failed'); }
            }}
          />
        </div>
      </div>
    </div>
  );
}


