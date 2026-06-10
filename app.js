const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const VALHALLA_HEIGHT_URL = 'https://valhalla1.openstreetmap.de/height';

let map;
let currentMode = 'auto';
let waypoints = [];
let waypointMarkers = [];
let waypointIds = [];
let waypointNames = new Map(); // id -> name
const GEOCODE_CACHE = {}; // rounded coord key -> name
const ROUTE_SOURCE = 'route-source';
const ROUTE_LAYER = 'route-layer';
let currentRoute = null;
let isRiding = false;
let rideData = { points: [], distance: 0, startTime: 0, maxLean: 0, maxSpeed: 0 };
let geoWatchId = null;
let leanAngle = 0;
let nextStepIdx = 0;
let announceState = {};
let rideTimerInterval = null;
let db = null;
  let previewTimeout = null;
  let replayState = null;
let isPremium = localStorage.getItem('curveRunner_premium') !== 'false';
let autoRouteTimeout = null;
let navFollowMode = true;
let suggestionTimeout = null;
let groupTopic = null;
let lastGroupPostTime = 0;
let groupEventSource = null;
let friendMarkers = {};
let replayMode = 'speed';
let mapBearingMode = 'north'; // 'north' or 'heading'
let deviceOrientationHeading = 0;

// ============================================
// FIREBASE CONFIG — Replace with your own values from
// https://console.firebase.google.com → Project Settings → Your apps
// Leave as-is to run entirely offline (no cloud sync).
// ============================================
const firebaseConfig = {
  apiKey: "AIzaSyAkZPwOdnRc_s6qw3y4qcUAenCmVQXnpVE",
  authDomain: "curverunner-b224e.firebaseapp.com",
  projectId: "curverunner-b224e",
  storageBucket: "curverunner-b224e.firebasestorage.app",
  messagingSenderId: "774837234577",
  appId: "1:774837234577:web:81cbdf4f7208ee642ac830",
  measurementId: "G-FZMJ6Q31KB"
};
const FIREBASE_CONFIGURED = firebaseConfig.apiKey !== "YOUR_API_KEY";

let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let currentUser = null;

// Suppress harmless MapLibre tile-abort noise
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && e.reason.name === 'AbortError' && e.reason.message && e.reason.message.includes('aborted')) {
    e.preventDefault();
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initDB();
    initMap();
    initUI();
    loadHistory();
    initFirebase();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then(reg => {
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showToast('Update available! Reload to get latest features.');
            }
          });
        });
      }).catch(console.error);
    }
  } catch (e) {
    console.error('Init failed', e);
    showToast('App init failed. Reload the page.');
  }
});

function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('CurveRunnerDB', 1);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('rides')) {
        database.createObjectStore('rides', { keyPath: 'id', autoIncrement: true });
      }
      if (!database.objectStoreNames.contains('routes')) {
        database.createObjectStore('routes', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(); };
    req.onerror = (e) => reject(e);
  });
}

function getSavedMapView() {
  try {
    const center = localStorage.getItem('curveRunner_lastCenter');
    const zoom = localStorage.getItem('curveRunner_lastZoom');
    if (center && zoom) {
      return { center: JSON.parse(center), zoom: parseFloat(zoom) };
    }
  } catch (e) {}
  return null;
}

function saveMapView() {
  if (!map) return;
  try {
    const c = map.getCenter();
    localStorage.setItem('curveRunner_lastCenter', JSON.stringify([c.lng, c.lat]));
    localStorage.setItem('curveRunner_lastZoom', map.getZoom());
  } catch (e) {}
}

function autoLocate() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      const coords = [pos.coords.longitude, pos.coords.latitude];
      map.setCenter(coords);
      map.setZoom(10);
      saveMapView();
    },
    err => {
      console.log('Auto-locate failed:', err);
    },
    { enableHighAccuracy: false, timeout: 10000 }
  );
}

function initMap() {
  const saved = getSavedMapView();
  const initialCenter = saved ? saved.center : [-122.4194, 37.7749];
  const initialZoom = saved ? saved.zoom : 10;

  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '&copy; OpenStreetMap contributors'
        }
      },
      layers: [
        { id: 'osm', type: 'raster', source: 'osm', minzoom: 0, maxzoom: 22 }
      ]
    },
    center: initialCenter,
    zoom: initialZoom,
    maxPitch: 0,
    attributionControl: false
  });

  map.addControl(new maplibregl.AttributionControl({ compact: true }));
  const geolocateControl = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserLocation: true
  });
  map.addControl(new maplibregl.NavigationControl());
  map.addControl(geolocateControl);

  map.on('moveend', saveMapView);
  map.on('zoomend', saveMapView);

  if (!saved) {
    autoLocate();
  }

  map.on('click', (e) => {
    if (currentMode === 'waypoints') {
      const features = map.queryRenderedFeatures(
        [[e.point.x - 15, e.point.y - 15], [e.point.x + 15, e.point.y + 15]],
        { layers: ['preview-layer'] }
      );
      if (features.length > 0 && waypoints.length >= 2) {
        const clickPoint = [e.lngLat.lng, e.lngLat.lat];
        const segIdx = findClosestSegment(clickPoint);
        if (segIdx !== -1) {
          addWaypoint(clickPoint, segIdx + 1);
          showToast('Waypoint inserted on line');
          return;
        }
      }
      addWaypoint([e.lngLat.lng, e.lngLat.lat]);
    }
  });

  map.on('load', () => {
    map.addSource('preview-source', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
    });
    map.addLayer({
      id: 'preview-layer',
      type: 'line',
      source: 'preview-source',
      layout: { 'line-join': 'round', 'line-cap': 'round', 'visibility': 'none' },
      paint: { 'line-color': '#ff6b00', 'line-width': 3, 'line-dasharray': [4, 3], 'line-opacity': 0.6 }
    });

    map.addSource(ROUTE_SOURCE, {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }
    });
    map.addLayer({
      id: ROUTE_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ff6b00', 'line-width': 5, 'line-opacity': 0.9 }
    });

    map.addSource('replay-track', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'replay-track',
      type: 'line',
      source: 'replay-track',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.9 }
    });

    setTimeout(() => {
      try {
        if (geolocateControl.trigger) geolocateControl.trigger();
      } catch (e) {
        console.log('Auto GPS trigger failed', e);
      }
    }, 800);
  });
}

function updatePremiumUI() {
  const btn = document.getElementById('btn-premium');
  if (isPremium) {
    btn.classList.add('active');
    btn.textContent = 'PREMIUM';
  } else {
    btn.classList.remove('active');
    btn.textContent = 'FREE';
  }
}

function togglePremium() {
  isPremium = !isPremium;
  localStorage.setItem('curveRunner_premium', isPremium);
  updatePremiumUI();
  updateWaypointPanelUI();
  if (isPremium && waypoints.length >= 2) {
    showToast('Premium auto-routing enabled');
    triggerAutoRoute();
  } else if (!isPremium) {
    showToast('Free mode: manual routing');
  }
}

function updateWaypointPanelUI() {
  const routeBtn = document.getElementById('btn-route-wp');
  const hint = document.querySelector('#panel-waypoints .hint');
  const autoPreview = document.getElementById('auto-preview');
  const autoPreviewRow = autoPreview?.closest('.toggle-row');

  if (isPremium) {
    if (routeBtn) routeBtn.classList.add('hidden');
    if (hint) hint.innerHTML = '<strong>Premium mode:</strong> Route auto-calculates as you add, move, or reorder points.';
    if (autoPreviewRow) autoPreviewRow.classList.add('hidden');
  } else {
    if (routeBtn) routeBtn.classList.remove('hidden');
    if (hint) hint.innerHTML = 'Tap map to add points. <strong>Drag</strong> markers to move. <strong>Tap</strong> the dashed line to insert. Reorder with arrows.';
    if (autoPreviewRow) autoPreviewRow.classList.remove('hidden');
  }
}

function triggerAutoRoute() {
  if (!isPremium || waypoints.length < 2) return;
  debouncedAutoRoute();
}

function debouncedAutoRoute() {
  if (autoRouteTimeout) clearTimeout(autoRouteTimeout);
  autoRouteTimeout = setTimeout(() => {
    if (waypoints.length >= 2) {
      calculateWaypointRoute(true, true);
    }
  }, 600);
}

function flashMarker(marker) {
  const el = marker.getElement();
  el.classList.remove('marker-flash');
  void el.offsetWidth;
  el.classList.add('marker-flash');
  setTimeout(() => el.classList.remove('marker-flash'), 400);
}

