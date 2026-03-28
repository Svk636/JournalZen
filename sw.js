// ═══════════════════════════════════════════════════════════════
//  ZEN JOURNAL — Service Worker  (sw.js)
//
//  Strategy overview:
//    • App shell (HTML + icons)  → Cache-first, revalidate in background
//    • Static assets (cdnjs)    → Cache-first, long TTL
//    • Supabase REST / Auth      → Network-only (never cache)
//    • AI API endpoints          → Network-only (never cache keys/responses)
//    • Everything else           → Network-first, fall back to cache
//
//  Background Sync:
//    • Tag: 'zj-sync-entries'
//    • Fires SW_SYNC_TRIGGER message to active client — the app calls
//      SB.flush() using its own in-memory token (SW has no localStorage).
//
//  Update flow:
//    • New SW installs alongside old (waiting state)
//    • App detects reg.waiting → shows update toast
//    • User clicks "Update" → postMessage SKIP_WAITING → controllerchange → reload
// ═══════════════════════════════════════════════════════════════

const CACHE_VERSION = 'zj-v1';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const ALL_CACHES    = [SHELL_CACHE, STATIC_CACHE];

// ── App shell assets — precached on install ─────────────────────
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.ico',
  './icons/icon-32.png',
  './icons/icon-16.png',
  './icons/icon-144.png',
];

// ── External static hosts worth caching ────────────────────────
const STATIC_ORIGINS = [
  'https://cdnjs.cloudflare.com',
];

// ── Always go to network — no caching ever ─────────────────────
const NETWORK_ONLY_PATTERNS = [
  /supabase\.co/,
  /generativelanguage\.googleapis\.com/,
  /api\.openai\.com/,
  /api\.anthropic\.com/,
  /api\.groq\.com/,
];


// ═══════════════════════════════════════════════════════════════
//  INSTALL
// ═══════════════════════════════════════════════════════════════

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => {
        // Partial precache failure is OK in dev (missing icons etc.)
        console.warn('[SW] Precache partial failure:', err.message);
        return self.skipWaiting();
      })
  );
});


// ═══════════════════════════════════════════════════════════════
//  ACTIVATE — purge old caches, claim clients
// ═══════════════════════════════════════════════════════════════

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !ALL_CACHES.includes(k))
          .map(k => {
            console.log('[SW] Deleting stale cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => self.clients.claim())
  );
});


// ═══════════════════════════════════════════════════════════════
//  FETCH — request routing
// ═══════════════════════════════════════════════════════════════

self.addEventListener('fetch', event => {
  const { request } = event;

  // Ignore non-GET and non-http(s) (e.g. chrome-extension://)
  if (request.method !== 'GET') return;
  if (!request.url.startsWith('http')) return;

  const url = new URL(request.url);

  // ── 1. Network-only: Supabase + all AI API calls ──────────────
  if (NETWORK_ONLY_PATTERNS.some(p => p.test(request.url))) {
    // Let the browser handle it — no event.respondWith means passthrough
    return;
  }

  // ── 2. Cache-first: external static (cdnjs) ───────────────────
  if (STATIC_ORIGINS.some(o => request.url.startsWith(o))) {
    event.respondWith(cacheFirstStatic(request));
    return;
  }

  // ── 3. Cache-first + background revalidate: app shell ─────────
  if (url.origin === self.location.origin) {
    event.respondWith(shellCacheFirst(request));
    return;
  }

  // ── 4. Network-first fallback ─────────────────────────────────
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});


// ── Strategy: cache-first for external static assets ───────────
async function cacheFirstStatic(request) {
  const cache  = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// ── Strategy: serve shell from cache, revalidate in background ─
async function shellCacheFirst(request) {
  const cache  = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);

  // Revalidate in background regardless
  const fetchPromise = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || await fetchPromise;
}


// ═══════════════════════════════════════════════════════════════
//  BACKGROUND SYNC — 'zj-sync-entries'
//
//  SW cannot read localStorage (tokens live there), so it messages
//  the active client to trigger flush from the app side.
// ═══════════════════════════════════════════════════════════════

self.addEventListener('sync', event => {
  if (event.tag === 'zj-sync-entries') {
    event.waitUntil(notifyClientToSync());
  }
});

async function notifyClientToSync() {
  const allClients = await self.clients.matchAll({
    type:               'window',
    includeUncontrolled: false,
  });

  if (!allClients.length) return; // browser will retry

  // Prefer the focused window; fall back to first
  const target = allClients.find(c => c.focused) || allClients[0];
  target.postMessage({ type: 'SW_SYNC_TRIGGER' });
}


// ═══════════════════════════════════════════════════════════════
//  MESSAGE — SKIP_WAITING (from app update toast)
// ═══════════════════════════════════════════════════════════════

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
