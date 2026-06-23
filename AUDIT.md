# CurveRunner Code Audit

Date: 2026-06-23

## Biggest Bottlenecks

### 1. Architecture
- `app.js` is ~4,000 lines of mixed concerns (map, GPS, routing, auth, UI, modals, replay, sensors, etc.).
- No module boundaries; everything shares global state.
- Dead code and stale comments exist (e.g. `curviness sliders removed`).

### 2. Map Performance
- All map markers are DOM elements; no marker clustering.
- Route data is fetched eagerly when waypoints change; no lazy loading.
- Service worker caches app shell but does not aggressively cache map tiles for offline use.
- No debounce on route preview recalculations.

### 3. Riding-Mode UX
- Touch targets are inconsistent; some are 36–40px.
- No dedicated riding-mode view; bottom panel stays visible during navigation.
- No high-contrast/sunlight mode.
- Text-heavy instructions in the nav banner.

### 4. GPS Handling
- Raw GPS updates are applied directly; no smoothing (Kalman/low-pass).
- No handling for GPS signal loss.
- Background location is not explicitly handled for iOS/Android PWAs.

### 5. Route Discovery
- Curviness is internal; no visible rating/badge for the rider.
- No filtering by distance/length/curviness.
- No route preview cards with elevation/curve density.
- Empty states are missing.

### 6. Offline/PWA
- Map tiles are not cached for saved routes.
- No explicit offline indicator.
- No splash screen beyond the manifest.
- Route caching is limited to IndexedDB; not surfaced as "download for offline".

### 7. UI Polish
- Inconsistent spacing/typography.
- No loading skeletons for route lists.
- Text selection is not disabled globally.
- Safe-area handling is partial.

## Prioritized Implementation Plan

1. **Foundation**: modularize source, improve service worker tile caching, update manifest/splash.
2. **Map Performance**: lazy route discovery, marker clustering, debounce recalculations.
3. **Riding Mode**: large touch targets, high-contrast mode, dedicated fullscreen nav view, UI lock.
4. **GPS**: smoothing, signal-loss handling, background location graceful degradation.
5. **Route Discovery**: curviness badge, route preview cards, filtering, empty states.
6. **Offline**: route download, offline indicator, tile caching for saved routes.
7. **Polish**: skeletons, consistent spacing, disable text selection, safe areas.
