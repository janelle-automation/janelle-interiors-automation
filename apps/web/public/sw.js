const CACHE = 'janelle-shell-v2';
// Two installable apps, two cold-start URLs. Both resolve to the same
// index.html through the SPA rewrite, so caching the pair costs one extra
// entry and lets Jenny open offline at her own address instead of the
// studio's dashboard.
const SHELL = ['/', '/jenny-assistant'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first: always try the network, fall back to cache for navigation.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Only cache same-origin requests; skip API calls.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && e.request.mode === 'navigate') {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(
          (r) => r || caches.match(url.pathname.startsWith('/jenny-assistant') ? '/jenny-assistant' : '/')
        )
      )
  );
});
