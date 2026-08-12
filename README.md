# Weather Sonde Flight Planning

Static web app for planning weather sonde balloon flights (pilot balloon / radiosonde): it computes gas fill, burst altitude and the full flight trajectory (ascent – burst/release – parachute descent) from real wind and weather data, checks the path against selectable airspace categories, and renders everything on an interactive map.

**Live:** https://bwicki.github.io/s2_flightplanning/
**Stack:** Plain HTML/CSS/JavaScript — no build step, no backend. Leaflet for the map, html2canvas for image export, Open-Meteo for weather, OpenAIP for airspace data. Design system adopted from the Gasballoon Cockpit app (Wicki Partners Ballonteam).

---

## Planning modes

The mode toggle in the top bar shows two mission cards:

- **Forward — set launch:** clicking the map sets the launch site and immediately computes the trajectory and predicted landing point.
- **Backward — set landing:** clicking sets the desired landing point (violet crosshair); the app iteratively back-solves for a matching launch site and reports the residual miss distance.

Changing the release altitude, the launch date/time or an airspace category re-runs the existing prediction automatically in whichever mode is active.

## Defaults on load

- Launch position: the device's current location (geolocation; falls back to Zürich if denied)
- Launch time: now + 45 minutes, quick display in local time (LT), switchable to UTC
- Release altitude: 3 750 m AMSL (slider 500–7 000 m in 250 m steps)
- Payload: SparvEmbedded S2 sonde (9 g) + 5 g rigging; balloon preset Qualatex 9 g; fill gas Ballongas (Linde, 0.90 kg/m³ @ SL); ascent 2.5 m/s; descent 5 m/s @ SL
- Airspace overlay: CTR, Prohibited and TMA enabled

## Computation model

- **Atmosphere:** ICAO standard atmosphere anchored to the local surface pressure/temperature from the weather model.
- **Balloon fill:** buoyancy – weight – drag balance (Cd ≈ 0.25); gas volume solved by bisection to the target ascent rate. Outputs gross/net lift, fill volume, inflated diameter.
- **Burst altitude:** ideal-gas expansion vs. burst diameter, estimated from balloon weight (D = 0.208 · w^0.456, manufacturer-table fit, 100–3000 g), manually overridable.
- **Trajectory:** 200 m altitude steps; u/v wind from the model pressure levels (1000–30 hPa + 10 m wind), altitude-interpolated; parachute descent density-scaled (v ∝ 1/√ρ).
- **Tropopause:** WMO criterion (lapse ≤ 2 K/km over 4.5 km) from model temperatures.

## Weather data

Open-Meteo Forecast API (−5 to +15 days) with automatic switch to the Archive API (ERA5 reanalysis) for older dates. The header chip always names the model actually in effect:

- With **auto selection**, the app itself picks the highest-resolution usable model — ICON-D2 2 km (Central Europe, ≤ ~44 h), ICON-EU 7 km (Europe, ≤ ~5 d), otherwise ECMWF IFS 0.25° — and requests it explicitly so it can be named ("auto-selected").
- Any model can be chosen manually from the grouped catalogue (global models, European regional models incl. AROME/UKV/HARMONIE/ICON-2I, other regional models incl. HRRR/HRDPS/MSM).
- If a model does not cover the location/time, the app falls back and labels the fallback in the chip and results.

## Airspace overlay & conflict check (approximate)

Hamburger menu → **Airspace overlay…** offers per-category toggles, each with its map colour: CTR, Prohibited (P), Restricted (R), Danger (D), TMA, CTA (administrative — listed separately from TMA on purpose), TMZ/RMZ, ATZ, gliding sectors. Data comes from the OpenAIP core API (community-maintained). Because that API sends no CORS headers, requests are routed through public CORS relays when the direct call is blocked.

Enabled categories are drawn as tinted polygons. The polygons are click-through on purpose: clicking the map inside an airspace still sets the launch/landing point; the vertical limits of any violated airspace appear in the conflict box. A top-bar toggle (⬡ Airspace on/off) hides or shows the overlay; the conflict check keeps running either way. After every calculation each trajectory point is tested against position **and** altitude band of the enabled airspaces:

- **Conflict:** red-shaded box in the results listing every violated airspace with the altitude band crossed, "⚠ Airspace conflict" in the status chip, offending polygons highlighted on the map.
- **No conflict:** green-shaded confirmation line.

Limits: FL limits are pressure altitudes compared against geometric altitude; AGL floors are approximated with the launch elevation; NOTAM activations are not reflected. A planning aid, never a clearance — check DABS/NOTAM before launch.

## Map

- Fullscreen Leaflet map, starting at the device position (zoom 12 ≈ 20 km view). Base layers top right (left-aligned radio list): Streets, Terrain, Satellite, Light.
- **Signatures:** royal-blue balloon (launch), explosion star (burst), red parachute with sonde (landing), violet crosshair (desired landing), and a prominent pulsing teal ring for the device position that always renders above the airspace shading.
- **Trajectory:** drawn on a dedicated canvas layer with a genuine linear colour gradient per segment — the hue runs continuously from blue (slow) through green/yellow to red (fast, 0–50 km/h horizontal ground speed) over a dark casing.
- Clicking launch/burst/landing flies to the point at the base layer's maximum zoom and opens a popup with the details plus an **"Open in Google Maps ↗"** link.
- While a trajectory is shown, a slim two-row legend bar sits at the foot of the map: a small icon legend (launch / burst / landing) on top, and below it the continuous blue→red speed gradient whose scale stretches automatically to the speeds actually occurring in the current trajectory, with min / mid / max values (km/h) beneath the bar.
- After every calculation the viewport is fitted to the whole flight path, keeping clear of the open side panels. Zoom control and the cockpit-style scale bar (segments, distance, ≈ 1:x) sit bottom right and slide left while the results panel is open. Version badge bottom left.

