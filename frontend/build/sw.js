const CACHE_VERSION = 'v1';
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

  // Skip non-GET or cross-origin (except same-origin static) and API calls
  if (req.method !== 'GET') return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/media/proxy')) return;

  // Images and fonts: cache-first
  if (/\/(images?|img|media)\//i.test(url.pathname) || /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|\.ico|\.woff2?|\.ttf)$/i.test(url.pathname)) {
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


