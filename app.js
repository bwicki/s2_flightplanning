'use strict';

/* =========================================================================
   Weather Sonde Flight Planning
   ---------------------------------------------------------------------
   All physics below are planning-grade approximations, not a certified
   trajectory model. Weather and wind data come from the free Open-Meteo
   API (no key required, CORS enabled), which is why this can run as a
   static page on GitHub Pages.
   ========================================================================= */

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------
const G0 = 9.80665;
const M_AIR = 0.0289644;
const R_GAS = 8.3144598;
const R_SPECIFIC_AIR = 287.05;
const CD_BALLOON = 0.25;   // drag coefficient, planning assumption
const EARTH_R = 6371000;

const $ = id => document.getElementById(id);

// Empirical burst-diameter fit (m) from published 100g-3000g sounding
// balloon burst tables, power-law regression: D ~= 0.208 * w^0.456.
// Outside that range (small party-style balloons) it is a rough
// extrapolation - prefer the manual override with real data.
function estimateBurstDiameter(weightGrams) {
  return 0.208 * Math.pow(weightGrams, 0.456);
}

// ---------------------------------------------------------------------
// Standard atmosphere anchored to observed surface conditions
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
// Balloon sizing
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

  let lo = 1e-4, hi = 5000;
  let fLo = netForce(lo), fHi = netForce(hi);
  let guard = 0;
  while (fLo * fHi > 0 && guard < 30) { hi *= 2; fHi = netForce(hi); guard++; }
  if (fLo * fHi > 0) return null;

  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    const fMid = netForce(mid);
    if (fLo * fMid <= 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------------
// Burst altitude via ideal-gas expansion
// ---------------------------------------------------------------------
function solveBurstAltitude(atmosphere, z0, P0, T0, V0, Vburst, hMax) {
  function volumeAt(h) {
    const { P, T } = atmosphere(h);
    return V0 * (P0 / P) * (T / T0);
  }
  let lo = z0, hi = hMax;
  if (volumeAt(hi) < Vburst) return null;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (volumeAt(mid) < Vburst) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ---------------------------------------------------------------------
// Geo helpers
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
// Weather via Open-Meteo (wind + temperature on pressure levels)
// ---------------------------------------------------------------------
const PRESSURE_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30];

function buildHourlyParams() {
  const vars = [];
  PRESSURE_LEVELS.forEach(p => {
    vars.push(`windspeed_${p}hPa`, `winddirection_${p}hPa`, `geopotential_height_${p}hPa`, `temperature_${p}hPa`);
  });
  return vars.join(',');
}

async function fetchWeather(lat, lon, dateUTC, timeUTC, modelSlug) {
  const requested = new Date(`${dateUTC}T${timeUTC}:00Z`);
  const now = new Date();
  const daysFromNow = (requested - now) / 86400000;

  const hourlyParams = buildHourlyParams();
  let url, isArchive = false;
  const modelParam = modelSlug ? `&models=${modelSlug}` : '';

  if (daysFromNow < -5 || daysFromNow > 15) {
    isArchive = true;
    const d = dateUTC;
    url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
          `&start_date=${d}&end_date=${d}&hourly=surface_pressure,temperature_2m,windspeed_10m,winddirection_10m,${hourlyParams}` +
          `&wind_speed_unit=ms&timezone=UTC`;
  } else {
    url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
          `&current=surface_pressure,temperature_2m,windspeed_10m,winddirection_10m` +
          `&hourly=${hourlyParams}${modelParam}&wind_speed_unit=ms&forecast_days=16&timezone=UTC`;
  }

  let res = await fetch(url);
  if (!res.ok && modelSlug) {
    res = await fetch(url.replace(modelParam, ''));
    modelSlug = null;
  }
  if (!res.ok) throw new Error(`Weather request failed (${res.status})`);
  const data = await res.json();

  const elevation = data.elevation ?? 0;

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

  const levels = [];      // wind levels
  const tempLevels = [];  // temperature levels for tropopause detection

  const w10 = isArchive ? data.hourly.windspeed_10m?.[idx] : data.current?.windspeed_10m;
  const d10 = isArchive ? data.hourly.winddirection_10m?.[idx] : data.current?.winddirection_10m;
  if (w10 != null && d10 != null) {
    levels.push({ altitude: elevation + 10, speed: w10, dir: d10 });
  }

  PRESSURE_LEVELS.forEach(p => {
    const alt = data.hourly[`geopotential_height_${p}hPa`]?.[idx];
    const spd = data.hourly[`windspeed_${p}hPa`]?.[idx];
    const dir = data.hourly[`winddirection_${p}hPa`]?.[idx];
    const tmp = data.hourly[`temperature_${p}hPa`]?.[idx];
    if (alt != null && spd != null && dir != null) levels.push({ altitude: alt, speed: spd, dir: dir });
    if (alt != null && tmp != null) tempLevels.push({ altitude: alt, tempC: tmp });
  });

  levels.sort((a, b) => a.altitude - b.altitude);
  tempLevels.sort((a, b) => a.altitude - b.altitude);

  return {
    elevation, surfacePressurePa, surfaceTempK, levels, tempLevels,
    matchedTime: data.hourly.time[idx],
    modelUsed: modelSlug || 'best_match (automatic)',
    isArchive,
  };
}

// WMO-style tropopause: lowest level above ~4.5 km where the lapse rate
// drops to <= 2 K/km and stays that low for the next ~2 km.
function computeTropopause(tempLevels) {
  if (!tempLevels || tempLevels.length < 3) return null;
  for (let i = 0; i < tempLevels.length - 1; i++) {
    const a = tempLevels[i], b = tempLevels[i + 1];
    if (a.altitude < 4500) continue;
    const lapse = -(b.tempC - a.tempC) / ((b.altitude - a.altitude) / 1000); // K/km
    if (lapse <= 2) {
      // Verify the mean lapse rate over the ~2 km above also stays <= 2 K/km
      let refIdx = i, topIdx = i;
      while (topIdx < tempLevels.length - 1 && tempLevels[topIdx].altitude - a.altitude < 2000) topIdx++;
      const top = tempLevels[topIdx];
      const meanLapse = -(top.tempC - a.tempC) / ((top.altitude - a.altitude) / 1000);
      if (meanLapse <= 2 || topIdx === refIdx) return a.altitude;
    }
  }
  return null;
}

async function geocodePlace(name) {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
  const data = await res.json();
  if (!data.results || !data.results.length) return null;
  const r = data.results[0];
  return { lat: r.latitude, lon: r.longitude, label: `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ', ' + r.country : ''}` };
}

// ---------------------------------------------------------------------
// Wind interpolation
// ---------------------------------------------------------------------
function windComponents(speed, dirFromDeg) {
  const toRad = d => d * Math.PI / 180;
  const dirTo = toRad(dirFromDeg + 180);
  return { u: speed * Math.sin(dirTo), v: speed * Math.cos(dirTo) };
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
// Trajectory integration
// ---------------------------------------------------------------------
function computeTrajectory(opts) {
  const { launchLat, launchLon, z0, releaseAlt, groundAlt, atmosphere, levels,
          ascentRateMs, descentRateSeaLevel, startEpochMs } = opts;

  const rhoLaunch = atmosphere(z0).rho;
  const path = [];
  let lat = launchLat, lon = launchLon, tSec = 0;

  path.push({ lat, lon, alt: z0, t: 0 });

  const stepH = 200;
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
// Balloon presets (persisted in localStorage; safe fallback when blocked)
// =========================================================================
const DEFAULT_PRESETS = [
  { id: 'qualatex-9', name: 'Qualatex 9 g (latex party balloon)', weight: 9 },
  { id: 'latex-11', name: 'Latex 11 g', weight: 11 },
  { id: 'latex-30', name: 'Latex 30 g', weight: 30 },
];
const PRESETS_KEY = 'sfp_balloon_presets_v1';
let presetsMemory = null; // in-memory fallback if localStorage unavailable

function loadPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) { /* storage blocked */ }
  return presetsMemory || DEFAULT_PRESETS.map(p => ({ ...p }));
}
function savePresets(list) {
  presetsMemory = list;
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(list)); } catch (e) { /* storage blocked */ }
}

