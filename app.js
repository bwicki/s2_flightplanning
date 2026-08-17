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

// ICAO coordinate notation: degrees / minutes / seconds.decimal + hemisphere,
// e.g. 47\u00b022'36.8"N 008\u00b032'30.1"E (longitude with 3-digit degrees).
function fmtDMS(v, isLat) {
  const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = ((a - d) * 60 - m) * 60;
  if (s >= 59.95) { s = 0; m += 1; }
  if (m >= 60) { m = 0; d += 1; }
  const dp = String(d).padStart(isLat ? 2 : 3, '0');
  const mp = String(m).padStart(2, '0');
  const sp = s.toFixed(1).padStart(4, '0');
  return `${dp}\u00b0${mp}'${sp}"${hemi}`;
}
function fmtCoordsDMS(lat, lon) { return `${fmtDMS(lat, true)} ${fmtDMS(lon, false)}`; }

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

// When no model is selected, pick a concrete one ourselves (highest usable
// resolution for the location and lead time) so it can be named in the UI.
function autoSelectModel(lat, lon, daysAhead) {
  const inD2 = lat >= 43.2 && lat <= 58 && lon >= -3.9 && lon <= 20.3;
  const inEU = lat >= 29.5 && lat <= 70.5 && lon >= -23.5 && lon <= 62.5;
  if (daysAhead <= 1.8 && inD2) return 'icon_d2';
  if (daysAhead <= 4.8 && inEU) return 'icon_eu';
  return 'ecmwf_ifs025';
}

async function fetchWeather(lat, lon, dateUTC, timeUTC, modelSlug) {
  const requested = new Date(`${dateUTC}T${timeUTC}:00Z`);
  const now = new Date();
  const daysFromNow = (requested - now) / 86400000;

  const hourlyParams = buildHourlyParams();
  let url, isArchive = false;
  let modelAuto = false;
  const archiveReq = daysFromNow < -5 || daysFromNow > 15;
  if (!modelSlug && !archiveReq) {
    modelSlug = autoSelectModel(lat, lon, Math.max(0, daysFromNow));
    modelAuto = true;
  }
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
  let fellBack = false;
  if (!res.ok && modelSlug) {
    res = await fetch(url.replace(modelParam, ''));
    modelSlug = null;
    fellBack = true;
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
    loadedAt: new Date(),
    modelUsed: modelSlug || (isArchive ? 'era5' : 'best_match'),
    modelAuto,
    modelFellBack: fellBack,
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
  { id: 'qualatex-9', name: 'Qualatex 9 g (latex balloon)', weight: 9 },
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
      if (Array.isArray(parsed) && parsed.length) {
        // Migration: drop the old "party" wording from persisted lists.
        let changed = false;
        parsed.forEach(p => {
          if (p && p.name === 'Qualatex 9 g (latex party balloon)') { p.name = 'Qualatex 9 g (latex balloon)'; changed = true; }
        });
        if (changed) savePresets(parsed);
        return parsed;
      }
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

function presetEditorEl() { return $('presetEditor'); }

function openPresetEditor(mode) {
  const ed = presetEditorEl();
  if (!ed) return;
  const sel = $('balloonType');
  const presets = loadPresets();
  const cur = presets.find(p => p.id === sel.value);
  ed.dataset.mode = mode;
  ed.hidden = false;
  const nameI = $('presetName'), wI = $('presetWeightInput'), msg = $('presetMsg');
  const saveB = $('presetSaveBtn');
  msg.textContent = '';
  if (mode === 'add') {
    nameI.value = ''; wI.value = '20';
    nameI.disabled = false; wI.disabled = false;
    saveB.textContent = 'Save';
    msg.textContent = 'New preset:';
  } else if (mode === 'edit') {
    if (sel.value === 'custom' || !cur) { msg.textContent = '"Custom…" is not a saved preset — edit the weight field directly.'; nameI.disabled = true; wI.disabled = true; saveB.textContent = 'OK'; ed.dataset.mode = 'noop'; return; }
    nameI.value = cur.name; wI.value = cur.weight;
    nameI.disabled = false; wI.disabled = false;
    saveB.textContent = 'Save';
    msg.textContent = 'Edit preset:';
  } else if (mode === 'delete') {
    if (sel.value === 'custom' || !cur) { msg.textContent = '"Custom…" can\u2019t be deleted.'; nameI.disabled = true; wI.disabled = true; saveB.textContent = 'OK'; ed.dataset.mode = 'noop'; return; }
    if (presets.length <= 1) { msg.textContent = 'At least one saved preset must remain.'; nameI.disabled = true; wI.disabled = true; saveB.textContent = 'OK'; ed.dataset.mode = 'noop'; return; }
    nameI.value = cur.name; wI.value = cur.weight;
    nameI.disabled = true; wI.disabled = true;
    saveB.textContent = 'Delete';
    msg.textContent = `Delete preset "${cur.name}"?`;
  }
}

function closePresetEditor() { const ed = presetEditorEl(); if (ed) ed.hidden = true; }

function commitPresetEditor() {
  const ed = presetEditorEl();
  if (!ed) return;
  const mode = ed.dataset.mode;
  const sel = $('balloonType');
  let presets = loadPresets();
  const msg = $('presetMsg');
  if (mode === 'noop') { closePresetEditor(); return; }
  if (mode === 'delete') {
    presets = presets.filter(x => x.id !== sel.value);
    savePresets(presets);
    renderPresetSelect(presets[0].id);
    updateBurstHint();
    closePresetEditor();
    return;
  }
  const name = $('presetName').value.trim();
  const weight = parseFloat($('presetWeightInput').value);
  if (!name) { msg.textContent = 'Please enter a preset name.'; return; }
  if (!weight || weight <= 0) { msg.textContent = 'Please enter a valid weight in grams.'; return; }
  if (mode === 'add') {
    const id = 'custom-' + Date.now();
    presets.push({ id, name, weight });
    savePresets(presets);
    renderPresetSelect(id);
  } else if (mode === 'edit') {
    const idx = presets.findIndex(p => p.id === sel.value);
    if (idx !== -1) {
      presets[idx] = { ...presets[idx], name, weight };
      savePresets(presets);
      renderPresetSelect(presets[idx].id);
    }
  }
  updateBurstHint();
  closePresetEditor();
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
  airspaceLayer: null,
  ensembleLayer: null,
  ensembleActive: false,
  ensembleCount: 0,
  trajectoryGradient: null,
  profileViolations: [],
  lastResult: null,
  busy: false,
};

// Pictorial map signatures (SVG divIcons). Anchors: balloon & parachute sit
// with their payload point on the coordinate; explosion & crosshair centered.
const SIG_SVGS = {
  launch: {
    svg: `<svg width="30" height="30" viewBox="0 0 30 30"><ellipse cx="15" cy="9" rx="7.5" ry="8.5" fill="#4169e1" stroke="#ffffff" stroke-width="2"/><path d="M13.5 17.5 L16.5 17.5 L15.8 20 L14.2 20 Z" fill="#4169e1" stroke="#fff" stroke-width="0.8"/><line x1="15" y1="20" x2="15" y2="25" stroke="#ffffff" stroke-width="1.6"/><rect x="12.6" y="25" width="4.8" height="4" rx="1" fill="#4169e1" stroke="#ffffff" stroke-width="1.4"/></svg>`,
    size: [30, 30], anchor: [15, 29],
  },
  release: { // small explosion
    svg: `<svg width="32" height="32" viewBox="0 0 32 32"><path d="M16 1 L19.2 9.5 L27.5 5.5 L22.5 13 L31 16 L22.5 19 L27.5 26.5 L19.2 22.5 L16 31 L12.8 22.5 L4.5 26.5 L9.5 19 L1 16 L9.5 13 L4.5 5.5 L12.8 9.5 Z" fill="#ffb454" stroke="#0a0d10" stroke-width="1.4"/><path d="M16 8 L17.8 13.2 L23 11 L19.8 15.2 L25 16 L19.8 16.8 L23 21 L17.8 18.8 L16 24 L14.2 18.8 L9 21 L12.2 16.8 L7 16 L12.2 15.2 L9 11 L14.2 13.2 Z" fill="#e0483f"/><circle cx="16" cy="16" r="3" fill="#fff2c9"/></svg>`,
    size: [32, 32], anchor: [16, 16],
  },
  land: { // parachute with sonde
    svg: `<svg width="30" height="32" viewBox="0 0 30 32"><path d="M3.5 13 A12 10.5 0 0 1 26.5 13 Z" fill="#e0483f" stroke="#ffffff" stroke-width="1.8"/><path d="M3.5 13 Q9 10.5 15 13 Q21 10.5 26.5 13" fill="none" stroke="#ffffff" stroke-width="1"/><line x1="4.5" y1="13.5" x2="14" y2="26" stroke="#ffffff" stroke-width="1.3"/><line x1="25.5" y1="13.5" x2="16" y2="26" stroke="#ffffff" stroke-width="1.3"/><rect x="12.4" y="26" width="5.2" height="4.4" rx="1" fill="#e0483f" stroke="#ffffff" stroke-width="1.4"/></svg>`,
    size: [30, 32], anchor: [15, 31],
  },
  target: { // desired landing crosshair
    svg: `<svg width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="9" fill="none" stroke="#b78cff" stroke-width="3"/><circle cx="15" cy="15" r="9" fill="rgba(183,140,255,0.15)"/><line x1="15" y1="1" x2="15" y2="8" stroke="#b78cff" stroke-width="3"/><line x1="15" y1="22" x2="15" y2="29" stroke="#b78cff" stroke-width="3"/><line x1="1" y1="15" x2="8" y2="15" stroke="#b78cff" stroke-width="3"/><line x1="22" y1="15" x2="29" y2="15" stroke="#b78cff" stroke-width="3"/><circle cx="15" cy="15" r="2.6" fill="#b78cff"/></svg>`,
    size: [30, 30], anchor: [15, 15],
  },
  device: { // current device position: pulsing ring + bold dot
    html: `<div class="device-marker"><div class="dm-ring"></div><div class="dm-dot"></div></div>`,
    size: [34, 34], anchor: [17, 17],
  },
};


function sigMarker(lat, lon, kind) {
  const s = SIG_SVGS[kind];
  const m = L.marker([lat, lon], {
    icon: L.divIcon({
      className: 'sig-marker',
      html: s.html || s.svg,
      iconSize: s.size,
      iconAnchor: s.anchor,
    }),
  });
  if (kind === 'device') m.setZIndexOffset(1200);
  return m;
}

function currentMode() {
  const checked = document.querySelector('input[name="searchMode"]:checked');
  return checked ? checked.value : 'forward';
}

const APP_VERSION = 'v1.56.0 · 2026-08-17';

function initMap() {
  state.map = L.map('map', { worldCopyJump: true, zoomControl: false }).setView([parseFloat($('launchLat').value), parseFloat($('launchLon').value)], 12);

  // Zoom + scale bar bottom-right (cockpit idiom)
  L.control.zoom({ position: 'bottomright' }).addTo(state.map);
  // Cockpit-style scale bar (custom, updates on zoom/pan)
  (function () {
    const bar = document.createElement('div');
    bar.className = 'map-scale-bar';
    bar.innerHTML = '<div class="map-scale-ruler-wrap"><div class="map-scale-ruler"><div></div><div></div><div></div><div></div></div><span class="map-scale-tick-label" style="left:0;">0</span><span class="map-scale-tick-label" id="scaleMid" style="left:50%;transform:translateX(-50%);"></span><span class="map-scale-tick-label" id="scaleEnd" style="right:0;"></span></div><span class="map-scale-text"><span id="scaleKm"></span> · <span class="map-scale-ratio" id="scaleRatio"></span></span>';
    document.getElementById('mapwrap').appendChild(bar);
    const fmt = (m) => m >= 1000 ? (m / 1000 >= 10 ? Math.round(m / 1000) + ' km' : (m / 1000).toFixed(1).replace(/\.0$/, '') + ' km') : Math.round(m) + ' m';
    function updateScale() {
      const map = state.map;
      const c = map.getSize().y / 2;
      const p1 = map.containerPointToLatLng([0, c]);
      const p2 = map.containerPointToLatLng([100, c]);
      const mPer100px = map.distance(p1, p2);
      const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000];
      let target = mPer100px * 1.2;
      let dist = nice[nice.length - 1];
      for (const n of nice) { if (n >= target) { dist = n; break; } }
      const px = dist / mPer100px * 100;
      bar.querySelector('.map-scale-ruler').style.width = px + 'px';
      document.getElementById('scaleMid').textContent = fmt(dist / 2);
      document.getElementById('scaleEnd').textContent = fmt(dist);
      document.getElementById('scaleKm').textContent = fmt(dist);
      const mPerPx = mPer100px / 100;
      const denom = Math.round(mPerPx * 96 / 0.0254);
      document.getElementById('scaleRatio').textContent = '\u2248 1:' + denom.toLocaleString('de-CH');
    }
    state.map.on('zoomend moveend resize', updateScale);
    setTimeout(updateScale, 200);
  })();

  // Version badge bottom-left (cockpit idiom)
  const vc = $('versionChip');
  if (vc) vc.textContent = APP_VERSION;

  // Base layers + always-visible radio control, top-right (cockpit idiom)
  const baseLayers = {
    'Streets': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
    'Terrain': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap' }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '© Esri' }),
    'Light': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd', attribution: '© OpenStreetMap, © CARTO' }),
  };
  baseLayers['Streets'].addTo(state.map);
  let activeBaseLayerName = 'Streets';
  const BaseLayerRadioControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'base-layer-radio');
      div.innerHTML = Object.keys(baseLayers).map(name =>
        `<label><input type="radio" name="baseLayerRadio" value="${name}" ${name === 'Streets' ? 'checked' : ''}><span>${name}</span></label>`
      ).join('');
      L.DomEvent.disableClickPropagation(div);
      div.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', () => {
          if (!input.checked) return;
          state.map.removeLayer(baseLayers[activeBaseLayerName]);
          activeBaseLayerName = input.value;
          baseLayers[activeBaseLayerName].addTo(state.map);
        });
      });
      return div;
    }
  });
  state.map.addControl(new BaseLayerRadioControl());
  state.setBaseLayer = (name) => {
    if (!baseLayers[name] || name === activeBaseLayerName) return activeBaseLayerName;
    const prev = activeBaseLayerName;
    state.map.removeLayer(baseLayers[activeBaseLayerName]);
    activeBaseLayerName = name;
    baseLayers[name].addTo(state.map);
    const r = document.querySelector(`.base-layer-radio input[value="${name}"]`);
    if (r) r.checked = true;
    return prev;
  };

  state.launchMarker = sigMarker(parseFloat($('launchLat').value), parseFloat($('launchLon').value), 'launch').addTo(state.map);
  attachPointZoom(state.launchMarker, ll => `Launch site<br>${fmtCoordsDMS(ll.lat, ll.lng)}`);

  state.map.on('click', (e) => {
    if (state.busy) return;
    if (currentMode() === 'backward') {
      reverseCalcFromLanding(e.latlng.lat, e.latlng.lng).catch(showError);
    } else {
      setLaunchPoint(e.latlng.lat, e.latlng.lng);
      runCalculation().catch(showError);
    }
  });

  // Force size recompute once flex layout settles (cockpit idiom)
  const fixMapSize = () => state.map.invalidateSize();
  window.addEventListener('load', fixMapSize);
  window.addEventListener('orientationchange', () => setTimeout(fixMapSize, 300));
  setTimeout(fixMapSize, 50);
  setTimeout(fixMapSize, 300);
  if (window.ResizeObserver) new ResizeObserver(fixMapSize).observe(document.getElementById('mapwrap'));

  // Start centered on the device position (~20 km view) when permitted;
  // silently keep the default location otherwise.
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude, longitude } = pos.coords;
      if (state.deviceMarker) state.map.removeLayer(state.deviceMarker);
      state.deviceMarker = sigMarker(latitude, longitude, 'device').addTo(state.map).bindPopup('Device position');
      setLaunchPoint(latitude, longitude);
      state.map.setView([latitude, longitude], 12);
      setStatus('Centered on device position', `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
    }, () => { /* permission denied or unavailable: keep default */ }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  }
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
  // Default launch time: 45 minutes from now (rounded up to 5 min), UTC core.
  const now = new Date(Date.now() + 45 * 60000);
  now.setUTCMinutes(Math.ceil(now.getUTCMinutes() / 5) * 5, 0, 0);
  $('launchDate').value = now.toISOString().slice(0, 10);
  $('launchTime').value = now.toISOString().slice(11, 16);
}

function applyTheme(theme) {
  document.body.classList.toggle('day', theme === 'light');
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('themeToggle');
  if (btn) btn.innerHTML = theme === 'light' ? '<span>◑ Switch to night mode</span>' : '<span>◐ Switch to day mode</span>';
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
    state.deviceMarker = sigMarker(latitude, longitude, 'device').addTo(state.map)
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
  const d = $('resultsDrawer');
  const h = $('resultsHandle');
  if (d) d.classList.remove('collapsed');
  if (h) h.classList.remove('closed');
  const mw = $('mapwrap');
  if (mw) mw.classList.add('results-open');
}
function closeResults() {
  const d = $('resultsDrawer');
  const h = $('resultsHandle');
  if (d) d.classList.add('collapsed');
  if (h) h.classList.add('closed');
  const mw = $('mapwrap');
  if (mw) mw.classList.remove('results-open');
}
function toggleResults() {
  const d = $('resultsDrawer');
  if (!d) return;
  if (d.classList.contains('collapsed')) openResults(); else closeResults();
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
async function calculateFor(lat, lon, modelOverride) {
  const dateUTC = $('launchDate').value;
  const timeUTC = $('launchTime').value;
  if (!dateUTC || !timeUTC) throw new Error('Please set a launch date and time (UTC).');

  const modelSlug = modelOverride !== undefined ? modelOverride : ($('weatherModel').value || null);
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
  const drawer = $('menuDrawer');
  if (drawer) drawer.classList.add('collapsed');
  const dh = $('drawerHandle');
  if (dh) dh.classList.add('closed');
  const rb0 = $('quickControls');
  if (rb0) rb0.classList.add('closed');
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
    setTimeout(fitFlightPath, 320);
    checkAirspaceViolations(r.traj).catch(() => {});
    updateGmapsBtn();
    updateEnsembleBtn();
    updateWxChip(r.weather.modelUsed, {
      auto: r.weather.modelAuto,
      fellBack: r.weather.modelFellBack,
      requested: $('weatherModel').value,
      time: r.weather.matchedTime,
      loadedAt: r.weather.loadedAt,
    });
    setStatus(r.note ? 'Note — see form' : 'Calculation complete', `wx: ${r.weather.matchedTime} UTC`);
  } finally {
    state.busy = false;
  }
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return { num: `${h} h ${String(m).padStart(2, '0')} min`, unit: '' };
}

// Every result value gets an explicit unit, rendered as number + muted unit tag
function setVal(id, num, unit) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = '';
  el.appendChild(document.createTextNode(num));
  if (unit) {
    const u = document.createElement('span');
    u.className = 'unit';
    u.textContent = unit;
    el.appendChild(u);
  }
}


// Reverse geocoding for "near <place>/<CC>" labels (Nominatim, cached, best effort)
const revGeoCache = new Map();
async function reverseGeocode(lat, lon) {
  const key = lat.toFixed(2) + ',' + lon.toFixed(2);
  if (revGeoCache.has(key)) return revGeoCache.get(key);
  let out = null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12&accept-language=en`, { signal: ctl.signal });
    clearTimeout(t);
    if (res.ok) {
      const d = await res.json();
      const a = d.address || {};
      const place = a.village || a.town || a.city || a.municipality || a.hamlet || a.county || null;
      const cc = (a.country_code || '').toUpperCase();
      if (place) out = `near ${place}${cc ? '/' + cc : ''}`;
    }
  } catch (e) { /* offline / rate limited -> coords only */ }
  revGeoCache.set(key, out);
  return out;
}