function initUI() {
  updatePremiumUI();

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentMode = tab.dataset.mode;
      document.getElementById('panel-auto').classList.toggle('hidden', currentMode !== 'auto');
      document.getElementById('panel-waypoints').classList.toggle('hidden', currentMode !== 'waypoints');
      if (currentMode === 'waypoints') {
        showPreviewLine();
        updateWaypointPanelUI();
      } else {
        hidePreviewLine();
      }
    });
  });

  // curviness sliders removed — route discovery is now automatic

  // Autocomplete for location inputs
  const startInput = document.getElementById('search-start');
  const endInput = document.getElementById('search-end');
  [startInput, endInput].forEach(input => {
    input.addEventListener('input', () => {
      delete input.dataset.lon;
      delete input.dataset.lat;
      const val = input.value.trim();
      if (val.length < 2) {
        hideSuggestions(input.id === 'search-start' ? 'suggestions-start' : 'suggestions-end');
        return;
      }
      if (suggestionTimeout) clearTimeout(suggestionTimeout);
      suggestionTimeout = setTimeout(() => fetchSuggestions(val, input.id), 250);
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#suggestions-start') && !e.target.closest('#search-start')) {
      hideSuggestions('suggestions-start');
    }
    if (!e.target.closest('#suggestions-end') && !e.target.closest('#search-end')) {
      hideSuggestions('suggestions-end');
    }
  });

  // Auto-recalculate when avoidance toggles change (if a route exists)
  ['avoid-freeways', 'avoid-tolls', 'avoid-dirt', 'avoid-ferry'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (currentRoute) {
        hideRouteOptions();
        if (currentMode === 'auto' && document.getElementById('search-end').value.trim()) {
          calculateAutoRoute();
        } else if (currentMode === 'waypoints' && waypoints.length >= 2) {
          calculateWaypointRoute(true, true);
        }
      }
    });
  });

  document.getElementById('btn-gps-start').addEventListener('click', useCurrentLocationAsStart);
  document.getElementById('btn-route-auto').addEventListener('click', calculateAutoRoute);
  document.getElementById('btn-route-wp').addEventListener('click', () => calculateWaypointRoute(false, false));
  document.getElementById('btn-clear-wp').addEventListener('click', clearWaypoints);
  document.getElementById('btn-start-ride').addEventListener('click', startRide);
  document.getElementById('btn-stop-ride').addEventListener('click', stopRide);
  document.getElementById('btn-history').addEventListener('click', showHistoryModal);
  document.getElementById('btn-settings').addEventListener('click', showSettingsModal);
  document.getElementById('btn-offline').addEventListener('click', saveCurrentRouteOffline);
  document.getElementById('btn-export-route').addEventListener('click', exportRouteGPX);
  document.getElementById('gpx-import').addEventListener('change', (e) => importGPX(e.target.files[0]));
  document.getElementById('auto-preview').addEventListener('change', () => {
    if (document.getElementById('auto-preview').checked && waypoints.length >= 2) {
      debouncedRoutePreview();
    }
  });
  document.getElementById('btn-premium').addEventListener('click', togglePremium);
  document.getElementById('btn-elevation').addEventListener('click', () => showElevationModalForRoute());
  document.getElementById('btn-nav-follow').addEventListener('click', () => toggleNavMode('follow'));
  document.getElementById('btn-nav-overview').addEventListener('click', () => toggleNavMode('overview'));
  document.getElementById('btn-cancel-ride').addEventListener('click', cancelRide);
  document.getElementById('btn-replay-elevation').addEventListener('click', () => {
    if (replayState && replayState.ride) showElevationModalForRide(replayState.ride);
  });
  document.getElementById('btn-weather').addEventListener('click', () => showWeatherModalForRoute());
  document.getElementById('btn-group-share').addEventListener('click', showGroupModal);
  document.getElementById('btn-copy-group-link').addEventListener('click', copyGroupLink);
  document.getElementById('btn-stop-group').addEventListener('click', stopGroupRideSharing);
  document.getElementById('btn-photo').addEventListener('click', dropPhotoWaypoint);
  document.getElementById('btn-compass').addEventListener('click', toggleMapBearingMode);
  document.getElementById('photo-capture').addEventListener('change', handlePhotoCapture);
  document.getElementById('btn-replay-lean').addEventListener('click', toggleReplayLeanMode);
  document.getElementById('btn-replay-curves').addEventListener('click', () => {
    if (replayState && replayState.ride && replayState.ride.curves) showCurveModal(replayState.ride.curves);
    else showToast('No curve data for this ride');
  });

  // Welcome screen listeners
  document.getElementById('btn-google-signin')?.addEventListener('click', signInWithGoogle);
  document.getElementById('btn-email-signin')?.addEventListener('click', signInWithEmail);
  document.getElementById('btn-email-signup')?.addEventListener('click', signUpWithEmail);
  document.getElementById('btn-skip-auth')?.addEventListener('click', () => {
    localStorage.setItem('curveRunner_welcomeSeen', 'true');
    hideWelcomeScreen();
  });
  document.getElementById('btn-install-help')?.addEventListener('click', showInstallHelpModal);
  document.getElementById('btn-settings-signin')?.addEventListener('click', () => {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    document.getElementById('modal-overlay').classList.add('hidden');
    showWelcomeScreen();
  });
  document.getElementById('btn-settings-signout')?.addEventListener('click', signOutUser);

  initPanelDrag();

  document.querySelectorAll('.close-modal').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
      document.getElementById('modal-overlay').classList.add('hidden');
    });
  });
  document.getElementById('modal-overlay').addEventListener('click', () => {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    document.getElementById('modal-overlay').classList.add('hidden');
  });

  document.getElementById('replay-playpause').addEventListener('click', toggleReplay);
  document.getElementById('replay-close').addEventListener('click', stopReplay);
  document.getElementById('replay-slider').addEventListener('input', (e) => {
    if (!replayState) return;
    pauseReplay();
    seekReplay(parseFloat(e.target.value));
  });
  document.querySelectorAll('#replay-speed .speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#replay-speed .speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (replayState) replayState.speedMultiplier = parseFloat(btn.dataset.speed);
    });
  });

  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    const btn = document.createElement('button');
    btn.textContent = 'Enable Motion Sensors';
    btn.className = 'btn-primary';
    btn.style.cssText = 'position:absolute;top:110px;left:12px;z-index:30;padding:8px 12px;font-size:0.85rem;';
    btn.addEventListener('click', async () => {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res === 'granted') {
          window.addEventListener('deviceorientation', handleOrientation);
          window.addEventListener('devicemotion', handleMotion);
          showToast('Sensors enabled');
          btn.remove();
        } else {
          showToast('Motion permission denied');
        }
      } catch (e) {
        showToast('Error enabling motion');
      }
    });
    document.body.appendChild(btn);
  } else {
    window.addEventListener('deviceorientation', handleOrientation);
    window.addEventListener('devicemotion', handleMotion);
  }

  // Check for group ride URL param
  const urlParams = new URLSearchParams(window.location.search);
  const groupTopic = urlParams.get('group');
  if (groupTopic) {
    setTimeout(() => {
      subscribeGroupRide(groupTopic);
      showToast('Joining group ride...');
    }, 1200);
  }
}

/* ---------- Geolocation & Geocoding ---------- */

function geocodeCacheKey(lon, lat) {
  return lon.toFixed(3) + ',' + lat.toFixed(3);
}

async function reverseGeocode(lon, lat) {
  const key = geocodeCacheKey(lon, lat);
  if (GEOCODE_CACHE[key]) return GEOCODE_CACHE[key];
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lon=${lon}&lat=${lat}&zoom=14&accept-language=en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'CurveRunner/1.0' } });
    if (!res.ok) return null;
    const data = await res.json();
    let name = data.display_name || data.name || null;
    if (name) {
      name = name.split(',')[0].trim();
      if (name.length > 30) name = name.substring(0, 27) + '...';
      GEOCODE_CACHE[key] = name;
    }
    return name;
  } catch (e) {
    return null;
  }
}

async function geocode(query) {
  const url = `${NOMINATIM_URL}?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const data = await res.json();
  if (data && data.length) {
    return [parseFloat(data[0].lon), parseFloat(data[0].lat)];
  }
  throw new Error('Location not found');
}

function getCurrentPosition(preferCached = false) {
  return new Promise((resolve, reject) => {
    const options = {
      enableHighAccuracy: !preferCached,
      maximumAge: preferCached ? 60000 : 0,
      timeout: 15000
    };
    navigator.geolocation.getCurrentPosition(
      pos => resolve([pos.coords.longitude, pos.coords.latitude]),
      err => {
        if (!preferCached) {
          // Retry with cached/low-accuracy position
          navigator.geolocation.getCurrentPosition(
            pos2 => resolve([pos2.coords.longitude, pos2.coords.latitude]),
            err2 => reject(err2),
            { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 }
          );
        } else {
          reject(err);
        }
      },
      options
    );
  });
}

function geolocationErrorMessage(err) {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'GPS permission denied. Check browser/site settings.';
    case err.POSITION_UNAVAILABLE:
      return 'GPS unavailable. Try the map’s GPS button first, or enter a location manually.';
    case err.TIMEOUT:
      return 'GPS timed out. Try again or enter a location manually.';
    default:
      return 'GPS error: ' + (err.message || 'unknown');
  }
}

async function useCurrentLocationAsStart() {
  try {
    const pos = await getCurrentPosition();
    const input = document.getElementById('search-start');
    input.value = 'My Location';
    input.dataset.lon = pos[0];
    input.dataset.lat = pos[1];
    map.setCenter(pos);
    map.setZoom(15);
  } catch (e) {
    showToast(geolocationErrorMessage(e));
  }
}

/* ---------- Autocomplete ---------- */

async function fetchSuggestions(query, inputId) {
  const listId = inputId === 'search-start' ? 'suggestions-start' : 'suggestions-end';
  const list = document.getElementById(listId);
  if (!list) return;

  try {
    const bounds = map.getBounds();
    const viewbox = `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`;
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&viewbox=${viewbox}&accept-language=en`;
    const res = await fetch(url, { headers: { 'User-Agent': 'CurveRunner/1.0' } });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.length) {
      list.classList.add('hidden');
      return;
    }

    list.innerHTML = '';
    data.forEach(item => {
      const li = document.createElement('li');
      let display = item.display_name;
      if (display.length > 55) display = display.substring(0, 52) + '...';
      li.textContent = display;
      li.addEventListener('click', () => {
        const input = document.getElementById(inputId);
        input.value = item.display_name;
        input.dataset.lon = item.lon;
        input.dataset.lat = item.lat;
        list.classList.add('hidden');
      });
      list.appendChild(li);
    });
    list.classList.remove('hidden');
  } catch (e) {
    list.classList.add('hidden');
  }
}

function hideSuggestions(listId) {
  const list = document.getElementById(listId);
  if (list) list.classList.add('hidden');
}

/* ---------- Routing ---------- */

function buildCostingOptions() {
  const opts = {};
  if (document.getElementById('avoid-freeways')?.checked) opts.use_highways = 0.0;
  if (document.getElementById('avoid-tolls')?.checked) opts.use_tolls = 0.0;
  if (document.getElementById('avoid-dirt')?.checked) opts.use_trails = 0.0;
  if (document.getElementById('avoid-ferry')?.checked) opts.use_ferry = 0.0;
  return opts;
}

function generateWaypointCurvyPath(waypoints, curviness) {
  if (curviness <= 0 || waypoints.length < 2) return waypoints;
  const result = [waypoints[0]];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const intermediates = generateCurvyWaypoints(waypoints[i], waypoints[i + 1], curviness);
    result.push(...intermediates);
    result.push(waypoints[i + 1]);
  }
  return result;
}

function hideRouteOptions() {
  document.getElementById('route-options-auto').classList.add('hidden');
  document.getElementById('route-options-waypoints').classList.add('hidden');
}

function getRouteSamples(coords, count) {
  if (coords.length === 0) return [];
  const samples = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor((coords.length - 1) * (i / Math.max(count - 1, 1)));
    samples.push(coords[idx]);
  }
  return samples;
}

function isDuplicateRoute(route, existingRoutes) {
  const newCoords = route.geometry.coordinates;
  const newSamples = getRouteSamples(newCoords, 5);
  const newLen = route.length;

  for (const existing of existingRoutes) {
    const exCoords = existing.geometry.coordinates;
    const exSamples = getRouteSamples(exCoords, 5);
    const exLen = existing.length;

    let allClose = true;
    for (let i = 0; i < 5; i++) {
      const d = haversineDistance(newSamples[i], exSamples[i]);
      if (d > 0.8) {
        allClose = false;
        break;
      }
    }

    if (allClose && Math.abs(newLen - exLen) / Math.max(newLen, exLen, 1) < 0.2) {
      return true;
    }
  }
  return false;
}

const ROUTE_NAME_MAP = {
  2: [0, 5],
  3: [0, 2, 5],
  4: [0, 1, 2, 5],
  5: [0, 1, 2, 3, 5],
  6: [0, 1, 2, 3, 4, 5]
};

function getRouteOptionNames(count) {
  const names = [
    'Straight path',
    'Least curves',
    'Curvy',
    'More curvy',
    'Even more curvy',
    'Maximum curvy',
    'Very twisty',
    'Extremely twisty',
    'Winding madness',
    'Maximum intensity'
  ];
  if (count <= 1) return ['Route'];
  if (count <= 6 && ROUTE_NAME_MAP[count]) {
    return ROUTE_NAME_MAP[count].map(i => names[i]);
  }
  const result = [];
  const step = (names.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) {
    result.push(names[Math.round(i * step)]);
  }
  return result;
}

async function discoverRoutes(start, end, waypoints = null) {
  const costingOptions = buildCostingOptions();
  const levels = [0, 100, 50, 25, 75, 12, 37, 62, 87, 6, 18, 31, 43, 56, 68, 81, 93];
  const distinctRoutes = [];

  for (let i = 0; i < levels.length; i += 3) {
    const batch = levels.slice(i, i + 3);
    const promises = batch.map(async level => {
      try {
        let route;
        if (waypoints) {
          const pts = generateWaypointCurvyPath(waypoints, level);
          route = await fetchRoute(pts, costingOptions);
        } else {
          const intermediates = generateCurvyWaypoints(start, end, level);
          route = await fetchRoute([start, ...intermediates, end], costingOptions);
        }
        return route;
      } catch (e) {
        return null;
      }
    });

    const results = await Promise.all(promises);
    for (const route of results) {
      if (route && !isDuplicateRoute(route, distinctRoutes)) {
        distinctRoutes.push(route);
        if (distinctRoutes.length >= 10) break;
      }
    }
    if (distinctRoutes.length >= 10) break;
  }

  return distinctRoutes;
}

