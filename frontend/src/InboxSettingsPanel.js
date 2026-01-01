import React, { useEffect, useMemo, useState } from 'react';
import api from './api';

const splitNumbers = (txt) => {
  const raw = String(txt || '')
    .split(/\r?\n|,/g)
    .map(s => s.trim())
    .filter(Boolean);
  // keep as-is; backend will normalize digits
  return raw;
};

export default function InboxSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  const [automationsGate, setAutomationsGate] = useState(false);
  const [testNumbersText, setTestNumbersText] = useState('');

  const [buyTitle, setBuyTitle] = useState('Acheter | شراء');
  const [statusTitle, setStatusTitle] = useState('Statut | حالة');

  const [btn1Audio, setBtn1Audio] = useState('');
  const [btn2Audio, setBtn2Audio] = useState('');
  const [btn3Audio, setBtn3Audio] = useState('');

  const normalizedPreview = useMemo(() => {
    const arr = splitNumbers(testNumbersText);
    return arr.join(', ');
  }, [testNumbersText]);

  const load = async () => {
    setErr('');
    setOk('');
    setLoading(true);
    try {
      const res = await api.get('/admin/inbox-config');
      const cfg = res?.data || {};
      setAutomationsGate(!!cfg.automations_test_gate_enabled);
      setTestNumbersText(Array.isArray(cfg.test_numbers) ? cfg.test_numbers.join('\n') : '');
      setBuyTitle(cfg.catalog_buy_button_title || 'Acheter | شراء');
      setStatusTitle(cfg.catalog_order_status_button_title || 'Statut | حالة');
      setBtn1Audio(cfg.order_confirm_btn1_audio_url || '');
      setBtn2Audio(cfg.order_confirm_btn2_audio_url || '');
      setBtn3Audio(cfg.order_confirm_btn3_audio_url || '');
    } catch (e) {
      setErr('Failed to load inbox settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setErr('');
    setOk('');
    setSaving(true);
    try {
      const payload = {
        automations_test_gate_enabled: !!automationsGate,
        test_numbers: splitNumbers(testNumbersText),
        catalog_buy_button_title: buyTitle,
        catalog_order_status_button_title: statusTitle,
        order_confirm_btn1_audio_url: btn1Audio,
        order_confirm_btn2_audio_url: btn2Audio,
        order_confirm_btn3_audio_url: btn3Audio,
      };
      await api.post('/admin/inbox-config', payload);
      setOk('Saved.');
      // re-fetch to show normalized state from backend
      await load();
    } catch (e) {
      setErr('Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-sm text-slate-600">Loading…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-screen bg-white">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="text-2xl font-semibold">Inbox Settings</div>
        <div className="text-sm text-slate-500 mt-1">
          These settings are stored in the database and applied immediately (no redeploy).
        </div>

        {(err || ok) && (
          <div className="mt-4">
            {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">{err}</div>}
            {ok && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-2 rounded">{ok}</div>}
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="border rounded-xl p-4">
            <div className="font-medium">Test Numbers</div>
            <div className="text-xs text-slate-500 mt-1">
              Digits only is fine (e.g. <span className="font-mono">2126…</span>). One per line.
            </div>

            <label className="flex items-center gap-2 mt-3 text-sm">
              <input type="checkbox" checked={automationsGate} onChange={(e) => setAutomationsGate(e.target.checked)} />
              Enable automations only for test numbers
            </label>

            <div className="mt-3">
              <textarea
                className="w-full border rounded px-2 py-2 text-sm font-mono"
                rows={7}
                placeholder="212612345678&#10;0612345678"
                value={testNumbersText}
                onChange={(e) => setTestNumbersText(e.target.value)}
              />
              <div className="text-xs text-slate-500 mt-2">
                Preview: {normalizedPreview || '—'}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Used for: automation test-gate + catalog quick-reply buttons.
              </div>
            </div>
          </div>

          <div className="border rounded-xl p-4">
            <div className="font-medium">Catalog Quick-Reply Buttons</div>
            <div className="text-xs text-slate-500 mt-1">
              These titles show on the WhatsApp quick buttons (only for test numbers).
            </div>
            <div className="mt-3 space-y-3">
              <div>
                <div className="text-xs text-slate-500 mb-1">Buy button title</div>
                <input className="w-full border rounded px-2 py-1 text-sm" value={buyTitle} onChange={(e) => setBuyTitle(e.target.value)} />
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">Order status button title</div>
                <input className="w-full border rounded px-2 py-1 text-sm" value={statusTitle} onChange={(e) => setStatusTitle(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="border rounded-xl p-4 md:col-span-2">
            <div className="font-medium">Order Confirmation — Button Audio URLs</div>
            <div className="text-xs text-slate-500 mt-1">
              When customers click the confirmation buttons, we’ll send these audio URLs (if set).
            </div>
            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-slate-500 mb-1">Confirm (BTN1) audio URL</div>
                <input className="w-full border rounded px-2 py-1 text-sm" value={btn1Audio} onChange={(e) => setBtn1Audio(e.target.value)} placeholder="https://…" />
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">Change info (BTN2) audio URL</div>
                <input className="w-full border rounded px-2 py-1 text-sm" value={btn2Audio} onChange={(e) => setBtn2Audio(e.target.value)} placeholder="https://…" />
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">Talk to agent (BTN3) audio URL</div>
                <input className="w-full border rounded px-2 py-1 text-sm" value={btn3Audio} onChange={(e) => setBtn3Audio(e.target.value)} placeholder="https://…" />
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-2">
          <button
            className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-60"
            onClick={save}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          <button className="px-4 py-2 rounded border" onClick={load} disabled={saving}>
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}


