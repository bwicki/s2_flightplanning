# Gas Balloon Landing Predictor (GBLP)

A single-page web app for long-distance gas balloon flights. It helps plan a safe descent and landing area — including at night or above a closed cloud layer — based on current position, live wind forecasts, and configurable descent parameters.

**Current version: v60** (29.07.2026) — this number always matches the `APP_VERSION` constant near the top of the script in `index.html` and the version chip shown in the app's header.

No installation needed: open `index.html` in a browser (works as a home-screen PWA on iPad/iPhone via "Add to Home Screen"). No backend or server of any kind — everything runs entirely in the browser, using free public APIs (Open-Meteo for weather, OpenStreetMap/Overpass for map data, openAIP for airspace, Nominatim for place names).

---

## The two main functions

The map has a mode toggle (top-left, below any warning banners) that switches between:

### 1. Landing Area (default, always live)
Continuously projects where the balloon would land if descent were initiated now, using the current position, course/speed, and the descent parameters below. Shows:
- The projected flight path (teal cruise segment → yellow descent segment)
- A Monte-Carlo-based landing area (accounts for forecast uncertainty, scaled by how old the weather model run is)
- Ground wind at the landing site, with a trend arrow

### 2. Plan Descent
Tap anywhere on the map to set an "Intended Landing Point" (red crosshair). The app searches for the descent-initiation time that lands closest to that point, using the forecast wind for the actual arrival hour (not "now"), and shows:
- A violet descent-initiation marker — **drag it** to manually override the plan and see the landing area recalculate live
- The same landing-area/path visualization, in the planning colors (violet dashed path, orange landing area)
- "Estimated Descent Point" (time + distance) in the sidebar

Switching back to Landing Area leaves the last planned area visible on the map (with a delete button) until you plan a new one or clear it.

---

## Map layers (header icons)

Each toggle button shows a small traffic-light dot: invisible when off, yellow while loading, green once ready.

| Icon | Layer | Source |
|---|---|---|
| ⚡ | Power lines | OpenInfraMap vector tiles |
| 🛣️ | Roads + place names | Esri roads / Overpass (bounded to ~35-40km around map center to stay fast) |
| ✈️ | Airspace (raster) | openAIP tiles |
| 🌬 | Ground wind particles | Computed from the loaded weather model |
| 🌳 | Nature reserves & protected areas | Overpass (red hatched outline) |

Base map: Streets / Terrain / Satellite (top-right Leaflet control). Default on first load: Streets + ground wind particles only.

## Sidebar

- **Current Position** — live GPS fix, or manual entry in Test Mode
- **Projected/Planned Landing Area** — see above; title turns "PLANNED" (red) only while planning
- **Descent Parameters** — initiation delay, descent rate (with live adiabatic-braking readout), intercept height, post-intercept rate, Monte-Carlo scatter (default 15%)
- **Flight Charts** (collapsed by default) — Wind Profile and Hodograph, both reflecting the planned descent point's location/time while planning

## Test / Manual Mode

If GPS drops out, a banner offers to enable Manual Mode (tap position manually, or type exact Alt/Course/Speed). When GPS comes back, the same banner asks whether to leave Manual Mode again, rather than silently switching back.

## Emergency contact

The red warning-triangle button (left of Test Mode) prepares a position report for WhatsApp/SMS (up to 5 recipients)/Email. All contact details (pilot name, aircraft registration, mobile + second/SatPhone number, email, SMS recipients) are configured once in Settings and stored only on this device. **Important:** this is a static page with no server — it cannot send anything silently in the background. Each channel opens the corresponding app (wa.me / sms: / mailto:) with the message pre-filled; you still tap "send" yourself. Every attempt is logged in the Flight Log.

## Adiabatic braking model

Gas compressed adiabatically during a fast descent stays warmer (and less dense) than it would in slow thermal equilibrium with the surrounding air, giving extra buoyancy — a real, physically-understood effect that increases with descent rate (faster descent → less time for heat to escape → more retained warmth), saturating toward a fully-adiabatic maximum. This extra buoyancy is mathematically equivalent to having dropped that many kg of ballast, so it's expressed as a fraction of the balloon's total system mass (configurable in Settings, alongside gas volume) — a heavier system is proportionally less affected by the same absolute ballast-equivalent. The "Empirical variance factor" setting lets you scale the whole effect to match your own logged flights.

## Known limitations & approximations

- **No backend of any kind.** Emergency messages, CSV/Dropbox uploads, etc. are all client-side only — see the Emergency Contact section above.
- **Free public APIs**, not guaranteed uptime or rate limits. Overpass-based layers (nature reserves, place names) retry automatically with a cooldown and mirror rotation if the primary server is overloaded.
- **openAIP's Core API is CORS-blocked** for browser requests — real per-class airspace filtering and automated airspace-crossing warnings aren't possible from this page; only the combined raster tile overlay is shown.
- **Satellite count isn't available.** The standard browser Geolocation API only exposes latitude/longitude/altitude/accuracy/heading/speed — not satellite count, which requires native GPS-chip access no web page has.
- **In-page screen recording doesn't work on iPhone/iPad.** iOS Safari has no Screen Capture API at all (an Apple/WebKit platform limitation) — the recording button detects this and points to iOS's own Control Center recording instead. On desktop browsers that do support it, the button pulses red with a stop icon while recording.
- **A dashed ring shows the pre-cached tile area's boundary** once zoomed out far enough for it to be a useful reference.
- **Adiabatic braking and Monte-Carlo scatter are approximations**, not calibrated against real flight data — treat as a planning aid, not a certified instrument.
- **Cloud file pickers** (Dropbox, Google Drive, etc.) shown when uploading a file are controlled entirely by iOS/the browser, based on which provider apps are installed — not something this page can add to or configure.