function showRouteOptions(routes, mode) {
  const containerId = mode === 'auto' ? 'route-options-auto' : 'route-options-waypoints';
  const listId = mode === 'auto' ? 'route-options-list-auto' : 'route-options-list-waypoints';
  const container = document.getElementById(containerId);
  const list = document.getElementById(listId);

  container.classList.remove('hidden');
  list.innerHTML = '';

  const names = getRouteOptionNames(routes.length);

  routes.forEach((route, i) => {
    const btn = document.createElement('div');
    btn.className = 'route-option' + (i === 0 ? ' selected' : '');
    btn.innerHTML = `
      <div>
        <div class="name">${i + 1}. ${names[i]}</div>
        <div class="meta">${route.length.toFixed(1)} km · ${Math.round(route.time / 60)} min</div>
      </div>
      <div style="font-size:1.2rem">→</div>
    `;
    btn.addEventListener('click', () => {
      list.querySelectorAll('.route-option').forEach(el => el.classList.remove('selected'));
      btn.classList.add('selected');
      selectRouteOption(route, mode);
    });
    list.appendChild(btn);
  });

  currentRoute = routes[0];
  displayRoute(currentRoute);
  document.getElementById('btn-start-ride').classList.remove('hidden');
  document.getElementById('btn-elevation').classList.remove('hidden');

  if (mode === 'waypoints') {
    updateRouteStats(routes[0].length, routes[0].time, waypoints.length);
    hidePreviewLine();
  }

  const routeWord = routes.length === 1 ? 'route' : 'routes';
  showToast(`${routes.length} ${routeWord} found`);
}

function selectRouteOption(route, mode) {
  currentRoute = route;
  displayRoute(route);
  document.getElementById('btn-start-ride').classList.remove('hidden');
  document.getElementById('btn-elevation').classList.remove('hidden');
  if (mode === 'waypoints') {
    updateRouteStats(route.length, route.time, waypoints.length);
  }
}

async function calculateAutoRoute() {
  const startInput = document.getElementById('search-start');
  const endInput = document.getElementById('search-end');
  const startQuery = startInput.value.trim();
  const endQuery = endInput.value.trim();

  if (!endQuery) return showToast('Enter a destination');

  let start;
  try {
    if (startInput.dataset.lon && startInput.dataset.lat) {
      start = [parseFloat(startInput.dataset.lon), parseFloat(startInput.dataset.lat)];
    } else if (startQuery) {
      start = await geocode(startQuery);
    } else {
      start = await getCurrentPosition();
    }
  } catch (e) {
    return showToast('Start location error: ' + e.message);
  }

  let end;
  try {
    if (endInput.dataset.lon && endInput.dataset.lat) {
      end = [parseFloat(endInput.dataset.lon), parseFloat(endInput.dataset.lat)];
    } else if (endQuery) {
      end = await geocode(endQuery);
    } else {
      return showToast('Enter a destination');
    }
  } catch (e) {
    return showToast('Destination error: ' + e.message);
  }

  hideRouteOptions();
  showToast('Analyzing routes...');

  try {
    const routes = await discoverRoutes(start, end);
    
    if (routes.length === 0) {
      showToast('No routes found');
      return;
    }
    
    if (routes.length === 1) {
      currentRoute = routes[0];
      displayRoute(routes[0]);
      showToast('1 route found');
      speak('Route found.');
      return;
    }
    
    showRouteOptions(routes, 'auto');
    speak(`${routes.length} routes found. Choose your preference.`);
  } catch (e) {
    showToast('Routing failed: ' + e.message);
  }
}

async function calculateWaypointRoute(silent = false, autoUpdate = false) {
  if (waypoints.length < 2) return showToast('Add at least 2 waypoints');
  if (!isPremium && waypoints.length > 3) {
    if (!silent) showToast('Free tier: max 3 waypoints. Upgrade to Premium for unlimited.');
    return;
  }

  const costingOptions = buildCostingOptions();

  try {
    if (autoUpdate) {
      // Single quick route for premium auto-update
      const pts = generateWaypointCurvyPath(waypoints, 50);
      const route = await fetchRoute(pts, costingOptions);
      currentRoute = route;
      displayRoute(route, !silent);
      hidePreviewLine();
      updateRouteStats(route.length, route.time, waypoints.length);
      document.getElementById('btn-start-ride').classList.remove('hidden');
      document.getElementById('btn-elevation').classList.remove('hidden');
      return;
    }

    // Full route discovery for manual button
    hideRouteOptions();
    showToast('Analyzing routes...');
    
    const routes = await discoverRoutes(null, null, waypoints);
    
    if (routes.length === 0) {
      showToast('No routes found');
      return;
    }
    
    if (routes.length === 1) {
      currentRoute = routes[0];
      displayRoute(routes[0]);
      hidePreviewLine();
      updateRouteStats(routes[0].length, routes[0].time, waypoints.length);
      document.getElementById('btn-start-ride').classList.remove('hidden');
      document.getElementById('btn-elevation').classList.remove('hidden');
      showToast('1 route found');
      return;
    }
    
    showRouteOptions(routes, 'waypoints');
    speak(`${routes.length} routes found. Choose your preference.`);
  } catch (e) {
    showToast('Routing failed: ' + e.message);
  }
}

function generateCurvyWaypoints(start, end, curviness) {
  if (curviness <= 0) return [];
  const count = Math.max(1, Math.floor(curviness / 15));
  const maxOffsetDeg = (curviness / 100) * 0.08;
  const pts = [];
  const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);

  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    const lat = start[1] + (end[1] - start[1]) * t;
    const lng = start[0] + (end[0] - start[0]) * t;
    const perp = angle + (Math.PI / 2) * (Math.random() > 0.5 ? 1 : -1);
    const offset = maxOffsetDeg * (0.5 + Math.random() * 0.5);
    pts.push([lng + Math.cos(perp) * offset, lat + Math.sin(perp) * offset]);
  }
  return pts;
}

async function fetchRoute(locations, costingOptions = {}) {
  const body = {
    locations: locations.map(loc => ({ lon: loc[0], lat: loc[1] })),
    costing: 'motorcycle',
    costing_options: {
      motorcycle: {
        use_highways: 0.0,
        use_tolls: 0.0,
        ...costingOptions
      }
    },
    directions_options: {
      units: 'kilometers',
      language: 'en'
    }
  };

  const res = await fetch(VALHALLA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  if (!data.trip || !data.trip.legs || !data.trip.legs.length) throw new Error('No route found');

  // Concatenate all legs into a single continuous route
  let allCoords = [];
  let allManeuvers = [];
  let shapeOffset = 0;

  for (const leg of data.trip.legs) {
    let coords = decodePolyline(leg.shape, 6);
    if (coords.length < 2) coords = decodePolyline(leg.shape, 5);

    // Avoid duplicating the last point of previous leg
    if (allCoords.length > 0 && coords.length > 0) {
      const last = allCoords[allCoords.length - 1];
      const first = coords[0];
      if (Math.abs(last[0] - first[0]) < 1e-6 && Math.abs(last[1] - first[1]) < 1e-6) {
        coords = coords.slice(1);
      }
    }
    allCoords = allCoords.concat(coords);

    // Adjust maneuver shape indices to account for previous legs
    if (leg.maneuvers) {
      for (const m of leg.maneuvers) {
        const adjusted = {
          ...m,
          begin_shape_index: (m.begin_shape_index || 0) + shapeOffset,
          end_shape_index: (m.end_shape_index || 0) + shapeOffset
        };
        allManeuvers.push(adjusted);
      }
    }
    shapeOffset += coords.length;
  }

  return {
    geometry: { type: 'LineString', coordinates: allCoords },
    maneuvers: allManeuvers,
    length: data.trip.summary ? data.trip.summary.length : 0,
    time: data.trip.summary ? data.trip.summary.time : 0
  };
}

function decodePolyline(str, precision = 6) {
  let index = 0, lat = 0, lng = 0, coordinates = [];
  const factor = Math.pow(10, precision);
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0; result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    coordinates.push([lng / factor, lat / factor]);
  }
  return coordinates;
}

function displayRoute(route, fit = true) {
  map.getSource(ROUTE_SOURCE).setData({
    type: 'Feature',
    geometry: route.geometry
  });

  if (fit) {
    const bounds = route.geometry.coordinates.reduce((b, c) => {
      if (!b) return new maplibregl.LngLatBounds(c, c);
      b.extend(c);
      return b;
    }, null);
    map.fitBounds(bounds, { padding: 60, maxZoom: 18 });
  }

  if (route.maneuvers.length) {
    document.getElementById('nav-banner').classList.remove('hidden');
    document.getElementById('nav-instruction').textContent = route.maneuvers[0].instruction;
    document.getElementById('nav-distance').textContent = route.maneuvers[0].length ? route.maneuvers[0].length.toFixed(1) + ' km' : '';
  } else {
    document.getElementById('nav-banner').classList.add('hidden');
  }
}

/* ---------- Waypoints & Preview Line ---------- */

function addWaypoint(coords, index = null) {
  const insertIndex = index !== null ? index : waypoints.length;
  if (index !== null) {
    waypoints.splice(insertIndex, 0, coords);
  } else {
    waypoints.push(coords);
  }

  const id = Date.now() + '-' + Math.random();
  waypointIds.splice(insertIndex, 0, id);

  reverseGeocode(coords[0], coords[1]).then(name => {
    if (name) {
      waypointNames.set(id, name);
      updateWaypointList();
    }
  });

  const el = document.createElement('div');
  el.className = 'waypoint-marker';
  el.textContent = insertIndex + 1;
  const marker = new maplibregl.Marker({ element: el, draggable: true })
    .setLngLat(coords)
    .addTo(map);

  marker._waypointIndex = insertIndex;

  marker.on('drag', () => {
    const idx = marker._waypointIndex;
    if (idx >= 0 && idx < waypoints.length) {
      waypoints[idx] = [marker.getLngLat().lng, marker.getLngLat().lat];
      updatePreviewLine();
    }
  });

  marker.on('dragend', () => {
    const idx = marker._waypointIndex;
    if (idx >= 0 && idx < waypoints.length) {
      waypoints[idx] = [marker.getLngLat().lng, marker.getLngLat().lat];
      updateWaypointList();
      updatePreviewLine();
      triggerAutoRoute();
    }
  });

  if (index !== null) {
    waypointMarkers.splice(insertIndex, 0, marker);
  } else {
    waypointMarkers.push(marker);
  }

  renumberMarkers();
  updateWaypointList();
  updatePreviewLine();
  showPreviewLine();

  triggerAutoRoute();
  if (!isPremium && document.getElementById('auto-preview').checked && waypoints.length >= 2) {
    debouncedRoutePreview();
  }
}

function removeWaypoint(index) {
  if (index < 0 || index >= waypoints.length) return;
  const id = waypointIds[index];
  waypointNames.delete(id);
  waypointIds.splice(index, 1);
  waypoints.splice(index, 1);
  waypointMarkers[index].remove();
  waypointMarkers.splice(index, 1);
  renumberMarkers();
  updateWaypointList();
  updatePreviewLine();
  if (waypoints.length < 2) {
    map.getSource(ROUTE_SOURCE).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
    document.getElementById('btn-start-ride').classList.add('hidden');
    document.getElementById('nav-banner').classList.add('hidden');
    document.getElementById('route-stats').classList.add('hidden');
    currentRoute = null;
  }
  triggerAutoRoute();
  if (!isPremium && currentRoute && document.getElementById('auto-preview').checked) {
    debouncedRoutePreview();
  }
}