let ptLabelToken = 0;
function fillPointCells(r) {
  const launch = r.traj.path[0];
  const land = r.traj.landing;
  const set = (el, p) => {
    if (!el) return;
    el.innerHTML = `<span class="pt-coord">${fmtCoordsDMS(p.lat, p.lon)}</span><span class="pt-place">\u2026</span>`;
  };
  const el1 = $('resLaunchPt'), el2 = $('resLandingPt');
  set(el1, launch);
  set(el2, land);
  const token = ++ptLabelToken;
  const fillPlace = (el, lat, lon) => reverseGeocode(lat, lon).then(pl => {
    if (token !== ptLabelToken || !el) return;
    const ps = el.querySelector('.pt-place');
    if (ps) ps.textContent = pl || '';
  });
  fillPlace(el1, launch.lat, launch.lon);
  fillPlace(el2, land.lat, land.lon);
}

function renderResults(r) {
  setVal('resPressure', (r.P0 / 100).toFixed(1), 'hPa');
  setVal('resGrossLift', (r.grossLiftKg * 1000).toFixed(1), 'g');
  setVal('resNetLift', (r.netLiftKg * 1000).toFixed(1), 'g');
  setVal('resGasVolume', r.V0.toFixed(3), 'm³');
  const diam = Math.cbrt(6 * r.V0 / Math.PI);
  setVal('resDiameter', diam.toFixed(2), 'm');
  if (r.burstAlt) setVal('resBurstAlt', Math.round(r.burstAlt).toLocaleString('de-CH'), 'm AMSL');
  else setVal('resBurstAlt', 'not reached', '≤ 45 km');
  const at = fmtDuration(r.ascentTimeSec);
  setVal('resAscentTime', at.num, at.unit);
  const ft = fmtDuration(r.traj.totalTimeSec);
  setVal('resFlightTime', ft.num, ft.unit);
  setVal('resDistance', (r.distanceM / 1000).toFixed(1), 'km');
  if (r.tropopauseAlt) setVal('resTropopause', Math.round(r.tropopauseAlt).toLocaleString('de-CH'), 'm AMSL');
  else setVal('resTropopause', 'not detectable', 'from levels');
  $('resWeatherSource').textContent = `Open-Meteo ${r.weather.isArchive ? '(historical archive)' : '(forecast)'} — model: ${r.weather.modelUsed} — matched: ${r.weather.matchedTime} UTC`;
  fillPointCells(r);
  if (r.note) $('calcError').textContent = r.note;
}

