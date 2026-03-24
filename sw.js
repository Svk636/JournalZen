// ═══════════════════════════════════════════════════════
//  ZEN JOURNAL — SERVICE WORKER
//  Cache-first for shell, network-first for API
// ═══════════════════════════════════════════════════════

const CACHE_NAME    = 'zen-journal-v1';
const FONT_CACHE    = 'zen-journal-fonts-v1';

// App shell — all files that need to work offline
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.ico',
];

// ── INSTALL: cache app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => {
        // If some icons are missing, don't block install — cache what we can
        console.warn('[SW] Shell cache partial:', err.message);
        return caches.open(CACHE_NAME)
          .then(cache => cache.add('./index.html'));
      })
  );
});

// ── ACTIVATE: purge old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== FONT_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: routing strategy ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Supabase API — network only, never cache
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(fetch(request).catch(() =>
      new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      })
    ));
    return;
  }

  // 2. Google Fonts CSS — stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const fetched = fetch(request).then(res => {
            cache.put(request, res.clone());
            return res;
          });
          return cached || fetched;
        })
      )
    );
    return;
  }

  // 3. Google Fonts files — cache first (fonts don't change)
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(res => {
            cache.put(request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // 4. App shell / local assets — cache first, fallback to network
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(res => {
          // Cache successful GET responses
          if (res.ok && request.method === 'GET') {
            caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
          }
          return res;
        }).catch(() => {
          // Offline fallback — serve index.html for navigation requests
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
    );
    return;
  }

  // 5. Everything else — network with cache fallback
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ── BACKGROUND SYNC: flush queued entries when back online ──
self.addEventListener('sync', event => {
  if (event.tag === 'zj-sync-entries') {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client =>
          client.postMessage({ type: 'SW_SYNC_TRIGGER' })
        );
      })
    );
  }
});

// ── SKIP WAITING: instant update when user clicks "Update" ──
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