## User interface

- **Top bar (fixed layout, never scrolls sideways):** ☰ menu (entries: 1 Flight settings, 2 Resulting flight data, Airspace overlay…, day/night switch, and always "ⓘ About — more info" opening this document in a PDF viewer with fixed Print/Close buttons), the mission-card mode toggle (Forward in launch blue, Backward in landing red), the compact weather-model chip, the **⬡ Airspace on/off toggle**, and the two-line status which truncates with an ellipsis instead of pushing the layout — the Wicki Partners logo stays visible on the right. The chip's second line shows when the weather was loaded and the lead of the used forecast hour (e.g. "ld 14:32 · wx +18h"); tapping the chip opens the model list with "↻ Update weather now" as the first entry. Once a trajectory exists, a "Traj → GMaps" button appears: its text opens the trajectory as a waypoint route (launch → path points incl. burst → landing) in Google Maps, and its QR icon opens a closable popover with a large QR code carrying the same route for scanning with a phone (Google Maps cannot draw free lines via URL, hence waypoints).
- **Panel 1 · Flight settings (left, green handle, ≤ 18 % of the window):** cards 01 Payload, 02 Balloon (presets in localStorage with inline editor), 03 Fill gas, 04 Site & time (place search, lat/lon, UTC), 05 Flight profile. All values carry small non-bold unit tags (g, m, kg/m³, °N/°E, m AMSL, m/s). On first open a red frame pulses around "Ascent target" and "Release altitude" until touched.
- **Quick controls below the green handle** (move with the panel): a compact launch-time box — date/time editable in **LT or UTC** (segment toggle, persisted), with a conversion line always showing the other zone, plus a "now" button — and the **vertical release-altitude slider** (m AMSL, 500–7 000, 250 m steps) in the cockpit slider idiom. Every change re-runs the current prediction.
- **Panel 2 · Resulting flight data (right, amber handle, ≤ 18 %):** exports (JSON; print — a single A4-landscape page with the flight settings table left, a Streets-layer map of the whole trajectory in the middle and the results table right; share link; PNG), the airspace conflict box, a data grid styled identically to the left panel (small labels, non-bold dark-grey mono values, explicit units), and the two-panel profile chart: altitude profile coloured by horizontal speed classes on top, the ground-speed curve (km/h, max labelled) below, dashed burst line through both, colour legend. Airspace violations are drawn into the altitude panel as red boxes spanning exactly the time window and altitude band of each conflict, labelled with the airspace name.
- Both panels open/close via the large labelled vertical handles (1 Flight settings / 2 Resulting flight data) or the hamburger menu.

## Desktop & iPad (PWA)

Full-viewport layout with safe-area insets and cockpit-sized touch targets. Apple web-app meta tags allow "Add to Home Screen" (edge-to-edge, no browser chrome); `apple-touch-icon.png` provides the tile (flight-arc graphic on white — iOS renders transparency black). The browser favicon is the same graphic with a transparent background. No `prompt()/alert()/confirm()` anywhere (disabled in iOS standalone apps). A head-level error reporter paints runtime **and resource-loading** failures as a red banner even if app.js itself fails to load; appending `?debug` to the URL opens an on-screen console (Eruda).

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup, PWA meta tags, favicon (SVG data URI), head-level error reporter, CDN includes |
| `style.css` | Complete styling; Gasballoon-Cockpit design tokens, day mode via `body.day` |
| `app.js` | Physics, Open-Meteo + OpenAIP integration, map/canvas rendering, UI logic; `APP_VERSION` at the top |
| `apple-touch-icon.png` | 180×180 iOS home-screen tile |
| `icon-4b.svg` | Source SVG of the app icon |
| `readme.pdf` | This document as PDF, linked from the ☰ menu ("About — read first!") |

## Deployment (GitHub Pages)

1. Upload the app files to `github.com/bwicki/s2_flightplanning` (`main`, repo root) — drag & drop or "choose your files"; if Chrome kills the upload tab, retry in an incognito window.
2. Pages serves from *main / root*; the site refreshes within about a minute.
3. Hard-reload the browser (Ctrl/Cmd+Shift+R). Increment the `?v=N` cache busters in `index.html` and keep `APP_VERSION` in `app.js` (badge bottom left) in sync on every release. If a device shows a stale or "not found" state, load once with a throwaway query string (e.g. `?fresh=1`).

## Model limitations

All outputs are planning approximations: generic burst-diameter fit, constant ascent rate without thermal effects, wind snapped to the nearest model hour, approximate airspace altitude handling, no icing/superpressure/pendulum modelling, community-maintained airspace data without NOTAM activation status. Before any real launch, check the manufacturer's data sheet, DABS/NOTAMs and the airspace structure.