function renderPresetSelect(selectedId) {
  const sel = $('balloonType');
  if (!sel) return;
  const presets = loadPresets();
  sel.innerHTML = '';
  presets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name; opt.dataset.weight = p.weight;
    sel.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = 'custom'; customOpt.textContent = 'Custom…';
  customOpt.dataset.weight = $('balloonWeight').value || 9;
  sel.appendChild(customOpt);

  // Default selection: requested preset, else Qualatex 9 g, else first entry.
  if (selectedId && presets.some(p => p.id === selectedId)) sel.value = selectedId;
  else if (presets.some(p => p.id === 'qualatex-9')) sel.value = 'qualatex-9';
  else sel.value = presets[0].id;

  const w = sel.selectedOptions[0]?.dataset.weight;
  if (w) $('balloonWeight').value = w;
}

function addPreset() {
  const name = prompt('Preset name (e.g. "Latex 20 g"):');
  if (!name) return;
  const weight = parseFloat(prompt('Balloon weight in grams:', '20'));
  if (!weight || weight <= 0) { alert('Please enter a valid weight in grams.'); return; }
  const presets = loadPresets();
  const id = 'custom-' + Date.now();
  presets.push({ id, name, weight });
  savePresets(presets);
  renderPresetSelect(id);
  updateBurstHint();
}

