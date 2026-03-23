// ═══════════════════════════════════════════════════════
//  Zen Journal — Service Worker
//  Strategy:
//    • App shell (HTML/icons/manifest)    → Cache-first, network-fallback
//    • Google Fonts CSS                   → Stale-while-revalidate
//    • Google Fonts files (.woff2)        → Cache-first (immutable by URL)
//    • Supabase API calls                 → Network-only (never cache auth/data)
//    • Background Sync tag               → 'zj-sync-entries'
// ═══════════════════════════════════════════════════════

const CACHE_NAME    = 'zj-shell-v1';
const OFFLINE_URL   = './index.html';

// Files that make up the app shell
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  // Icons — all sizes for every device
  './icons/favicon.ico',
  './icons/icon-16.png',
  './icons/icon-32.png',
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

// ── INSTALL — cache the app shell ──────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        SHELL_ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn('[SW] Failed to cache:', url, err)
          )
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE — clear old caches ────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// ── FETCH — routing ────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Never intercept non-GET
  if (req.method !== 'GET') return;

  // 2. Never intercept Supabase — network-only (auth tokens must never be cached)
  if (url.hostname.endsWith('supabase.co')) return;

  // 3. Google Fonts CSS — stale-while-revalidate
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 4. Google Fonts files — cache-first (woff2 URLs are content-addressed, immutable)
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 5. CDN resources (jsPDF etc.) — cache-first
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(cacheFirst(req));
    return;
  }

  // 6. Same-origin — cache-first for app shell, network-fallback for everything else
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(response => {
          if (response && response.status === 200 && response.type === 'basic') {
            const toCache = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, toCache));
          }
          return response;
        }).catch(() => {
          // Offline and not cached
          if (req.mode === 'navigate') return caches.match(OFFLINE_URL);
          return new Response('', { status: 503, statusText: 'Offline' });
        });
      })
    );
    return;
  }

  // 7. Everything else — network only
  // (cross-origin requests not already handled above pass through)
});

// ── Helpers ────────────────────────────────────────────

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(req) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const fresh  = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || await fresh;
}

// ── BACKGROUND SYNC ─────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'zj-sync-entries') {
    event.waitUntil(notifyClients('SW_SYNC_TRIGGER'));
  }
});

// ── MESSAGE ─────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── HELPER: broadcast to all controlled + uncontrolled windows ──
async function notifyClients(type) {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true   // include pages not yet controlled by this SW
  });
  clients.forEach(client => client.postMessage({ type }));
}