function moveWaypointUp(index) {
  if (index <= 0) return;
  [waypoints[index], waypoints[index - 1]] = [waypoints[index - 1], waypoints[index]];
  [waypointIds[index], waypointIds[index - 1]] = [waypointIds[index - 1], waypointIds[index]];
  [waypointMarkers[index], waypointMarkers[index - 1]] = [waypointMarkers[index - 1], waypointMarkers[index]];
  renumberMarkers();
  flashMarker(waypointMarkers[index - 1]);
  flashMarker(waypointMarkers[index]);
  showToast('Waypoint ' + (index + 1) + ' moved up');
  updateWaypointList();
  updatePreviewLine();
  triggerAutoRoute();
  if (!isPremium && document.getElementById('auto-preview').checked) debouncedRoutePreview();
}

function moveWaypointDown(index) {
  if (index >= waypoints.length - 1) return;
  [waypoints[index], waypoints[index + 1]] = [waypoints[index + 1], waypoints[index]];
  [waypointIds[index], waypointIds[index + 1]] = [waypointIds[index + 1], waypointIds[index]];
  [waypointMarkers[index], waypointMarkers[index + 1]] = [waypointMarkers[index + 1], waypointMarkers[index]];
  renumberMarkers();
  flashMarker(waypointMarkers[index]);
  flashMarker(waypointMarkers[index + 1]);
  showToast('Waypoint ' + (index + 1) + ' moved down');
  updateWaypointList();
  updatePreviewLine();
  triggerAutoRoute();
  if (!isPremium && document.getElementById('auto-preview').checked) debouncedRoutePreview();
}

function renumberMarkers() {
  waypointMarkers.forEach((m, i) => {
    m._waypointIndex = i;
    m.getElement().textContent = i + 1;
  });
}

function clearWaypoints() {
  waypoints = [];
  waypointIds = [];
  waypointNames.clear();
  waypointMarkers.forEach(m => m.remove());
  waypointMarkers = [];
  updateWaypointList();
  updatePreviewLine();
  hidePreviewLine();
  hideRouteOptions();
  map.getSource(ROUTE_SOURCE).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
  document.getElementById('btn-start-ride').classList.add('hidden');
  document.getElementById('btn-elevation').classList.add('hidden');
  document.getElementById('nav-banner').classList.add('hidden');
  document.getElementById('route-stats').classList.add('hidden');
  currentRoute = null;
}

function updatePreviewLine() {
  if (!map.getSource('preview-source')) return;
  map.getSource('preview-source').setData({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: waypoints }
  });
}

function showPreviewLine() {
  if (map.getLayer('preview-layer')) {
    map.setLayoutProperty('preview-layer', 'visibility', 'visible');
  }
}

function hidePreviewLine() {
  if (map.getLayer('preview-layer')) {
    map.setLayoutProperty('preview-layer', 'visibility', 'none');
  }
}

function findClosestSegment(point) {
  let minDist = Infinity;
  let bestIdx = -1;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const d = pointToSegmentDistance(point, waypoints[i], waypoints[i + 1]);
    if (d < minDist) {
      minDist = d;
      bestIdx = i;
    }
  }
  return minDist < 1.0 ? bestIdx : -1;
}

function pointToSegmentDistance(p, a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const px = toRad(p[0]), py = toRad(p[1]);
  const ax = toRad(a[0]), ay = toRad(a[1]);
  const bx = toRad(b[0]), by = toRad(b[1]);
  const scale = Math.cos((ay + by) / 2);
  const dx = (bx - ax) * scale;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return haversineDistance(p, a);
  const dpx = (px - ax) * scale;
  const dpy = py - ay;
  let t = (dpx * dx + dpy * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const projx = ax + t * dx;
  const projy = ay + t * dy;
  const projDeg = [projx * 180 / Math.PI, projy * 180 / Math.PI];
  return haversineDistance(p, projDeg);
}

function debouncedRoutePreview() {
  if (previewTimeout) clearTimeout(previewTimeout);
  previewTimeout = setTimeout(() => {
    if (waypoints.length >= 2) {
      calculateWaypointRoute(true, true);
    }
  }, 800);
}

function updateWaypointList() {
  const list = document.getElementById('waypoint-list');
  list.innerHTML = '';
  waypoints.forEach((wp, i) => {
    const li = document.createElement('li');
    li.className = 'waypoint-item';

    let distStr = '';
    if (i > 0) {
      const d = haversineDistance(waypoints[i - 1], wp);
      distStr = `<div class="meta">+${d.toFixed(1)} km from previous</div>`;
    }

    const id = waypointIds[i];
    const name = waypointNames.get(id);
    li.innerHTML = `
      <div style="display:flex;align-items:center;flex:1;min-width:0">
        <span class="idx">${i + 1}</span>
        <div class="name">
          <span>${name ? name : 'Point ' + (i + 1)}</span>
          ${distStr}
        </div>
      </div>
      <div class="reorder">
        <button ${i === 0 ? 'disabled' : ''} data-dir="up" title="Move up">↑</button>
        <button ${i === waypoints.length - 1 ? 'disabled' : ''} data-dir="down" title="Move down">↓</button>
      </div>
      <button class="delete" title="Remove">×</button>
    `;

    li.querySelector('[data-dir="up"]')?.addEventListener('click', () => moveWaypointUp(i));
    li.querySelector('[data-dir="down"]')?.addEventListener('click', () => moveWaypointDown(i));
    li.querySelector('.delete')?.addEventListener('click', () => removeWaypoint(i));

    list.appendChild(li);
  });
}

function updateRouteStats(lengthKm, timeSec, numPoints) {
  const stats = document.getElementById('route-stats');
  stats.classList.remove('hidden');
  const min = Math.round(timeSec / 60);
  document.getElementById('stat-dist').textContent = lengthKm.toFixed(1) + ' km';
  document.getElementById('stat-time').textContent = min + ' min';
  document.getElementById('stat-points').textContent = numPoints + ' pts';
}

/* ---------- Voice Navigation ---------- */

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  utter.pitch = 1.0;
  utter.volume = 1.0;
  const voices = window.speechSynthesis.getVoices();
  const en = voices.find(v => v.lang && v.lang.startsWith('en')) || voices[0];
  if (en) utter.voice = en;
  window.speechSynthesis.speak(utter);
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

/* ---------- Ride Recording ---------- */

async function startRide() {
  if (!currentRoute && (currentMode !== 'waypoints' || waypoints.length === 0)) {
    return showToast('No route to follow. Plan a route first.');
  }

  // Hide button immediately so double-taps don't start multiple rides
  document.getElementById('btn-start-ride').classList.add('hidden');

  let userPos;
  try {
    userPos = await getCurrentPosition();
  } catch (e) {
    document.getElementById('btn-start-ride').classList.remove('hidden');
    return showToast('GPS required: ' + geolocationErrorMessage(e));
  }

  const userCoords = [userPos[0], userPos[1]];

  // In waypoint mode, route from current location through all waypoints
  if (currentMode === 'waypoints' && waypoints.length > 0) {
    showToast('Routing from your location...');
    try {
      const costingOptions = buildCostingOptions();
      const newRoute = await fetchRoute([userCoords, ...waypoints], costingOptions);
      currentRoute = newRoute;
      displayRoute(currentRoute, false);
    } catch (e) {
      document.getElementById('btn-start-ride').classList.remove('hidden');
      return showToast('Routing from your location failed: ' + e.message);
    }
  }

  // Snap current GPS position to the route and find upcoming turn
  snapToRoute(userCoords);

  // Default to follow mode
  navFollowMode = true;
  updateNavModeUI();
  document.getElementById('nav-mode-toggle').classList.remove('hidden');

  // Center map on rider for immediate nav feel
  map.easeTo({ center: userCoords, zoom: 18, duration: 600 });

  isRiding = true;
  rideData = { points: [], distance: 0, startTime: Date.now(), maxLean: 0, maxSpeed: 0, photos: [] };
  announceState = {};

  document.getElementById('btn-start-ride').classList.add('hidden');
  document.getElementById('btn-stop-ride').classList.remove('hidden');
  document.getElementById('btn-cancel-ride').classList.remove('hidden');
  document.getElementById('ride-hud').classList.remove('hidden');
  document.getElementById('ride-actions').classList.remove('hidden');
  document.getElementById('warning-banner').classList.remove('hidden');
  document.getElementById('bottom-panel').classList.add('collapsed');

  geoWatchId = navigator.geolocation.watchPosition(
    handleRidePosition,
    (err) => console.error('GPS error', err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
  );

  startTimer();
  speak('Ride started. Navigate safely.');
}

function snapToRoute(userCoords) {
  if (!currentRoute || !currentRoute.maneuvers.length) return;

  const coords = currentRoute.geometry.coordinates;
  let minDist = Infinity;
  let nearestIdx = 0;

  for (let i = 0; i < coords.length; i++) {
    const d = haversineDistance(userCoords, coords[i]);
    if (d < minDist) {
      minDist = d;
      nearestIdx = i;
    }
  }

  // Find the next upcoming maneuver based on nearest route point
  let nextIdx = currentRoute.maneuvers.length - 1;
  for (let i = 0; i < currentRoute.maneuvers.length; i++) {
    const m = currentRoute.maneuvers[i];
    if (m.end_shape_index >= nearestIdx) {
      nextIdx = i;
      break;
    }
  }

  nextStepIdx = nextIdx;
  announceState = {};

  // Update nav banner immediately
  const man = currentRoute.maneuvers[nextStepIdx];
  if (man) {
    document.getElementById('nav-instruction').textContent = man.instruction;
    document.getElementById('nav-distance').textContent = man.length ? man.length.toFixed(1) + ' km' : '';
    document.getElementById('nav-banner').classList.remove('hidden');
  }
}

function stopRide() {
  isRiding = false;
  if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
  clearInterval(rideTimerInterval);

  const duration = Math.floor((Date.now() - rideData.startTime) / 1000);
  const curves = detectCurves(rideData.points);
  const photos = rideData.photos || [];
  const ride = {
    id: Date.now(),
    date: new Date().toISOString(),
    distance: rideData.distance,
    duration: duration,
    maxSpeed: rideData.maxSpeed,
    maxLean: rideData.maxLean,
    points: rideData.points,
    curves: curves,
    photos: photos
  };

  saveRide(ride);
  speak('Ride complete. Distance ' + rideData.distance.toFixed(1) + ' kilometers.');

  document.getElementById('btn-start-ride').classList.remove('hidden');
  document.getElementById('btn-stop-ride').classList.add('hidden');
  document.getElementById('btn-cancel-ride').classList.add('hidden');
  document.getElementById('ride-hud').classList.add('hidden');
  document.getElementById('ride-actions').classList.add('hidden');
  document.getElementById('warning-banner').classList.add('hidden');
  document.getElementById('bottom-panel').classList.remove('collapsed');
  document.getElementById('nav-banner').classList.add('hidden');
  document.getElementById('nav-mode-toggle').classList.add('hidden');

  stopGroupRideSharing();
  nextStepIdx = 0;
  navFollowMode = true;
  announceState = {};
}

function cancelRide() {
  isRiding = false;
  if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
  clearInterval(rideTimerInterval);
  speak('Navigation cancelled.');

  document.getElementById('btn-stop-ride').classList.add('hidden');
  document.getElementById('btn-cancel-ride').classList.add('hidden');
  document.getElementById('btn-start-ride').classList.remove('hidden');
  document.getElementById('ride-hud').classList.add('hidden');
  document.getElementById('ride-actions').classList.add('hidden');
  document.getElementById('warning-banner').classList.add('hidden');
  document.getElementById('nav-banner').classList.add('hidden');
  document.getElementById('nav-mode-toggle').classList.add('hidden');
  document.getElementById('bottom-panel').classList.remove('collapsed');

  stopGroupRideSharing();
  // Clear route line from map but keep waypoints for replanning
  map.getSource(ROUTE_SOURCE).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
  currentRoute = null;

  nextStepIdx = 0;
  navFollowMode = true;
  announceState = {};
}

function handleRidePosition(position) {
  const coords = [position.coords.longitude, position.coords.latitude];
  const alt = position.coords.altitude || 0;
  const speed = position.coords.speed || 0;
  const speedKmh = speed * 3.6;

  const point = {
    lon: coords[0],
    lat: coords[1],
    alt: alt,
    speed: speedKmh,
    time: Date.now(),
    lean: leanAngle
  };
  rideData.points.push(point);

  if (rideData.points.length > 1) {
    const prev = rideData.points[rideData.points.length - 2];
    const d = haversineDistance([prev.lon, prev.lat], coords);
    rideData.distance += d;
  }

  if (speedKmh > rideData.maxSpeed) rideData.maxSpeed = speedKmh;
  if (Math.abs(leanAngle) > rideData.maxLean) rideData.maxLean = Math.abs(leanAngle);

  document.getElementById('hud-speed').textContent = Math.round(speedKmh);
  document.getElementById('hud-dist').textContent = rideData.distance.toFixed(1);
  document.getElementById('hud-lean').textContent = Math.round(leanAngle) + '°';

  // Follow rider in nav mode
  if (navFollowMode) {
    const centerOptions = { center: coords, duration: 500, easing: t => t };
    if (mapBearingMode === 'heading') {
      // Use GPS heading when moving, fallback to device compass
      let bearing = position.coords.heading;
      if (bearing === null || isNaN(bearing) || bearing < 0) {
        bearing = deviceOrientationHeading;
      }
      if (bearing !== null && !isNaN(bearing) && bearing >= 0) {
        centerOptions.bearing = bearing;
      }
    } else {
      centerOptions.bearing = 0; // North-up
    }
    map.easeTo(centerOptions);
  }

  // Post to group ride if sharing (throttle to 10s)
  if (groupTopic) {
    const now = Date.now();
    if (now - lastGroupPostTime > 10000) {
      lastGroupPostTime = now;
      postGroupPosition(groupTopic, coords[0], coords[1], speedKmh);
    }
  }

  updateNav(position);
}

function updateNav(position) {
  if (!currentRoute || !currentRoute.maneuvers.length) return;

  const userCoords = [position.coords.longitude, position.coords.latitude];
  const coords = currentRoute.geometry.coordinates;
  const maneuvers = currentRoute.maneuvers;

  // Dynamically re-snap to route to skip completed maneuvers
  let minDist = Infinity;
  let nearestIdx = 0;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineDistance(userCoords, coords[i]);
    if (d < minDist) {
      minDist = d;
      nearestIdx = i;
    }
  }
  let currentManIdx = 0;
  for (let i = 0; i < maneuvers.length; i++) {
    if (maneuvers[i].end_shape_index >= nearestIdx) {
      currentManIdx = i;
      break;
    }
  }
  if (currentManIdx > nextStepIdx) {
    nextStepIdx = currentManIdx;
    announceState = {}; // reset for new upcoming turns
  }

  if (nextStepIdx >= maneuvers.length) {
    document.getElementById('nav-instruction').textContent = 'You have arrived';
    document.getElementById('nav-distance').textContent = '';
    return;
  }

  const man = maneuvers[nextStepIdx];
  const idx = man.begin_shape_index;
  if (idx === undefined || idx >= coords.length) return;

  const manCoord = coords[idx];
  const dist = haversineDistance(userCoords, manCoord);
  document.getElementById('nav-distance').textContent = (dist * 1000).toFixed(0) + ' m';

  if (!announceState[nextStepIdx]) announceState[nextStepIdx] = {};
  const state = announceState[nextStepIdx];

  if (!state.at200 && dist < 0.2 && dist > 0.08) {
    state.at200 = true;
    speak('In ' + Math.round(dist * 1000) + ' meters, ' + man.instruction);
  }
  if (!state.at50 && dist < 0.05) {
    state.at50 = true;
    speak(man.instruction);
    nextStepIdx++;
    const nextMan = maneuvers[nextStepIdx];
    document.getElementById('nav-instruction').textContent = nextMan ? nextMan.instruction : 'You have arrived';
  }
}

function toggleNavMode(mode) {
  navFollowMode = (mode === 'follow');
  updateNavModeUI();

  if (navFollowMode) {
    if (rideData.points.length > 0) {
      const last = rideData.points[rideData.points.length - 1];
      map.easeTo({ center: [last.lon, last.lat], zoom: 18, duration: 500 });
    }
  } else if (currentRoute) {
    const bounds = currentRoute.geometry.coordinates.reduce((b, c) => {
      if (!b) return new maplibregl.LngLatBounds(c, c);
      b.extend(c);
      return b;
    }, null);
    map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 500 });
  }
}

