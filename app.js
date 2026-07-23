'use strict';

/* =========================================================================
   Sonde Flight Planning
   ---------------------------------------------------------------------
   All physics below are planning-grade approximations, not a certified
   trajectory model. Sources / assumptions are noted inline. Weather and
   wind data come from the free Open-Meteo API (no key required, CORS
   enabled), which is why this can run as a static page on GitHub Pages.
   ========================================================================= */

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------
const G0 = 9.80665;          // m/s^2
const M_AIR = 0.0289644;     // kg/mol
const R_GAS = 8.3144598;     // J/(mol*K)
const R_SPECIFIC_AIR = 287.05; // J/(kg*K)
const CD_BALLOON = 0.25;     // drag coefficient, sphere-ish latex balloon at high Re (planning assumption)
const EARTH_R = 6371000;     // m, mean radius for flat-earth trajectory projection

// Empirical burst-diameter fit (m) from published 100g-3000g sounding
// balloon burst tables (Totex/Hwoyee/Kaymont), power-law regression:
//   D_burst(m) ~= 0.208 * weight(g)^0.456
// This is an approximation; always prefer a manufacturer data sheet value
// via the override field, especially far outside the 100-3000g range.
function estimateBurstDiameter(weightGrams) {
  return 0.208 * Math.pow(weightGrams, 0.456);
}

// ---------------------------------------------------------------------
// Standard-atmosphere model, anchored to an observed surface condition
// (z0, P0 [Pa], T0 [K]) instead of MSL, using ICAO standard lapse rates.
// Returns a function h(m ASL) -> {P, T, rho}
// ---------------------------------------------------------------------
function buildAtmosphere(z0, P0, T0) {
  const layers = [
    { hb: z0,    L: -0.0065 },
    { hb: 11000, L: 0.0 },
    { hb: 20000, L: 0.0010 },
    { hb: 32000, L: 0.0028 },
    { hb: 47000, L: 0.0 },
    { hb: 51000, L: -0.0028 },
  ];
  // Chain base pressure/temperature through each layer boundary.
  layers[0].Tb = T0;
  layers[0].Pb = P0;
  for (let i = 1; i < layers.length; i++) {
    const prev = layers[i - 1];
    const dh = layers[i].hb - prev.hb;
    if (dh <= 0) { layers[i].Tb = prev.Tb; layers[i].Pb = prev.Pb; continue; }
    const Tb_top = prev.Tb + prev.L * dh;
    let Pb_top;
    if (prev.L !== 0) {
      Pb_top = prev.Pb * Math.pow(Tb_top / prev.Tb, -G0 * M_AIR / (R_GAS * prev.L));
    } else {
      Pb_top = prev.Pb * Math.exp(-G0 * M_AIR * dh / (R_GAS * prev.Tb));
    }
    layers[i].Tb = Tb_top;
    layers[i].Pb = Pb_top;
  }

  return function atH(h) {
    let layer = layers[0];
    for (let i = layers.length - 1; i >= 0; i--) {
      if (h >= layers[i].hb) { layer = layers[i]; break; }
    }
    const dh = h - layer.hb;
    const T = layer.Tb + layer.L * dh;
    let P;
    if (layer.L !== 0) {
      P = layer.Pb * Math.pow(T / layer.Tb, -G0 * M_AIR / (R_GAS * layer.L));
    } else {
      P = layer.Pb * Math.exp(-G0 * M_AIR * dh / (R_GAS * layer.Tb));
    }
    const rho = P / (R_SPECIFIC_AIR * T);
    return { P, T, rho };
  };
}