function editPreset() {
  const sel = $('balloonType');
  if (sel.value === 'custom') { alert('The "Custom…" entry is not a saved preset — edit the weight field directly.'); return; }
  const presets = loadPresets();
  const idx = presets.findIndex(p => p.id === sel.value);
  if (idx === -1) return;
  const name = prompt('Preset name:', presets[idx].name);
  if (!name) return;
  const weight = parseFloat(prompt('Balloon weight in grams:', presets[idx].weight));
  if (!weight || weight <= 0) { alert('Please enter a valid weight in grams.'); return; }
  presets[idx] = { ...presets[idx], name, weight };
  savePresets(presets);
  renderPresetSelect(presets[idx].id);
  updateBurstHint();
}

function deletePreset() {
  const sel = $('balloonType');
  if (sel.value === 'custom') { alert('The "Custom…" entry can\'t be deleted.'); return; }
  let presets = loadPresets();
  if (presets.length <= 1) { alert('At least one saved preset must remain.'); return; }
  const p = presets.find(x => x.id === sel.value);
  if (!p || !confirm(`Delete preset "${p.name}"?`)) return;
  presets = presets.filter(x => x.id !== sel.value);
  savePresets(presets);
  renderPresetSelect(presets[0].id);
  updateBurstHint();
}

// =========================================================================
// UI state
// =========================================================================
const state = {
  map: null,
  launchMarker: null,
  releaseMarker: null,
  landMarker: null,
  targetMarker: null,
  deviceMarker: null,
  trajectoryLine: null,
  lastResult: null,
  busy: false,
};

function markerStyle(kind) {
  const colors = { launch: '#59d18f', release: '#ffb020', land: '#ff6b6b', device: '#4fd1c5', target: '#b78cff' };
  return { radius: 8, color: colors[kind], weight: 2, fillColor: colors[kind], fillOpacity: 0.55 };
}

function currentMode() {
  const checked = document.querySelector('input[name="searchMode"]:checked');
  return checked ? checked.value : 'forward';
}