function updateNavModeUI() {
  const followBtn = document.getElementById('btn-nav-follow');
  const overviewBtn = document.getElementById('btn-nav-overview');
  if (!followBtn || !overviewBtn) return;
  if (navFollowMode) {
    followBtn.classList.add('active');
    overviewBtn.classList.remove('active');
  } else {
    followBtn.classList.remove('active');
    overviewBtn.classList.add('active');
  }
}

function toggleMapBearingMode() {
  mapBearingMode = mapBearingMode === 'north' ? 'heading' : 'north';
  const compassBtn = document.getElementById('btn-compass');
  if (compassBtn) {
    if (mapBearingMode === 'heading') {
      compassBtn.classList.add('active');
      compassBtn.style.background = 'var(--accent)';
      showToast('🧭 Heading-up mode');
    } else {
      compassBtn.classList.remove('active');
      compassBtn.style.background = '';
      showToast('🧭 North-up mode');
      // Immediately reset map to north
      map.easeTo({ bearing: 0, duration: 300 });
    }
  }
}

function startTimer() {
  rideTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - rideData.startTime) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    document.getElementById('hud-time').textContent = m + ':' + s;
  }, 1000);
}

function haversineDistance(a, b) {
  const R = 6371;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const lat1 = a[1] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const a1 = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a1), Math.sqrt(1 - a1));
  return R * c;
}

/* ---------- Sensors ---------- */

function handleOrientation(e) {
  if (e.gamma !== null) {
    leanAngle = e.gamma;
  }
  // Track compass heading for map rotation
  if (e.webkitCompassHeading !== null && !isNaN(e.webkitCompassHeading)) {
    deviceOrientationHeading = e.webkitCompassHeading;
  } else if (e.alpha !== null && !isNaN(e.alpha)) {
    // Android fallback: alpha is rotation from north (0 = north, increasing clockwise)
    deviceOrientationHeading = e.alpha;
  }
}

function handleMotion(e) {
  const acc = e.accelerationIncludingGravity;
  if (acc && acc.x !== null && acc.z !== null) {
    const angle = Math.atan2(acc.x, acc.z) * (180 / Math.PI);
    leanAngle = angle;
  }
}

/* ---------- GPX ---------- */

function toGPX(name, points) {
  const trkpts = points.map(p => {
    const lon = p.lon !== undefined ? p.lon : p[0];
    const lat = p.lat !== undefined ? p.lat : p[1];
    const alt = p.alt !== undefined ? p.alt : (p[2] || 0);
    return `    <trkpt lat="${lat}" lon="${lon}">${alt ? `<ele>${alt}</ele>` : ''}</trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${escapeXml(name)}</name><trkseg>\n${trkpts}\n  </trkseg></trk>\n</gpx>`;
}

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportRouteGPX() {
  if (!currentRoute) return showToast('No route to export');
  const pts = currentRoute.geometry.coordinates.map(c => [c[0], c[1], 0]);
  downloadFile(toGPX('CurveRunner Route', pts), 'route-' + Date.now() + '.gpx', 'application/gpx+xml');
  showToast('Route exported as GPX');
}

function exportRideGPX(id) {
  const tx = db.transaction('rides', 'readonly');
  const store = tx.objectStore('rides');
  const req = store.get(id);
  req.onsuccess = (e) => {
    const ride = e.target.result;
    if (!ride) return;
    downloadFile(toGPX('Ride ' + new Date(ride.date).toLocaleDateString(), ride.points), 'ride-' + id + '.gpx', 'application/gpx+xml');
    showToast('Ride exported');
  };
}

function importGPX(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      const parser = new DOMParser();
      const xml = parser.parseFromString(text, 'text/xml');
      const trkpts = xml.querySelectorAll('trkpt');
      const points = [];
      trkpts.forEach(pt => {
        const lat = parseFloat(pt.getAttribute('lat'));
        const lon = parseFloat(pt.getAttribute('lon'));
        if (!isNaN(lat) && !isNaN(lon)) points.push([lon, lat]);
      });
      if (points.length < 2) {
        showToast('GPX has no valid track points');
        return;
      }
      const route = {
        geometry: { type: 'LineString', coordinates: points },
        maneuvers: [],
        length: 0,
        time: 0
      };
      for (let i = 1; i < points.length; i++) route.length += haversineDistance(points[i - 1], points[i]);
      currentRoute = route;
      displayRoute(route);
      document.getElementById('btn-start-ride').classList.remove('hidden');
      document.getElementById('btn-elevation').classList.remove('hidden');
      showToast('GPX imported. ' + route.length.toFixed(1) + ' km');
    } catch (err) {
      showToast('Failed to import GPX');
    }
  };
  reader.readAsText(file);
}

/* ---------- Database & History ---------- */

function saveRide(ride) {
  const tx = db.transaction('rides', 'readwrite');
  tx.objectStore('rides').add(ride);
  tx.oncomplete = () => {
    loadHistory();
    if (currentUser) saveRideToCloud(ride);
  };
}

function loadHistory() {
  const tx = db.transaction('rides', 'readonly');
  const store = tx.objectStore('rides');
  const req = store.getAll();
  req.onsuccess = (e) => {
    const rides = e.target.result.reverse();
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    rides.forEach(r => {
      const li = document.createElement('li');
      const date = new Date(r.date).toLocaleDateString();
      const durMin = Math.floor(r.duration / 60);
      const durSec = (r.duration % 60).toString().padStart(2, '0');
      const curvesCount = r.curves && r.curves.length ? r.curves.length : 0;
      const photosCount = r.photos && r.photos.length ? r.photos.length : 0;
      li.innerHTML = `<div class="info"><div class="date">${date}</div><div class="stats">${r.distance.toFixed(1)} km · ${durMin}:${durSec} · max ${Math.round(r.maxSpeed)} km/h · lean ${Math.round(r.maxLean)}°${curvesCount ? ' · ' + curvesCount + ' curves' : ''}${photosCount ? ' · ' + photosCount + ' 📷' : ''}</div></div><div class="ride-actions"><button class="btn-small btn-secondary export-btn">GPX</button>${curvesCount ? '<button class="btn-small btn-secondary curves-btn">🏆</button>' : ''}${photosCount ? '<button class="btn-small btn-secondary photos-btn">📷</button>' : ''}<button class="btn-small btn-primary replay-btn">▶</button></div>`;
      li.querySelector('.export-btn').addEventListener('click', () => exportRideGPX(r.id));
      if (curvesCount) {
        li.querySelector('.curves-btn').addEventListener('click', () => showCurveModal(r.curves));
      }
      if (photosCount) {
        li.querySelector('.photos-btn').addEventListener('click', () => showPhotosModal(r.photos));
      }
      li.querySelector('.replay-btn').addEventListener('click', () => startReplay(r));
      list.appendChild(li);
    });
  };
}

function saveCurrentRouteOffline() {
  if (!currentRoute) return showToast('No route to save');
  const tx = db.transaction('routes', 'readwrite');
  tx.objectStore('routes').add({
    name: 'Route ' + new Date().toLocaleTimeString(),
    geometry: currentRoute.geometry,
    maneuvers: currentRoute.maneuvers,
    length: currentRoute.length,
    time: currentRoute.time,
    created: new Date().toISOString()
  });
  tx.oncomplete = () => showToast('Route saved offline');
}

