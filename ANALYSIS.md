# CurveRunner — Hivemind Optimization Report

> **Objective:** Increase site speed, maximize UX smoothness, and improve overall quality.
> A panel of senior engineers (Apple / Google / Microsoft / X / SpaceX) analyzed the codebase,
> test-ran the app, debated each recommendation, and voted. Any item reaching **≥80% approval
> was implemented.** This file is the record of that process.

---

## How the hivemind worked

| Phase | Activity |
|------|----------|
| **1. Analyze** | Every member read `index.html`, `app.js` (3,759 lines), `style.css`, `sw.js`, `manifest.json`, assets. |
| **2. Test-run** | Cloned the repo, syntax-checked all JS, served it locally, measured transfer sizes, probed the live site and every API it depends on. |
| **3. Recommend** | Each member filed findings; findings were merged into one ranked list. |
| **4. Debate & vote** | Each member APPROVED or REJECTED every item, arguing trade-offs. Members could switch their vote if convinced. |
| **5. Implement** | Items with ≥80% approval were shipped to the working tree. |

### The panel
- **Adrian** — Senior Frontend / Web Performance (ex-Google). Owns load time, render path, bundles.
- **Marcus** — Mobile / PWA Engineer (ex-Apple). Owns installed-app behavior, sensors, battery.
- **Priya** — Quality & Accessibility Engineer (ex-Microsoft). Owns correctness, a11y, test coverage.
- **Diego** — Backend / Reliability Engineer (ex-SpaceX). Owns APIs, data, rate limits, offline.
- **Lena** — Mobile UX Designer (ex-Stripe/X). Owns motion, touch, perceived performance.

---

## Phase 1 — Test-run & analysis findings (shared)

**Stack:** vanilla JS + MapLibre GL, Firebase (Auth+Firestore), Valhalla/OSM routing, Nominatim geocoding, Open-Meteo weather, ntfy.sh group sharing, Service Worker + IndexedDB. No build step.

**Measured before:**

| Asset | Size |
|------|------|
| `favicon.png` | **712 KB** (1024×1024 used as a favicon) |
| `icon.png` | **278 KB** (declared `192x192` in manifest, actually 1024×1024) |
| `app.js` | 132 KB (unminified) |
| Firebase (app+auth+firestore) | **~500 KB raw (~150 KB gzip)** — loaded on **every** page load, render-blocking |
| MapLibre GL | 745 KB (core map — unavoidable, but uncached-for-offline-first) |

**Key defects identified across the panel:**

1. **~990 KB of images on the critical path.** A 712 KB favicon and 278 KB icon, both 1024×1024. Brutal on mobile data.
2. **4 render-blocking external `<script>` tags + the app script**, none deferred. Firebase blocks first paint even for users who never sign in.
3. **No Screen Wake Lock during rides.** A motorcycle nav app that *warns the user to keep the screen on* but never actually prevents sleep — the screen can lock mid-ride.
4. **`O(n)` full-route scans on every GPS tick.** `snapToRoute` / `updateNav` linear-scan the entire route (and the entire original route, again) on every 1 Hz position update. Janky on long routes.
5. **Jittery follow camera.** `map.easeTo` every tick with `easing: t => t` (linear) and no heading smoothing → mechanical, spin-prone motion.
6. **Route discovery is strictly sequential** — up to 9 Valhalla calls with 600 ms gaps (~5–9 s of waiting) before the user sees options.
7. **Curvy-roads query pulls every highway type** (footways, paths, cycleways, service roads) for the whole viewport — enormous Overpass payloads, can freeze the map.
8. **`getAll()` in history** loads every ride including base64 photo data URLs into memory on every history open.
9. **`location.reload(true)`** — deprecated boolean argument.
10. **Nominatim calls set a `User-Agent` header** — a *forbidden* fetch header that browsers silently strip; misleading dead code.
11. **PWA manifest** declares one icon at the wrong size; no `maskable`/512 icons — poor install icon on Android.
12. **Accessibility gaps:** icon buttons rely on emoji, no `aria-label`s; toasts/nav banner not `aria-live`; inputs label-less.
13. **Toast spam:** the group-ride path fires a toast on every inbound position.
14. **Service worker** caches naively and atomically (one failed precache breaks install); no navigation preload.

---

## Phase 2 — Recommendations (ranked by impact)

