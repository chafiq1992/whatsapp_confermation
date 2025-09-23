import React, { useEffect, useState } from 'react';
import api from './api';
const AnalyticsPanel = React.lazy(() => import('./AnalyticsPanel'));

export default function AdminDashboard({ onClose }) {
  const [agents, setAgents] = useState([]);
  const [form, setForm] = useState({ username: '', name: '', password: '', is_admin: false });
  const [loading, setLoading] = useState(false);
  const [tagOptions, setTagOptions] = useState([]);
  const [savingTags, setSavingTags] = useState(false);
  const [tab, setTab] = useState('agents'); // 'agents' | 'tags' | 'analytics'

  const loadAgents = async () => {
    try {
      const res = await api.get('/admin/agents');
      setAgents(res.data || []);
    } catch (e) {}
  };

  useEffect(() => { loadAgents(); }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/admin/tag-options');
        setTagOptions(Array.isArray(res.data) ? res.data : []);
      } catch (e) {}
    })();
  }, []);

  const createAgent = async (e) => {
    e.preventDefault();
    if (!form.username || !form.password) return;
    setLoading(true);
    try {
      await api.post('/admin/agents', form);
      setForm({ username: '', name: '', password: '', is_admin: false });
      await loadAgents();
    } finally {
      setLoading(false);
    }
  };

  const deleteAgent = async (username) => {
    if (!window.confirm(`Delete agent ${username}?`)) return;
    await api.delete(`/admin/agents/${encodeURIComponent(username)}`);
    await loadAgents();
  };

  const inboxLink = `${window.location.origin}/?inbox=shared`;

  const updateTagOption = (idx, field, value) => {
    setTagOptions(prev => prev.map((opt, i) => i === idx ? { ...opt, [field]: value } : opt));
  };

  const addTagOption = () => setTagOptions(prev => [...prev, { label: '', icon: '' }]);
  const removeTagOption = (idx) => setTagOptions(prev => prev.filter((_, i) => i !== idx));
  const saveTagOptions = async () => {
    setSavingTags(true);
    try {
      const cleaned = tagOptions.filter(o => (o.label || '').trim()).map(o => ({ label: o.label.trim(), icon: (o.icon || '').trim() }));
      await api.post('/admin/tag-options', { options: cleaned });
    } finally {
      setSavingTags(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="w-[720px] max-w-[90vw] bg-gray-900 border border-gray-700 rounded-lg p-4" onClick={(e)=>e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Admin Dashboard</h2>
          <div className="flex items-center gap-2">
            <button className={`px-3 py-1 rounded ${tab==='agents'?'bg-blue-600 text-white':'bg-gray-800 text-gray-300'}`} onClick={()=>setTab('agents')}>Agents</button>
            <button className={`px-3 py-1 rounded ${tab==='tags'?'bg-blue-600 text-white':'bg-gray-800 text-gray-300'}`} onClick={()=>setTab('tags')}>Tags</button>
            <button className={`px-3 py-1 rounded ${tab==='analytics'?'bg-blue-600 text-white':'bg-gray-800 text-gray-300'}`} onClick={()=>setTab('analytics')}>Analytics</button>
            <button className="px-3 py-1 rounded bg-gray-800 text-gray-200" onClick={()=>{ window.open('/#/automation-studio', '_blank', 'noopener,noreferrer'); }}>Automation</button>
            <button className="px-2 py-1 bg-gray-700 rounded" onClick={onClose}>✕</button>
          </div>
        </div>

        {tab === 'agents' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="border border-gray-800 rounded p-3">
            <h3 className="font-medium mb-2">Add Agent</h3>
            <form onSubmit={createAgent} className="flex flex-col gap-2">
              <input className="p-2 bg-gray-800 rounded" placeholder="username" value={form.username} onChange={(e)=>setForm({ ...form, username: e.target.value })} />
              <input className="p-2 bg-gray-800 rounded" placeholder="name (optional)" value={form.name} onChange={(e)=>setForm({ ...form, name: e.target.value })} />
              <input className="p-2 bg-gray-800 rounded" type="password" placeholder="password" value={form.password} onChange={(e)=>setForm({ ...form, password: e.target.value })} />
              <label className="text-sm flex items-center gap-2">
                <input type="checkbox" checked={form.is_admin} onChange={(e)=>setForm({ ...form, is_admin: e.target.checked })} />
                Make admin
              </label>
              <button disabled={loading} className="mt-1 px-3 py-2 bg-blue-600 rounded disabled:opacity-50">{loading ? 'Saving…' : 'Create / Update'}</button>
            </form>
          </div>

          <div className="border border-gray-800 rounded p-3">
            <h3 className="font-medium mb-2">Agents</h3>
            <div className="space-y-2 max-h-64 overflow-auto">
              {agents.map(a => (
                <div key={a.username} className="flex items-center justify-between bg-gray-800 rounded p-2">
                  <div>
                    <div className="font-medium">{a.name || a.username}</div>
                    <div className="text-xs text-gray-400">{a.username}{a.is_admin ? ' · admin' : ''}</div>
                  </div>
                  <button className="px-2 py-1 bg-red-600 rounded" onClick={()=>deleteAgent(a.username)}>Delete</button>
                </div>
              ))}
              {agents.length === 0 && (
                <div className="text-sm text-gray-400">No agents yet.</div>
              )}
            </div>
          </div>
        </div>
        )}

        {tab === 'agents' && (
        <div className="mt-4 border-t border-gray-800 pt-3">
          <h3 className="font-medium mb-1">Shared Inbox Link</h3>
          <div className="flex gap-2 items-center">
            <input className="flex-1 p-2 bg-gray-800 rounded" readOnly value={inboxLink} />
            <button className="px-3 py-2 bg-gray-700 rounded" onClick={() => navigator.clipboard.writeText(inboxLink)}>Copy</button>
          </div>
          <p className="text-xs text-gray-400 mt-1">Share this link with your agents to access the inbox. Use the filters to view per-agent tabs.</p>
        </div>
        )}

        {tab === 'tags' && (
        <div className="mt-4 border-t border-gray-800 pt-3">
          <h3 className="font-medium mb-2">Tag Options (icon + label)</h3>
          <div className="space-y-2">
            {tagOptions.map((opt, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <input
                  className="w-24 p-2 bg-gray-800 rounded"
                  placeholder="icon (emoji)"
                  value={opt.icon || ''}
                  onChange={(e) => updateTagOption(idx, 'icon', e.target.value)}
                />
                <input
                  className="flex-1 p-2 bg-gray-800 rounded"
                  placeholder="label (e.g. Urgent)"
                  value={opt.label || ''}
                  onChange={(e) => updateTagOption(idx, 'label', e.target.value)}
                />
                <button className="px-2 py-2 bg-red-600 rounded" onClick={() => removeTagOption(idx)}>Delete</button>
              </div>
            ))}
            {tagOptions.length === 0 && (
              <div className="text-sm text-gray-400">No tag options yet. Add some below.</div>
            )}
            <div className="flex items-center gap-2">
              <button className="px-3 py-2 bg-gray-700 rounded" onClick={addTagOption}>+ Add tag</button>
              <button disabled={savingTags} className="px-3 py-2 bg-blue-600 rounded disabled:opacity-50" onClick={saveTagOptions}>{savingTags ? 'Saving…' : 'Save tags'}</button>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-1">These options appear in the chat list filters and when editing conversation tags.</p>
        </div>
        )}

        {tab === 'analytics' && (
          <div className="mt-2">
            <React.Suspense fallback={<div className="p-3 text-sm text-gray-300">Loading analytics…</div>}>
              <AnalyticsPanel />
            </React.Suspense>
          </div>
        )}
      </div>
    </div>
  );
}


