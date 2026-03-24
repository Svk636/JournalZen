// ═══════════════════════════════════════════════════════
//  ZEN JOURNAL — SERVICE WORKER  v2.0
//  Strategy: Cache-first for app shell, network-first
//  for external CDN assets, background sync for entries.
// ═══════════════════════════════════════════════════════

const CACHE_NAME    = 'zj-shell-v2';
const CDN_CACHE     = 'zj-cdn-v1';
const OFFLINE_PAGE  = './index.html';

// App shell — these files are cached on install and served
// cache-first on every subsequent request.
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  // Icons (cache what exists — missing icons are handled gracefully)
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ── Install: pre-cache app shell ──────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(
        SHELL_ASSETS.map(url => new Request(url, { cache: 'reload' }))
      ))
      .then(() => self.skipWaiting())   // activate new SW immediately
      .catch(err => {
        // Don't let a missing icon abort the whole install
        console.warn('[SW] Install cache error (non-fatal):', err.message);
        return self.skipWaiting();
      })
  );
});

// ── Activate: prune old caches ────────────────────────
self.addEventListener('activate', event => {
  const KEEP = new Set([CACHE_NAME, CDN_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !KEEP.has(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())  // take control of open pages immediately
  );
});

// ── Fetch: routing strategy ───────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Only handle GET — let POST/PUT/DELETE bypass (Supabase API calls)
  if (request.method !== 'GET') return;

  // 2. Chrome extension / non-http — ignore
  if (!url.protocol.startsWith('http')) return;

  // 3. Supabase API — always network, never cache
  if (url.hostname.endsWith('.supabase.co')) return;

  // 4. CDN assets (jsPDF, etc.) — cache-first with network fallback
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(cdnFirst(request));
    return;
  }

  // 5. App shell + same-origin — cache-first, fall back to network,
  //    fall back to cached index.html (offline SPA fallback)
  event.respondWith(shellFirst(request));
});

// Cache-first for app shell
async function shellFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Only cache successful same-origin responses
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline fallback — serve cached index.html for navigation requests
    if (request.mode === 'navigate') {
      const fallback = await caches.match(OFFLINE_PAGE);
      if (fallback) return fallback;
    }
    return new Response('Offline — please reconnect', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// Cache-first for CDN scripts
async function cdnFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CDN_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('CDN resource unavailable offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// ── Background Sync: flush queued entries ─────────────
self.addEventListener('sync', event => {
  if (event.tag === 'zj-sync-entries') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clients => {
          if (clients.length > 0) {
            // Signal the active page to flush its queue
            clients[0].postMessage({ type: 'SW_SYNC_TRIGGER' });
          }
        })
    );
  }
});

// ── Message handling: skip waiting (update flow) ──────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
