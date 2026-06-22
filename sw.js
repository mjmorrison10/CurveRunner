const CACHE_NAME = 'curve-runner-v8';
const APP_ASSETS = [
  './',
  './index.html',
  './style.min.css',
  './app.min.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-64.png'
];

// Hosts whose responses are cacheable (CDN libraries + map tiles).
function isCacheableAsset(url) {
  return url.includes('unpkg.com') ||
         url.includes('gstatic.com') ||
         url.includes('tile.openstreetmap.org') ||
         url.includes('.png') ||
         url.includes('.jpg') ||
         url.includes('.css') ||
         url.includes('.js');
}

// API endpoints that should NEVER be touched by the service worker
function isApiEndpoint(url) {
  return url.includes('valhalla1.openstreetmap.de') ||
         url.includes('nominatim.openstreetmap.org') ||
         url.includes('api.open-meteo.com') ||
         url.includes('ntfy.sh') ||
         url.includes('overpass-api.de');
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    // addAll is all-or-nothing; cache each asset individually so one failure
    // (e.g. an icon) doesn't break the whole install.
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(APP_ASSETS.map(url =>
        cache.add(url).catch(err => console.warn('SW precache miss:', url, err.message))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // API calls (POST, CORS-sensitive) — pass through completely, do not intercept
  if (isApiEndpoint(url)) {
    return;
  }

  // Non-GET (e.g. file uploads) — leave to the browser
  if (e.request.method !== 'GET') {
    return;
  }

  // HTML navigations: network-first so users get fresh content fast, with cache fallback
  // when offline. Uses navigation preload when available.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      (async () => {
        const preload = e.preloadResponse;
        try {
          const netResp = preload || (await fetch(e.request));
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', netResp.clone()).catch(() => {});
          return netResp;
        } catch (err) {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match('./index.html')) || (await cache.match(e.request)) || Response.error();
        }
      })()
    );
    return;
  }

  // Static assets / tiles / CDN libs: cache-first, then network (and populate cache)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok && isCacheableAsset(url)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone)).catch(() => {});
        }
        return response;
      }).catch(() => cached);
    })
  );
});