Each was written as a concrete, testable change.

**P1 — Speed**
- R1. Resize/optimize images; ship a complete PWA icon set (192/512/maskable/apple-touch/favicons).
- R2. Make scripts non-blocking (`defer`) and **lazy-load Firebase** off the critical path.
- R3. Add resource `preconnect`/`dns-prefetch` for all third-party origins.
- R4. Minify `app.js` + `style.css`; ship `.min` bundles.
- R5. Parallelize route discovery (limited concurrency + early exit).
- R6. Cursor-based nearest-point search for live nav (kill the per-tick full scan).
- R7. Trim the Overpass query + viewport guard for the curvy-roads layer.

**P2 — Smoothness / UX**
- R8. Screen Wake Lock during rides (+ re-acquire on return to foreground).
- R9. Smooth the follow camera (remove linear easing, low-pass heading filter, `essential`).
- R10. Haptic feedback on turn cues / off-route / ride start.
- R11. De-duplicate & cap toasts (fix group-ride spam).

**P3 — Quality / A11y**
- R12. Fix `manifest.json` (correct sizes, `maskable` + `512`).
- R13. Fix `location.reload(true)`.
- R14. Remove forbidden `User-Agent` header; document Nominatim policy reliance on `Referer`.
- R15. Accessibility: `aria-label`s, `aria-live` regions, input labels.
- R16. Upgrade service worker (navigation preload, non-atomic precache, version bump).

**Considered but deferred (see votes below)**
- R17. Store ride summaries separately / lazy-load point arrays in history (DB migration).
- R18. Store photos as Blobs in a separate IndexedDB object store instead of base64.
- R19. Allow pinch-to-zoom (`user-scalable=yes`) for WCAG 1.4.4.
- R20. Auto-generate an `apple-touch-startup-image` set.

---

## Phase 3 — Debate & vote (5 members; 80% = 4 APPROVE)

Legend: ✓ APPROVE · ✗ REJECT · A=Adrian M=Marcus P=Priya D=Diego L=Lena. **Result** is APPROVED if ≥4 ✓.

| # | Recommendation | A | M | P | D | L | Result |
|---|----------------|---|---|---|---|---|--------|
| R1 | Optimize images + full icon set | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R2 | Defer scripts + lazy-load Firebase | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R3 | preconnect / dns-prefetch | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R4 | Minify app + css | ✓ | ✓ | ✗ | ✓ | ✓ | **APPROVED (4/5)** |
| R5 | Parallelize route discovery | ✓ | ✓ | ✓ | ✓¹ | ✓ | **APPROVED (5/5)** |
| R6 | Cursor-based nav search | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R7 | Trim Overpass + viewport guard | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R8 | Screen Wake Lock | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R9 | Smooth follow camera | ✓ | ✓ | ✓ | ✗ | ✓ | **APPROVED (4/5)** |
| R10 | Haptics | ✗ | ✓ | ✓ | ✓ | ✓ | **APPROVED (4/5)** |
| R11 | De-dup / cap toasts | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R12 | Fix manifest icons | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R13 | `reload()` fix | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R14 | Remove forbidden UA header | ✓ | ✓ | ✓ | ✓ | ✗ | **APPROVED (4/5)** |
| R15 | ARIA / a11y | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R16 | Service worker upgrade | ✓ | ✓ | ✓ | ✓ | ✓ | **APPROVED (5/5)** |
| R17 | Ride-summary store / lazy points | ✓ | ✗ | ✓ | ✓ | ✗ | **REJECTED (3/5)** |
| R18 | Photos as Blobs | ✓ | ✓ | ✗ | ✓ | ✗ | **REJECTED (3/5)** |
| R19 | Pinch-to-zoom (WCAG) | ✗ | ✗ | ✓ | ✗ | ✗ | **REJECTED (1/5)** |
| R20 | Apple startup images | ✗ | ✓ | ✗ | ✗ | ✗ | **REJECTED (2/5)** |

### Notable debates (why votes moved)

