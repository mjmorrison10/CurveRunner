const CACHE_NAME = 'curve-runner-v16';
const APP_SHELL = [
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

const TILE_CACHE_LIMIT = 600; // keep last ~600 tiles to avoid unbounded growth
const ROUTE_TILE_CACHE_LIMIT = 400; // tiles for saved routes

const TILE_HOSTS = ['tile.openstreetmap.org'];
const CDN_HOSTS = ['unpkg.com', 'gstatic.com'];

function isTile(url) {
  return TILE_HOSTS.some(host => url.includes(host));
}

function isCdn(url) {
  return CDN_HOSTS.some(host => url.includes(host));
}

function isApi(url) {
  return url.includes('valhalla1.openstreetmap.de') ||
         url.includes('nominatim.openstreetmap.org') ||
         url.includes('api.open-meteo.com') ||
         url.includes('ntfy.sh') ||
         url.includes('overpass-api.de') ||
         url.includes('router.project-osrm.org');
}

async function trimCache(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > limit) {
    const toDelete = keys.slice(0, keys.length - limit);
    await Promise.all(toDelete.map(req => cache.delete(req)));
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(APP_SHELL.map(url =>
        cache.add(url).catch(err => console.warn('SW precache miss:', url, err.message))
      ))
    ).then(() => self.skipWaiting())
  );
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

  // Never intercept API calls or non-GET requests
  if (e.request.method !== 'GET' || isApi(url)) return;

  // Navigation: network-first with cache fallback
  if (e.request.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          const preload = await e.preloadResponse;
          const netResp = preload || (await fetch(e.request));
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', netResp.clone()).catch(() => {});
          return netResp;
        } catch (err) {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match('./index.html')) ||
                 (await cache.match(e.request)) ||
                 new Response('<!DOCTYPE html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>CurveRunner Offline</title><style>body{background:#1a1a1a;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px}</style></head><body><div><h1>⚠️ Offline</h1><p>CurveRunner can\'t reach the network right now.</p><p>Cached routes and maps may still be available.</p><button onclick="location.reload()" style="padding:14px 24px;border:none;border-radius:10px;background:#ff6b00;color:#fff;font-weight:700;font-size:1rem;cursor:pointer">Retry</button></div></body></html>', { headers: { 'Content-Type': 'text/html' } });
        }
      })()
    );
    return;
  }

  // Tiles: cache-first, limit size
  if (isTile(url)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) {
          // Update cache in background for fresher tiles
          fetch(e.request).then(response => {
            if (response.ok) {
              caches.open(CACHE_NAME).then(cache => cache.put(e.request, response)).catch(() => {});
              trimCache(CACHE_NAME, TILE_CACHE_LIMIT + ROUTE_TILE_CACHE_LIMIT).catch(() => {});
            }
          }).catch(() => {});
          return cached;
        }
        return fetch(e.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(e.request, clone);
              trimCache(cache.name, TILE_CACHE_LIMIT + ROUTE_TILE_CACHE_LIMIT).catch(() => {});
            }).catch(() => {});
          }
          return response;
        }).catch(() => {
          return new Response('', { status: 503, statusText: 'Offline' });
        });
      })
    );
    return;
  }

  // CDN assets: cache-first with background update
  if (isCdn(url)) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const fetchAndCache = fetch(e.request).then(response => {
          if (response.ok) {
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, response.clone())).catch(() => {});
          }
          return response;
        }).catch(() => cached);
        return cached ? fetchAndCache.then(() => cached) : fetchAndCache;
      })
    );
    return;
  }

  // Other static assets: stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fetchPromise = fetch(e.request).then(response => {
        if (response.ok) {
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, response.clone())).catch(() => {});
        }
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Listen for messages from the app to cache tiles for a specific route
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'CACHE_ROUTE_TILES') {
    const tileUrls = e.data.tileUrls || [];
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of tileUrls) {
        try {
          const response = await fetch(url);
          if (response.ok) await cache.put(url, response);
        } catch (err) {}
      }
      await trimCache(CACHE_NAME, TILE_CACHE_LIMIT + ROUTE_TILE_CACHE_LIMIT);
    }).catch(() => {});
  }
});
