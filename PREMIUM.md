# CurveRunner — Premium vs Free Tier

> **Current status:** All premium features are enabled for free. Toggle between Free and Premium in the top bar.

---

## Free Tier

### Navigation & Routing
- **Auto-locate** on first app load — centers map on your GPS position automatically
- **Save & restore map view** — remembers last zoom, pan, and position between sessions
- **Named waypoints** — waypoints are labeled with their real-world location (reverse geocoded) instead of generic "Point 1, Point 2"
- **Straight-line preview** — dashed orange lines between waypoints so you can plan the shape
- **Manual "Route Through Points"** — one-click calculation of the actual road route through all waypoints
- **Up to 3 waypoints** for road routing — add more points, but road routing stops at 3 until you upgrade
- **Voice navigation** — turn-by-turn speech prompts piped to your Bluetooth helmet
- **Direction arrow** — your GPS icon is an arrow that points in the direction your phone is facing (using GPS heading or compass). It rotates with the map so it always points the way you're going
- **Draggable bottom panel** — grab the handle to resize the panel up and down with your finger or mouse
- **GPX import/export** — bring in routes from other apps, export your planned routes
- **Autocomplete location search** — as you type "High" or "Cypr", the app queries nearby locations and suggests "Highland, CA", "Cypress, CA", etc.

### Ride Recording
- **Live ride HUD** — speed, lean angle, distance, timer
- **Ride history** — stored locally on your phone forever
- **Basic ride stats** — max speed, max lean, total distance, duration
- **Save routes offline** — cache routes for no-signal areas

---

## Premium Tier

### Everything in Free, plus:

### Live Navigation & Ride Mode
- **Auto-snap to route on ride start** — when you tap "Start Ride", the app grabs your GPS position, finds the nearest point on the planned route, and immediately begins turn-by-turn navigation from where you are (not from the original start point)
- **Two navigation view modes** (like Google Maps):
  - **📍 Follow mode** — map smoothly centers on your live GPS position, rotates to your heading, and zooms in so you can see upcoming turns
  - **🗺️ Overview mode** — map zooms out to show the entire route at a glance; tap 📍 to snap back to follow mode
- **🧭 Compass toggle** — tap the compass button to alternate between **North-up** (map always points north) and **Heading-up** (map rotates to face the direction your phone is pointed). Uses GPS heading when moving, device compass when stationary
- **Dynamic turn re-snap** — if you skip a turn or take a detour, the app recalculates which maneuver you're closest to every GPS tick and resumes guidance from the next upcoming turn
- **Off-route rejoin** — if you miss a turn, the app detects you're off the original route, calculates a temporary path to the nearest point ahead on your planned route, and guides you back. Once you rejoin, it automatically resumes the original route guidance. No U-turns, no backtracking
- **Cancel navigation** — a "Cancel Navigation" button appears during any ride so you can abort turn-by-turn guidance and return to planning without saving a ride record

### Advanced Waypoint Routing
- **Unlimited waypoints** — no 3-waypoint cap; route through as many points as you want
- **Auto-routing through all waypoints** — the actual road route is automatically calculated and displayed through every waypoint as you add them
- **Auto-updating route** — drag a marker, add a point, or reorder waypoints and the road route recalculates in real-time (no button presses)
- **Multi-leg route display** — see the full continuous road route from start through every intermediate waypoint to the destination
- **Reorder animations** — markers flash and pulse when you move them up/down so you know the change took effect
- **Intelligent route discovery** — the app automatically tests multiple curviness levels and finds all distinct available routes, then presents them as named options (Straight path, Least curves, Curvy, More curvy, Even more curvy, Maximum curvy, etc.) instead of a confusing slider
- **Route from current location** — in Waypoint mode, tapping "Start Ride" automatically routes from your live GPS position to the first waypoint, then through all remaining points. No need to manually set a start point

### Ride Analysis
- **Ride replay** — watch your recorded ride on the map with a speed color-coded route (green = slow, red = fast)
- **Scrubber & playback controls** — drag through the ride, play at 1x/2x/4x speed
- **Lean angle heatmap** — replay your ride colored by how hard you leaned in each corner (green = gentle, red = aggressive). Toggle between speed and lean views
- **Elevation profile** — chart of hills and climbs for any route or recorded ride with total climb, descent, max grade, and min/max elevation
- **Curve detection & scoring** — automatically scores every corner on your ride (1–10) based on radius, speed, and lean angle. View the top 20 curves in a ranked list
- **Photo waypoint drops** — tap the camera button mid-ride to snap a geotagged photo. Photos appear as markers on the replay map and in a gallery in your ride history
- **Weather along route** — fetch current weather (temperature, conditions, wind) for sampled points along your planned route using Open-Meteo

### Group Ride Tracking
- **Live group ride sharing** — tap the 👥 button during a ride to generate a shareable link. The app posts your live GPS position every 10 seconds via ntfy.sh (free, no API key)
- **Friends watch your dot** — anyone who opens the shared link sees your live position on their map as a green dot
- **No account needed** — just share the link and ride. No backend server required.

### Pocket Mode Calibration (🤏)
- **Calibrate for your pocket** — keep your phone in your pocket while riding. The app measures the baseline angle of your phone in your pocket while you're upright on the motorcycle, then subtracts that baseline from every future lean reading
- **Adjustable delay timer** — choose a 30-second, 1-minute, 2-minute, or 5-minute delay before calibration begins. Gives you time to put the phone in your pocket, get on the bike, and settle in before it starts measuring
- **Voice countdown prompts** — the app speaks alerts at 30s, 10s, and 5s remaining, then says "Calibration starting now. Please remain upright for three seconds." Hands-free, eyes-free setup
- **Not as accurate as a handlebar mount** — the app warns you that pocket fabric shifts, body position changes, and the phone can move. Results will vary. For the most accurate lean data, mount the phone to your handlebars with a QuadLock or RAM mount
- **Dismissible warning** — tap "Don't show this warning again" if you already know the trade-offs and want a faster setup
- **Re-calibrate anytime** — your body position or pocket changes? Re-calibrate from Settings or the 🤏 button in the top bar
- **Live lean indicator** — when Pocket Mode is active, the HUD shows "Lean 📱" so you know the numbers are calibrated for your pocket

### Account & Cloud Sync
- **Cross-device ride history** — create a free account with Google or email to back up every ride to the cloud. View your stats, replays, and photos on any phone or tablet
- **Automatic sync** — finish a ride on one device, open the app on another, and your history appears instantly
- **No lock-in** — export any ride as GPX at any time; your data is always yours

### Coming Soon to Premium
- Additional route styles (scenic, fastest, etc.)
- Export to Scenic / Calimoto formats

---

---

## Firebase Setup (Required for Cloud Sync)

1. Go to [Firebase Console](https://console.firebase.google.com/project/curverunner-b224e)
2. **Authentication → Sign-in method** → enable **Google** and **Email/Password**
3. **Authentication → Settings → Authorized domains** → add `mjmorrison10.github.io`
4. **Firestore Database → Create database** → Start in production mode
5. **Firestore Rules** → paste and publish:
   ```javascript
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```
   > **Note:** `{document=**}` is a recursive wildcard that allows ALL subcollections under the user's document (e.g., `/users/{uid}/rides/{rideId}`). Without it, writes to subcollections will fail with "Missing or insufficient permissions."

*Toggle Free / Premium anytime from the button in the top bar. Sign in via Settings to enable cloud sync.*
