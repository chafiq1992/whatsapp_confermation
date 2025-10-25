import React, { useEffect, useMemo, useState } from 'react';
import api from './api';

export default function TemplatesDialog({ open, onClose, onSelectTemplate, toUserId }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(null); // selected template
  const [paramsState, setParamsState] = useState({}); // keyed by component index/param index
  const [customerData, setCustomerData] = useState(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const ctrl = new AbortController();
    (async () => {
      try {
        setLoading(true);
        const res = await api.get('/whatsapp/templates', { signal: ctrl.signal });
        if (!active) return;
        const list = Array.isArray(res.data) ? res.data : [];
        setTemplates(list);
      } catch (e) {
        if (e?.name !== 'CanceledError' && !api.isCancel?.(e)) setTemplates([]);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; ctrl.abort(); };
  }, [open]);

  useEffect(() => {
    if (!open || !toUserId) return;
    let alive = true;
    (async () => {
      try {
        const res = await api.get(`/search-customers-all`, { params: { phone_number: toUserId } });
        const list = Array.isArray(res.data) ? res.data : [];
        const first = list[0] || null;
        if (alive) setCustomerData(first);
      } catch {
        if (alive) setCustomerData(null);
      }
    })();
    return () => { alive = false; };
  }, [open, toUserId]);

  useEffect(() => {
    // When a template is selected and we have customer data, prefill parameters
    if (!active) return;
    const comps = Array.isArray(active.components) ? active.components : [];
    // Build default variables from last order/customer
    const name = String((customerData?.name || '').split(' ')[0] || '').trim();
    const orderNum = String(customerData?.last_order?.order_number || '').trim();
    const total = String(customerData?.last_order?.total_price || '').trim();
    const city = String(customerData?.primary_address?.city || '').trim();
    const address = String(customerData?.primary_address?.address1 || customerData?.addresses?.[0]?.address1 || '').trim();
    const phone = String(customerData?.primary_address?.phone || customerData?.phone || '').trim();
    const items = Array.isArray(customerData?.last_order?.line_items) ? customerData.last_order.line_items : [];
    const products = items.map(li => {
      const title = [li.title, li.variant_title].filter(Boolean).join(' — ');
      const qty = li.quantity != null ? `x${li.quantity}` : '';
      return `• ${title} ${qty}`.trim();
    }).join('\n');
    const defaults = [name, orderNum, products, total, city, address, phone];
    const next = {};
    let idx = 0;
    comps.forEach((c, ci) => {
      const params = Array.isArray(c.parameters) ? c.parameters : [];
      params.forEach((_, pi) => {
        if (idx < defaults.length && defaults[idx]) {
          next[`${ci}:${pi}`] = defaults[idx];
        }
        idx++;
      });
      // Buttons dynamic params (rare) not auto-filled here
    });
    if (Object.keys(next).length) setParamsState(next);
  }, [active, customerData]);

  const filtered = useMemo(() => {
    const term = (q || '').trim().toLowerCase();
    if (!term) return templates;
    return templates.filter(t => (
      String(t.name || '').toLowerCase().includes(term) ||
      String(t.status || '').toLowerCase().includes(term) ||
      String(t.language || '').toLowerCase().includes(term) ||
      String(t.category || '').toLowerCase().includes(term)
    ));
  }, [q, templates]);

  const buildGraphComponents = (template) => {
    const comps = Array.isArray(template?.components) ? template.components : [];
    const out = [];
    comps.forEach((c, ci) => {
      const t = String(c?.type || '').toUpperCase();
      if (t === 'BODY' || t === 'HEADER' || t === 'FOOTER') {
        const item = { type: t };
        const params = Array.isArray(c.parameters) ? c.parameters : [];
        if (params.length) {
          item.parameters = params.map((_, pi) => ({ type: 'text', text: paramsState[`${ci}:${pi}`] || '' }));
        }
        out.push(item);
      } else if (t === 'BUTTON' || t === 'BUTTONS') {
        // Graph expects a separate BUTTON component entry per button with subtype
        const buttons = Array.isArray(c.buttons) ? c.buttons : (Array.isArray(c.parameters) ? c.parameters : []);
        buttons.forEach((btn, bi) => {
          const subtype = String(btn?.sub_type || btn?.subtype || (btn?.type || '')).toUpperCase();
          const item = { type: 'BUTTON', sub_type: subtype || 'QUICK_REPLY', index: String(bi) };
          // For URL/PHONE buttons, Graph may expect parameters with text for dynamic parts
          if (Array.isArray(btn?.parameters) && btn.parameters.length) {
            item.parameters = btn.parameters.map((_, pi) => ({ type: 'text', text: paramsState[`${ci}:${bi}:${pi}`] || '' }));
          }
          out.push(item);
        });
      }
    });
    return out;
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-gray-900 text-white rounded-lg p-3 w-[900px] max-w-[95vw]" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2">
          <input
            className="flex-1 px-2 py-1 bg-gray-800 rounded"
            placeholder="Search templates…"
            value={q}
            onChange={e=>setQ(e.target.value)}
          />
          <button className="px-3 py-1 bg-gray-700 rounded" onClick={onClose}>Close</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-gray-800 rounded border border-gray-800">
            {loading && <div className="px-3 py-2 text-sm text-gray-400">Loading…</div>}
            {!loading && filtered.length === 0 && (
              <div className="px-3 py-2 text-sm text-gray-400">No templates</div>
            )}
            {!loading && filtered.map((t, idx) => (
              <button
                key={`${t.name || 'tpl'}_${idx}`}
                className={`w-full text-left px-3 py-2 hover:bg-gray-800 ${active && active.name===t.name ? 'bg-gray-800' : ''}`}
                onClick={() => { setActive(t); setParamsState({}); }}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-gray-400">{t.language || '—'} · {t.category || '—'}</div>
                  </div>
                  <div className={`text-xs px-2 py-0.5 rounded ${String(t.status||'').toLowerCase()==='approved' ? 'bg-green-700 text-white' : 'bg-gray-700 text-gray-200'}`}>{t.status || '—'}</div>
                </div>
              </button>
            ))}
          </div>
          <div className="max-h-[60vh] overflow-y-auto rounded border border-gray-800 p-3">
            {!active && <div className="text-sm text-gray-400">Select a template to preview and fill parameters.</div>}
            {active && (
              <div className="space-y-3">
                <div className="text-lg font-semibold">{active.name}</div>
                <div className="text-xs text-gray-400">{active.language || '—'} · {active.category || '—'}</div>
                <div className="space-y-2">
                  {(active.components || []).map((comp, ci) => (
                    <div key={ci} className="border border-gray-700 rounded p-2">
                      <div className="text-xs text-gray-400 mb-1">{comp.type}</div>
                      {(comp.parameters || []).length > 0 ? (
                        <div className="space-y-1">
                          {comp.parameters.map((p, pi) => (
                            <input
                              key={pi}
                              className="w-full px-2 py-1 bg-gray-800 rounded text-sm"
                              placeholder={`Param ${pi+1}`}
                              value={paramsState[`${ci}:${pi}`] || ''}
                              onChange={(e)=> setParamsState(s => ({...s, [`${ci}:${pi}`]: e.target.value}))}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-500">No parameters</div>
                      )}
                      {Array.isArray(comp.buttons) && comp.buttons.length>0 && (
                        <div className="mt-2 space-y-1">
                          {comp.buttons.map((btn, bi) => (
                            <div key={bi} className="text-xs">
                              <div className="text-gray-400">Button {bi+1} ({btn.sub_type || btn.subtype || btn.type || 'QUICK_REPLY'})</div>
                              {Array.isArray(btn.parameters) && btn.parameters.map((bp, pi) => (
                                <input
                                  key={pi}
                                  className="w-full px-2 py-1 bg-gray-800 rounded text-sm mt-1"
                                  placeholder={`Button ${bi+1} Param ${pi+1}`}
                                  value={paramsState[`${ci}:${bi}:${pi}`] || ''}
                                  onChange={(e)=> setParamsState(s => ({...s, [`${ci}:${bi}:${pi}`]: e.target.value}))}
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="pt-2">
                  <button
                    className="px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-sm"
                    onClick={async ()=>{
                      try {
                        const comps = buildGraphComponents(active);
                        const to = String(toUserId || '').trim();
                        if (!to) { alert('No recipient.'); return; }
                        await api.post('/whatsapp/send-template', {
                          to,
                          template_name: active.name,
                          language: active.language || 'en',
                          components: comps,
                        });
                        onClose && onClose();
                      } catch (e) {
                        alert('Failed to send template');
                      }
                    }}
                  >Send template</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