function initMap() {
  state.map = L.map('map', { worldCopyJump: true }).setView([parseFloat($('launchLat').value), parseFloat($('launchLon').value)], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(state.map);

  state.launchMarker = L.circleMarker([parseFloat($('launchLat').value), parseFloat($('launchLon').value)], markerStyle('launch')).addTo(state.map);

  state.map.on('click', (e) => {
    if (state.busy) return;
    if (currentMode() === 'backward') {
      reverseCalcFromLanding(e.latlng.lat, e.latlng.lng).catch(showError);
    } else {
      setLaunchPoint(e.latlng.lat, e.latlng.lng);
    }
  });
}

function setLaunchPoint(lat, lon) {
  $('launchLat').value = lat.toFixed(5);
  $('launchLon').value = lon.toFixed(5);
  state.launchMarker.setLatLng([lat, lon]);
  setStatus('Launch site set', `${lat.toFixed(4)}, ${lon.toFixed(4)} — press Calculate`);
}

function setStatus(msg, sub) {
  const line = $('statusLine');
  if (line) line.textContent = msg;
  const s = $('statusSub');
  if (s) s.textContent = sub || '';
}

function setSearchStatus(msg, kind) {
  const box = $('searchStatus');
  box.textContent = msg || '';
  box.className = 'status-box' + (msg ? ' ' + (kind || 'ok') : '');
}

function nowDefaults() {
  const now = new Date();
  $('launchDate').value = now.toISOString().slice(0, 10);
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  $('launchTime').value = `${hh}:${mm}`;
}

function applyTheme(theme) {
  document.body.classList.toggle('day', theme === 'light');
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('themeToggle');
  if (btn) btn.textContent = theme === 'light' ? '◑' : '◐';
  try { localStorage.setItem('sfp_theme', theme); } catch (e) { /* ignore */ }
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
  if (!navigator.geolocation) { setSearchStatus('Geolocation is not available in this browser.', 'err'); return; }
  setSearchStatus('Requesting device position…', 'ok');
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude, longitude } = pos.coords;
    if (state.deviceMarker) state.map.removeLayer(state.deviceMarker);
    state.deviceMarker = L.circleMarker([latitude, longitude], markerStyle('device')).addTo(state.map)
      .bindPopup('Device position').openPopup();
    setLaunchPoint(latitude, longitude);
    state.map.setView([latitude, longitude], 10);
    setSearchStatus(`Using device position: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, 'ok');
  }, err => {
    setSearchStatus(`Could not get device position: ${err.message}`, 'err');
  }, { enableHighAccuracy: true, timeout: 10000 });
}

async function searchPlace() {
  const q = $('placeSearch').value.trim();
  if (!q) return;
  setSearchStatus(`Searching for "${q}"…`, 'ok');
  try {
    const r = await geocodePlace(q);
    if (!r) { setSearchStatus(`No location found for "${q}".`, 'err'); return; }
    setLaunchPoint(r.lat, r.lon);
    state.map.setView([r.lat, r.lon], 9);
    setSearchStatus(`Found: ${r.label}`, 'ok');
  } catch (e) {
    setSearchStatus('Location search failed (network error).', 'err');
  }
}

// ---------------------------------------------------------------------
// Results modal
// ---------------------------------------------------------------------
function openResults() {
  const m = $('resultsModal');
  if (m) m.hidden = false;
  const fab = $('resultsOpenBtn');
  if (fab) fab.hidden = false;
}
function closeResults() {
  const m = $('resultsModal');
  if (m) m.hidden = true;
}

function showError(e) {
  console.error(e);
  $('calcError').textContent = e.message || String(e);
  setStatus('Calculation failed', 'see message under the form');
  state.busy = false;
}

// ---------------------------------------------------------------------
// Core calculation given explicit launch coordinates. Returns everything
// needed for rendering; does not touch the DOM.
// ---------------------------------------------------------------------
async function calculateFor(lat, lon) {
  const dateUTC = $('launchDate').value;
  const timeUTC = $('launchTime').value;
  if (!dateUTC || !timeUTC) throw new Error('Please set a launch date and time (UTC).');

  const modelSlug = $('weatherModel').value || null;
  const weather = await fetchWeather(lat, lon, dateUTC, timeUTC, modelSlug);
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
  const targetModeVal = $('targetMode').value;
  const targetAltInput = parseFloat($('targetAltitude').value) || 0;

  const effectiveLift = gasLift * (rho0 / 1.225);
  const totalMassKg = (balloonW + rigW + sondeW) / 1000;
  const V0 = solveLaunchVolume({ totalMassKg, effectiveLiftKgPerM3: effectiveLift, rhoAirLocal: rho0, ascentRateMs: ascentRate });
  if (!V0) throw new Error('Could not find a valid balloon size for these inputs — check weights and ascent rate.');

  const totalBuoyancyKg = effectiveLift * V0;
  const grossLiftKg = totalBuoyancyKg - balloonW / 1000;
  const netLiftKg = grossLiftKg - (sondeW + rigW) / 1000;

  const overrideD = parseFloat($('burstDiameterOverride').value);
  const burstDiameter = overrideD > 0 ? overrideD : estimateBurstDiameter(balloonW);
  const Vburst = (4 / 3) * Math.PI * Math.pow(burstDiameter / 2, 3);
  const burstAlt = solveBurstAltitude(atmosphere, z0, P0, T0, V0, Vburst, 45000);

  let releaseAlt, note = '';
  if (targetModeVal === 'burst') {
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
  const tropopauseAlt = computeTropopause(weather.tempLevels);

  return {
    weather, atmosphere, z0, P0, T0, burstAlt, releaseAlt, traj, V0,
    burstDiameter, Vburst, distanceM, ascentTimeSec, grossLiftKg, netLiftKg,
    tropopauseAlt, note,
  };
}

async function runCalculation() {
  if (state.busy) return;
  state.busy = true;
  $('calcError').textContent = '';
  setStatus('Fetching weather…', 'wind + pressure levels');
  try {
    const lat = parseFloat($('launchLat').value);
    const lon = parseFloat($('launchLon').value);
    const r = await calculateFor(lat, lon);
    state.lastResult = r;
    renderResults(r);
    drawTrajectory(r.traj);
    drawProfile(r.traj);
    openResults();
    setStatus(r.note ? 'Note — see form' : 'Calculation complete', `wx: ${r.weather.matchedTime} UTC`);
  } finally {
    state.busy = false;
  }
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function renderResults(r) {
  $('resPressure').textContent = `${(r.P0 / 100).toFixed(1)} hPa`;
  $('resGrossLift').textContent = `${(r.grossLiftKg * 1000).toFixed(1)} g`;
  $('resNetLift').textContent = `${(r.netLiftKg * 1000).toFixed(1)} g`;
  $('resGasVolume').textContent = `${r.V0.toFixed(3)} m³`;
  const diam = Math.cbrt((6 * r.V0) / Math.PI);
  $('resDiameter').textContent = `${diam.toFixed(2)} m`;
  $('resBurstAlt').textContent = r.burstAlt ? `${Math.round(r.burstAlt).toLocaleString()} m AMSL` : 'not reached ≤45 km';
  $('resAscentTime').textContent = fmtDuration(r.ascentTimeSec);
  $('resFlightTime').textContent = fmtDuration(r.traj.totalTimeSec);
  $('resDistance').textContent = `${(r.distanceM / 1000).toFixed(1)} km`;
  $('resTropopause').textContent = r.tropopauseAlt
    ? `${Math.round(r.tropopauseAlt).toLocaleString()} m AMSL`
    : 'not detectable from levels';
  $('resWeatherSource').textContent = `Open-Meteo ${r.weather.isArchive ? '(historical archive)' : '(forecast)'} — model: ${r.weather.modelUsed} — matched: ${r.weather.matchedTime} UTC`;
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

// ---------------------------------------------------------------------
// Profile chart: compact box with fine grid (500 m / 10 min)
// ---------------------------------------------------------------------
function drawProfile(traj) {
  const svg = $('profileSvg');
  const W = 420, H = 280, padL = 48, padB = 28, padT = 10, padR = 10;
  const plotW = W - padL - padR, plotH = H - padB - padT;

  const maxT = traj.totalTimeSec;
  const minA = Math.floor(traj.path[0].alt / 500) * 500;
  const maxAraw = traj.path[traj.releaseIdx].alt;
  const maxA = Math.ceil(maxAraw / 500) * 500;

  const x = t => padL + (t / maxT) * plotW;
  const y = a => padT + plotH - ((a - minA) / (maxA - minA)) * plotH;

  let grid = '';
  // Horizontal grid lines every 500 m
  for (let a = minA; a <= maxA; a += 500) {
    const yy = y(a);
    const major = a % 2500 === 0;
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid-line)" stroke-width="${major ? 1 : 0.5}" opacity="${major ? 0.9 : 0.5}"/>`;
    if (major) grid += `<text x="${padL - 5}" y="${yy + 3}" text-anchor="end" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">${(a / 1000).toFixed(1)}k</text>`;
  }
  // Vertical grid lines every 10 min
  const stepT = 600;
  const labelEvery = Math.max(1, Math.ceil((maxT / stepT) / 8)); // avoid label crowding
  let k = 0;
  for (let t = 0; t <= maxT; t += stepT, k++) {
    const xx = x(t);
    const labelled = k % labelEvery === 0;
    grid += `<line x1="${xx}" y1="${padT}" x2="${xx}" y2="${H - padB}" stroke="var(--grid-line)" stroke-width="${labelled ? 1 : 0.5}" opacity="${labelled ? 0.9 : 0.5}"/>`;
    if (labelled) grid += `<text x="${xx}" y="${H - padB + 12}" text-anchor="middle" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">${Math.round(t / 60)}′</text>`;
  }

  let d = `M ${x(0)} ${y(traj.path[0].alt)}`;
  traj.path.forEach(p => { d += ` L ${x(p.t)} ${y(p.alt)}`; });

  const releaseP = traj.path[traj.releaseIdx];
  const landP = traj.path[traj.path.length - 1];

  svg.innerHTML = `
    ${grid}
    <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="none" stroke="var(--grid-line)" stroke-width="1"/>
    <path d="${d}" fill="none" stroke="#4fd1c5" stroke-width="2"/>
    <circle cx="${x(0)}" cy="${y(traj.path[0].alt)}" r="3.5" fill="#59d18f"/>
    <circle cx="${x(releaseP.t)}" cy="${y(releaseP.alt)}" r="3.5" fill="#ffb020"/>
    <circle cx="${x(landP.t)}" cy="${y(landP.alt)}" r="3.5" fill="#ff6b6b"/>
    <text x="${padL - 5}" y="${padT + 4}" text-anchor="end" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">m</text>
    <text x="${W - padR}" y="${H - 4}" text-anchor="end" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">min</text>
  `;
}