function loadSavedRoutes() {
  const tx = db.transaction('routes', 'readonly');
  const store = tx.objectStore('routes');
  const req = store.getAll();
  req.onsuccess = (e) => {
    const routes = e.target.result.reverse();
    const list = document.getElementById('saved-routes-list');
    list.innerHTML = '';
    if (!routes.length) {
      list.innerHTML = '<li style="color:var(--text-dim);font-size:0.85rem">No saved routes yet.</li>';
      return;
    }
    routes.forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = `<span style="font-size:0.85rem">${r.name}</span><button class="btn-small btn-secondary">Load</button>`;
      li.querySelector('button').addEventListener('click', () => {
        currentRoute = { geometry: r.geometry, maneuvers: r.maneuvers || [], length: r.length || 0, time: r.time || 0 };
        displayRoute(currentRoute);
        document.getElementById('btn-start-ride').classList.remove('hidden');
        document.getElementById('btn-elevation').classList.remove('hidden');
        showToast('Offline route loaded');
      });
      list.appendChild(li);
    });
  };
}

/* ---------- Elevation Profile ---------- */

async function showElevationModalForRoute() {
  if (!currentRoute) return showToast('No route to analyze');
  showToast('Fetching elevation data...');
  try {
    const coords = currentRoute.geometry.coordinates;
    const sampled = samplePoints(coords, 80);
    const elevations = await fetchElevations(sampled);
    const distances = cumulativeDistances(sampled);
    showElevationModal(distances, elevations, 'Route Elevation');
  } catch (e) {
    showToast('Elevation failed: ' + e.message);
  }
}

async function showElevationModalForRide(ride) {
  if (!ride.points || ride.points.length < 2) return showToast('No ride data');
  const pts = ride.points;
  const coords = pts.map(p => [p.lon !== undefined ? p.lon : p[0], p.lat !== undefined ? p.lat : p[1]]);
  const elevations = pts.map(p => p.alt || p[2] || 0);

  if (elevations.every(e => e === 0)) {
    showToast('No altitude recorded. Fetching from map...');
    try {
      const sampled = samplePoints(coords, 80);
      const fetchedElevations = await fetchElevations(sampled);
      const distances = cumulativeDistances(sampled);
      showElevationModal(distances, fetchedElevations, 'Ride Elevation');
      return;
    } catch (e) {
      showToast('Could not fetch elevation fallback');
      return;
    }
  }

  const distances = cumulativeDistances(coords);
  showElevationModal(distances, elevations, 'Ride Elevation');
}

function samplePoints(coords, max) {
  if (coords.length <= max) return coords;
  const step = coords.length / max;
  const sampled = [];
  for (let i = 0; i < max; i++) {
    sampled.push(coords[Math.floor(i * step)]);
  }
  sampled.push(coords[coords.length - 1]);
  return sampled;
}

async function fetchElevations(coords) {
  const body = {
    shape: coords.map(c => ({ lat: c[1], lon: c[0] })),
    range: false
  };
  const res = await fetch(VALHALLA_HEIGHT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data.height || !data.height.length) throw new Error('No elevation data');
  return data.height;
}

function cumulativeDistances(coords) {
  const dists = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineDistance(coords[i - 1], coords[i]);
    dists.push(total);
  }
  return dists;
}

function calculateElevationStats(elevations, distances) {
  let climb = 0, descent = 0, maxEl = -Infinity, minEl = Infinity, maxGrade = 0;
  for (let i = 0; i < elevations.length - 1; i++) {
    const diff = elevations[i + 1] - elevations[i];
    const d = distances[i + 1] - distances[i];
    if (d > 0) {
      const grade = (diff / (d * 1000)) * 100;
      if (Math.abs(grade) > maxGrade) maxGrade = Math.abs(grade);
    }
    if (diff > 0) climb += diff;
    else descent += Math.abs(diff);
    if (elevations[i] > maxEl) maxEl = elevations[i];
    if (elevations[i] < minEl) minEl = elevations[i];
  }
  if (elevations[elevations.length - 1] > maxEl) maxEl = elevations[elevations.length - 1];
  if (elevations[elevations.length - 1] < minEl) minEl = elevations[elevations.length - 1];
  return { climb, descent, maxEl, minEl, maxGrade };
}

function showElevationModal(distances, elevations, title) {
  const stats = calculateElevationStats(elevations, distances);
  const totalDist = distances[distances.length - 1];

  const statsDiv = document.getElementById('elevation-stats');
  statsDiv.innerHTML = `
    <span>↑ ${Math.round(stats.climb)}m</span>
    <span>↓ ${Math.round(stats.descent)}m</span>
    <span>Max ${Math.round(stats.maxEl)}m</span>
    <span>Min ${Math.round(stats.minEl)}m</span>
    <span>Grade ${stats.maxGrade.toFixed(1)}%</span>
  `;

  const container = document.getElementById('elevation-chart-container');
  container.innerHTML = '';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 160');
  svg.setAttribute('preserveAspectRatio', 'none');

  const pad = { top: 10, right: 10, bottom: 24, left: 40 };
  const w = 400 - pad.left - pad.right;
  const h = 160 - pad.top - pad.bottom;

  const minEl = Math.min(...elevations);
  const maxEl = Math.max(...elevations);
  const elRange = Math.max(maxEl - minEl, 1);
  const maxDist = distances[distances.length - 1];

  const x = d => pad.left + (d / maxDist) * w;
  const y = e => pad.top + h - ((e - minEl) / elRange) * h;

  const gridCount = 5;
  for (let i = 0; i <= gridCount; i++) {
    const yPos = pad.top + (i / gridCount) * h;
    const elVal = Math.round(maxEl - (i / gridCount) * elRange);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', pad.left);
    line.setAttribute('y1', yPos);
    line.setAttribute('x2', pad.left + w);
    line.setAttribute('y2', yPos);
    line.setAttribute('class', 'grid');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', pad.left - 6);
    text.setAttribute('y', yPos + 3);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('class', 'axis-text');
    text.textContent = elVal + 'm';
    svg.appendChild(text);
  }

  const distSteps = 4;
  for (let i = 0; i <= distSteps; i++) {
    const d = (i / distSteps) * maxDist;
    const xPos = x(d);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', xPos);
    text.setAttribute('y', 160 - 4);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('class', 'axis-text');
    text.textContent = (d).toFixed(1) + 'km';
    svg.appendChild(text);
  }

  let areaPath = `M ${x(0)} ${y(elevations[0])}`;
  for (let i = 1; i < elevations.length; i++) {
    areaPath += ` L ${x(distances[i])} ${y(elevations[i])}`;
  }
  areaPath += ` L ${x(maxDist)} ${pad.top + h} L ${x(0)} ${pad.top + h} Z`;
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', areaPath);
  area.setAttribute('class', 'area');
  svg.appendChild(area);

  let linePath = `M ${x(0)} ${y(elevations[0])}`;
  for (let i = 1; i < elevations.length; i++) {
    linePath += ` L ${x(distances[i])} ${y(elevations[i])}`;
  }
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', linePath);
  line.setAttribute('class', 'line');
  svg.appendChild(line);

  container.appendChild(svg);

  document.getElementById('modal-elevation').querySelector('h2').textContent = title;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-elevation').classList.remove('hidden');
}

/* ---------- Replay System ---------- */

function startReplay(ride) {
  if (!ride.points || ride.points.length < 2) {
    return showToast('Not enough data to replay');
  }

  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.getElementById('modal-overlay').classList.add('hidden');

  document.getElementById('top-bar').classList.add('hidden');
  document.getElementById('bottom-panel').classList.add('hidden');
  document.getElementById('nav-banner').classList.add('hidden');
  document.getElementById('ride-hud').classList.add('hidden');
  document.getElementById('warning-banner').classList.add('hidden');
  document.getElementById('replay-overlay').classList.remove('hidden');

  map.getSource(ROUTE_SOURCE).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });

  const segments = buildReplaySegments(ride.points);
  if (map.getSource('replay-track')) {
    map.getSource('replay-track').setData({ type: 'FeatureCollection', features: segments });
  }

  const coords = ride.points.map(p => [p.lon !== undefined ? p.lon : p[0], p.lat !== undefined ? p.lat : p[1]]);
  const bounds = coords.reduce((b, c) => {
    if (!b) return new maplibregl.LngLatBounds(c, c);
    b.extend(c);
    return b;
  }, null);
  map.fitBounds(bounds, { padding: 60, maxZoom: 18 });

  const el = document.createElement('div');
  el.className = 'replay-dot';
  const marker = new maplibregl.Marker({ element: el }).setLngLat(coords[0]).addTo(map);

  const times = ride.points.map(p => p.time || 0);
  const totalDuration = Math.max(times[times.length - 1] - times[0], 1);

  replayState = {
    ride,
    isPlaying: false,
    virtualTime: 0,
    speedMultiplier: 2,
    points: ride.points,
    totalDuration,
    marker,
    lastFrameTime: 0,
    animationId: null
  };

  document.getElementById('replay-title').textContent = 'Ride Replay – ' + new Date(ride.date).toLocaleDateString();
  updateReplayUI(0);
  playReplay();

  // Add photo markers
  showPhotoMarkers(ride.photos || []);

  // Reset replay mode to speed
  replayMode = 'speed';
  document.getElementById('btn-replay-lean').classList.remove('active');
  document.getElementById('btn-replay-lean').style.background = '';
}

function buildReplaySegments(points) {
  const mode = replayMode || 'speed';
  const features = [];
  if (mode === 'lean') {
    const leans = points.map(p => Math.abs(p.lean || 0));
    const maxLean = Math.max(...leans, 1);
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const avgLean = (Math.abs(p1.lean || 0) + Math.abs(p2.lean || 0)) / 2;
      const color = leanToColor(avgLean, maxLean);
      features.push({
        type: 'Feature',
        properties: { color, lean: avgLean },
        geometry: {
          type: 'LineString',
          coordinates: [
            [p1.lon !== undefined ? p1.lon : p1[0], p1.lat !== undefined ? p1.lat : p1[1]],
            [p2.lon !== undefined ? p2.lon : p2[0], p2.lat !== undefined ? p2.lat : p2[1]]
          ]
        }
      });
    }
  } else {
    const speeds = points.map(p => p.speed || 0);
    const maxSpeed = Math.max(...speeds, 1);
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const avgSpeed = ((p1.speed || 0) + (p2.speed || 0)) / 2;
      const color = speedToColor(avgSpeed, maxSpeed);
      features.push({
        type: 'Feature',
        properties: { color, speed: avgSpeed },
        geometry: {
          type: 'LineString',
          coordinates: [
            [p1.lon !== undefined ? p1.lon : p1[0], p1.lat !== undefined ? p1.lat : p1[1]],
            [p2.lon !== undefined ? p2.lon : p2[0], p2.lat !== undefined ? p2.lat : p2[1]]
          ]
        }
      });
    }
  }
  return features;
}

function speedToColor(speed, maxSpeed) {
  const t = Math.min(speed / maxSpeed, 1);
  if (t < 0.5) {
    const r = Math.round(255 * (t * 2));
    return `rgb(${r}, 255, 0)`;
  } else {
    const g = Math.round(255 * (1 - (t - 0.5) * 2));
    return `rgb(255, ${g}, 0)`;
  }
}

function toggleReplay() {
  if (!replayState) return;
  if (replayState.isPlaying) {
    pauseReplay();
  } else {
    playReplay();
  }
}

function playReplay() {
  if (!replayState) return;
  if (replayState.virtualTime >= replayState.totalDuration) {
    replayState.virtualTime = 0;
  }
  replayState.isPlaying = true;
  replayState.lastFrameTime = performance.now();
  document.getElementById('replay-playpause').textContent = '⏸';
  replayState.animationId = requestAnimationFrame(replayLoop);
}

