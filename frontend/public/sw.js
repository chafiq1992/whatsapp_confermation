const CACHE_VERSION = 'v4';
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

  // Skip non-GET, Range requests, or API-like endpoints entirely
  if (req.method !== 'GET') return;
  if (hasRange) return;
  // Skip non-http(s) schemes (e.g., chrome-extension:, blob:)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (
    path.startsWith('/api') ||
    path.startsWith('/ws') ||
    path.startsWith('/media/proxy') ||
    path.startsWith('/proxy-audio') ||
    path.startsWith('/proxy-media') ||
    path.startsWith('/link-preview')
  ) return;

  // Cache-first for image proxy endpoint to enable fast thumbnail loads and offline viewing
  if (path.startsWith('/proxy-image')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
          return res;
        });
      })
    );
    return;
  }

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

// Background precache of thumbnails, with concurrency limits to avoid network saturation
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'PRECACHE_THUMBS' && Array.isArray(data.urls)) {
    const urls = Array.from(new Set(data.urls.filter(Boolean)));
    const CONCURRENCY = 6;
    event.waitUntil((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      let idx = 0;
      const runNext = async () => {
        const i = idx++;
        if (i >= urls.length) return;
        const u = urls[i];
        try {
          const match = await cache.match(u);
          if (!match) {
            const res = await fetch(u, { cache: 'no-store' });
            if (res && res.ok) {
              await cache.put(u, res.clone());
            }
          }
        } catch {}
        return runNext();
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, runNext));
    })());
  }
});


