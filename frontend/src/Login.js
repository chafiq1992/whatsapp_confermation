import React, { useState } from 'react';
import api from './api';

export default function Login({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!username || !password) {
      setError('Please enter username and password');
      return;
    }
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { username, password });
      const token = res?.data?.token;
      const user = res?.data?.username || username;
      const isAdmin = !!res?.data?.is_admin;
      try {
        if (token) localStorage.setItem('agent_token', token);
        if (user) localStorage.setItem('agent_username', user);
        localStorage.setItem('agent_is_admin', isAdmin ? '1' : '0');
      } catch {}
      if (typeof onSuccess === 'function') onSuccess(user, token, isAdmin);
    } catch (e) {
      setError('Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gray-900 text-white">
      <form onSubmit={handleSubmit} className="bg-gray-800 border border-gray-700 rounded-xl p-6 w-full max-w-sm space-y-4">
        <div className="text-xl font-semibold">Agent Login</div>
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <div>
          <label className="block text-sm text-gray-300 mb-1">Username</label>
          <input
            className="w-full p-2 rounded bg-gray-900 border border-gray-700 text-white"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </div>
        <div>
          <label className="block text-sm text-gray-300 mb-1">Password</label>
          <input
            type="password"
            className="w-full p-2 rounded bg-gray-900 border border-gray-700 text-white"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button
          type="submit"
          className={`w-full py-2 rounded bg-indigo-600 hover:bg-indigo-500 transition ${loading ? 'opacity-70 cursor-not-allowed' : ''}`}
          disabled={loading}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}