function pauseReplay() {
  if (!replayState) return;
  replayState.isPlaying = false;
  if (replayState.animationId) cancelAnimationFrame(replayState.animationId);
  document.getElementById('replay-playpause').textContent = '▶';
}

function replayLoop(now) {
  if (!replayState || !replayState.isPlaying) return;
  const dt = now - replayState.lastFrameTime;
  replayState.lastFrameTime = now;
  replayState.virtualTime += dt * replayState.speedMultiplier;

  if (replayState.virtualTime >= replayState.totalDuration) {
    replayState.virtualTime = replayState.totalDuration;
    updateReplayPosition(replayState.virtualTime);
    pauseReplay();
    return;
  }

  updateReplayPosition(replayState.virtualTime);
  replayState.animationId = requestAnimationFrame(replayLoop);
}

function updateReplayPosition(virtualTime) {
  if (!replayState) return;
  const pts = replayState.points;
  const startTime = pts[0].time || 0;
  const targetTime = startTime + virtualTime;

  let idx = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const t1 = pts[i].time || 0;
    const t2 = pts[i + 1].time || 0;
    if (t1 <= targetTime && t2 >= targetTime) {
      idx = i;
      break;
    }
  }
  if (idx >= pts.length - 1) idx = pts.length - 2;

  const p1 = pts[idx];
  const p2 = pts[idx + 1];
  const t1 = p1.time || 0;
  const t2 = p2.time || 0;
  const segDuration = t2 - t1;
  const t = segDuration > 0 ? (targetTime - t1) / segDuration : 0;

  const lon1 = p1.lon !== undefined ? p1.lon : p1[0];
  const lat1 = p1.lat !== undefined ? p1.lat : p1[1];
  const lon2 = p2.lon !== undefined ? p2.lon : p2[0];
  const lat2 = p2.lat !== undefined ? p2.lat : p2[1];

  const lon = lon1 + (lon2 - lon1) * t;
  const lat = lat1 + (lat2 - lat1) * t;
  const speed = (p1.speed || 0) + ((p2.speed || 0) - (p1.speed || 0)) * t;
  const lean = (p1.lean || 0) + ((p2.lean || 0) - (p1.lean || 0)) * t;

  let dist = 0;
  for (let i = 0; i < idx; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const aLon = a.lon !== undefined ? a.lon : a[0];
    const aLat = a.lat !== undefined ? a.lat : a[1];
    const bLon = b.lon !== undefined ? b.lon : b[0];
    const bLat = b.lat !== undefined ? b.lat : b[1];
    dist += haversineDistance([aLon, aLat], [bLon, bLat]);
  }
  dist += haversineDistance([lon1, lat1], [lon, lat]);

  replayState.marker.setLngLat([lon, lat]);

  document.getElementById('replay-hud-speed').textContent = Math.round(speed);
  document.getElementById('replay-hud-lean').textContent = Math.round(lean) + '°';
  document.getElementById('replay-hud-dist').textContent = dist.toFixed(1);

  const pct = (virtualTime / replayState.totalDuration) * 100;
  document.getElementById('replay-slider').value = pct;

  document.getElementById('replay-current').textContent = formatTime(virtualTime / 1000);
}

function seekReplay(pct) {
  if (!replayState) return;
  replayState.virtualTime = (pct / 100) * replayState.totalDuration;
  updateReplayPosition(replayState.virtualTime);
}

function updateReplayUI(virtualTime) {
  if (!replayState) return;
  const pct = (virtualTime / replayState.totalDuration) * 100;
  document.getElementById('replay-slider').value = pct;
  document.getElementById('replay-current').textContent = formatTime(virtualTime / 1000);
  document.getElementById('replay-total').textContent = formatTime(replayState.totalDuration / 1000);
  document.getElementById('replay-hud-speed').textContent = '0';
  document.getElementById('replay-hud-lean').textContent = '0°';
  document.getElementById('replay-hud-dist').textContent = '0.0';
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return m + ':' + s;
}

function stopReplay() {
  if (replayState) {
    pauseReplay();
    replayState.marker.remove();
    replayState = null;
  }
  if (map.getSource('replay-track')) {
    map.getSource('replay-track').setData({ type: 'FeatureCollection', features: [] });
  }
  clearPhotoMarkers();
  document.getElementById('replay-overlay').classList.add('hidden');
  document.getElementById('top-bar').classList.remove('hidden');
  document.getElementById('bottom-panel').classList.remove('hidden');
}

/* ---------- Panel Drag ---------- */

function initPanelDrag() {
  const handle = document.getElementById('panel-handle');
  const panel = document.getElementById('bottom-panel');
  let isDragging = false;
  let startY, startHeight, moved = false;

  function getClientY(e) {
    return e.touches ? e.touches[0].clientY : e.clientY;
  }

  function startDrag(e) {
    isDragging = true;
    moved = false;
    startY = getClientY(e);
    const rect = panel.getBoundingClientRect();
    startHeight = rect.height;

    panel.classList.remove('collapsed');
    panel.style.transition = 'none';
    panel.style.transform = 'none';
    panel.style.maxHeight = 'none';
    panel.style.height = startHeight + 'px';
    handle.style.cursor = 'grabbing';
  }

  function onDrag(e) {
    if (!isDragging) return;
    if (e.cancelable) e.preventDefault();
    const y = getClientY(e);
    const delta = Math.abs(y - startY);
    if (delta > 5) moved = true;
    const deltaY = startY - y;
    const newHeight = Math.min(Math.max(startHeight + deltaY, 56), window.innerHeight * 0.85);
    panel.style.height = newHeight + 'px';
  }

  function endDrag() {
    if (!isDragging) return;
    isDragging = false;
    handle.style.cursor = 'grab';

    const currentHeight = parseFloat(panel.style.height);
    panel.style.transition = '';

    if (!moved) {
      panel.classList.toggle('collapsed');
      panel.style.height = '';
      panel.style.maxHeight = '';
      panel.style.transform = '';
      return;
    }

    if (currentHeight < 120) {
      panel.classList.add('collapsed');
    } else {
      panel.classList.remove('collapsed');
    }
    panel.style.height = '';
    panel.style.maxHeight = '';
    panel.style.transform = '';
  }

  handle.addEventListener('mousedown', startDrag);
  handle.addEventListener('touchstart', startDrag, { passive: true });

  window.addEventListener('mousemove', onDrag);
  window.addEventListener('touchmove', onDrag, { passive: false });

  window.addEventListener('mouseup', endDrag);
  window.addEventListener('touchend', endDrag);
}

/* ---------- Modals & Toasts ---------- */

function showHistoryModal() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-history').classList.remove('hidden');
}

function showSettingsModal() {
  loadSavedRoutes();
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-settings').classList.remove('hidden');
}

function showToast(msg) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.5s';
    setTimeout(() => toast.remove(), 500);
  }, 3000);
}

/* ---------- Welcome Screen & Auth ---------- */

function initFirebase() {
  if (!FIREBASE_CONFIGURED) {
    console.log('Firebase not configured. Cloud sync disabled.');
    checkWelcomeScreen();
    return;
  }
  try {
    firebaseApp = firebase.initializeApp(firebaseConfig);
    firebaseAuth = firebase.auth();
    firebaseDb = firebase.firestore();

    firebaseAuth.onAuthStateChanged(user => {
      currentUser = user;
      updateAuthUI();
      if (user) {
        hideWelcomeScreen();
        syncRidesFromCloud();
      } else {
        checkWelcomeScreen();
      }
    });
  } catch (e) {
    console.error('Firebase init failed', e);
    checkWelcomeScreen();
  }
}

function checkWelcomeScreen() {
  if (localStorage.getItem('curveRunner_welcomeSeen') === 'true') {
    hideWelcomeScreen();
    return;
  }
  showWelcomeScreen();
}

function showWelcomeScreen() {
  const screen = document.getElementById('welcome-screen');
  if (screen) screen.classList.remove('hidden');
}

function hideWelcomeScreen() {
  const screen = document.getElementById('welcome-screen');
  if (screen) screen.classList.add('hidden');
}

async function signInWithGoogle() {
  if (!firebaseAuth) return showToast('Firebase not configured');
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await firebaseAuth.signInWithPopup(provider);
    showToast('Signed in with Google');
  } catch (e) {
    showToast('Google sign-in failed: ' + e.message);
  }
}

async function signInWithEmail() {
  if (!firebaseAuth) return showToast('Firebase not configured');
  const email = document.getElementById('welcome-email').value.trim();
  const password = document.getElementById('welcome-password').value;
  if (!email || !password) return showToast('Enter email and password');
  try {
    await firebaseAuth.signInWithEmailAndPassword(email, password);
    showToast('Signed in');
  } catch (e) {
    showToast('Sign in failed: ' + e.message);
  }
}

async function signUpWithEmail() {
  if (!firebaseAuth) return showToast('Firebase not configured');
  const email = document.getElementById('welcome-email').value.trim();
  const password = document.getElementById('welcome-password').value;
  if (!email || !password) return showToast('Enter email and password');
  if (password.length < 6) return showToast('Password must be at least 6 characters');
  try {
    await firebaseAuth.createUserWithEmailAndPassword(email, password);
    showToast('Account created!');
  } catch (e) {
    showToast('Sign up failed: ' + e.message);
  }
}

async function signOutUser() {
  if (!firebaseAuth) return;
  try {
    await firebaseAuth.signOut();
    showToast('Signed out');
  } catch (e) {
    showToast('Sign out failed: ' + e.message);
  }
}

function updateAuthUI() {
  const statusDiv = document.getElementById('account-status');
  const signInBtn = document.getElementById('btn-settings-signin');
  const signOutBtn = document.getElementById('btn-settings-signout');
  if (!statusDiv || !signInBtn || !signOutBtn) return;

  if (currentUser) {
    const name = currentUser.displayName || currentUser.email || 'Signed in';
    statusDiv.textContent = '☁️ ' + name;
    signInBtn.classList.add('hidden');
    signOutBtn.classList.remove('hidden');
  } else {
    statusDiv.textContent = 'Not signed in — rides saved locally only';
    signInBtn.classList.remove('hidden');
    signOutBtn.classList.add('hidden');
  }
}

function showInstallHelpModal() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-install-help').classList.remove('hidden');
}

/* ---------- Cloud Sync ---------- */

