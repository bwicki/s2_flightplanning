# Sonde Flight Planning

A static, client-side web app for planning latex sounding-balloon ascents:
balloon sizing (lift), predicted burst altitude, and a wind-drift trajectory
prediction with a reverse (landing-point → launch-point) solver.

No backend, no API key, no build step — it's plain HTML/CSS/JS and runs
directly on **GitHub Pages**.

## Hosting on GitHub Pages

1. Push `index.html`, `style.css`, `app.js` to a repository (root, or a
   `/docs` folder).
2. Repo **Settings → Pages** → set source to the branch/folder containing
   these files.
3. Open the published URL — everything runs in the browser.

## What it calculates

- **Gas volume & balloon diameter** required at launch to reach the chosen
  target ascent rate, from a force balance between buoyancy, weight and
  aerodynamic drag (drag coefficient assumed 0.25).
- **Gross lift** (neck lift: the balloon's buoyancy minus its own weight,
  before the payload is attached) and **net lift** (after payload — this is
  what actually drives the ascent rate).
- **Predicted burst altitude**, from gas expansion with altitude (ideal gas
  law against a standard-atmosphere model anchored to the actual local
  surface pressure/temperature) versus an estimated burst volume.
- **Wind-drift trajectory**: ascent phase at the constant target ascent
  rate, then descent under a parachute whose sink rate scales with
  `1/sqrt(air density)`, both drifted using an interpolated wind profile
  from pressure-level forecast data.
- **Reverse launch-point solving**: shift-click a desired landing spot on
  the map and the app back-solves a launch site (2-pass refinement against
  the real wind field) — useful for avoiding no-go landing areas.

## Data sources

- Weather & wind: [Open-Meteo](https://open-meteo.com) forecast and
  historical-archive APIs (free, no key, CORS-enabled). Pressure-level wind
  and geopotential height are pulled for standard levels from 1000 hPa down
  to 30 hPa (~30 hPa ≈ 23-24 km — above that the model coasts on the
  highest available level's wind, which becomes less reliable for very
  high-altitude, large-balloon flights).
- Place search & elevation: Open-Meteo geocoding and elevation endpoints.
- Map tiles: OpenStreetMap.

## Known approximations — read before flying

This tool is for **mission planning**, not a certified predictor. In
particular:

- Burst diameter is estimated from a power-law curve fit to published
  100 g–3000 g meteorological-balloon burst tables. Outside that range
  (e.g. the default 9 g party-balloon preset) it is a rough extrapolation —
  use the manual burst-diameter override whenever you have real data.
- Ascent rate is treated as constant with altitude; drag coefficient (0.25)
  and the "Ballongas" lift value are editable estimates, not certified
  constants — check them against your gas supplier's spec sheet.
- Descent modelled as a single parachute with a user-set sea-level sink
  rate scaled by density; no explicit terminal-velocity/free-fall staging.
- Trajectory drift uses a flat-earth projection and linear (u/v-component)
  interpolation between pressure-level wind reports — fine for regional
  flights, increasingly approximate over very long drifts.
- Landing elevation is assumed equal to the launch elevation (no terrain
  model for the landing area).
- The reverse solver assumes the wind field is locally uniform between the
  original and back-solved launch points; it is a good starting estimate,
  not a guarantee, for launch sites more than ~50–100 km apart.

Always cross-check against your balloon manufacturer's data sheet, a
dedicated predictor (e.g. CUSF/habhub-style tools) if available, and
current airspace/NOTAM restrictions before an actual launch.

## Files

- `index.html` — structure and input form
- `style.css` — dark instrument-panel theme
- `app.js` — atmosphere model, balloon sizing, weather fetch, trajectory,
  map interaction (single file, no build tooling required)
