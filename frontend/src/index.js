import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import StudioPage from './StudioPage';

const root = ReactDOM.createRoot(document.getElementById('root'));
const hash = window.location.hash || '';
const path = window.location.pathname || '';
const isStudio = (hash && hash.includes('/automation-studio')) || path === '/automation-studio' || path.startsWith('/automation-studio/');

root.render(
  isStudio ? <StudioPage /> : <App />
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals

// Register service worker for asset caching (production-safe)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      navigator.serviceWorker.register('/sw.js');
    } catch {}
  });
}

// Apply document direction from localStorage or ?rtl=1
try {
  const params = new URLSearchParams(window.location.search);
  const rtlParam = params.get('rtl');
  const storedDir = localStorage.getItem('dir');
  const dir = (rtlParam === '1' || rtlParam === 'true') ? 'rtl' : (storedDir || document.documentElement.getAttribute('dir') || 'ltr');
  document.documentElement.setAttribute('dir', dir);
} catch {}