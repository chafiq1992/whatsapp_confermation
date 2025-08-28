import React, { useEffect, useState } from 'react';
import api from './api';

export default function AdminDashboard({ onClose }) {
  const [agents, setAgents] = useState([]);
  const [form, setForm] = useState({ username: '', name: '', password: '', is_admin: false });
  const [loading, setLoading] = useState(false);

  const loadAgents = async () => {
    try {
      const res = await api.get('/admin/agents');
      setAgents(res.data || []);
    } catch (e) {}
  };

  useEffect(() => { loadAgents(); }, []);

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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="w-[720px] max-w-[90vw] bg-gray-900 border border-gray-700 rounded-lg p-4" onClick={(e)=>e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Admin Dashboard</h2>
          <button className="px-2 py-1 bg-gray-700 rounded" onClick={onClose}>✕</button>
        </div>

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

        <div className="mt-4 border-t border-gray-800 pt-3">
          <h3 className="font-medium mb-1">Shared Inbox Link</h3>
          <div className="flex gap-2 items-center">
            <input className="flex-1 p-2 bg-gray-800 rounded" readOnly value={inboxLink} />
            <button className="px-3 py-2 bg-gray-700 rounded" onClick={() => navigator.clipboard.writeText(inboxLink)}>Copy</button>
          </div>
          <p className="text-xs text-gray-400 mt-1">Share this link with your agents to access the inbox. Use the filters to view per-agent tabs.</p>
        </div>
      </div>
    </div>
  );
}