// Zoom fully onto a key point when its marker is clicked
function attachPointZoom(marker, labelFn) {
  marker.on('click', () => {
    const ll = marker.getLatLng();
    let z = 18;
    try { z = Math.min(state.map.getMaxZoom() || 18, 19); } catch (e) { /* keep 18 */ }
    if (!isFinite(z)) z = 18;
    state.map.flyTo(ll, z, { duration: 0.8 });
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`;
    const base = labelFn ? labelFn(ll) : (marker._baseHtml || '');
    marker.bindPopup(`${base}<br><a class="gmaps-link" href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps ↗</a>`, { autoClose: false });
    setTimeout(() => marker.openPopup(), 850);
  });
}

// Fit the whole flight path in view, keeping it clear of the open drawers
function fitFlightPath() {
  if (!state.trajectoryLine) return;
  const rd = $('resultsDrawer');
  const resultsOpen = rd && !rd.classList.contains('collapsed');
  const md = $('menuDrawer');
  const paramsOpen = md && !md.classList.contains('collapsed');
  const rightPad = (resultsOpen ? Math.min(440, window.innerWidth * 0.92) : 0) + 50;
  const leftPad = (paramsOpen ? Math.min(620, window.innerWidth * 0.94) : 0) + 50;
  state.map.fitBounds(state.trajectoryLine.getBounds(), {
    paddingTopLeft: [leftPad, 60],
    paddingBottomRight: [rightPad, 70],
  });
}


// Canvas overlay stroking the flight path with genuine per-segment linear
// gradients (dark casing pass first, then the colored pass).
const GradientPathLayer = L.Layer.extend({
  initialize: function (latlngs, colors) { this._lls = latlngs; this._cols = colors; },
  onAdd: function (map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'flightpath-canvas leaflet-zoom-hide');
    this._canvas.style.pointerEvents = 'none';
    map.getPanes().overlayPane.appendChild(this._canvas);
    this._redraw = this._draw.bind(this);
    map.on('move zoomend viewreset resize', this._redraw);
    this._draw();
    return this;
  },
  onRemove: function (map) {
    map.off('move zoomend viewreset resize', this._redraw);
    if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
  },
  _draw: function () {
    const map = this._map;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this._canvas.width = size.x * dpr;
    this._canvas.height = size.y * dpr;
    this._canvas.style.width = size.x + 'px';
    this._canvas.style.height = size.y + 'px';
    L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));
    const ctx = this._canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    const pts = this._lls.map(ll => map.latLngToContainerPoint(ll));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // casing pass
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = 'rgba(10,13,16,0.75)';
    ctx.lineWidth = 8;
    ctx.stroke();
    // gradient pass, one linear gradient per segment
    ctx.lineWidth = 4;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (Math.abs(a.x - b.x) < 0.1 && Math.abs(a.y - b.y) < 0.1) continue;
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, this._cols[i - 1]);
      g.addColorStop(1, this._cols[i]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = g;
      ctx.stroke();
    }
  },
});

function drawTrajectory(traj) {
  state.profileViolations = [];
  clearEnsemble();
  if (state.trajectoryGradient) { state.map.removeLayer(state.trajectoryGradient); state.trajectoryGradient = null; }
  const slb0 = $('speedLegendBar');
  if (slb0 && !state.trajectoryLine) slb0.classList.remove('show');
  if (state.trajectoryLine) state.map.removeLayer(state.trajectoryLine);
  if (state.releaseMarker) state.map.removeLayer(state.releaseMarker);
  if (state.landMarker) state.map.removeLayer(state.landMarker);

  const latlngs = traj.path.map(p => [p.lat, p.lon]);

  // Continuous color gradient along the path, mapped to horizontal ground
  // speed (blue = slow ... red = fast), one short polyline per 200 m step.
  const segSpeeds = [];
  for (let i = 1; i < traj.path.length; i++) {
    const a = traj.path[i - 1], b = traj.path[i];
    const dt = b.t - a.t;
    segSpeeds.push(dt > 0 ? haversine(a.lat, a.lon, b.lat, b.lon) / dt * 3.6 : 0);
  }
  const speedColor = v => {
    const c = Math.min(Math.max(v, 0), 50) / 50;      // 0..1 over 0..50 km/h
    return `hsl(${Math.round(215 * (1 - c))}, 82%, 55%)`; // 215° blue -> 0° red
  };
  // Per-vertex speeds (average of adjacent segments); the canvas layer below
  // strokes every segment with a true linear color gradient between its two
  // endpoint colors, so the hue runs continuously along the whole path.
  const n = traj.path.length;
  const vSpd = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = segSpeeds[Math.max(0, i - 1)] ?? 0;
    const b = segSpeeds[Math.min(segSpeeds.length - 1, i)] ?? a;
    vSpd[i] = (a + b) / 2;
  }
  // Scale stretched to the speeds actually occurring in this trajectory
  // (guarded to a minimum 5 km/h span so noise does not explode the colors).
  let minV = Math.min(...vSpd), maxV = Math.max(...vSpd);
  if (!isFinite(minV)) { minV = 0; maxV = 1; }
  minV = Math.floor(minV);
  maxV = Math.ceil(maxV);
  if (maxV - minV < 5) maxV = minV + 5;
  const hueOf = v => 215 * (1 - Math.min(Math.max((v - minV) / (maxV - minV), 0), 1));
  const vColors = vSpd.map(v => `hsl(${(hueOf(v)).toFixed(1)}, 82%, 55%)`);

  state.trajectoryGradient = new GradientPathLayer(latlngs, vColors).addTo(state.map);
  // Invisible polyline keeps bounds/fitting and the "trajectory exists" checks working.
  state.trajectoryLine = L.polyline(latlngs, { opacity: 0, weight: 1, interactive: false }).addTo(state.map);
  const slb = $('speedLegendBar');
  if (slb) {
    slb.classList.add('show');
    const mid = Math.round((minV + maxV) / 2);
    if ($('gwlMin')) $('gwlMin').textContent = String(minV);
    if ($('gwlMid')) $('gwlMid').textContent = String(mid);
    if ($('gwlMax')) $('gwlMax').textContent = String(maxV);
  }

  const releasePt = traj.path[traj.releaseIdx];
  state.releaseMarker = sigMarker(releasePt.lat, releasePt.lon, 'release').addTo(state.map)
    .bindPopup(`Burst / release<br>${Math.round(releasePt.alt)} m AMSL`);
  state.releaseMarker._baseHtml = `Burst / release<br>${Math.round(releasePt.alt)} m AMSL`;
  attachPointZoom(state.releaseMarker);

  const land = traj.path[traj.path.length - 1];
  state.landMarker = sigMarker(land.lat, land.lon, 'land').addTo(state.map)
    .bindPopup(`Predicted landing<br>${fmtCoordsDMS(land.lat, land.lon)}`);
  state.landMarker._baseHtml = `Predicted landing<br>${fmtCoordsDMS(land.lat, land.lon)}`;
  attachPointZoom(state.landMarker);

  // Launch marker on top again for clarity
  if (state.launchMarker.setZIndexOffset) state.launchMarker.setZIndexOffset(400);

}

// ---------------------------------------------------------------------
// Profile chart: compact box with fine grid (500 m / 10 min)
// ---------------------------------------------------------------------
function drawProfile(traj) {
  const svg = $('profileSvg');
  const W = 420, H = 330, padL = 48, padR = 10;
  const p1T = 8, p1H = 168, p1B = p1T + p1H;
  const p2T = p1B + 20, p2H = 82, p2B = p2T + p2H;
  const plotW = W - padL - padR;

  const maxT = traj.totalTimeSec;
  const minA = Math.floor(traj.path[0].alt / 500) * 500;
  const maxA = Math.ceil(traj.path[traj.releaseIdx].alt / 500) * 500;

  const x = t => padL + (t / maxT) * plotW;
  const yA = a => p1T + p1H - ((a - minA) / (maxA - minA)) * p1H;

  // Horizontal ground speed per segment (km/h)
  const speeds = [0];
  for (let i = 1; i < traj.path.length; i++) {
    const a = traj.path[i - 1], b = traj.path[i];
    const dt = b.t - a.t;
    speeds.push(dt > 0 ? haversine(a.lat, a.lon, b.lat, b.lon) / dt * 3.6 : speeds[i - 1]);
  }
  speeds[0] = speeds.length > 1 ? speeds[1] : 0;
  const maxS = Math.max(...speeds);
  const niceS = Math.max(10, Math.ceil(maxS / 10) * 10);
  const yS = v => p2T + p2H - (v / niceS) * p2H;
  const maxIdx = speeds.indexOf(maxS);

  const spdColor = v => v < 15 ? '#3f7fd0' : v < 30 ? '#3fd06b' : v < 45 ? '#ffb454' : '#e0483f';

  let grid = '';
  for (let a = minA; a <= maxA; a += 500) {
    const yy = yA(a);
    const major = a % 2500 === 0;
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid-line)" stroke-width="${major ? 1 : 0.5}" opacity="${major ? 0.9 : 0.5}"/>`;
    if (major) grid += `<text x="${padL - 5}" y="${yy + 3}" text-anchor="end" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">${(a / 1000).toFixed(1)}k</text>`;
  }
  const stepT = 600;
  const labelEvery = Math.max(1, Math.ceil((maxT / stepT) / 8));
  let k = 0;
  for (let t = 0; t <= maxT; t += stepT, k++) {
    const xx = x(t);
    const labelled = k % labelEvery === 0;
    grid += `<line x1="${xx}" y1="${p1T}" x2="${xx}" y2="${p1B}" stroke="var(--grid-line)" stroke-width="${labelled ? 1 : 0.5}" opacity="${labelled ? 0.9 : 0.5}"/>`;
    grid += `<line x1="${xx}" y1="${p2T}" x2="${xx}" y2="${p2B}" stroke="var(--grid-line)" stroke-width="${labelled ? 1 : 0.5}" opacity="${labelled ? 0.9 : 0.5}"/>`;
    if (labelled) grid += `<text x="${xx}" y="${p2B + 12}" text-anchor="middle" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">${Math.round(t / 60)}′</text>`;
  }
  // Speed panel horizontal grid: half + full scale
  [niceS / 2, niceS].forEach(v => {
    const yy = yS(v);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid-line)" stroke-width="0.5" opacity="0.6"/>`;
    grid += `<text x="${padL - 5}" y="${yy + 3}" text-anchor="end" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">${Math.round(v)}</text>`;
  });

  // Altitude profile: consecutive segments merged per speed class (option A)
  let altSegs = '';
  let segD = `M ${x(traj.path[0].t)} ${yA(traj.path[0].alt)}`;
  let segCol = spdColor(speeds[1] || 0);
  for (let i = 1; i < traj.path.length; i++) {
    const col = spdColor(speeds[i]);
    const px = x(traj.path[i].t), py = yA(traj.path[i].alt);
    if (col !== segCol) {
      altSegs += `<path d="${segD}" fill="none" stroke="${segCol}" stroke-width="2.4" stroke-linecap="round"/>`;
      segD = `M ${x(traj.path[i - 1].t)} ${yA(traj.path[i - 1].alt)} L ${px} ${py}`;
      segCol = col;
    } else {
      segD += ` L ${px} ${py}`;
    }
  }
  altSegs += `<path d="${segD}" fill="none" stroke="${segCol}" stroke-width="2.4" stroke-linecap="round"/>`;

  // Ground speed panel (option C): area + line
  let spdLine = `M ${x(traj.path[0].t)} ${yS(speeds[0])}`;
  for (let i = 1; i < traj.path.length; i++) spdLine += ` L ${x(traj.path[i].t)} ${yS(speeds[i])}`;
  const spdArea = spdLine + ` L ${x(traj.path[traj.path.length - 1].t)} ${p2B} L ${x(traj.path[0].t)} ${p2B} Z`;

  const releaseP = traj.path[traj.releaseIdx];
  const landP = traj.path[traj.path.length - 1];
  const bx = x(releaseP.t);
  const mx = x(traj.path[maxIdx].t), my = yS(speeds[maxIdx]);
  const maxLabelX = Math.min(Math.max(mx, padL + 30), W - padR - 40);

  const legY = p2B + 20;
  const legend = `
    <rect x="${padL}" y="${legY}" width="13" height="6" fill="#3f7fd0"/>
    <rect x="${padL + 13}" y="${legY}" width="13" height="6" fill="#3fd06b"/>
    <rect x="${padL + 26}" y="${legY}" width="13" height="6" fill="#ffb454"/>
    <rect x="${padL + 39}" y="${legY}" width="13" height="6" fill="#e0483f"/>
    <text x="${padL + 58}" y="${legY + 6}" fill="var(--text-dim)" font-size="8" font-family="IBM Plex Mono">&lt;15 / 15–30 / 30–45 / &gt;45 km/h horiz.</text>
    <text x="${W - padR}" y="${legY + 6}" text-anchor="end" fill="var(--text-dim)" font-size="8" font-family="IBM Plex Mono">max ${Math.round(maxS)} km/h</text>
  `;

  // P4: red conflict boxes — time window x altitude band of each violated airspace
  let violBoxes = '';
  (state.profileViolations || []).forEach(v => {
    const x1 = Math.max(padL, x(v.tMin)), x2 = Math.min(W - padR, x(v.tMax));
    const y1 = Math.max(p1T, yA(Math.min(v.maxAlt, maxA)));
    const y2 = Math.min(p1B, yA(Math.max(v.minAlt, minA)));
    const w = Math.max(x2 - x1, 3), h = Math.max(y2 - y1, 3);
    violBoxes += `<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="#e0483f" opacity="0.18" stroke="#e0483f" stroke-width="1"/>`;
    if (w > 34) {
      const nm = String(v.it.name || '').slice(0, 14);
      violBoxes += `<text x="${x1 + 3}" y="${Math.max(y1 + 9, p1T + 9)}" fill="#e0483f" font-size="7.5" font-family="IBM Plex Mono">${nm} \u2717</text>`;
    }
  });

  svg.innerHTML = `
    ${grid}
    ${violBoxes}
    <rect x="${padL}" y="${p1T}" width="${plotW}" height="${p1H}" fill="none" stroke="var(--grid-line)" stroke-width="1"/>
    <rect x="${padL}" y="${p2T}" width="${plotW}" height="${p2H}" fill="none" stroke="var(--grid-line)" stroke-width="1"/>
    <line x1="${bx}" y1="${p1T}" x2="${bx}" y2="${p2B}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" opacity="0.8"/>
    <path d="${spdArea}" fill="#3fd0c9" opacity="0.12"/>
    <path d="${spdLine}" fill="none" stroke="#3fd0c9" stroke-width="1.8"/>
    ${altSegs}
    <circle cx="${x(0)}" cy="${yA(traj.path[0].alt)}" r="3.5" fill="#4169e1" stroke="#fff" stroke-width="1"/>
    <circle cx="${bx}" cy="${yA(releaseP.alt)}" r="3.8" fill="#ffb454" stroke="#fff" stroke-width="1"/>
    <circle cx="${x(landP.t)}" cy="${yA(landP.alt)}" r="3.5" fill="#e0483f" stroke="#fff" stroke-width="1"/>
    <circle cx="${mx}" cy="${my}" r="2.8" fill="#3fd0c9" stroke="#fff" stroke-width="1"/>
    <text x="${maxLabelX}" y="${Math.max(my - 5, p2T + 8)}" text-anchor="middle" fill="var(--text-dim)" font-size="8" font-family="IBM Plex Mono">${Math.round(maxS)} km/h</text>
    <text x="${padL - 5}" y="${p1T + 4}" text-anchor="end" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">m</text>
    <text x="${padL - 5}" y="${p2T + 4}" text-anchor="end" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">km/h</text>
    <text x="${W - padR}" y="${p2B + 12}" text-anchor="end" fill="var(--text-dim)" font-size="8.5" font-family="IBM Plex Mono">min</text>
    ${legend}
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
    state.targetMarker = sigMarker(targetLat, targetLon, 'target').addTo(state.map)
      .bindPopup(`Desired landing<br>${fmtCoordsDMS(targetLat, targetLon)}`).openPopup();

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
    setTimeout(fitFlightPath, 320);
    checkAirspaceViolations(result.traj).catch(() => {});
    updateGmapsBtn();
    updateEnsembleBtn();

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
  updateWxChip();
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
  const url = buildShareUrl();
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


// Reflect the effective weather model in the header chip.
// selectedValue = value of the hidden select; usedSlug (optional) = what the
// calculation actually used (differs from selection after a fallback).
function updateWxChip(usedSlug, opts) {
  const nameEl = $('wxModelName');
  const subEl = $('wxModelSub');
  if (!nameEl) return;
  const models = window.__wxModels || [];
  const sel = $('weatherModel') ? $('weatherModel').value : '';
  const labelFor = v => {
    if (v === 'era5') return 'ERA5 reanalysis';
    if (!v || v.startsWith('best_match')) return 'Best match (auto)';
    const m = models.find(mm => !mm.group && mm.v === v);
    return m ? m.label : v;
  };
  opts = opts || {};
  if (usedSlug !== undefined && usedSlug !== null) {
    nameEl.textContent = labelFor(usedSlug);
    if (subEl) {
      let info = '';
      if (opts.time) {
        const wxDate = new Date(opts.time + (opts.time.length === 16 ? ':00Z' : 'Z'));
        const loaded = opts.loadedAt || new Date();
        const p2 = x => String(x).padStart(2, '0');
        const leadH = Math.round((wxDate - loaded) / 3600000);
        info = `ld ${p2(loaded.getHours())}:${p2(loaded.getMinutes())} · wx ${leadH >= 0 ? '+' : ''}${leadH}h`;
      }
      if (opts.fellBack) subEl.textContent = 'fallback' + (info ? ' · ' + info : ' — retry');
      else if (opts.auto) subEl.textContent = 'auto' + (info ? ' · ' + info : '');
      else subEl.textContent = info || 'tap to change';
    }
    return;
  }
  nameEl.textContent = sel ? labelFor(sel) : 'Best match (auto)';
  if (subEl) subEl.textContent = 'tap to change';
}


// Re-run the existing prediction (forward or backward) after a parameter change
// from the release-altitude slider. Does nothing if no trajectory exists yet.
function recalcExistingTrajectory() {
  if (state.busy || !state.trajectoryLine) return;
  if (currentMode() === 'backward' && state.targetMarker) {
    const ll = state.targetMarker.getLatLng();
    reverseCalcFromLanding(ll.lat, ll.lng).catch(showError);
  } else {
    runCalculation().catch(showError);
  }
}


// =========================================================================
// Airspace overlay & violation check (OpenAIP core API, approximate)
// =========================================================================
const OPENAIP_DEFAULT_KEY = 'e9946fdef0b38f6540986cb7045f893a';
const AS_CATS = [
  { id: 'ctr',    label: 'CTR',              types: [4],      color: '#2f7fd0', def: true },
  { id: 'p',      label: 'Prohibited (P)',   types: [3],      color: '#e0483f', def: true },
  { id: 'r',      label: 'Restricted (R)',   types: [1],      color: '#e07a3f', def: false },
  { id: 'd',      label: 'Danger (D)',       types: [2],      color: '#e0b400', def: false },
  { id: 'tma',    label: 'TMA',              types: [7],      color: '#7a9bd0', def: true },
  { id: 'cta',    label: 'CTA (administrative)', types: [26], color: '#93a3b5', def: false },
  { id: 'tmz',    label: 'TMZ / RMZ',        types: [5, 6],   color: '#8cd0c9', def: false },
  { id: 'atz',    label: 'ATZ',              types: [13],     color: '#b78cff', def: false },
  { id: 'glider', label: 'Gliding sectors',  types: [21],     color: '#3fd06b', def: false },
];

function asPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('sfp_airspace_v2') || '{}');
    if (!p.cats) p.cats = {};
    AS_CATS.forEach(c => { if (p.cats[c.id] === undefined) p.cats[c.id] = c.def; });
    return p;
  } catch (e) { const p = { cats: {} }; AS_CATS.forEach(c => p.cats[c.id] = c.def); return p; }
}
function saveAsPrefs(p) { try { localStorage.setItem('sfp_airspace_v2', JSON.stringify(p)); } catch (e) { /* ignore */ } }

function enabledAsTypes() {
  const p = asPrefs();
  const types = new Map();
  AS_CATS.forEach(c => { if (p.cats[c.id]) c.types.forEach(t => types.set(t, c)); });
  return types;
}

// value/unit/referenceDatum -> metres AMSL (AGL approximated with ground elev)
function asLimitMeters(lim, groundElev) {
  if (!lim || lim.value === undefined) return null;
  let m;
  if (lim.unit === 6) m = lim.value * 100 * 0.3048;      // flight level
  else if (lim.unit === 1) m = lim.value * 0.3048;       // feet
  else m = lim.value;                                    // metres
  if (lim.referenceDatum === 0) m += (groundElev || 0);  // GND / AGL approx
  return m;
}
function asLimitText(lim) {
  if (!lim || lim.value === undefined) return '?';
  if (lim.unit === 6) return 'FL' + lim.value;
  const u = lim.unit === 1 ? 'ft' : 'm';
  const r = lim.referenceDatum === 0 ? ' AGL' : lim.referenceDatum === 2 ? ' STD' : ' AMSL';
  return `${lim.value} ${u}${r}`;
}

const asCache = new Map();
const asRelayCooldown = { corsproxy: 0 };
async function fetchAirspaces(bbox) {
  const key = (asPrefs().key || OPENAIP_DEFAULT_KEY).trim();
  if (!key) return [];
  // Quantize the bbox outward to a 0.2-degree grid: panning inside the same
  // cell reuses the cache instead of firing a new (relay) request every time.
  const q = 0.2;
  bbox = [Math.floor(bbox[0] / q) * q, Math.floor(bbox[1] / q) * q,
          Math.ceil(bbox[2] / q) * q, Math.ceil(bbox[3] / q) * q];
  const bkey = bbox.map(v => v.toFixed(1)).join(',');
  if (asCache.has(bkey)) return asCache.get(bkey);
  const url = `https://api.core.openaip.net/api/airspaces?apiKey=${encodeURIComponent(key)}&bbox=${bbox.join(',')}&limit=1000`;
  // The OpenAIP core API sends no CORS headers, so a direct browser fetch is
  // blocked. Try direct first (in case that changes), then public CORS relays.
  // Relays first: the direct call is CORS-blocked in browsers today and only
  // kept as a last resort in case OpenAIP ever enables CORS. A relay that
  // answered 429 recently is demoted for 90 s to spread the load.
  const cp = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
  const ao = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const candidates = Date.now() < asRelayCooldown.corsproxy
    ? [ao, cp, url] : [cp, ao, url];
  let data = null, lastErr = null;
  for (const u of candidates) {
    // Per-candidate timeout so a hanging relay falls through to the next one
    // instead of failing the whole load (frequent on cellular iPads).
    const ctl = ('AbortController' in window) ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 9000) : null;
    try {
      const res = await fetch(u, ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) {
        if (res.status === 429 && u.startsWith('https://corsproxy.io')) asRelayCooldown.corsproxy = Date.now() + 90000;
        lastErr = new Error(`Airspace request failed (${res.status})`);
        continue;
      }
      data = await res.json();
      if (data && data.items) break;
      data = null;
    } catch (e) { lastErr = e; }
    finally { if (timer) clearTimeout(timer); }
  }
  if (!data) throw (lastErr || new Error('Airspace request failed'));
  const items = data.items || [];
  asCache.set(bkey, items);
  if (asCache.size > 24) asCache.delete(asCache.keys().next().value);
  return items;
}

