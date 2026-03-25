/**
 * Zen Journal — Service Worker
 * Strategy:
 *   - App shell (HTML, icons):  Cache-first, stale-while-revalidate on update
 *   - jsPDF from CDN:           Cache-first (immutable versioned URL)
 *   - Supabase API calls:       Network-only (never cache auth / user data)
 *   - Everything else:          Network-first with cache fallback
 *
 * Update flow:
 *   1. New SW installs silently, waits (does NOT skipWaiting automatically)
 *   2. App detects reg.waiting, shows toast "New version available"
 *   3. User taps "Update" → app posts SKIP_WAITING → SW takes control → reload
 *
 * Background Sync:
 *   Listens for 'zj-sync-entries' sync event and pings the app to flush queue.
 */

'use strict';

// ── Cache names ──────────────────────────────────────────────────────────────
// Bump SHELL_VERSION to force-evict old shell cache on next SW activation.
const SHELL_VERSION  = 'v5';
const CDN_CACHE      = 'zj-cdn-v1';       // CDN assets — immutable, never bust
const SHELL_CACHE    = `zj-shell-${SHELL_VERSION}`;
const RUNTIME_CACHE  = 'zj-runtime-v1';   // runtime network-first fallback

// ── App shell files to precache ──────────────────────────────────────────────
// These are fetched & cached during `install` so the app works fully offline.
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './ic.js',
  './manifest.json',
  './icons/favicon.ico',
  './icons/icon-16.png',
  './icons/icon-32.png',
  './icons/icon-144.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// ── CDN assets to cache on first use ────────────────────────────────────────
const CDN_ORIGINS = [
  'cdnjs.cloudflare.com',
];

// ── Never-cache origins ──────────────────────────────────────────────────────
// Auth tokens, user data and sync calls must always go to the network.
const BYPASS_ORIGINS = [
  'supabase.co',
];

// ════════════════════════════════════════════════════════════════════════════
//  INSTALL — precache shell
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => {
        // Use individual add() calls so one 404 doesn't abort the whole install.
        // Icons may not exist in dev — skip gracefully.
        return Promise.allSettled(
          SHELL_FILES.map(url =>
            cache.add(url).catch(err => {
              console.warn(`[SW] Precache failed for ${url}:`, err.message);
            })
          )
        );
      })
      .then(() => {
        // Do NOT call skipWaiting() here — let the user control the update.
        console.log('[SW] Install complete, waiting for activation signal.');
      })
  );
});

// ════════════════════════════════════════════════════════════════════════════
//  ACTIVATE — evict stale shell caches
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  const VALID_CACHES = new Set([SHELL_CACHE, CDN_CACHE, RUNTIME_CACHE]);

  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => !VALID_CACHES.has(k))
            .map(k => {
              console.log('[SW] Deleting stale cache:', k);
              return caches.delete(k);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ════════════════════════════════════════════════════════════════════════════
//  FETCH — routing strategy
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET (let POST/PUT/DELETE pass through untouched)
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // ── 1. Bypass: Supabase or other auth/API origins ──
  if (BYPASS_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(fetch(request));
    return;
  }

  // ── 2. CDN assets: cache-first (treat as immutable) ──
  if (CDN_ORIGINS.some(o => url.hostname.includes(o))) {
    event.respondWith(_cdnFirst(request));
    return;
  }

  // ── 3. App shell navigation (HTML pages, same origin) ──
  if (request.mode === 'navigate') {
    event.respondWith(_shellFirst(request));
    return;
  }

  // ── 4. Same-origin assets: cache-first (shell) ──
  if (url.origin === self.location.origin) {
    event.respondWith(_shellFirst(request));
    return;
  }

  // ── 5. Everything else: network-first with runtime cache fallback ──
  event.respondWith(_networkFirst(request));
});

// ── Cache-first for CDN (immutable) ──────────────────────────────────────────
async function _cdnFirst(request) {
  const cached = await caches.match(request, { cacheName: CDN_CACHE });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CDN_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    return new Response('CDN resource unavailable offline.', { status: 503 });
  }
}

// ── Cache-first for shell, stale-while-revalidate ────────────────────────────
async function _shellFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    // Kick off background revalidation (don't await)
    _revalidate(request);
    return cached;
  }
  // Not in cache — fetch from network and cache it
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    // Offline fallback: serve index.html for navigations
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html') ||
                       await caches.match('./');
      if (fallback) return fallback;
    }
    return new Response('App is offline and this resource is not cached.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// ── Network-first with runtime cache fallback ─────────────────────────────────
async function _networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Network error and no cached version available.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// ── Background revalidation helper ───────────────────────────────────────────
async function _revalidate(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response);
    }
  } catch (_) {
    // Offline during revalidation — silently ignore
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  MESSAGE — SKIP_WAITING (triggered by user tapping "Update" in the app)
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    console.log('[SW] SKIP_WAITING received — activating new SW.');
    self.skipWaiting();
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  BACKGROUND SYNC — 'zj-sync-entries'
//  Tells the app to flush its Supabase queue when connectivity is restored.
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === 'zj-sync-entries') {
    event.waitUntil(_triggerAppSync());
  }
});

async function _triggerAppSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
  clients.forEach(client => {
    client.postMessage({ type: 'SW_SYNC_TRIGGER' });
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS (stub — wire up if you add push later)
// ════════════════════════════════════════════════════════════════════════════
self.addEventListener('push', event => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch (_) { payload = { title: 'Zen Journal', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Zen Journal', {
      body:    payload.body    || '',
      icon:    './icons/icon-192.png',
      badge:   './icons/icon-32.png',
      tag:     'zj-push',
      renotify: false,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin) && 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow('./');
    })
  );
});
