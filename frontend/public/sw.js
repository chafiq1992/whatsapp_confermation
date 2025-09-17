const CACHE_VERSION = 'v3';
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;
const STATIC_CACHE = `static-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  '/',
  '/index.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => {
      if (!key.includes(CACHE_VERSION)) return caches.delete(key);
    }))).then(() => self.clients.claim())
  );
});

// Simple routing: cache-first for images/fonts; stale-while-revalidate for others; bypass APIs
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const path = url.pathname;
  const hasRange = !!req.headers.get('range');

  // Skip non-GET, Range requests, or API-like/proxy endpoints entirely
  if (req.method !== 'GET') return;
  if (hasRange) return;
  if (
    path.startsWith('/api') ||
    path.startsWith('/ws') ||
    path.startsWith('/media/proxy') ||
    path.startsWith('/proxy-audio') ||
    path.startsWith('/proxy-image') ||
    path.startsWith('/proxy-media') ||
    path.startsWith('/link-preview')
  ) return;

  // Images and fonts: cache-first
  if (/\/(images?|img|media)\//i.test(path) || /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|\.ico|\.woff2?|\.ttf)$/i.test(path)) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Default: stale-while-revalidate for same-origin GET
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});