async function saveRideToCloud(ride) {
  if (!currentUser || !firebaseDb) return;
  try {
    const cloudData = { ...ride };
    delete cloudData.syncedAt; // will be added by server
    await firebaseDb.collection('users').doc(currentUser.uid).collection('rides').doc(String(ride.id)).set({
      ...cloudData,
      syncedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    console.log('Ride saved to cloud');
  } catch (e) {
    console.error('Cloud save failed', e);
    showToast('Cloud sync failed — saved locally');
  }
}

async function syncRidesFromCloud() {
  if (!currentUser || !firebaseDb) return;
  try {
    showToast('Syncing rides from cloud...');
    const snapshot = await firebaseDb.collection('users').doc(currentUser.uid).collection('rides').get();
    const cloudRides = snapshot.docs.map(d => {
      const data = d.data();
      // Remove Firestore timestamp objects before storing in IndexedDB
      delete data.syncedAt;
      return data;
    });

    const tx = db.transaction('rides', 'readwrite');
    const store = tx.objectStore('rides');

    const getAllReq = store.getAll();
    getAllReq.onsuccess = (e) => {
      const localRides = e.target.result;
      const localIds = new Set(localRides.map(r => r.id));
      let added = 0;
      for (const ride of cloudRides) {
        if (!localIds.has(ride.id)) {
          store.add(ride);
          added++;
        }
      }
      tx.oncomplete = () => {
        if (added > 0) {
          showToast(`Synced ${added} ride${added > 1 ? 's' : ''} from cloud`);
          loadHistory();
        } else {
          showToast('Rides up to date');
        }
      };
    };
  } catch (e) {
    console.error('Cloud sync failed', e);
    showToast('Cloud sync failed');
  }
}

function toggleReplayLeanMode() {
  replayMode = replayMode === 'lean' ? 'speed' : 'lean';
  const btn = document.getElementById('btn-replay-lean');
  if (replayMode === 'lean') {
    btn.classList.add('active');
    btn.style.background = 'var(--accent)';
    showToast('Lean heatmap mode');
  } else {
    btn.classList.remove('active');
    btn.style.background = '';
    showToast('Speed heatmap mode');
  }
  if (replayState && replayState.ride) {
    const segments = buildReplaySegments(replayState.ride.points);
    if (map.getSource('replay-track')) {
      map.getSource('replay-track').setData({ type: 'FeatureCollection', features: segments });
    }
  }
}

function leanToColor(lean, maxLean) {
  const t = Math.min(lean / Math.max(maxLean, 1), 1);
  if (t < 0.33) {
    return `rgb(0, ${Math.round(255 * (1 - t * 3))}, 0)`;
  } else if (t < 0.66) {
    return `rgb(${Math.round(255 * ((t - 0.33) * 3))}, 255, 0)`;
  } else {
    return `rgb(255, ${Math.round(255 * (1 - (t - 0.66) * 3))}, 0)`;
  }
}

/* ---------- Weather ---------- */

async function showWeatherModalForRoute() {
  if (!currentRoute) return showToast('No route to check weather');
  showToast('Fetching weather...');
  const coords = currentRoute.geometry.coordinates;
  const sampled = samplePoints(coords, 6);
  const cards = document.getElementById('weather-cards');
  cards.innerHTML = '';

  for (const pt of sampled) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${pt[1]}&longitude=${pt[0]}&current=temperature_2m,weather_code,wind_speed_10m`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const cur = data.current;
      const emoji = weatherCodeToEmoji(cur.weather_code);
      const card = document.createElement('div');
      card.className = 'weather-card';
      card.innerHTML = `
        <div class="emoji">${emoji}</div>
        <div class="info">
          <div class="loc">${pt[1].toFixed(3)}, ${pt[0].toFixed(3)}</div>
          <div class="temp">${Math.round(cur.temperature_2m)}°C</div>
          <div class="detail">Wind ${Math.round(cur.wind_speed_10m)} km/h</div>
        </div>
      `;
      cards.appendChild(card);
    } catch (e) {
      console.error('Weather fetch failed', e);
    }
  }
  document.getElementById('modal-weather').querySelector('h2').textContent = 'Weather Along Route';
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-weather').classList.remove('hidden');
}

function weatherCodeToEmoji(code) {
  const map = {
    0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
    45: '🌫️', 48: '🌫️',
    51: '🌦️', 53: '🌦️', 55: '🌧️',
    61: '🌧️', 63: '🌧️', 65: '🌧️',
    71: '🌨️', 73: '🌨️', 75: '🌨️', 77: '🌨️',
    80: '🌦️', 81: '🌧️', 82: '🌧️',
    95: '⛈️', 96: '⛈️', 99: '⛈️'
  };
  return map[code] || '🌡️';
}

/* ---------- Group Ride ---------- */

function showGroupModal() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-group').classList.remove('hidden');
  const hostView = document.getElementById('group-host-view');
  const riderView = document.getElementById('group-rider-view');
  if (groupTopic) {
    hostView.classList.remove('hidden');
    riderView.classList.add('hidden');
    const shareUrl = `${window.location.origin}${window.location.pathname}?group=${encodeURIComponent(groupTopic)}`;
    document.getElementById('group-share-link').textContent = shareUrl;
    document.getElementById('btn-stop-group').classList.remove('hidden');
  } else {
    hostView.classList.remove('hidden');
    riderView.classList.add('hidden');
    generateGroupTopic();
    const shareUrl = `${window.location.origin}${window.location.pathname}?group=${encodeURIComponent(groupTopic)}`;
    document.getElementById('group-share-link').textContent = shareUrl;
    document.getElementById('btn-stop-group').classList.add('hidden');
  }
}

function generateGroupTopic() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let topic = 'curve-';
  for (let i = 0; i < 8; i++) topic += chars.charAt(Math.floor(Math.random() * chars.length));
  groupTopic = topic;
  localStorage.setItem('curveRunner_groupTopic', topic);
}

function copyGroupLink() {
  if (!groupTopic) generateGroupTopic();
  const shareUrl = `${window.location.origin}${window.location.pathname}?group=${encodeURIComponent(groupTopic)}`;
  navigator.clipboard.writeText(shareUrl).then(() => {
    showToast('Link copied! Share it with your group.');
    document.getElementById('btn-stop-group').classList.remove('hidden');
  }).catch(() => {
    showToast('Could not copy link');
  });
}

function stopGroupRideSharing() {
  if (groupEventSource) {
    groupEventSource.close();
    groupEventSource = null;
  }
  groupTopic = null;
  localStorage.removeItem('curveRunner_groupTopic');
  Object.values(friendMarkers).forEach(m => m.remove());
  friendMarkers = {};
}

async function postGroupPosition(topic, lon, lat, speed) {
  try {
    const payload = `${lon.toFixed(6)},${lat.toFixed(6)},${Math.round(speed)}`;
    await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: payload });
  } catch (e) {
    console.error('Group post failed', e);
  }
}

function subscribeGroupRide(topic) {
  stopGroupRideSharing();
  groupTopic = topic;
  try {
    groupEventSource = new EventSource(`https://ntfy.sh/${topic}/sse`);
    groupEventSource.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleGroupMessage(msg);
    };
    groupEventSource.onerror = () => {
      console.error('Group SSE error');
    };
  } catch (e) {
    console.error('Failed to subscribe to group ride', e);
  }
}

function handleGroupMessage(msg) {
  if (!msg || !msg.message) return;
  const parts = msg.message.split(',');
  if (parts.length < 2) return;
  const lon = parseFloat(parts[0]);
  const lat = parseFloat(parts[1]);
  if (isNaN(lon) || isNaN(lat)) return;

  const id = msg.id || 'friend';
  if (!friendMarkers[id]) {
    const el = document.createElement('div');
    el.className = 'friend-dot';
    friendMarkers[id] = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
  } else {
    friendMarkers[id].setLngLat([lon, lat]);
  }
  showToast('👥 Group rider updated');
}

/* ---------- Curve Detection ---------- */

function detectCurves(points) {
  if (!points || points.length < 3) return [];
  const curves = [];
  for (let i = 1; i < points.length - 1; i++) {
    const A = points[i - 1];
    const B = points[i];
    const C = points[i + 1];
    const r = radiusOfCurvature(A, B, C);
    if (r > 0 && r < 800) {
      const avgSpeed = ((A.speed || 0) + (B.speed || 0) + (C.speed || 0)) / 3;
      const maxLean = Math.max(Math.abs(A.lean || 0), Math.abs(B.lean || 0), Math.abs(C.lean || 0));
      let score = (800 / r) * (avgSpeed / 60) * (maxLean / 30);
      score = Math.min(10, Math.max(1, score * 5));
      curves.push({
        index: i,
        radius: Math.round(r),
        avgSpeed: Math.round(avgSpeed),
        maxLean: Math.round(maxLean),
        score: score.toFixed(1)
      });
    }
  }
  // Sort by score descending, keep top 20
  curves.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
  return curves.slice(0, 20);
}

function radiusOfCurvature(A, B, C) {
  const lon1 = A.lon !== undefined ? A.lon : A[0];
  const lat1 = A.lat !== undefined ? A.lat : A[1];
  const lon2 = B.lon !== undefined ? B.lon : B[0];
  const lat2 = B.lat !== undefined ? B.lat : B[1];
  const lon3 = C.lon !== undefined ? C.lon : C[0];
  const lat3 = C.lat !== undefined ? C.lat : C[1];

  // Convert to local meters using equirectangular approximation
  const scale = Math.cos(((lat1 + lat2 + lat3) / 3) * Math.PI / 180) * 111320;
  const x1 = lon1 * scale, y1 = lat1 * 111320;
  const x2 = lon2 * scale, y2 = lat2 * 111320;
  const x3 = lon3 * scale, y3 = lat3 * 111320;

  const a = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  const b = Math.sqrt((x3 - x2) ** 2 + (y3 - y2) ** 2);
  const c = Math.sqrt((x3 - x1) ** 2 + (y3 - y1) ** 2);

  const area = 0.5 * Math.abs((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
  if (area < 1e-6) return Infinity;
  return (a * b * c) / (4 * area);
}

function showCurveModal(curves) {
  const list = document.getElementById('curves-list');
  list.innerHTML = '';
  if (!curves || !curves.length) {
    list.innerHTML = '<p style="color:var(--text-dim)">No significant curves detected.</p>';
  } else {
    curves.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'curve-item';
      item.innerHTML = `
        <div class="score-row">
          <span class="score">${c.score}/10</span>
          <span style="font-size:0.85rem;color:var(--text-dim)">#${i + 1}</span>
        </div>
        <div class="meta">
          Radius ${c.radius}m · Speed ${c.avgSpeed} km/h · Lean ${c.maxLean}°
        </div>
      `;
      list.appendChild(item);
    });
  }
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-curves').classList.remove('hidden');
}

/* ---------- Photo Waypoints ---------- */

let photoMarkers = [];

function dropPhotoWaypoint() {
  if (!isRiding) return showToast('Start a ride to drop photos');
  document.getElementById('photo-capture').click();
}

function handlePhotoCapture(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    if (!rideData.photos) rideData.photos = [];
    const lastPoint = rideData.points[rideData.points.length - 1];
    if (!lastPoint) return;
    rideData.photos.push({
      lon: lastPoint.lon,
      lat: lastPoint.lat,
      dataUrl: dataUrl,
      time: Date.now()
    });
    showToast('Photo dropped! 📷');
    speak('Photo saved');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

function showPhotoMarkers(photos) {
  clearPhotoMarkers();
  photos.forEach(p => {
    const el = document.createElement('div');
    el.className = 'photo-marker';
    el.textContent = '📷';
    el.addEventListener('click', () => {
      const img = document.createElement('img');
      img.src = p.dataUrl;
      img.style.cssText = 'max-width:100%;border-radius:12px;margin-bottom:10px;';
      const container = document.createElement('div');
      container.appendChild(img);
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px;';
      modal.appendChild(container);
      modal.addEventListener('click', () => modal.remove());
      document.body.appendChild(modal);
    });
    const marker = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
    photoMarkers.push(marker);
  });
}

function clearPhotoMarkers() {
  photoMarkers.forEach(m => m.remove());
  photoMarkers = [];
}

function showPhotosModal(photos) {
  const grid = document.getElementById('photos-grid');
  grid.innerHTML = '';
  if (!photos || !photos.length) {
    grid.innerHTML = '<p style="color:var(--text-dim)">No photos for this ride.</p>';
  } else {
    photos.forEach(p => {
      const img = document.createElement('img');
      img.src = p.dataUrl;
      img.className = 'photo-thumb';
      img.addEventListener('click', () => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:60;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px;';
        const fullImg = document.createElement('img');
        fullImg.src = p.dataUrl;
        fullImg.style.cssText = 'max-width:100%;max-height:90vh;border-radius:12px;';
        modal.appendChild(fullImg);
        modal.addEventListener('click', () => modal.remove());
        document.body.appendChild(modal);
      });
      grid.appendChild(img);
    });
  }
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-photos').classList.remove('hidden');
}
