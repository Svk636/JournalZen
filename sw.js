// sw.js — Zen Journal Service Worker
// Strategy: cache-first for app shell; network-first for Supabase API calls.
// Background sync tag: 'zj-sync-entries'

const CACHE_NAME    = 'zj-v1';
const SHELL_ASSETS  = [
  './',
  './index.html',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())   // take control immediately
  );
});

// ── Activate: delete stale caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())  // take control of all open tabs
  );
});

// ── Fetch: cache-first for same-origin, network-only for Supabase ─────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Always bypass the cache for Supabase API calls — fresh data only
  if (url.hostname.endsWith('.supabase.co')) return;

  // For everything else (app shell, icons, scripts):
  // Try cache first, fall back to network, cache new responses
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        // Only cache successful same-origin GET responses
        if (
          response.ok &&
          request.method === 'GET' &&
          url.origin === self.location.origin
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Offline fallback for navigation requests — serve the app shell
      if (request.mode === 'navigate') {
        return caches.match('./') || caches.match('./index.html');
      }
    })
  );
});

// ── Background Sync: flush queued entries when back online ────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'zj-sync-entries') {
    event.waitUntil(notifyClientsToSync());
  }
});

// Tell the open app tab to flush its queue now
async function notifyClientsToSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: 'SW_SYNC_TRIGGER' });
  }
}

// ── Message handler: SKIP_WAITING from app (update flow) ─────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
