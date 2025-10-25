import React, { useEffect, useMemo, useState } from 'react';
import api from './api';

export default function TemplatesDialog({ open, onClose, onSelectTemplate }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');

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

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-gray-900 text-white rounded-lg p-3 w-[720px] max-w-[95vw]" onClick={e=>e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2">
          <input
            className="flex-1 px-2 py-1 bg-gray-800 rounded"
            placeholder="Search templates…"
            value={q}
            onChange={e=>setQ(e.target.value)}
          />
          <button className="px-3 py-1 bg-gray-700 rounded" onClick={onClose}>Close</button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto divide-y divide-gray-800 rounded border border-gray-800">
          {loading && <div className="px-3 py-2 text-sm text-gray-400">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="px-3 py-2 text-sm text-gray-400">No templates</div>
          )}
          {!loading && filtered.map((t, idx) => (
            <button
              key={`${t.name || 'tpl'}_${idx}`}
              className="w-full text-left px-3 py-2 hover:bg-gray-800"
              onClick={() => { onSelectTemplate && onSelectTemplate(t); }}
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
      </div>
    </div>
  );
}