// ---------------------------------------------------------------------
// Backward mode: click sets desired landing; solve a matching launch site.
// ---------------------------------------------------------------------
async function reverseCalcFromLanding(targetLat, targetLon) {
  state.busy = true;
  try {
    // Mark the desired landing point (violet) immediately.
    if (state.targetMarker) state.map.removeLayer(state.targetMarker);
    state.targetMarker = L.circleMarker([targetLat, targetLon], markerStyle('target')).addTo(state.map)
      .bindPopup(`Desired landing<br>${targetLat.toFixed(4)}, ${targetLon.toFixed(4)}`).openPopup();

    setStatus('Back-solving launch site…', 'iterating against wind field');
    $('calcError').textContent = '';

    // Start from the current launch coordinates; if no calculation exists
    // yet, seed the drift vector with a forward run first.
    let launchLat = parseFloat($('launchLat').value);
    let launchLon = parseFloat($('launchLon').value);

    // Iteratively shift the launch point by the residual landing error.
    let result = null;
    for (let iter = 0; iter < 3; iter++) {
      result = await calculateFor(launchLat, launchLon);
      const dLat = targetLat - result.traj.landing.lat;
      const dLon = targetLon - result.traj.landing.lon;
      const errM = haversine(targetLat, targetLon, result.traj.landing.lat, result.traj.landing.lon);
      if (errM < 500) break; // close enough
      launchLat += dLat;
      launchLon += dLon;
    }

    // Final run from the solved launch point.
    result = await calculateFor(launchLat, launchLon);
    state.lastResult = result;

    $('launchLat').value = launchLat.toFixed(5);
    $('launchLon').value = launchLon.toFixed(5);
    state.launchMarker.setLatLng([launchLat, launchLon]);

    renderResults(result);
    drawTrajectory(result.traj);
    drawProfile(result.traj);
    openResults();

    const finalErr = haversine(targetLat, targetLon, result.traj.landing.lat, result.traj.landing.lon);
    setStatus('Launch site back-solved', `landing ${(finalErr / 1000).toFixed(1)} km from target`);
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------
// Export: JSON / print / share link / image
// ---------------------------------------------------------------------
function gatherInputs() {
  return {
    sondeType: $('sondeType').value, sondeWeight: $('sondeWeight').value, riggingWeight: $('riggingWeight').value,
    balloonType: $('balloonType').value, balloonWeight: $('balloonWeight').value, burstDiameterOverride: $('burstDiameterOverride').value,
    gasType: $('gasType').value, gasLift: $('gasLift').value,
    launchLat: $('launchLat').value, launchLon: $('launchLon').value,
    launchDate: $('launchDate').value, launchTime: $('launchTime').value,
    weatherModel: $('weatherModel').value,
    targetMode: $('targetMode').value, targetAltitude: $('targetAltitude').value,
    ascentRate: $('ascentRate').value, descentRate: $('descentRate').value,
  };
}

function applyInputs(inputs) {
  Object.entries(inputs).forEach(([k, v]) => { if ($(k) && v != null) $(k).value = v; });
  $('targetAltitudeWrap').style.display = $('targetMode').value === 'altitude' ? '' : 'none';
  if (state.map) {
    const la = parseFloat(inputs.launchLat), lo = parseFloat(inputs.launchLon);
    if (!isNaN(la) && !isNaN(lo)) { state.launchMarker.setLatLng([la, lo]); state.map.panTo([la, lo]); }
  }
}

function exportJson() {
  if (!state.lastResult) { setStatus('Run a calculation first before exporting.'); return; }
  const results = {};
  document.querySelectorAll('.result-card').forEach(card => {
    results[card.querySelector('.label').textContent] = card.querySelector('.value').textContent;
  });
  const payload = { generatedAt: new Date().toISOString(), inputs: gatherInputs(), results };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sonde-flight-plan-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function copyShareLink() {
  const encoded = btoa(encodeURIComponent(JSON.stringify(gatherInputs())));
  const url = `${location.origin}${location.pathname}?state=${encoded}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(
      () => setStatus('Share link copied to clipboard.'),
      () => setStatus(`Share link: ${url}`)
    );
  } else {
    setStatus(`Share link: ${url}`);
  }
}

function loadStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const encoded = params.get('state');
  if (!encoded) return;
  try {
    const inputs = JSON.parse(decodeURIComponent(atob(encoded)));
    applyInputs(inputs);
    setStatus('Link parameters loaded', 'press Calculate to run');
  } catch (e) { /* malformed */ }
}

function exportImage() {
  if (typeof html2canvas === 'undefined') { setStatus('Image export library failed to load.'); return; }
  setStatus('Rendering image export…');
  html2canvas($('resultsCard'), { backgroundColor: null, useCORS: true }).then(canvas => {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `sonde-flight-plan-${Date.now()}.png`;
    a.click();
    setStatus('Image exported.');
  }).catch(() => {
    setStatus('Image export failed — try a screenshot instead.');
  });
}

// ---------------------------------------------------------------------
// Wiring (each block guarded so one failure can't break the rest)
// ---------------------------------------------------------------------
function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
  else console.warn('Missing element:', id);
}

function wireUI() {
  on('sondeType', 'change', e => {
    const w = e.target.selectedOptions[0].dataset.weight;
    if (w) $('sondeWeight').value = w;
  });
  on('balloonType', 'change', e => {
    const w = e.target.selectedOptions[0].dataset.weight;
    if (w) $('balloonWeight').value = w;
    updateBurstHint();
  });
  on('balloonWeight', 'input', updateBurstHint);
  on('burstDiameterOverride', 'input', updateBurstHint);
  on('addPresetBtn', 'click', addPreset);
  on('editPresetBtn', 'click', editPreset);
  on('deletePresetBtn', 'click', deletePreset);
  on('gasType', 'change', e => {
    const l = e.target.selectedOptions[0].dataset.lift;
    if (l) $('gasLift').value = l;
  });
  on('targetMode', 'change', e => {
    $('targetAltitudeWrap').style.display = e.target.value === 'altitude' ? '' : 'none';
  });
  on('geolocateBtn', 'click', useDeviceLocation);
  on('searchBtn', 'click', searchPlace);
  on('placeSearch', 'keydown', e => { if (e.key === 'Enter') searchPlace(); });
  ['launchLat', 'launchLon'].forEach(id => on(id, 'change', () => {
    const lat = parseFloat($('launchLat').value), lon = parseFloat($('launchLon').value);
    if (!isNaN(lat) && !isNaN(lon)) { state.launchMarker.setLatLng([lat, lon]); state.map.panTo([lat, lon]); }
  }));
  on('calcBtn', 'click', () => runCalculation().catch(showError));
  on('themeToggle', 'click', () => {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    applyTheme(cur === 'light' ? 'dark' : 'light');
  });
  on('exportJsonBtn', 'click', exportJson);
  on('printBtn', 'click', () => window.print());
  on('copyLinkBtn', 'click', copyShareLink);
  on('exportImageBtn', 'click', exportImage);

  // Results modal controls
  on('resultsCloseBtn', 'click', closeResults);
  on('resultsOpenBtn', 'click', openResults);
  on('resultsModal', 'click', e => { if (e.target === $('resultsModal')) closeResults(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeResults(); });

  // Sidebar collapse handle (cockpit idiom)
  on('sidebarHandle', 'click', () => {
    const sb = $('sidebar');
    sb.classList.toggle('collapsed');
    $('sidebarHandle').textContent = sb.classList.contains('collapsed') ? '◀' : '▶';
    setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 280);
  });
  if ($('sidebarHandle')) $('sidebarHandle').textContent = '▶';

  // Collapsible cards
  document.querySelectorAll('.card > h3').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });

  // Keep map sized correctly on orientation change / resize (iPad)
  window.addEventListener('resize', () => { if (state.map) setTimeout(() => state.map.invalidateSize(), 150); });
}

window.addEventListener('DOMContentLoaded', () => {
  const safe = (label, fn) => { try { fn(); } catch (e) { console.error(label, e); } };

  safe('theme', () => {
    let theme = 'dark';
    try { theme = localStorage.getItem('sfp_theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); } catch (e) { /* ignore */ }
    applyTheme(theme);
  });
  safe('defaults', nowDefaults);
  safe('map', initMap);
  safe('presets', () => renderPresetSelect('qualatex-9'));
  safe('wiring', wireUI);
  safe('bursthint', updateBurstHint);
  safe('urlstate', loadStateFromUrl);
});
