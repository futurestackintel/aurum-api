/* ============================================
   AURUM — Service Worker
   Handles caching for PWA offline support.
============================================ */

const CACHE_NAME = 'aurum-v1';

const STATIC_ASSETS = [
  '/',
  '/app.html',
  '/index.html',
  '/css/tokens.css',
  '/css/base.css',
  '/css/components.css',
  '/css/landing.css',
  '/js/api.js',
  '/js/auth.js',
  '/js/router.js',
  '/js/pages/ledger.js',
  '/js/pages/arena.js',
  '/js/pages/profile.js',
  '/js/pages/leaderboard.js',
  '/js/pages/elite-rooms.js'
];

/* --- Install: cache static assets --- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

/* --- Activate: clear old caches --- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

/* --- Fetch: network first, cache fallback --- */
self.addEventListener('fetch', event => {
  /* Skip non-GET and API requests — always live */
  if (
    event.request.method !== 'GET' ||
    event.request.url.includes('api.tryaurum.store') ||
    event.request.url.includes('clerk')
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, clone);
        });
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});