/**
 * Zen Journal — Service Worker
 * Strategy: Cache-first for app shell, network-first for Supabase API,
 * stale-while-revalidate for Google Fonts.
 *
 * Cache versioning: bump CACHE_VERSION on every deploy to force refresh.
 */

const CACHE_VERSION  = 'zj-v1';
const STATIC_CACHE   = `${CACHE_VERSION}-static`;
const FONT_CACHE     = `${CACHE_VERSION}-fonts`;
const DYNAMIC_CACHE  = `${CACHE_VERSION}-dynamic`;

// All files that form the app shell — cached on install
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-72.png',
  './icons/icon-96.png',
  './icons/icon-128.png',
  './icons/icon-144.png',
  './icons/icon-152.png',
  './icons/icon-192.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Supabase origin — always network-first, never cache auth tokens
const SUPABASE_ORIGIN = self.location.hostname !== 'localhost'
  ? null  // resolved at runtime from SUPABASE_URL constant in page
  : null;

// ── Install: pre-cache static shell ──────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())   // activate immediately
      .catch(err => console.warn('[SW] install cache failed:', err))
  );
});

// ── Activate: delete old caches ──────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('zj-') && !k.startsWith(CACHE_VERSION))
          .map(k => {
            console.log('[SW] deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())  // take control of all tabs immediately
  );
});

// ── Fetch: routing logic ──────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Skip non-GET requests entirely (POST/PUT/DELETE go straight to network)
  if (req.method !== 'GET') return;

  // 2. Skip chrome-extension and dev-tools requests
  if (!url.protocol.startsWith('http')) return;

  // 3. Supabase API — network-only (never cache auth/data calls)
  if (url.hostname.endsWith('supabase.co')) {
    event.respondWith(networkOnly(req));
    return;
  }

  // 4. Google Fonts CSS — stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }

  // 5. Google Fonts files (woff2) — cache-first, very long-lived
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // 6. CDN (jsPDF etc.) — cache-first
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(cacheFirst(req, DYNAMIC_CACHE));
    return;
  }

  // 7. App shell & static assets — cache-first with network fallback
  if (STATIC_ASSETS.some(a => url.pathname.endsWith(a.replace('./', '/')))) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // 8. Navigation requests (HTML) — network-first, fall back to index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then(c => c.put(req, clone));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 9. Everything else — network-first, cache on success
  event.respondWith(networkFirst(req, DYNAMIC_CACHE));
});

// ── Background sync: flush queued entries when online ────────
self.addEventListener('sync', event => {
  if (event.tag === 'zj-sync-entries') {
    // Notify all open clients to flush their queue
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clients => {
          clients.forEach(client => {
            client.postMessage({ type: 'SW_SYNC_TRIGGER' });
          });
        })
    );
  }
});

// ── Push notifications (future-ready stub) ───────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Zen Journal', {
      body:    data.body    || 'Your intention session is ready.',
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-72.png',
      tag:     'zj-notification',
      renotify: false,
      data:    data.url || './',
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url && c.focus);
      if (existing) return existing.focus();
      return self.clients.openWindow(event.notification.data || './');
    })
  );
});

// ── Message handler ──────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_VERSION });
  }
});

// ════════════════════════════════════════════════════════════
//  STRATEGY HELPERS
// ════════════════════════════════════════════════════════════

/** Always go to network. No caching. */
async function networkOnly(req) {
  try {
    return await fetch(req);
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Offline', message: err.message }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/** Cache first, network fallback, cache miss updates cache. */
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    return new Response('Offline and not cached', { status: 503 });
  }
}

/** Network first, fall back to cache. Updates cache on network success. */
async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response('Offline and not cached', { status: 503 });
  }
}

/** Return cache immediately, then update cache from network in background. */
async function staleWhileRevalidate(req, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(req);

  const networkPromise = fetch(req)
    .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);

  return cached || await networkPromise;
}
