import React, { useEffect, useState, useMemo } from 'react';
import api from './api';
import AutomationStudio from './AutomationStudio';

export default function StudioPage() {
  const [allowed, setAllowed] = useState(false);
  const [list, setList] = useState([]);
  const [orderIdInput, setOrderIdInput] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [orderFlow, setOrderFlow] = useState(null);
  const [flowVersion, setFlowVersion] = useState(0);
  const [loadingOrder, setLoadingOrder] = useState(false);
  const [runs, setRuns] = useState([]);
  const [loadingRuns, setLoadingRuns] = useState(false);

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
  const initialFlow = useMemo(() => {
    if (selectedId === 'order_confirmation') return orderFlow;
    return (selectedAutomation && selectedAutomation.flow) ? selectedAutomation.flow : null;
  }, [selectedAutomation, selectedId, orderFlow]);

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

  // When selecting Order Confirmation, fetch latest run and build a live visualization
  useEffect(() => {
    if (selectedId !== 'order_confirmation') return;
    (async () => {
      try {
        setLoadingOrder(true);
        // Fetch last run key to get an order id, then fetch that run
        const last = await api.get('/flows/order-confirmation/last?limit=1');
        const first = Array.isArray(last.data) && last.data.length ? last.data[0] : null;
        let oid = orderIdInput;
        if (!oid && first && first.key) {
          const parts = String(first.key).split(':');
          oid = parts[parts.length - 1] || '';
        }
        if (oid) {
          setOrderIdInput(oid);
          await fetchOrderRun(oid);
        } else {
          // Clear flow if none available yet
          setOrderFlow(buildOrderFlowFromLogs([]));
        }
      } catch {}
      finally { setLoadingOrder(false); }
    })();
    fetchRunsHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  if (!allowed) return null;

  const goHome = () => { window.location.href = '/#/automation-studio'; };
  const openFlow = (id) => { window.location.href = '/#/automation-studio/' + encodeURIComponent(id); };
  const fetchOrderRun = async (oid) => {
    try {
      setLoadingOrder(true);
      const res = await api.get(`/flows/order-confirmation/${encodeURIComponent(oid)}`);
      const logs = (res?.data && Array.isArray(res.data.nodes)) ? res.data.nodes : [];
      setOrderFlow(buildOrderFlowFromLogs(logs));
      setFlowVersion(v=>v+1);
    } catch {}
    finally { setLoadingOrder(false); }
  };
  const fetchRunsHistory = async () => {
    try {
      setLoadingRuns(true);
      const res = await api.get('/flows/order-confirmation/history?limit=50');
      const arr = Array.isArray(res.data) ? res.data : [];
      setRuns(arr);
    } catch {}
    finally { setLoadingRuns(false); }
  };
  const runTest = async () => {
    try {
      const oid = orderIdInput && orderIdInput.trim() ? orderIdInput.trim() : `test_${Date.now()}`;
      const body = { order_id: oid };
      if (testPhone && testPhone.trim()) body.phone = testPhone.trim();
      // Try to extract template settings from current flow (send_template action)
      try {
        const src = initialFlow || orderFlow || null;
        if (src && Array.isArray(src.nodes)) {
          const send = src.nodes.find(n => n?.type === 'action' && String(n?.data?.type||'') === 'send_whatsapp_template');
          if (send && send.data) {
            if (send.data.template_name) body.template_name = send.data.template_name;
            if (send.data.language) body.language = send.data.language;
            if (send.data.components) body.components = send.data.components;
          }
        }
      } catch {}
      await api.post('/flows/order-confirmation/test-run', body);
      setOrderIdInput(oid);
      // Give backend a moment to persist
      setTimeout(async () => {
        await fetchOrderRun(oid);
        await fetchRunsHistory();
      }, 1200);
    } catch {
      alert('Failed to start test run');
    }
  };

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
          {selectedId === 'order_confirmation' ? (
            <>
              <input
                className="px-2 py-1 text-sm border rounded w-48"
                placeholder="Order ID"
                value={orderIdInput}
                onChange={(e)=>setOrderIdInput(e.target.value)}
              />
              <input
                className="px-2 py-1 text-sm border rounded w-44"
                placeholder="Test phone (optional)"
                value={testPhone}
                onChange={(e)=>setTestPhone(e.target.value)}
              />
              <button
                className="px-2 py-1 text-sm border rounded"
                onClick={()=>{ if (orderIdInput) { fetchOrderRun(orderIdInput); } }}
                disabled={!orderIdInput || loadingOrder}
              >{loadingOrder ? 'Loading…' : 'Load'}</button>
              <button
                className="px-2 py-1 text-sm border rounded"
                onClick={async ()=>{
                  try {
                    setLoadingOrder(true);
                    const last = await api.get('/flows/order-confirmation/last?limit=1');
                    const first = Array.isArray(last.data) && last.data.length ? last.data[0] : null;
                    let oid = '';
                    if (first && first.key) {
                      const parts = String(first.key).split(':');
                      oid = parts[parts.length - 1] || '';
                    }
                    if (oid) { setOrderIdInput(oid); await fetchOrderRun(oid); }
                  } catch {}
                  finally { setLoadingOrder(false); }
                }}
              >Latest</button>
              <button
                className="px-2 py-1 text-sm bg-blue-600 text-white rounded"
                onClick={runTest}
              >Run Test</button>
            </>
          ) : (
            <button
              className="px-2 py-1 text-sm border rounded"
              onClick={async ()=>{
                try { await persist(list); alert('Automations saved'); } catch { alert('Failed to save'); }
              }}
            >Save</button>
          )}
        </div>
      </div>
      <div className="h-[calc(100vh-14rem)]">
        <AutomationStudio
          key={`flow-${selectedId}-${flowVersion}`}
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
      {selectedId === 'order_confirmation' && (
        <div className="h-44 border-t bg-white">
          <div className="h-10 border-b flex items-center justify-between px-3">
            <div className="text-sm font-medium">Flow history</div>
            <button className="px-2 py-1 text-sm border rounded" onClick={fetchRunsHistory} disabled={loadingRuns}>{loadingRuns ? 'Refreshing…' : 'Refresh'}</button>
          </div>
          <div className="h-[calc(100%-2.5rem)] overflow-x-auto overflow-y-hidden">
            <div className="flex items-stretch gap-2 px-3 py-2 min-w-max">
              {runs.map((r)=>{
                const status = (r?.last?.status||'ok');
                const pill = status === 'error' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200';
                return (
                  <button key={`${r.order_id}:${r.ts}`} onClick={()=>{ setOrderIdInput(r.order_id||''); fetchOrderRun(r.order_id||''); }} className="border rounded-lg p-3 bg-white hover:shadow text-left min-w-[240px]">
                    <div className={`inline-block text-[11px] px-1.5 py-0.5 rounded border ${pill}`}>{status}</div>
                    <div className="text-sm font-medium mt-1">Order {String(r.order_id||'')}</div>
                    <div className="text-xs text-slate-500 mt-1">{String(r.last?.name||'')}</div>
                    <div className="text-[11px] text-slate-400 mt-2">{String(r.ts||'')}</div>
                  </button>
                );
              })}
              {(!runs || runs.length===0) && (
                <div className="text-sm text-slate-500 px-3 py-2">No runs yet.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Build a visual flow from backend logs
function buildOrderFlowFromLogs(nodesLogs) {
  // Index logs by name for convenience
  const byName = {};
  for (const n of nodesLogs || []) {
    byName[n?.name || ''] = n;
  }

  let idSeq = 1; const nextId = () => 'n' + (idSeq++);
  const N = [];
  const E = [];

  // Positions
  const baseY = 160; const yFalse = 300; const dx = 260; let x = 120;

  // Trigger
  const trigInput = byName['trigger:order_created']?.input || {};
  const trigger = { id: nextId(), type: 'trigger', x, y: baseY, data: { source: 'shopify', topic: 'orders/create', sample: safeJson(trigInput), runtime: byName['trigger:order_created'] } };
  N.push(trigger); x += dx;

  // Normalize phone
  const normalizeLog = byName['normalize_phone'] || {};
  const normalize = { id: nextId(), type: 'action', x, y: baseY, data: { type: 'normalize_phone', text: `e164: ${String((normalizeLog.output||{}).e164||'')}`, runtime: normalizeLog } };
  N.push(normalize); E.push({ id: nextId(), from: trigger.id, fromPort: 'out', to: normalize.id, toPort: 'in' }); x += dx;

  // Check WhatsApp
  const checkLog = byName['check_whatsapp'] || {};
  const hasWa = (checkLog.output && typeof checkLog.output.has_wa !== 'undefined') ? !!checkLog.output.has_wa : true;
  const cond = { id: nextId(), type: 'condition', x, y: baseY, data: { expression: 'has WhatsApp?', trueLabel: 'Yes', falseLabel: 'No', runtime: checkLog } };
  N.push(cond); E.push({ id: nextId(), from: normalize.id, fromPort: 'out', to: cond.id, toPort: 'in' });

  // False branch: tag no_wtp
  const tagNo = { id: nextId(), type: 'action', x: x + dx, y: yFalse, data: { type: 'shopify_tag', text: 'add tag: no_wtp', runtime: byName['tag:no_wtp'] } };
  N.push(tagNo); E.push({ id: nextId(), from: cond.id, fromPort: 'false', to: tagNo.id, toPort: 'in' });

  // True branch: send template -> tag ok_wtp
  const sendLog = byName['send_template'] || {};
  const send = { id: nextId(), type: 'action', x: x + dx, y: baseY, data: { type: 'send_whatsapp_template', template_name: String((sendLog.input||{}).template||'order_confirmed'), language: String((sendLog.input||{}).language||'en'), runtime: sendLog } };
  N.push(send); E.push({ id: nextId(), from: cond.id, fromPort: 'true', to: send.id, toPort: 'in' });

  const tagOk = { id: nextId(), type: 'action', x: x + 2*dx, y: baseY, data: { type: 'shopify_tag', text: 'add tag: ok_wtp', runtime: byName['tag:ok_wtp'] } };
  N.push(tagOk); E.push({ id: nextId(), from: send.id, fromPort: 'out', to: tagOk.id, toPort: 'in' });

  // Exit node summarizing result
  const resultStatus = (sendLog.status||'ok') === 'ok' ? 'Message sent' : `Error: ${String(sendLog.error||'unknown')}`;
  const exit = { id: nextId(), type: 'exit', x: x + 3*dx, y: baseY, data: { text: resultStatus } };
  N.push(exit);
  // Connect both branches to exit
  E.push({ id: nextId(), from: tagOk.id, fromPort: 'out', to: exit.id, toPort: 'in' });
  E.push({ id: nextId(), from: tagNo.id, fromPort: 'out', to: exit.id, toPort: 'in' });

  return { nodes: N, edges: E };
}

function safeJson(obj) {
  try { return JSON.stringify(obj || {}, null, 2); } catch { return String(obj || ''); }
}