- **R4 (minify)** — Priya initially REJECTED: *"minified files hurt debuggability and the user has no build step."* Adrian/Lena changed the approach: **keep `app.js`/`style.css` as readable source and ship `app.min.js`/`style.min.css`**, plus a `build.sh` to regenerate. Priya flipped → APPROVED.
- **R5 (parallelize discovery)** — Diego, the reliability lead, flagged the free `valhalla1.openstreetmap.de` server: *"hammering it concurrently risks 429s and hurts the shared resource."* Concession: **concurrency capped at 2**, per-worker polite delay, 429 back-off + single re-queue, and early-exit at 6 distinct routes. Diego APPROVED with that cap (footnote ¹).
- **R9 (camera smoothing)** — Diego REJECTED the heading low-pass filter as *"added state that could lag the map."* But 4 others (esp. Lena/Marcus) argued linear easing + raw GPS heading is the actual jitter source. Kept the filter conservative (`t=0.35`). APPROVED 4/5.
- **R10 (haptics)** — Adrian REJECTED as *"gimmick, drains battery."* Marcus/Lena/Priya/Diego countered it's **eyes-free safety feedback** for a rider with a helmet on; wrapped in feature-detection and trivial cost. APPROVED 4/5.
- **R17/R18 (DB refactor)** — REJECTED as **too risky without a migration plan and user testing**; deferred to a follow-up. The panel agreed the *symptom* (slow history as rides accumulate) is real but a schema migration shouldn't ship in a speed pass.
- **R19 (pinch-to-zoom)** — REJECTED 1/5: it's a full-screen map app; enabling browser zoom would fight the map's own gestures and break the chrome layout. Priya (a11y) disagreed but was outvoted; flagged for a future `prefers-reduced`-aware revisit.

---

## Phase 4 — Implemented (≥80% approved)

All of **R1–R16** are in the working tree. Files changed:

| File | Change |
|------|--------|
| `index.html` | preconnect/dns-prefetch; new optimized icon links; `defer` scripts; **Firebase tags removed** (lazy-loaded); `aria-label`s; `aria-live` toast & nav banner; input labels; description meta. |
| `app.js` | Wake Lock + visibility re-acquire; haptics; lazy Firebase loader (session-aware); cursor-based nav search; smoothed follow camera; concurrent route discovery; trimmed Overpass + viewport guard; toast de-dup/cap; `reload()` fix; removed forbidden UA header. |
| `style.css` → `style.min.css` | minified production bundle (source kept). |
| `app.min.js` | minified production bundle (source kept). |
| `manifest.json` | correct 192/512 + maskable icons, scope, categories, description. |
| `sw.js` | v7; precache minified + icons; navigation preload; non-atomic precache; network-first navigation; cache-first assets/tiles. |
| `icons/*` | new 192/512/maskable-192/maskable-512/apple-touch/32/64. |
| `build.sh` | one-command re-minify after editing source. |

### Build / maintain
```bash
./build.sh        # regenerate app.min.js + style.min.css from source
```
`index.html` and `sw.js` reference the `.min` files, so edit `app.js`/`style.css`, run `build.sh`, and ship. Source stays readable.

---

## Measured impact

**Image payload:** `990 KB → 58.6 KB` (all icons) — **−94%**. The favicon alone went 712 KB → ~1 KB.

**Critical-path JS for an anonymous visitor (gzipped, as served):**

| | Before | After |
|---|---|---|
| app code | ~35 KB (`app.js` gzip) | **23.4 KB** (`app.min.js` gzip) |
| css | ~5.5 KB | **4.1 KB** |
| Firebase | ~150 KB gzip **(render-blocking)** | **0 KB** (not loaded until sign-in) |
| images on load | ~990 KB | **~30 KB** |

Net: Firebase is no longer on the critical path **at all** for the majority of users; first paint is dominated only by the unavoidable MapLibre engine (~176 KB gzip, then SW-cached).

**Routing UX:** discovery wall-time roughly halved (concurrency 2 + early exit) vs strictly sequential.

**Live nav CPU:** per-tick route scan goes from `O(route length)` to `O(window)` with exact fallback — meaningful on long routes / older phones.

**New capabilities:** the screen now actually **stays on** during a ride (Wake Lock); riders get **haptic** turn/off-route cues; install icons are correct on Android & iOS.

---

## Follow-ups (deferred, needs design/test)
- R17/R18: IndexedDB schema v2 — store ride *summaries* separately and photos as Blobs, to keep history fast as the library grows.
- R19: revisit gesture/zoom accessibility with a reduced-motion-aware approach.
- R20: apple-touch startup images for a splash on iOS.
