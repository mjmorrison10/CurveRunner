const CACHE_NAME = 'curve-runner-v6';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.png',
  './favicon.png'
];

// API endpoints that should NEVER be touched by the service worker
function isApiEndpoint(url) {
  return url.includes('valhalla1.openstreetmap.de') ||
         url.includes('nominatim.openstreetmap.org') ||
         url.includes('api.open-meteo.com') ||
         url.includes('ntfy.sh');
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;

  // --- API calls (POST, CORS-sensitive) — pass through completely, do not intercept ---
  if (isApiEndpoint(url)) {
    return; // Let browser handle it natively
  }

  // --- Tile requests and static assets — cache-first with network fallback ---
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // Only cache GET requests for tiles and CDN assets
        if (e.request.method === 'GET' && response.ok) {
          const isTile = url.includes('tile.openstreetmap.org') || url.includes('.png') || url.includes('.jpg');
          const isCDN = url.includes('unpkg.com') || url.includes('gstatic.com');
          if (isTile || isCDN) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
        }
        return response;
      }).catch(() => {
        return cached;
      });
    })
  );
});
