const CACHE_NAME = 'curve-runner-v5';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.png',
  './favicon.png'
];

// URLs that are safe to cache (GET requests for static assets / tiles only)
function shouldCache(url) {
  if (url.includes('tile.openstreetmap.org')) return true; // map tiles
  if (url.includes('unpkg.com')) return true; // MapLibre, Firebase SDKs
  if (url.includes('gstatic.com')) return true; // Google assets (Firebase)
  if (url.includes('openstreetmap.org') && url.endsWith('.png')) return true; // tile images
  return false;
}

// API endpoints that should NOT be cached (POST/CORS sensitive)
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
  const isGet = e.request.method === 'GET';

  // --- API calls (POST, CORS) — never cache, just fetch ---
  if (isApiEndpoint(url)) {
    e.respondWith(
      fetch(e.request).catch(() => {
        return new Response(JSON.stringify({ error: 'Offline — no network connection' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // --- Static assets / tiles — cache-first with network fallback ---
  if (isGet && shouldCache(url)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          return response;
        }).catch(() => {
          return cached; // already null if we got here, but safe fallback
        });
      })
    );
    return;
  }

  // --- App shell / navigation — network-first with cache fallback ---
  e.respondWith(
    fetch(e.request).then(response => {
      return response;
    }).catch(() => {
      return caches.match(e.request).then(cached => {
        return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      });
    })
  );
});