function ringContains(lat, lon, ring) {
  let inside = false;
  for (let i = 0, jj = ring.length - 1; i < ring.length; jj = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[jj][0], yj = ring[jj][1];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function geomContains(lat, lon, geometry) {
  if (!geometry) return false;
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  for (const poly of polys) {
    if (!poly || !poly[0]) continue;
    if (ringContains(lat, lon, poly[0])) {
      let inHole = false;
      for (let h = 1; h < poly.length; h++) if (ringContains(lat, lon, poly[h])) { inHole = true; break; }
      if (!inHole) return true;
    }
  }
  return false;
}

// ---- overlay rendering for the current map view ----
function airspaceVisible() {
  try { return localStorage.getItem('sfp_airspace_show') !== '0'; } catch (e) { return true; }
}
function renderAirspaceToggle() {
  const b = $('airspaceToggleBtn');
  if (!b) return;
  const on = airspaceVisible();
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
}

async function refreshAirspaceOverlay() {
  const types = enabledAsTypes();
  if (state.airspaceLayer) { state.map.removeLayer(state.airspaceLayer); state.airspaceLayer = null; }
  if (!airspaceVisible()) return;
  if (types.size === 0) return;
  if (state.map.getZoom() < 7) { setStatus('Airspace overlay', 'zoom in to load airspaces'); return; }
  const b = state.map.getBounds();
  try {
    const items = await fetchAirspaces([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    const layers = [];
    items.forEach(it => {
      const cat = types.get(it.type);
      if (!cat || !it.geometry) return;
      const polys = it.geometry.type === 'MultiPolygon' ? it.geometry.coordinates : [it.geometry.coordinates];
      polys.forEach(poly => {
        if (!poly || !poly[0]) return;
        const latlngs = poly.map(ring => ring.map(pt => [pt[1], pt[0]]));
        // interactive:false lets map clicks pass through the polygons, so
        // setting a launch/landing point works with the overlay visible.
        const layer = L.polygon(latlngs, { color: cat.color, weight: 1.5, opacity: 0.9, fillColor: cat.color, fillOpacity: 0.12, interactive: false });
        layer._asMeta = it;
        layers.push(layer);
      });
    });
    state.airspaceLayer = L.featureGroup(layers).addTo(state.map);
    state.airspaceLayer.eachLayer(l => { if (l.bringToBack) l.bringToBack(); });
  } catch (e) {
    setStatus('Airspace load failed', e.message || 'check API key');
  }
}

// ---- trajectory violation check ----
async function checkAirspaceViolations(traj) {
  const warnEl = $('airspaceWarn');
  const types = enabledAsTypes();
  if (!warnEl) return;
  if (types.size === 0) { warnEl.hidden = true; return; }
  const lats = traj.path.map(p => p.lat), lons = traj.path.map(p => p.lon);
  const pad = 0.15;
  const bbox = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
  const groundElev = traj.path[0].alt;
  let items;
  try { items = await fetchAirspaces(bbox); } catch (e) { warnEl.hidden = true; return; }
  const hits = new Map();
  items.forEach(it => {
    const cat = types.get(it.type);
    if (!cat || !it.geometry) return;
    const lo = asLimitMeters(it.lowerLimit, groundElev);
    const hi = asLimitMeters(it.upperLimit, groundElev);
    for (const p of traj.path) {
      if (lo !== null && p.alt < lo) continue;
      if (hi !== null && p.alt > hi) continue;
      if (geomContains(p.lat, p.lon, it.geometry)) {
        const k = (it.name || '?') + '|' + it.type;
        if (!hits.has(k)) hits.set(k, { it, cat, minAlt: p.alt, maxAlt: p.alt, tMin: p.t, tMax: p.t });
        const h = hits.get(k);
        h.minAlt = Math.min(h.minAlt, p.alt); h.maxAlt = Math.max(h.maxAlt, p.alt);
        h.tMin = Math.min(h.tMin, p.t); h.tMax = Math.max(h.tMax, p.t);
      }
    }
  });
  state.profileViolations = [...hits.values()];
  drawProfile(traj);
  if (hits.size === 0) {
    warnEl.hidden = false;
    warnEl.classList.remove('conflict');
    warnEl.classList.add('clear');
    warnEl.innerHTML = '<b style="color:var(--good);">✓ No conflict</b> with the enabled airspace categories (approximate check).';
    return;
  }
  const rows = [...hits.values()].map(h =>
    `<li><b>${h.it.name || 'Airspace'}</b> (${h.cat.label}, ${asLimitText(h.it.lowerLimit)} – ${asLimitText(h.it.upperLimit)}) — crossed at ${Math.round(h.minAlt)}–${Math.round(h.maxAlt)} m AMSL</li>`).join('');
  warnEl.hidden = false;
  warnEl.classList.remove('clear');
  warnEl.classList.add('conflict');
  warnEl.innerHTML = `<b>⚠ Airspace conflict</b> — trajectory enters ${hits.size} enabled airspace${hits.size > 1 ? 's' : ''}:<ul>${rows}</ul>`;
  setStatus('⚠ Airspace conflict', [...hits.values()].map(h => h.it.name).slice(0, 2).join(', '));
  // Highlight the offending polygons on the map
  if (state.airspaceLayer) {
    state.airspaceLayer.eachLayer(l => {
      const m = l._asMeta;
      if (m && hits.has((m.name || '?') + '|' + m.type)) l.setStyle({ weight: 3, fillOpacity: 0.28 });
    });
  }
}

function buildAirspaceMenu() {
  const rows = $('airspaceRows');
  if (!rows) return;
  const p = asPrefs();
  rows.innerHTML = '';
  AS_CATS.forEach(c => {
    const lab = document.createElement('label');
    lab.className = 'as-row';
    lab.innerHTML = `<input type="checkbox" ${p.cats[c.id] ? 'checked' : ''}><span class="as-swatch" style="background:${c.color};"></span><span>${c.label}</span>`;
    lab.querySelector('input').addEventListener('change', (e) => {
      const np = asPrefs();
      np.cats[c.id] = e.target.checked;
      saveAsPrefs(np);
      refreshAirspaceOverlay();
      if (state.lastResult) checkAirspaceViolations(state.lastResult.traj).catch(() => {});
    });
    rows.appendChild(lab);
  });
}


// Single-page A4-landscape print report: plan data | street map with the whole
// trajectory | result data. Temporarily switches to Streets, fits the path,
// snapshots the map via html2canvas, then opens a print window.
async function printFlightReport() {
  if (state.busy) return;
  // Open the target window inside the user gesture — after the map snapshot
  // (async) the gesture is gone and every blocker would kill the window.
  const w = window.open('', '_blank');
  if (!w) { showPopupHelp(null); return; }
  try { w.document.write('<p style="font:13px sans-serif;padding:20px;">Preparing flight report\u2026</p>'); } catch (e) { /* ignore */ }
  const rows = sel => [...document.querySelectorAll(sel)].map(cell => {
    const lab = cell.querySelector('label');
    const inp = cell.querySelector('input, select');
    const val = cell.querySelector('.val');
    let v = '';
    if (inp) {
      v = inp.tagName === 'SELECT' ? (inp.selectedOptions[0] ? inp.selectedOptions[0].textContent : inp.value) : inp.value;
      const u = cell.querySelector('.iunit');
      if (u) v += ' ' + u.textContent;
    } else if (val) v = val.textContent;
    return lab && v ? [lab.textContent, v] : null;
  }).filter(Boolean);

  const planRows = rows('#menuDrawer .fcell');
  const resRows = rows('#resultsDrawer .datacell');

  // Map snapshot: Streets layer, whole trajectory in view, no drawer padding
  let mapImg = null;
  const prevBase = state.setBaseLayer ? state.setBaseLayer('Streets') : null;
  try {
    if (state.trajectoryLine) {
      state.map.fitBounds(state.trajectoryLine.getBounds(), { padding: [30, 30], animate: false });
    }
    await new Promise(r => setTimeout(r, 900)); // let tiles settle
    if (window.html2canvas) {
      const canvas = await html2canvas(document.getElementById('map'), {
        useCORS: true, allowTaint: false, logging: false, scale: 1.4,
        ignoreElements: el => el.classList && (el.classList.contains('side-handle') || el.id === 'quickControls' || el.classList.contains('base-layer-radio') || el.classList.contains('leaflet-control-zoom')),
      });
      mapImg = canvas.toDataURL('image/png');
    }
  } catch (e) { console.warn('map snapshot failed', e); }
  if (prevBase && state.setBaseLayer) state.setBaseLayer(prevBase);

  const tbl = (title, rws) => `<h2>${title}</h2><table>${rws.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>`;
  let wptTable = '';
  if (state.lastResult && state.lastResult.traj) {
    const p = state.lastResult.traj.path;
    const rel = p[state.lastResult.traj.releaseIdx];
    const land = p[p.length - 1];
    const fmt = q => fmtCoordsDMS(q.lat, q.lon);
    wptTable = `<h2>Waypoints</h2><table class="wpt">
      <tr><td>Launch</td><td>${fmt(p[0])} · ${Math.round(p[0].alt)} m</td></tr>
      <tr><td>Burst / release</td><td>${fmt(rel)} · ${Math.round(rel.alt)} m</td></tr>
      <tr><td>Landing</td><td>${fmt(land)} · ${Math.round(land.alt)} m</td></tr>
    </table>`;
  }
  w.document.open();
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sonde flight plan</title><style>
    @page{size:A4 landscape;margin:9mm;}
    html,body{margin:0;font:9px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif;color:#16202a;}
    .head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #0f8f86;padding-bottom:3px;margin-bottom:6px;}
    .head h1{font-size:14px;margin:0;color:#0f8f86;}
    .head span{font-size:8px;color:#5c6b78;}
    .grid{display:flex;flex-direction:column;gap:6px;height:176mm;}
    .mapwrap{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;}
    .cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-height:62mm;overflow:hidden;}
    h2{font-size:10px;margin:0 0 3px;color:#0f8f86;border-bottom:1px solid #d3dae0;padding-bottom:2px;}
    table{width:100%;border-collapse:collapse;margin-bottom:6px;}
    td{border:0.5px solid #d3dae0;padding:1px 3px;vertical-align:top;font-size:7.6px;}
    td:first-child{color:#5c6b78;width:46%;}
    td:last-child{font-family:ui-monospace,Menlo,monospace;}
    .mapwrap img{width:100%;flex:1 1 auto;min-height:0;object-fit:contain;border:1px solid #d3dae0;}
    table.wpt td{font-family:ui-monospace,Menlo,monospace;}
    .foot{font-size:7px;color:#5c6b78;margin-top:4px;}
  </style></head><body>
    <div class="head"><h1>Weather Sonde Flight Planning</h1><span>${APP_VERSION} · printed ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</span></div>
    <div class="grid">
      <div class="mapwrap"><h2>Trajectory (Streets)</h2>${mapImg ? `<img src="${mapImg}">` : '<p>Map snapshot unavailable.</p>'}</div>
      <div class="cols">
        <div>${tbl('Flight settings', planRows)}${wptTable}</div>
        <div>${tbl('Resulting flight data', resRows)}</div>
      </div>
    </div>
    <div class="foot">Planning approximation — check manufacturer data, DABS/NOTAM and airspace before launch. Airspace data: OpenAIP (community).</div>
  <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),300));<\/script></body></html>`);
  w.document.close();
}


// Google Maps cannot draw a free line via URL (a /dir/ link is always turned
// into road routing). The trajectory is therefore exported as a KML file that
// Google Earth / Google My Maps display as the actual flight line; the QR
// code carries this app's share link, which reproduces the exact trajectory.
function buildTrajKml() {
  const r = state.lastResult;
  if (!r || !r.traj || r.traj.path.length < 2) return null;
  const path = r.traj.path;
  const rel = path[r.traj.releaseIdx];
  const land = path[path.length - 1];
  const coords = path.map(p => `${p.lon.toFixed(5)},${p.lat.toFixed(5)},${Math.round(p.alt)}`).join(' ');
  const pm = (name, p) => `<Placemark><name>${name}</name><Point><coordinates>${p.lon.toFixed(5)},${p.lat.toFixed(5)},${Math.round(p.alt)}</coordinates></Point></Placemark>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>Sonde trajectory</name>
<Style id="t"><LineStyle><color>ffc9d03f</color><width>4</width></LineStyle></Style>
<Placemark><name>Trajectory</name><styleUrl>#t</styleUrl><LineString><altitudeMode>absolute</altitudeMode><coordinates>${coords}</coordinates></LineString></Placemark>
${pm('Launch', path[0])}${pm('Burst', rel)}${pm('Landing', land)}
</Document></kml>`;
}

function buildShareUrl() {
  const encoded = btoa(encodeURIComponent(JSON.stringify(gatherInputs())));
  return `${location.origin}${location.pathname}?state=${encoded}`;
}

function downloadTrajKml() {
  const kml = buildTrajKml();
  if (!kml) return;
  const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sonde-trajectory.kml';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  setStatus('KML downloaded', 'open in Google Earth / import to My Maps');
}

function buildGmapsTrajUrl() { return buildTrajKml() ? buildShareUrl() : null; }

function updateGmapsBtn() {
  const show = !!buildGmapsTrajUrl();
  const b = $('gmapsTrajBtn');
  if (b) b.hidden = !show;
  const sep = $('gmapsSep');
  if (sep) sep.hidden = !show;
}


// ---- Pop-up handling ------------------------------------------------------
// Feature strings like 'noopener' make browsers treat the target as a popup
// *window*, which blockers kill far more aggressively than plain new tabs.
// So: open as a plain tab, null the opener afterwards, and when it is still
// blocked, show device-specific instructions plus a direct link (a real tap
// on an <a> is always allowed).
function openTab(url) {
  const w = window.open(url, '_blank');
  if (w) { try { w.opener = null; } catch (e) { /* ignore */ } return w; }
  showPopupHelp(url);
  return null;
}

function showPopupHelp(url) {
  let ov = $('popupHelp');
  if (ov) ov.remove();
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  let steps;
  if (isIOS) {
    steps = ['Open the iPad/iPhone <b>Settings</b> app', 'Scroll to <b>Safari</b> (or Apps \u2192 Safari)', 'Switch <b>Block Pop-ups</b> OFF', standalone ? 'Return to this app and try again (applies to home-screen apps too)' : 'Return to Safari and try again'];
  } else if (/Edg\//.test(ua) || /Chrome\//.test(ua)) {
    steps = ['Look at the right end of the address bar \u2014 a small <b>\u201cpop-up blocked\u201d</b> icon appeared', 'Click it and choose <b>\u201cAlways allow pop-ups and redirects from bwicki.github.io\u201d</b>', 'Click <b>Done</b> and try again'];
  } else if (/Firefox\//.test(ua)) {
    steps = ['A yellow bar appeared at the top: <b>\u201cFirefox prevented this site from opening a pop-up\u201d</b>', 'Click <b>Options / Preferences</b> in that bar', 'Choose <b>\u201cAllow pop-ups for bwicki.github.io\u201d</b> and try again'];
  } else {
    steps = ['Open <b>Safari \u2192 Settings \u2192 Websites \u2192 Pop-up Windows</b>', 'Set <b>bwicki.github.io</b> to <b>Allow</b>', 'Try again'];
  }
  ov = document.createElement('div');
  ov.id = 'popupHelp';
  ov.className = 'overlay';
  ov.innerHTML = `<div class="popup-help-card">
    <button type="button" class="overlay-close" id="popupHelpClose">\u2715</button>
    <h3>\u26D4 Pop-ups are blocked</h3>
    <p>The browser blocked the new window. To allow it permanently:</p>
    <ol>${steps.map(s => `<li>${s}</li>`).join('')}</ol>
    ${url ? `<a class="popup-open-link" href="${url}" target="_blank" rel="noopener">\u2197 Open the link directly now</a>` : ''}
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#popupHelpClose').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  const a = ov.querySelector('.popup-open-link');
  if (a) a.addEventListener('click', close);
}


// =========================================================================
// Ensemble mode (E1): freeze the current anchor and rerun the trajectory
// with every model available for the region; show all tracks, the scatter
// hull and a marker at the weighted most-probable point.
// =========================================================================
// res = grid spacing (km), cad = documented update cadence (h). The API does
// not expose the true run init time, so cadence serves as the age proxy.
const ENSEMBLE_META = {
  icon_d2: { res: 2.2, cad: 3 }, icon_eu: { res: 7, cad: 3 }, icon_seamless: { res: 11, cad: 3 },
  icon_global: { res: 11, cad: 6 }, ecmwf_ifs025: { res: 25, cad: 6 }, ecmwf_aifs025: { res: 25, cad: 6 },
  gfs_seamless: { res: 11, cad: 6 }, gfs_global: { res: 11, cad: 6 }, gfs_graphcast025: { res: 25, cad: 6 },
  gfs_hrrr: { res: 3, cad: 1 }, ncep_nbm_conus: { res: 3, cad: 1 },
  meteofrance_arpege_europe: { res: 11, cad: 6 }, meteofrance_seamless: { res: 11, cad: 6 },
  meteofrance_arome_france: { res: 1.3, cad: 3 }, meteofrance_arome_france_hd: { res: 1.3, cad: 3 },
  ukmo_seamless: { res: 10, cad: 6 }, ukmo_global_deterministic_10km: { res: 10, cad: 6 },
  ukmo_uk_deterministic_2km: { res: 2, cad: 6 },
  knmi_seamless: { res: 5.5, cad: 6 }, knmi_harmonie_arome_europe: { res: 5.5, cad: 6 },
  dmi_seamless: { res: 2, cad: 3 }, dmi_harmonie_arome_europe: { res: 2, cad: 3 },
  metno_seamless: { res: 1, cad: 3 }, metno_nordic: { res: 1, cad: 3 },
  italia_meteo_arpae_icon_2i: { res: 2.2, cad: 3 },
  gem_seamless: { res: 15, cad: 12 }, gem_global: { res: 15, cad: 12 },
  gem_regional: { res: 10, cad: 6 }, gem_hrdps_continental: { res: 2.5, cad: 6 },
  jma_seamless: { res: 20, cad: 6 }, jma_gsm: { res: 20, cad: 6 }, jma_msm: { res: 5, cad: 3 },
  kma_seamless: { res: 13, cad: 6 }, cma_grapes_global: { res: 15, cad: 12 }, bom_access_global: { res: 15, cad: 12 },
};
const ENSEMBLE_MAX = 9;
const ENSEMBLE_COLORS = ['#e0483f', '#4169e1', '#3fd06b', '#ffb454', '#c951d6', '#20c3d4', '#f06fa0', '#8fd63f', '#a07be0'];

function ensembleModels(lat, lon) {
  const models = window.__wxModels || [];
  const covers = m => !m.cov || (lat >= m.cov[0] && lon >= m.cov[1] && lat <= m.cov[2] && lon <= m.cov[3]);
  const list = models
    .filter(m => !m.group && m.v && covers(m))
    .map(m => {
      const meta = ENSEMBLE_META[m.v] || { res: 25, cad: 6 };
      return { v: m.v, label: m.label, weight: (1 / meta.res) * (3 / meta.cad) };
    })
    .sort((a, b) => b.weight - a.weight);
  return list.slice(0, ENSEMBLE_MAX);
}

function convexHull(pts) { // monotone chain on [lat, lon]
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cross = (o, a, b) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function clearEnsemble() {
  if (state.ensembleLayer) { state.map.removeLayer(state.ensembleLayer); state.ensembleLayer = null; }
  const leg = $('ensembleLegend');
  if (leg) leg.remove();
  state.ensembleResults = [];
  state.ensembleActive = false;
  updateEnsembleBtn();
}

function updateEnsembleBtn(runningText) {
  const b = $('ensembleBtn');
  if (!b) return;
  const lbl = b.querySelector('.ens-lbl');
  const ready = !!state.trajectoryLine;
  b.classList.toggle('dis', !ready && !state.ensembleActive && !runningText);
  b.classList.toggle('active', !!state.ensembleActive);
  if (lbl) {
    if (runningText) lbl.textContent = runningText;
    else if (state.ensembleActive) lbl.textContent = `Ensemble · ${state.ensembleCount || 0}`;
    else lbl.textContent = 'Ensemble';
  }
}

// Inject a diagonal hatch pattern into the Leaflet SVG renderer once, so the
// ensemble hull can be filled with visible hatching instead of a flat tint.
function ensureEnsembleHatch() {
  const svg = document.querySelector('#map svg');
  if (!svg || svg.querySelector('#ensHatch')) return;
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  defs.insertAdjacentHTML('beforeend',
    `<pattern id="ensHatch" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">` +
    `<rect width="10" height="10" fill="#8a4fd0" fill-opacity="0.10"/>` +
    `<line x1="0" y1="0" x2="0" y2="10" stroke="#8a4fd0" stroke-width="2.5" stroke-opacity="0.45"/>` +
    `</pattern>`);
}

function buildEnsembleLegend(results, mode) {
  const old = $('ensembleLegend');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'ensembleLegend';
  el.innerHTML = `<div class="el-head">Ensemble \u2014 ${results.filter(r => r.enabled).length}/${results.length} models \u00b7 ${mode === 'backward' ? 'launch' : 'landing'} spread</div>` +
    results.map((r, i) =>
      `<label class="el-row${r.enabled ? '' : ' off'}"><input type="checkbox" data-ei="${i}" ${r.enabled ? 'checked' : ''}>` +
      `<span class="el-num" style="background:${r.color};">${r.num}</span><span class="el-line" style="background:${r.color};"></span><span class="el-lbl">${r.m.label}</span></label>`
    ).join('') +
    `<div class="el-row"><span class="el-num" style="background:#8a4fd0;">\u2605</span><span class="el-line" style="background:#8a4fd0;"></span><span class="el-lbl">most probable (weighted)</span></div>`;
  el.addEventListener('change', (e) => {
    const idx = parseInt(e.target.dataset.ei, 10);
    if (isNaN(idx)) return;
    const r = state.ensembleResults[idx];
    if (r.enabled && ensembleEnabled().length <= 2) { e.target.checked = true; return; } // keep >= 2 members
    r.enabled = e.target.checked;
    renderEnsembleLayers();
  });
  document.getElementById('main').appendChild(el);
}

async function runEnsemble() {
  if (state.busy || !state.trajectoryLine || !state.lastResult) return;
  if (state.ensembleActive) { clearEnsemble(); return; }
  const mode = currentMode();
  const anchor = mode === 'backward' && state.targetMarker
    ? state.targetMarker.getLatLng()
    : { lat: parseFloat($('launchLat').value), lng: parseFloat($('launchLon').value) };
  const models = ensembleModels(anchor.lat, anchor.lng);
  if (!models.length) { setStatus('Ensemble', 'no models available here'); return; }

  state.busy = true;
  updateEnsembleBtn('… wait for data');
  setStatus('Ensemble starting…', `${models.length} models queued`);
  const results = [];
  try {
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      updateEnsembleBtn(`wait ${i + 1}/${models.length}…`);
      setStatus(`Ensemble ${i + 1}/${models.length}`, m.label);
      try {
        let r;
        if (mode === 'backward') {
          // per-model back-solve for the launch point (frozen landing anchor)
          let la = parseFloat($('launchLat').value), lo = parseFloat($('launchLon').value);
          for (let it = 0; it < 3; it++) {
            r = await calculateFor(la, lo, m.v);
            const err = haversine(anchor.lat, anchor.lng, r.traj.landing.lat, r.traj.landing.lon);
            if (err < 500) break;
            la += anchor.lat - r.traj.landing.lat;
            lo += anchor.lng - r.traj.landing.lon;
          }
          r = await calculateFor(la, lo, m.v);
          results.push({ m, traj: r.traj, endpoint: { lat: la, lon: lo } });
        } else {
          r = await calculateFor(anchor.lat, anchor.lng, m.v);
          results.push({ m, traj: r.traj, endpoint: { lat: r.traj.landing.lat, lon: r.traj.landing.lon } });
        }
      } catch (e) { console.info('ensemble member skipped:', m.v, '\u2014', e && e.message); }
    }
  } finally {
    state.busy = false;
  }
  if (results.length < 2) {
    setStatus('Ensemble failed', 'not enough members succeeded');
    updateEnsembleBtn();
    return;
  }

  results.forEach((r, i) => { r.color = ENSEMBLE_COLORS[i % ENSEMBLE_COLORS.length]; r.num = i + 1; r.enabled = true; });
  state.ensembleResults = results;
  state.ensembleMode = mode;
  renderEnsembleLayers();
  state.ensembleActive = true;
  updateEnsembleBtn();
  try { state.map.fitBounds(state.ensembleLayer.getBounds().extend(state.trajectoryLine.getBounds()), { padding: [60, 60] }); } catch (e) { /* keep view */ }
}

// Resample a path to K points by index fraction (for the weighted mean track)
function resamplePath(path, K) {
  const out = [];
  for (let k = 0; k < K; k++) {
    const f = k * (path.length - 1) / (K - 1);
    const i0 = Math.floor(f), i1 = Math.min(i0 + 1, path.length - 1), t = f - i0;
    out.push([path[i0].lat * (1 - t) + path[i1].lat * t, path[i0].lon * (1 - t) + path[i1].lon * t]);
  }
  return out;
}

function ensembleEnabled() { return (state.ensembleResults || []).filter(r => r.enabled); }

function ensembleBest() {
  const en = ensembleEnabled();
  let sw = 0, sla = 0, slo = 0;
  en.forEach(r => { sw += r.m.weight; sla += r.endpoint.lat * r.m.weight; slo += r.endpoint.lon * r.m.weight; });
  return sw ? { lat: sla / sw, lon: slo / sw, n: en.length } : null;
}

function renderEnsembleLayers() {
  if (state.ensembleLayer) { state.map.removeLayer(state.ensembleLayer); state.ensembleLayer = null; }
  const en = ensembleEnabled();
  const mode = state.ensembleMode;
  if (!en.length) return;
  const layers = [];
  en.forEach(r => {
    const col = r.color;
    layers.push(L.polyline(r.traj.path.map(p => [p.lat, p.lon]),
      { color: '#0a0d10', weight: 5, opacity: 0.5, interactive: false }));
    layers.push(L.polyline(r.traj.path.map(p => [p.lat, p.lon]),
      { color: col, weight: 3, opacity: 0.95, interactive: false }));
    // burst/release: small explosion cloud in the member color
    const rel = r.traj.path[r.traj.releaseIdx];
    layers.push(L.marker([rel.lat, rel.lon], {
      icon: L.divIcon({
        className: 'sig-marker',
        html: `<svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 2 L13.6 7.2 L18 4.5 L15.8 9.2 L21.5 9.5 L16.8 12.3 L20.5 16.5 L15 15.2 L15.5 21 L12 16.8 L8.5 21 L9 15.2 L3.5 16.5 L7.2 12.3 L2.5 9.5 L8.2 9.2 L6 4.5 L10.4 7.2 Z" fill="${col}" stroke="#fff" stroke-width="1.6"/></svg>`,
        iconSize: [22, 22], iconAnchor: [11, 11],
      }), interactive: true,
    }).bindTooltip(`${r.num} · ${r.m.label} — burst ${Math.round(rel.alt)} m`, { direction: 'top' }));
    layers.push(L.circleMarker([r.endpoint.lat, r.endpoint.lon],
      { radius: 5, color: '#ffffff', weight: 1.5, fillColor: col, fillOpacity: 1 })
      .bindTooltip(`${r.num} · ${r.m.label}`, { direction: 'top' }));
    const mid = r.traj.path[Math.max(1, Math.floor(r.traj.path.length * 0.25))];
    layers.push(L.marker([mid.lat, mid.lon], {
      icon: L.divIcon({ className: 'sig-marker', html: `<div class="ens-num" style="background:${col};">${r.num}</div>`, iconSize: [17, 17], iconAnchor: [8, 8] }),
      interactive: false,
    }));
  });
  // scatter hull (hatched)
  const hullPts = convexHull(en.map(r => [r.endpoint.lat, r.endpoint.lon]));
  if (hullPts.length >= 3) {
    ensureEnsembleHatch();
    layers.push(L.polygon(hullPts, {
      color: '#8a4fd0', weight: 3, opacity: 0.95, dashArray: '9 6',
      fillColor: 'url(#ensHatch)', fillOpacity: 1, interactive: false,
    }));
  }
  // weighted mean trajectory — drawn last, on top of all members
  const K = 60;
  let sw = 0;
  const acc = Array.from({ length: K }, () => [0, 0]);
  en.forEach(r => {
    const rp = resamplePath(r.traj.path, K);
    for (let k = 0; k < K; k++) { acc[k][0] += rp[k][0] * r.m.weight; acc[k][1] += rp[k][1] * r.m.weight; }
    sw += r.m.weight;
  });
  const meanPath = acc.map(p => [p[0] / sw, p[1] / sw]);
  layers.push(L.polyline(meanPath, { color: '#ffffff', weight: 6, opacity: 0.75, interactive: false }));
  layers.push(L.polyline(meanPath, { color: '#8a4fd0', weight: 3.5, opacity: 1, interactive: false }));

  const best = ensembleBest();
  const star = L.marker([best.lat, best.lon], {
    icon: L.divIcon({
      className: 'sig-marker',
      html: `<svg width="26" height="26" viewBox="0 0 26 26"><path d="M13 2 L15.6 9.4 L23.5 9.6 L17.2 14.4 L19.5 22 L13 17.4 L6.5 22 L8.8 14.4 L2.5 9.6 L10.4 9.4 Z" fill="#8a4fd0" stroke="#fff" stroke-width="1.6"/></svg>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    }),
    zIndexOffset: 900,
  }).bindPopup(
    `Most probable ${mode === 'backward' ? 'launch' : 'landing'} point<br>${fmtCoordsDMS(best.lat, best.lon)}<br>` +
    `<span style="font-size:10px;">weighted by grid resolution &amp; update cadence, ${best.n} models</span><br>` +
    `<button type="button" class="ens-adopt" onclick="window.__ensAdopt()">\u2713 Use as ${mode === 'backward' ? 'launch point' : 'landing point'}</button>`
  );
  layers.push(star);

  state.ensembleLayer = L.featureGroup(layers).addTo(state.map);
  state.ensembleCount = en.length;
  buildEnsembleLegend(state.ensembleResults, mode);
  updateEnsembleBtn();
  setStatus(`Ensemble \u00b7 ${en.length} models`, `spread shown \u2014 most probable ${mode === 'backward' ? 'launch' : 'landing'} marked`);
}

function adoptEnsembleBest() {
  const best = ensembleBest();
  if (!best) return;
  const mode = state.ensembleMode;
  const cell = $('resEnsBestCell');
  const val = $('resEnsBest');
  if (cell) cell.hidden = false;
  if (val) val.textContent = `${fmtCoordsDMS(best.lat, best.lon)} \u2014 ${mode === 'backward' ? 'launch' : 'landing'} \u00b7 weighted, ${best.n} models`;
  if (mode === 'backward') {
    $('launchLat').value = best.lat.toFixed(5);
    $('launchLon').value = best.lon.toFixed(5);
    if (state.launchMarker) state.launchMarker.setLatLng([best.lat, best.lon]);
    setStatus('Ensemble best adopted', 'set as launch point \u2014 recalculate to apply');
  } else {
    setStatus('Ensemble best adopted', 'shown in results & flight report');
  }
  openResults();
}
window.__ensAdopt = adoptEnsembleBest;

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
  on('addPresetBtn', 'click', () => openPresetEditor('add'));
  on('editPresetBtn', 'click', () => openPresetEditor('edit'));
  on('deletePresetBtn', 'click', () => openPresetEditor('delete'));
  on('presetSaveBtn', 'click', commitPresetEditor);
  on('presetCancelBtn', 'click', closePresetEditor);
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
  on('printBtn', 'click', () => { printFlightReport().catch(showError); });
  on('copyLinkBtn', 'click', copyShareLink);
  on('exportImageBtn', 'click', exportImage);

  // Results drawer controls (left)
  on('resultsCloseBtn', 'click', closeResults);
  on('resultsHandle', 'click', toggleResults);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeResults(); });

  // Settings drawer (right) with handle
  const toggleDrawer = (open) => {
    const d = $('menuDrawer');
    const h = $('drawerHandle');
    if (!d) return;
    if (open === undefined) open = d.classList.contains('collapsed');
    d.classList.toggle('collapsed', !open);
    if (h) h.classList.toggle('closed', !open);
    const rb = $('quickControls');
    if (rb) rb.classList.toggle('closed', !open);
    setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 280);
  };
  const mainMenu = () => $('mainMenu');
  on('menuBtn', 'click', (e) => {
    const m = mainMenu();
    if (m) {
      const show = m.hidden;
      m.hidden = !show;
      m.classList.toggle('open', show);
    }
    e.stopPropagation();
  });
  document.addEventListener('click', (e) => {
    const m = mainMenu();
    if (m && !m.hidden && !m.contains(e.target) && !e.target.closest('#menuBtn')) { m.hidden = true; m.classList.remove('open'); }
  });
  on('menuParamsBtn', 'click', () => { toggleDrawer(); const m = mainMenu(); if (m) { m.hidden = true; m.classList.remove('open'); } });
  on('menuResultsBtn', 'click', () => { toggleResults(); const m = mainMenu(); if (m) { m.hidden = true; m.classList.remove('open'); } });
  on('menuAboutBtn', 'click', () => {
    const m = mainMenu(); if (m) { m.hidden = true; m.classList.remove('open'); }
    openTab('readme_viewer.html');
  });
  on('menuCloseBtn', 'click', () => toggleDrawer(false));
  on('drawerHandle', 'click', () => toggleDrawer());
  // Open the parameters drawer on first load so the user sees the settings once,
  // and pulse the release-altitude group until the user touches it.
  toggleDrawer(true);
  const relGroup = $('releaseGroup');
  if (relGroup) relGroup.classList.add('release-pulse');
  const dismissReleaseHint = () => { if (relGroup) relGroup.classList.remove('release-pulse'); };

  // Release-altitude slider (below the green handle), two-way synced with the input
  const relSlider = $('sReleaseAlt');
  const relLbl = $('lblReleaseAlt');
  const setRelLbl = v => { if (relLbl) relLbl.textContent = `${Math.round(v)}`; };
  const syncSliderFromInput = () => {
    if (!relSlider) return;
    const v = parseFloat($('targetAltitude').value);
    if (!isNaN(v)) { relSlider.value = Math.min(7000, Math.max(500, v)); setRelLbl(relSlider.value); }
  };
  syncSliderFromInput();
  if (relSlider) {
    relSlider.addEventListener('input', () => {
      setRelLbl(relSlider.value);
      $('targetAltitude').value = relSlider.value;
      dismissReleaseHint();
    });
    relSlider.addEventListener('change', () => {
      $('targetAltitude').value = relSlider.value;
      $('targetMode').value = 'altitude';
      dismissReleaseHint();
      recalcExistingTrajectory();
    });
  }
  on('targetAltitude', 'change', () => { syncSliderFromInput(); dismissReleaseHint(); });

  // Compact launch-time box (S4d): fields edit in UTC or device local time,
  // the small line below always shows the conversion into the other zone.
  // Internally everything stays UTC (weather API, main card 04).
  let qTz = 'lt';
  try { qTz = localStorage.getItem('sfp_tz') || 'lt'; } catch (e) { /* ignore */ }

  const mainUtcDate = () => {
    const d = $('launchDate').value, t = $('launchTime').value;
    return (d && t) ? new Date(`${d}T${t}:00Z`) : null;
  };
  const pad2 = x => String(x).padStart(2, '0');
  const localParts = dt => ({
    date: `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`,
    time: `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`,
  });
  const utcParts = dt => ({ date: dt.toISOString().slice(0, 10), time: dt.toISOString().slice(11, 16) });

  const renderTzSeg = () => {
    document.querySelectorAll('#tzSeg .tz-opt').forEach(b => b.classList.toggle('active', b.dataset.tz === qTz));
  };
  const syncQuickTimeFromMain = () => {
    const dt = mainUtcDate();
    if (!dt) return;
    const p = qTz === 'lt' ? localParts(dt) : utcParts(dt);
    if ($('qLaunchDate')) $('qLaunchDate').value = p.date;
    if ($('qLaunchTime')) $('qLaunchTime').value = p.time;
    const alt = $('tzAlt');
    if (alt) {
      const o = qTz === 'lt' ? utcParts(dt) : localParts(dt);
      alt.textContent = `= ${o.time} ${qTz === 'lt' ? 'UTC' : 'LT'}`;
    }
  };
  const applyQuickTime = () => {
    const d = $('qLaunchDate') && $('qLaunchDate').value;
    const t = $('qLaunchTime') && $('qLaunchTime').value;
    if (!d || !t) return;
    let dt;
    if (qTz === 'lt') {
      const [y, m, dd] = d.split('-').map(Number);
      const [hh, mm] = t.split(':').map(Number);
      dt = new Date(y, m - 1, dd, hh, mm, 0);      // local wall clock -> Date
    } else {
      dt = new Date(`${d}T${t}:00Z`);
    }
    const u = utcParts(dt);
    $('launchDate').value = u.date;
    $('launchTime').value = u.time;
    syncQuickTimeFromMain();
    recalcExistingTrajectory();
  };
  renderTzSeg();
  syncQuickTimeFromMain();
  document.querySelectorAll('#tzSeg .tz-opt').forEach(b => {
    b.addEventListener('click', () => {
      qTz = b.dataset.tz;
      try { localStorage.setItem('sfp_tz', qTz); } catch (e) { /* ignore */ }
      renderTzSeg();
      syncQuickTimeFromMain();   // same instant, re-displayed in the new zone
    });
  });
  on('qLaunchDate', 'change', applyQuickTime);
  on('qLaunchTime', 'change', applyQuickTime);
  on('launchDate', 'change', syncQuickTimeFromMain);
  on('launchTime', 'change', syncQuickTimeFromMain);
  on('qNowBtn', 'click', () => {
    const now = new Date(Date.now() + 10 * 60000);
    now.setUTCMinutes(Math.ceil(now.getUTCMinutes() / 10) * 10, 0, 0);
    $('launchDate').value = now.toISOString().slice(0, 10);
    $('launchTime').value = now.toISOString().slice(11, 16);
    syncQuickTimeFromMain();
    recalcExistingTrajectory();
  });
  on('targetMode', 'change', dismissReleaseHint);

  // Weather model chip + popover (cockpit idiom), synced to hidden select
  // Full Open-Meteo model catalogue (forecast API `models=` strings).
  // Regional models only cover their domain and shorter horizons; if a model
  // doesn't cover the requested location/variables the app automatically
  // falls back to best_match (see fetchWeather).
  const wxModels = [
    { group: 'Automatic' },
    { v: '', label: 'Best match (auto blend)' },
    { group: 'Global' },
    { v: 'ecmwf_ifs025', label: 'ECMWF IFS 0.25°' },
    { v: 'ecmwf_aifs025', label: 'ECMWF AIFS 0.25° (AI)' },
    { v: 'gfs_seamless', label: 'GFS Seamless (NOAA)' },
    { v: 'gfs_global', label: 'GFS Global (NOAA)' },
    { v: 'gfs_graphcast025', label: 'GFS GraphCast (AI)' },
    { v: 'icon_seamless', label: 'ICON Seamless (DWD)' },
    { v: 'icon_global', label: 'ICON Global (DWD)' },
    { v: 'gem_seamless', label: 'GEM Seamless (Canada)' },
    { v: 'gem_global', label: 'GEM Global (Canada)' },
    { v: 'meteofrance_seamless', label: 'Météo-France Seamless' },
    { v: 'meteofrance_arpege_world', label: 'ARPEGE World (MF)' },
    { v: 'ukmo_seamless', label: 'UKMO Seamless' },
    { v: 'ukmo_global_deterministic_10km', label: 'UKMO Global 10 km' },
    { v: 'jma_seamless', label: 'JMA Seamless (Japan)' },
    { v: 'jma_gsm', label: 'JMA GSM (Japan)' },
    { v: 'kma_seamless', label: 'KMA Seamless (Korea)' },
    { v: 'cma_grapes_global', label: 'CMA GRAPES (China)' },
    { v: 'bom_access_global', label: 'BOM ACCESS-G (Australia)' },
    { group: 'Europe regional' },
    { v: 'icon_eu', label: 'ICON-EU 7 km (DWD)', cov: [29.5, -23.5, 70.5, 62.5] },
    { v: 'icon_d2', label: 'ICON-D2 2 km (DWD)', cov: [43.2, -3.9, 58.0, 20.3] },
    { v: 'meteofrance_arpege_europe', label: 'ARPEGE Europe (MF)', cov: [20, -32, 72, 42] },
    { v: 'meteofrance_arome_france', label: 'AROME France 1.3 km', cov: [37.5, -12, 55.4, 16] },
    { v: 'meteofrance_arome_france_hd', label: 'AROME France HD', cov: [37.5, -12, 55.4, 16] },
    { v: 'ukmo_uk_deterministic_2km', label: 'UKMO UKV 2 km', cov: [44, -17, 61.5, 10] },
    { v: 'knmi_seamless', label: 'KNMI Seamless (NL)', cov: [43, -12, 64, 25] },
    { v: 'knmi_harmonie_arome_europe', label: 'KNMI HARMONIE Europe', cov: [43, -12, 64, 25] },
    { v: 'dmi_seamless', label: 'DMI Seamless (DK)', cov: [44, -20, 72, 35] },
    { v: 'dmi_harmonie_arome_europe', label: 'DMI HARMONIE Europe', cov: [44, -20, 72, 35] },
    { v: 'metno_seamless', label: 'MET Norway Seamless', cov: [52, -18, 80.5, 54] },
    { v: 'metno_nordic', label: 'MET Norway Nordic 1 km', cov: [52, -18, 80.5, 54] },
    { v: 'italia_meteo_arpae_icon_2i', label: 'ICON-2I Italy (ARPAE)', cov: [33.7, 3, 48.9, 22] },
    { group: 'Regional (other)' },
    { v: 'gfs_hrrr', label: 'HRRR 3 km (USA)', cov: [21.1, -134.1, 52.6, -60.9] },
    { v: 'ncep_nbm_conus', label: 'NBM CONUS (USA)', cov: [19.2, -138.3, 57.3, -59.0] },
    { v: 'gem_regional', label: 'GEM Regional (Canada)', cov: [17.6, -179.9, 89.9, -40] },
    { v: 'gem_hrdps_continental', label: 'GEM HRDPS 2.5 km (Canada)', cov: [39.6, -152.2, 76.0, -40] },
    { v: 'jma_msm', label: 'JMA MSM 5 km (Japan)', cov: [22.4, 120, 47.6, 150] },
  ];
  window.__wxModels = wxModels;
  function addWxRefreshEntry(pop) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wx-refresh';
    b.innerHTML = '<span>\u21BB Update weather now</span>';
    b.addEventListener('click', () => {
      pop.classList.remove('open');
      recalcExistingTrajectory();
    });
    pop.appendChild(b);
  }
  function syncWxSelect() {
    const sel = $('weatherModel');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    wxModels.forEach(m => {
      if (m.group) return;
      const o = document.createElement('option');
      o.value = m.v; o.textContent = m.label;
      sel.appendChild(o);
    });
    sel.value = wxModels.some(m => m.v === cur) ? cur : '';
  }

  function renderWxPopover() {
    const pop = $('wxModelPopover');
    if (!pop) return;
    const cur = $('weatherModel').value;
    // Only list models that actually cover the current launch position;
    // global models (no cov box) are always shown.
    const lat = parseFloat($('launchLat').value);
    const lon = parseFloat($('launchLon').value);
    const covers = m => !m.cov || (isNaN(lat) || isNaN(lon)) ||
      (lat >= m.cov[0] && lon >= m.cov[1] && lat <= m.cov[2] && lon <= m.cov[3]);
    pop.innerHTML = '';
    addWxRefreshEntry(pop);
    let pendingGroup = null;
    wxModels.forEach(m => {
      if (m.group) { pendingGroup = m.group; return; }
      if (!covers(m)) return;
      if (pendingGroup) {
        const h = document.createElement('div');
        h.className = 'wx-group';
        h.textContent = pendingGroup;
        pop.appendChild(h);
        pendingGroup = null;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = m.label;
      if (m.v === cur) b.classList.add('active');
      b.addEventListener('click', () => {
        $('weatherModel').value = m.v;
        updateWxChip();
        pop.classList.remove('open');
      });
      pop.appendChild(b);
    });
  }
  syncWxSelect();
  updateWxChip();
  on("wxModelChip", "click", (e) => {
    const pop = $('wxModelPopover');
    if (!pop) return;
    if (pop.classList.contains('open')) { pop.classList.remove('open'); return; }
    renderWxPopover();
    const rect = $('wxModelChip').getBoundingClientRect();
    pop.style.top = (rect.bottom + 6) + 'px';
    pop.style.left = Math.max(6, rect.left) + 'px';
    pop.classList.add('open');
    e.stopPropagation();
  });
  document.addEventListener('click', (e) => {
    const pop = $('wxModelPopover');
    if (pop && pop.classList.contains('open') && !pop.contains(e.target) && e.target.closest('#wxModelChip') === null) {
      pop.classList.remove('open');
    }
  });


  // Airspace overlay controls
  buildAirspaceMenu();
  renderAirspaceToggle();
  on('airspaceToggleBtn', 'click', () => {
    const next = !airspaceVisible();
    try { localStorage.setItem('sfp_airspace_show', next ? '1' : '0'); } catch (e) { /* ignore */ }
    renderAirspaceToggle();
    refreshAirspaceOverlay();
  });
  on('menuAirspaceBtn', 'click', () => {
    const m = mainMenu(); if (m) { m.hidden = true; m.classList.remove('open'); }
    const am = $('airspaceMenu');
    if (am) { am.hidden = false; am.classList.add('open'); }
  });
  on('airspaceCloseBtn', 'click', () => {
    const am = $('airspaceMenu');
    if (am) { am.hidden = true; am.classList.remove('open'); }
  });
  document.addEventListener('click', (e) => {
    const am = $('airspaceMenu');
    if (am && !am.hidden && !am.contains(e.target) && !e.target.closest('#menuAirspaceBtn')) { am.hidden = true; am.classList.remove('open'); }
  });
  let asTimer = null;
  state.map.on('moveend zoomend', () => {
    clearTimeout(asTimer);
    asTimer = setTimeout(refreshAirspaceOverlay, 600);
  });
  refreshAirspaceOverlay();


  on('ensembleBtn', 'click', () => { runEnsemble().catch(showError); });
  updateEnsembleBtn();

  // G2: trajectory -> Google Maps (button text opens the route, QR icon toggles the popover)
  const gmPop = () => $('gmapsQrPop');
  const closeGmPop = () => { const p = gmPop(); if (p) { p.hidden = true; p.classList.remove('open'); } };
  const openGmQr = () => {
    const url = buildGmapsTrajUrl();
    const p = gmPop();
    if (!url || !p) return;
    if (!p.hidden) { closeGmPop(); return; }
    const box = $('gmapsQrBox');
    if (box) {
      try {
        if (typeof qrcode === 'function') {
          const q = qrcode(0, 'M');
          q.addData(url);
          q.make();
          box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0 });
        } else {
          box.innerHTML = '<p class="hint">QR library not loaded — use the button text to open the link.</p>';
        }
      } catch (err) {
        box.innerHTML = '<p class="hint">QR generation failed.</p>';
      }
    }
    p.hidden = false;
    p.classList.add('open');
  };
  const qrIcon = document.getElementById('gmapsQrIcon');
  if (qrIcon) qrIcon.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); openGmQr(); });
  on('gmapsTrajBtn', 'click', (e) => {
    if (e.target.closest && e.target.closest('#gmapsQrIcon')) return; // handled above
    closeGmPop();
    downloadTrajKml();
    e.stopPropagation();
  });
  on('gmapsQrCloseBtn', 'click', closeGmPop);
  document.addEventListener('click', (e) => {
    const p = gmPop();
    if (p && !p.hidden && !p.contains(e.target) && !e.target.closest('#gmapsTrajBtn')) closeGmPop();
  });

  // Collapsible cards
  document.querySelectorAll('.card > h3').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  });

  // Keep map sized correctly on orientation change / resize (iPad)
  window.addEventListener('resize', () => { if (state.map) setTimeout(() => state.map.invalidateSize(), 150); });
}

window.addEventListener('DOMContentLoaded', () => {
  if (typeof L === 'undefined') {
    if (window.__appError) window.__appError('Leaflet (map library) failed to load from cdn.jsdelivr.net \u2014 check the network connection or a content blocker, then reload.');
    return;
  }
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