// ---------------------------------------------------------------------
// Balloon sizing: solve gas volume at launch that yields the requested
// ascent rate, given payload mass and gas lifting power.
// ---------------------------------------------------------------------
function solveLaunchVolume(params) {
  const { totalMassKg, effectiveLiftKgPerM3, rhoAirLocal, ascentRateMs } = params;
  const weightN = totalMassKg * G0;

  function netForce(V0) {
    const buoyancyN = effectiveLiftKgPerM3 * V0 * G0;
    const r = Math.cbrt((3 * V0) / (4 * Math.PI));
    const A = Math.PI * r * r;
    const dragN = 0.5 * CD_BALLOON * rhoAirLocal * A * ascentRateMs * ascentRateMs;
    return buoyancyN - weightN - dragN;
  }

  let lo = 1e-4, hi = 5000; // m^3 search bracket
  // Expand hi until sign change is bracketed (guards against extreme inputs).
  let fLo = netForce(lo), fHi = netForce(hi);
  let guard = 0;
  while (fLo * fHi > 0 && guard < 30) { hi *= 2; fHi = netForce(hi); guard++; }
  if (fLo * fHi > 0) return null; // no solution found (unrealistic inputs)

  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    const fMid = netForce(mid);
    if (fLo * fMid <= 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------------
// Burst altitude: gas volume grows as V(h) = V0 * (P0/P(h)) * (T(h)/T0)
// (ideal gas, constant moles). Find h where V(h) = V_burst.
// ---------------------------------------------------------------------
function solveBurstAltitude(atmosphere, z0, P0, T0, V0, Vburst, hMax) {
  function volumeAt(h) {
    const { P, T } = atmosphere(h);
    return V0 * (P0 / P) * (T / T0);
  }
  let lo = z0, hi = hMax;
  if (volumeAt(hi) < Vburst) return null; // never bursts within search ceiling
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (volumeAt(mid) < Vburst) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------------
// Geo helpers (flat-earth projection, adequate for regional flight paths)
// ---------------------------------------------------------------------
function destPoint(lat, lon, dNorthM, dEastM) {
  const dLat = dNorthM / EARTH_R;
  const dLon = dEastM / (EARTH_R * Math.cos(lat * Math.PI / 180));
  return { lat: lat + dLat * 180 / Math.PI, lon: lon + dLon * 180 / Math.PI };
}
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------
// Weather / wind acquisition via Open-Meteo (https://open-meteo.com)
// ---------------------------------------------------------------------
const PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30];

function buildHourlyParams() {
  const vars = [];
  PRESSURE_LEVELS.forEach(p => {
    vars.push(`windspeed_${p}hPa`, `winddirection_${p}hPa`, `geopotential_height_${p}hPa`);
  });
  return vars.join(',');
}

async function fetchWeather(lat, lon, dateUTC, timeUTC) {
  const requested = new Date(`${dateUTC}T${timeUTC}:00Z`);
  const now = new Date();
  const daysFromNow = (requested - now) / 86400000;

  const hourlyParams = buildHourlyParams();
  let url, isArchive = false;

  if (daysFromNow < -5 || daysFromNow > 15) {
    // Outside the operational forecast window -> use historical reanalysis.
    // (For future dates beyond the forecast horizon there is no wind
    // forecast yet; we fall back to the archive so the tool still returns
    // a plausible climatological pattern for planning purposes.)
    isArchive = true;
    const d = dateUTC;
    url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
          `&start_date=${d}&end_date=${d}&hourly=surface_pressure,temperature_2m,windspeed_10m,winddirection_10m,${hourlyParams}` +
          `&wind_speed_unit=ms&timezone=UTC`;
  } else {
    url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
          `&current=surface_pressure,temperature_2m,windspeed_10m,winddirection_10m` +
          `&hourly=${hourlyParams}&wind_speed_unit=ms&forecast_days=16&timezone=UTC`;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
  const data = await res.json();

  const elevation = data.elevation ?? 0;

  // Find the hourly index closest to the requested time.
  const times = data.hourly.time.map(t => new Date(t + 'Z').getTime());
  const targetMs = requested.getTime();
  let idx = 0, best = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(times[i] - targetMs);
    if (diff < best) { best = diff; idx = i; }
  }

  let surfacePressurePa, surfaceTempK;
  if (isArchive) {
    surfacePressurePa = data.hourly.surface_pressure[idx] * 100;
    surfaceTempK = data.hourly.temperature_2m[idx] + 273.15;
  } else {
    surfacePressurePa = (data.current?.surface_pressure ?? data.hourly.surface_pressure?.[idx]) * 100;
    surfaceTempK = (data.current?.temperature_2m ?? 15) + 273.15;
  }

  const levels = [];
  // Low-level anchor point from 10 m wind observation/forecast.
  const w10 = isArchive ? data.hourly.windspeed_10m?.[idx] : data.current?.windspeed_10m;
  const d10 = isArchive ? data.hourly.winddirection_10m?.[idx] : data.current?.winddirection_10m;
  if (w10 != null && d10 != null) {
    levels.push({ altitude: elevation + 10, speed: w10, dir: d10 });
  }

  PRESSURE_LEVELS.forEach(p => {
    const alt = data.hourly[`geopotential_height_${p}hPa`]?.[idx];
    const spd = data.hourly[`windspeed_${p}hPa`]?.[idx];
    const dir = data.hourly[`winddirection_${p}hPa`]?.[idx];
    if (alt != null && spd != null && dir != null) levels.push({ altitude: alt, speed: spd, dir: dir });
  });

  levels.sort((a, b) => a.altitude - b.altitude);

  return { elevation, surfacePressurePa, surfaceTempK, levels, matchedTime: data.hourly.time[idx] };
}

async function fetchElevation(lat, lon) {
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    const data = await res.json();
    return data.elevation?.[0] ?? null;
  } catch { return null; }
}

async function geocodePlace(name) {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
  const data = await res.json();
  if (!data.results || !data.results.length) return null;
  const r = data.results[0];
  return { lat: r.latitude, lon: r.longitude, label: `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ', ' + r.country : ''}` };
}

// ---------------------------------------------------------------------
// Wind interpolation: component-wise (u/v) linear interpolation between
// bracketing altitude levels avoids the wraparound problem of averaging
// compass directions directly.
// ---------------------------------------------------------------------
function windComponents(speed, dirFromDeg) {
  const toRad = d => d * Math.PI / 180;
  const dirTo = toRad(dirFromDeg + 180); // direction air is moving TOWARD
  return { u: speed * Math.sin(dirTo), v: speed * Math.cos(dirTo) }; // u=east, v=north, m/s
}

function windAt(levels, altitude) {
  if (altitude <= levels[0].altitude) return windComponents(levels[0].speed, levels[0].dir);
  if (altitude >= levels[levels.length - 1].altitude) {
    const top = levels[levels.length - 1];
    return windComponents(top.speed, top.dir);
  }
  for (let i = 0; i < levels.length - 1; i++) {
    const a = levels[i], b = levels[i + 1];
    if (altitude >= a.altitude && altitude <= b.altitude) {
      const f = (altitude - a.altitude) / (b.altitude - a.altitude);
      const ca = windComponents(a.speed, a.dir), cb = windComponents(b.speed, b.dir);
      return { u: ca.u + (cb.u - ca.u) * f, v: ca.v + (cb.v - ca.v) * f };
    }
  }
  return { u: 0, v: 0 };
}

// ---------------------------------------------------------------------
// Trajectory integration: ascent (constant target rate) + descent
// (parachute terminal velocity scaled by sqrt(rho_ref/rho)).
// ---------------------------------------------------------------------
function computeTrajectory(opts) {
  const { launchLat, launchLon, z0, releaseAlt, groundAlt, atmosphere, levels,
          ascentRateMs, descentRateSeaLevel, startEpochMs } = opts;

  const rhoLaunch = atmosphere(z0).rho;
  const path = [];
  let lat = launchLat, lon = launchLon, tSec = 0;

  path.push({ lat, lon, alt: z0, t: 0 });

  const stepH = 200; // m per integration step
  // Ascent
  for (let h = z0; h < releaseAlt; h += stepH) {
    const h2 = Math.min(h + stepH, releaseAlt);
    const dh = h2 - h;
    const dt = dh / ascentRateMs;
    const mid = (h + h2) / 2;
    const { u, v } = windAt(levels, mid);
    const p = destPoint(lat, lon, v * dt, u * dt);
    lat = p.lat; lon = p.lon; tSec += dt;
    path.push({ lat, lon, alt: h2, t: tSec });
  }
  const releaseIdx = path.length - 1;

  // Descent
  for (let h = releaseAlt; h > groundAlt; h -= stepH) {
    const h2 = Math.max(h - stepH, groundAlt);
    const dh = h - h2;
    const mid = (h + h2) / 2;
    const rho = atmosphere(mid).rho;
    const vDesc = descentRateSeaLevel * Math.sqrt(rhoLaunch / rho);
    const dt = dh / vDesc;
    const { u, v } = windAt(levels, mid);
    const p = destPoint(lat, lon, v * dt, u * dt);
    lat = p.lat; lon = p.lon; tSec += dt;
    path.push({ lat, lon, alt: h2, t: tSec });
  }

  return { path, releaseIdx, totalTimeSec: tSec, landing: { lat, lon }, startEpochMs };
}

// =========================================================================
// UI wiring
// =========================================================================
const $ = id => document.getElementById(id);

const state = {
  map: null,
  launchMarker: null,
  releaseMarker: null,
  landMarker: null,
  deviceMarker: null,
  trajectoryLine: null,
  lastResult: null,
};

function initMap() {
  state.map = L.map('map', { worldCopyJump: true }).setView([parseFloat($('launchLat').value), parseFloat($('launchLon').value)], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(state.map);

  state.launchMarker = L.circleMarker([parseFloat($('launchLat').value), parseFloat($('launchLon').value)], markerStyle('launch')).addTo(state.map);

  state.map.on('click', (e) => {
    if (e.originalEvent.shiftKey) {
      reverseCalcFromLanding(e.latlng.lat, e.latlng.lng);
    } else {
      setLaunchPoint(e.latlng.lat, e.latlng.lng);
    }
  });
}

function markerStyle(kind) {
  const colors = { launch: '#59d18f', release: '#ffb020', land: '#ff6b6b', device: '#4fd1c5' };
  return { radius: 8, color: colors[kind], weight: 2, fillColor: colors[kind], fillOpacity: 0.55 };
}

function setLaunchPoint(lat, lon) {
  $('launchLat').value = lat.toFixed(5);
  $('launchLon').value = lon.toFixed(5);
  state.launchMarker.setLatLng([lat, lon]);
  setStatus(`Launch site set to ${lat.toFixed(4)}, ${lon.toFixed(4)}. Press "Calculate flight" to update the prediction.`);
}

function setStatus(msg) { $('statusLine').textContent = msg; }

function nowDefaults() {
  const now = new Date();
  $('launchDate').value = now.toISOString().slice(0, 10);
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  $('launchTime').value = `${hh}:${mm}`;
}

function wireDropdowns() {
  $('sondeType').addEventListener('change', e => {
    const w = e.target.selectedOptions[0].dataset.weight;
    if (w) $('sondeWeight').value = w;
  });
  $('balloonType').addEventListener('change', e => {
    const w = e.target.selectedOptions[0].dataset.weight;
    if (w) $('balloonWeight').value = w;
    updateBurstHint();
  });
  $('balloonWeight').addEventListener('input', updateBurstHint);
  $('burstDiameterOverride').addEventListener('input', updateBurstHint);
  $('gasType').addEventListener('change', e => {
    const l = e.target.selectedOptions[0].dataset.lift;
    if (l) $('gasLift').value = l;
  });
  $('targetMode').addEventListener('change', e => {
    $('targetAltitudeWrap').style.display = e.target.value === 'altitude' ? '' : 'none';
  });
  $('geolocateBtn').addEventListener('click', useDeviceLocation);
  $('searchBtn').addEventListener('click', searchPlace);
  $('placeSearch').addEventListener('keydown', e => { if (e.key === 'Enter') searchPlace(); });
  ['launchLat', 'launchLon'].forEach(id => $(id).addEventListener('change', () => {
    const lat = parseFloat($('launchLat').value), lon = parseFloat($('launchLon').value);
    if (!isNaN(lat) && !isNaN(lon)) { state.launchMarker.setLatLng([lat, lon]); state.map.panTo([lat, lon]); }
  }));
  $('calcBtn').addEventListener('click', () => runCalculation().catch(showError));
  updateBurstHint();
}

function updateBurstHint() {
  const w = parseFloat($('balloonWeight').value) || 0;
  const override = parseFloat($('burstDiameterOverride').value);
  const est = estimateBurstDiameter(w);
  $('burstDiameterHint').textContent = override
    ? `Using manual override: ${override.toFixed(2)} m burst diameter.`
    : `Estimated burst diameter (approximation): ${est.toFixed(2)} m.`;
}

function useDeviceLocation() {
  if (!navigator.geolocation) { setStatus('Geolocation is not available in this browser.'); return; }
  setStatus('Requesting device position…');
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude, longitude } = pos.coords;
    if (state.deviceMarker) state.map.removeLayer(state.deviceMarker);
    state.deviceMarker = L.circleMarker([latitude, longitude], markerStyle('device')).addTo(state.map)
      .bindPopup('Device position').openPopup();
    setLaunchPoint(latitude, longitude);
    state.map.setView([latitude, longitude], 10);
  }, err => {
    setStatus(`Could not get device position: ${err.message}`);
  }, { enableHighAccuracy: true, timeout: 10000 });
}

