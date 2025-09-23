import React, { useEffect, useMemo, useState } from 'react';
import api from './api';

function toIsoStart(date) {
  try {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0)).toISOString();
  } catch { return null; }
}

function toIsoEnd(date) {
  try {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59)).toISOString();
  } catch { return null; }
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
  }
  return `${m}m ${ss}s`;
}

export default function AnalyticsPanel() {
  const [agents, setAgents] = useState([]);
  const [stats, setStats] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('30d'); // today | 7d | 30d | 90d | custom
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/admin/agents');
        setAgents(Array.isArray(res.data) ? res.data : []);
      } catch {}
    })();
  }, []);

  const computeRange = () => {
    const now = new Date();
    const end = now.toISOString();
    if (period === 'today') {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
      return { start, end };
    }
    if (period === '7d' || period === '30d' || period === '90d') {
      const days = period === '7d' ? 7 : (period === '30d' ? 30 : 90);
      const start = new Date(now.getTime() - days * 864e5).toISOString();
      return { start, end };
    }
    if (period === 'custom' && customStart && customEnd) {
      const s = toIsoStart(customStart);
      const e = toIsoEnd(customEnd);
      if (s && e) return { start: s, end: e };
    }
    // default 30d
    return { start: new Date(now.getTime() - 30 * 864e5).toISOString(), end };
  };

  const fetchStats = async () => {
    setLoading(true);
    setError('');
    try {
      const { start, end } = computeRange();
      const qs = new URLSearchParams({ start, end }).toString();
      const res = await api.get(`/analytics/agents?${qs}`);
      setStats(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setError('Failed to load analytics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  const totals = useMemo(() => {
    const totalMessages = stats.reduce((s, x) => s + (Number(x.messages_sent || 0) || 0), 0);
    const totalOrders = stats.reduce((s, x) => s + (Number(x.orders_created || 0) || 0), 0);
    const totalAgents = agents.length;
    return { totalMessages, totalOrders, totalAgents };
  }, [stats, agents]);

  const nameOf = (username) => {
    const a = agents.find((x) => x.username === username);
    return a?.name || username;
  };

  const maxMsgs = Math.max(1, ...stats.map((x) => Number(x.messages_sent || 0)));
  const maxOrders = Math.max(1, ...stats.map((x) => Number(x.orders_created || 0)));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-lg font-semibold">Analytics</div>
        <div className="flex items-center gap-2">
          {['today','7d','30d','90d','custom'].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 rounded ${period===p ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`}
            >{p.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {period === 'custom' && (
        <div className="flex items-end gap-2">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Start date</label>
            <input type="date" value={customStart} onChange={(e)=>setCustomStart(e.target.value)} className="p-2 bg-gray-800 rounded" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">End date</label>
            <input type="date" value={customEnd} onChange={(e)=>setCustomEnd(e.target.value)} className="p-2 bg-gray-800 rounded" />
          </div>
          <button className="px-3 py-2 bg-blue-600 rounded" onClick={fetchStats}>Apply</button>
        </div>
      )}

      {error && <div className="text-red-400 text-sm">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-gray-800 rounded p-4 border border-gray-700">
          <div className="text-sm text-gray-400">Total messages</div>
          <div className="text-2xl font-bold">{totals.totalMessages}</div>
        </div>
        <div className="bg-gray-800 rounded p-4 border border-gray-700">
          <div className="text-sm text-gray-400">Total orders</div>
          <div className="text-2xl font-bold">{totals.totalOrders}</div>
        </div>
        <div className="bg-gray-800 rounded p-4 border border-gray-700">
          <div className="text-sm text-gray-400">Total agents</div>
          <div className="text-2xl font-bold">{totals.totalAgents}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-gray-800 rounded p-4 border border-gray-700">
          <div className="font-medium mb-2">Messages by agent</div>
          <div className="space-y-2">
            {stats.map((s) => (
              <div key={s.agent} className="flex items-center gap-2">
                <div className="w-32 text-sm text-gray-300 truncate" title={nameOf(s.agent)}>{nameOf(s.agent)}</div>
                <div className="flex-1 h-4 bg-gray-900 rounded overflow-hidden">
                  <div className="h-4 bg-blue-600" style={{ width: `${Math.round((Number(s.messages_sent||0)/maxMsgs)*100)}%` }}></div>
                </div>
                <div className="w-12 text-right text-sm">{s.messages_sent || 0}</div>
              </div>
            ))}
            {stats.length === 0 && <div className="text-sm text-gray-400">No data</div>}
          </div>
        </div>
        <div className="bg-gray-800 rounded p-4 border border-gray-700">
          <div className="font-medium mb-2">Orders by agent</div>
          <div className="space-y-2">
            {stats.map((s) => (
              <div key={s.agent} className="flex items-center gap-2">
                <div className="w-32 text-sm text-gray-300 truncate" title={nameOf(s.agent)}>{nameOf(s.agent)}</div>
                <div className="flex-1 h-4 bg-gray-900 rounded overflow-hidden">
                  <div className="h-4 bg-emerald-600" style={{ width: `${Math.round((Number(s.orders_created||0)/maxOrders)*100)}%` }}></div>
                </div>
                <div className="w-12 text-right text-sm">{s.orders_created || 0}</div>
              </div>
            ))}
            {stats.length === 0 && <div className="text-sm text-gray-400">No data</div>}
          </div>
        </div>
      </div>

      <div className="bg-gray-800 rounded p-4 border border-gray-700">
        <div className="font-medium mb-2">Per-agent details</div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left">
                <th className="py-1 pr-2">Agent</th>
                <th className="py-1 pr-2">Replies</th>
                <th className="py-1 pr-2">Orders</th>
                <th className="py-1 pr-2">Avg reply time</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.agent} className="border-t border-gray-700">
                  <td className="py-1 pr-2">{nameOf(s.agent)}</td>
                  <td className="py-1 pr-2">{s.messages_sent || 0}</td>
                  <td className="py-1 pr-2">{s.orders_created || 0}</td>
                  <td className="py-1 pr-2">{formatDuration(s.avg_response_seconds)}</td>
                </tr>
              ))}
              {stats.length === 0 && (
                <tr><td colSpan={4} className="py-2 text-gray-400">No data</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