async function searchPlace() {
  const q = $('placeSearch').value.trim();
  if (!q) return;
  setStatus(`Searching for "${q}"…`);
  try {
    const r = await geocodePlace(q);
    if (!r) { setStatus(`No location found for "${q}".`); return; }
    setLaunchPoint(r.lat, r.lon);
    state.map.setView([r.lat, r.lon], 9);
    setStatus(`Found: ${r.label}`);
  } catch (e) {
    setStatus('Location search failed (network error).');
  }
}

function showError(e) {
  console.error(e);
  $('calcError').textContent = e.message || String(e);
  setStatus('Calculation failed — see message under the form.');
}

// ---------------------------------------------------------------------
// Main calculation orchestration
// ---------------------------------------------------------------------
async function runCalculation() {
  $('calcError').textContent = '';
  setStatus('Fetching weather and wind data…');

  const lat = parseFloat($('launchLat').value);
  const lon = parseFloat($('launchLon').value);
  const dateUTC = $('launchDate').value;
  const timeUTC = $('launchTime').value;
  if (!dateUTC || !timeUTC) throw new Error('Please set a launch date and time (UTC).');

  const weather = await fetchWeather(lat, lon, dateUTC, timeUTC);
  const z0 = weather.elevation;
  const P0 = weather.surfacePressurePa;
  const T0 = weather.surfaceTempK;
  const atmosphere = buildAtmosphere(z0, P0, T0);
  const rho0 = atmosphere(z0).rho;

  const sondeW = parseFloat($('sondeWeight').value) || 0;
  const rigW = parseFloat($('riggingWeight').value) || 0;
  const balloonW = parseFloat($('balloonWeight').value) || 0;
  const gasLift = parseFloat($('gasLift').value) || 0.9;
  const ascentRate = parseFloat($('ascentRate').value);
  const descentRateSL = parseFloat($('descentRate').value);
  const targetMode = $('targetMode').value;
  const targetAltInput = parseFloat($('targetAltitude').value) || 0;

  const effectiveLift = gasLift * (rho0 / 1.225); // scale nominal sea-level lift by local air density

  const totalMassKg = (balloonW + rigW + sondeW) / 1000;
  const V0 = solveLaunchVolume({ totalMassKg, effectiveLiftKgPerM3: effectiveLift, rhoAirLocal: rho0, ascentRateMs: ascentRate });
  if (!V0) throw new Error('Could not find a valid balloon size for these inputs — check weights and ascent rate.');

  const totalBuoyancyKg = effectiveLift * V0;
  const grossLiftKg = totalBuoyancyKg - balloonW / 1000;       // neck lift, before payload
  const netLiftKg = grossLiftKg - (sondeW + rigW) / 1000;      // after payload attached

  const overrideD = parseFloat($('burstDiameterOverride').value);
  const burstDiameter = overrideD > 0 ? overrideD : estimateBurstDiameter(balloonW);
  const Vburst = (4 / 3) * Math.PI * Math.pow(burstDiameter / 2, 3);

  const burstAlt = solveBurstAltitude(atmosphere, z0, P0, T0, V0, Vburst, 45000);

  let releaseAlt, note = '';
  if (targetMode === 'burst') {
    if (!burstAlt) throw new Error('Balloon does not reach burst volume within the modelled altitude range (45 km). Try a smaller balloon or larger diameter override.');
    releaseAlt = burstAlt;
  } else {
    releaseAlt = targetAltInput;
    if (burstAlt && releaseAlt >= burstAlt) {
      releaseAlt = burstAlt;
      note = `Requested cutdown altitude is at or above the predicted burst height — using burst altitude (${Math.round(burstAlt)} m) instead.`;
    }
    if (releaseAlt <= z0) throw new Error('Release altitude must be above ground/launch elevation.');
  }

  const startEpochMs = new Date(`${dateUTC}T${timeUTC}:00Z`).getTime();
  const traj = computeTrajectory({
    launchLat: lat, launchLon: lon, z0, releaseAlt, groundAlt: z0,
    atmosphere, levels: weather.levels, ascentRateMs: ascentRate,
    descentRateSeaLevel: descentRateSL, startEpochMs,
  });

  const distanceM = haversine(lat, lon, traj.landing.lat, traj.landing.lon);
  const ascentTimeSec = (releaseAlt - z0) / ascentRate;

  state.lastResult = { weather, atmosphere, z0, P0, T0, burstAlt, releaseAlt, traj, V0, burstDiameter, Vburst, distanceM, ascentTimeSec };

  renderResults({
    surfacePressureHpa: P0 / 100,
    grossLiftKg, netLiftKg, V0, burstDiameter, burstAlt, ascentTimeSec,
    totalTimeSec: traj.totalTimeSec, distanceM, note,
  });
  drawTrajectory(traj);
  drawProfile(traj);

  setStatus(note || `Calculation complete — matched weather at ${weather.matchedTime} UTC.`);
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function renderResults(r) {
  $('resPressure').textContent = `${r.surfacePressureHpa.toFixed(1)} hPa`;
  $('resGrossLift').textContent = `${(r.grossLiftKg * 1000).toFixed(1)} g`;
  $('resNetLift').textContent = `${(r.netLiftKg * 1000).toFixed(1)} g`;
  $('resGasVolume').textContent = `${r.V0.toFixed(3)} m³`;
  const diam = Math.cbrt((6 * r.V0) / Math.PI);
  $('resDiameter').textContent = `${diam.toFixed(2)} m`;
  $('resBurstAlt').textContent = r.burstAlt ? `${Math.round(r.burstAlt).toLocaleString()} m AMSL` : 'not reached ≤45 km';
  $('resAscentTime').textContent = fmtDuration(r.ascentTimeSec);
  $('resFlightTime').textContent = fmtDuration(r.totalTimeSec);
  $('resDistance').textContent = `${(r.distanceM / 1000).toFixed(1)} km`;
  if (r.note) $('calcError').textContent = r.note;
}

function drawTrajectory(traj) {
  if (state.trajectoryLine) state.map.removeLayer(state.trajectoryLine);
  if (state.releaseMarker) state.map.removeLayer(state.releaseMarker);
  if (state.landMarker) state.map.removeLayer(state.landMarker);

  const latlngs = traj.path.map(p => [p.lat, p.lon]);
  state.trajectoryLine = L.polyline(latlngs, { color: '#4fd1c5', weight: 3, opacity: 0.85 }).addTo(state.map);

  const releasePt = traj.path[traj.releaseIdx];
  state.releaseMarker = L.circleMarker([releasePt.lat, releasePt.lon], markerStyle('release')).addTo(state.map)
    .bindPopup(`Burst / release<br>${Math.round(releasePt.alt)} m AMSL`);

  const land = traj.path[traj.path.length - 1];
  state.landMarker = L.circleMarker([land.lat, land.lon], markerStyle('land')).addTo(state.map)
    .bindPopup(`Predicted landing<br>${land.lat.toFixed(4)}, ${land.lon.toFixed(4)}`);

  state.map.fitBounds(state.trajectoryLine.getBounds(), { padding: [30, 30] });
}

function drawProfile(traj) {
  const svg = $('profileSvg');
  const W = 640, H = 200, padL = 46, padB = 24, padT = 12, padR = 12;
  const maxT = traj.totalTimeSec, maxA = traj.path[traj.releaseIdx].alt;
  const x = t => padL + (t / maxT) * (W - padL - padR);
  const y = a => H - padB - (a / maxA) * (H - padB - padT);

  let d = `M ${x(0)} ${y(traj.path[0].alt)}`;
  traj.path.forEach(p => { d += ` L ${x(p.t)} ${y(p.alt)}`; });

  const releaseP = traj.path[traj.releaseIdx];
  const landP = traj.path[traj.path.length - 1];

  svg.innerHTML = `
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#1f3352" stroke-width="1"/>
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#1f3352" stroke-width="1"/>
    <path d="${d}" fill="none" stroke="#4fd1c5" stroke-width="2.5"/>
    <circle cx="${x(0)}" cy="${y(traj.path[0].alt)}" r="4" fill="#59d18f"/>
    <circle cx="${x(releaseP.t)}" cy="${y(releaseP.alt)}" r="4" fill="#ffb020"/>
    <circle cx="${x(landP.t)}" cy="${y(landP.alt)}" r="4" fill="#ff6b6b"/>
    <text x="${padL}" y="${H - 6}" fill="#8aa0bf" font-size="10" font-family="IBM Plex Mono">0h</text>
    <text x="${W - padR - 34}" y="${H - 6}" fill="#8aa0bf" font-size="10" font-family="IBM Plex Mono">${fmtDuration(maxT)}</text>
    <text x="4" y="${padT + 6}" fill="#8aa0bf" font-size="10" font-family="IBM Plex Mono">${Math.round(maxA / 1000)}km</text>
    <text x="4" y="${H - padB}" fill="#8aa0bf" font-size="10" font-family="IBM Plex Mono">0</text>
  `;
}

// ---------------------------------------------------------------------
// Reverse calculation: shift-click a desired landing point to
// back-solve a launch site that drifts there (vector-translation
// approximation, refined by two iterations against the real wind field).
// ---------------------------------------------------------------------
async function reverseCalcFromLanding(targetLat, targetLon) {
  if (!state.lastResult) {
    setStatus('Run a calculation first, then shift-click the map to back-solve a launch site.');
    return;
  }
  setStatus('Back-solving launch site for the desired landing point…');
  try {
    let launchLat = parseFloat($('launchLat').value);
    let launchLon = parseFloat($('launchLon').value);

    for (let iter = 0; iter < 2; iter++) {
      const dateUTC = $('launchDate').value, timeUTC = $('launchTime').value;
      const weather = await fetchWeather(launchLat, launchLon, dateUTC, timeUTC);
      const z0 = weather.elevation, P0 = weather.surfacePressurePa, T0 = weather.surfaceTempK;
      const atmosphere = buildAtmosphere(z0, P0, T0);
      const r = state.lastResult;
      const traj = computeTrajectory({
        launchLat, launchLon, z0, releaseAlt: r.releaseAlt, groundAlt: z0,
        atmosphere, levels: weather.levels,
        ascentRateMs: parseFloat($('ascentRate').value),
        descentRateSeaLevel: parseFloat($('descentRate').value),
        startEpochMs: r.traj.startEpochMs,
      });
      const dLat = targetLat - traj.landing.lat;
      const dLon = targetLon - traj.landing.lon;
      launchLat += dLat;
      launchLon += dLon;
      state.lastResult.traj = traj; // keep latest for final render
    }

    setLaunchPoint(launchLat, launchLon);
    state.map.setView([launchLat, launchLon], state.map.getZoom());
    await runCalculation();
    setStatus(`Back-solved launch site so the balloon should land near ${targetLat.toFixed(4)}, ${targetLon.toFixed(4)} (wind-model approximation).`);
  } catch (e) {
    showError(e);
  }
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  nowDefaults();
  initMap();
  wireDropdowns();
});
