// Synthetic Sentinel-2 and Sentinel-1 scenes over Riverbend Dam (Region design §5): a year of statistics for baselines,
// grids for the telemetry window, water indices that are indices — never NTU or µg/L — and the day-10 storm plume.
// Statistics use the Planetary Computer (titiler) statistics shape, so live mode (src/geolive.mjs) shares the parser.
import { toLocal, toLonLat } from "./layout.mjs";
import { REGION } from "./region.mjs";
import { within } from "./functions.mjs";

const DAY = 86400000;
const AOIS = ["AOI-INFLOW", "AOI-INTAKE", "AOI-DAM"];
export const OPTICAL = ["ndti", "ndwi", "mndwi", "ndci"];
// window days from 2026-10-01: the storm on day 10, the first usable scene after it on day 11, raw water turns at the intake on day 11.85
export const PLUME = { stormDay: 10, sceneDay: 11, intakeOnsetDay: 11.85 };
export const CLOUD_LIMIT = 60;
export const usableCloud = (pct) => pct === null || pct <= CLOUD_LIMIT;

const hash = (s, seed) => { let h = 2166136261 ^ seed; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };
const r4 = (x) => Math.round(x * 10000) / 10000;
const doy = (t) => (t - Date.UTC(new Date(t).getUTCFullYear(), 0, 1)) / DAY;
const summer = (t) => (1 + Math.cos((2 * Math.PI * (doy(t) - 15)) / 365)) / 2; // 1 in mid-January, 0 in mid-July
const idFor = (mission, t) => `${mission}-${new Date(t).toISOString().slice(0, 10).replace(/-/g, "")}`;
const AREA_M2 = { "AOI-INFLOW": Math.PI * 450 * 300, "AOI-INTAKE": Math.PI * 250 * 150, "AOI-DAM": Math.PI * 2280 * 807.5 };

// A statistic in the titiler shape, from a mean and a spatial spread; pixel counts at 10 m.
function stat(mean, sd, area, validPct) {
  const count = Math.round(area / 100), valid = Math.round((count * validPct) / 100), lo = mean - 2.5 * sd, step = (5 * sd) / 10;
  const hist = [0.01, 0.03, 0.08, 0.15, 0.23, 0.23, 0.15, 0.08, 0.03, 0.01].map((f) => Math.round(f * valid));
  return { min: r4(lo), max: r4(mean + 2.5 * sd), mean: r4(mean), count: valid, sum: r4(mean * valid), std: r4(sd), median: r4(mean), majority: r4(mean), minority: r4(lo), unique: valid,
    histogram: [hist, Array.from({ length: 11 }, (_, i) => r4(lo + i * step))], valid_percent: r4(validPct), masked_pixels: count - valid, valid_pixels: valid, percentile_2: r4(mean - 2.05 * sd), percentile_98: r4(mean + 2.05 * sd) };
}

// Climatology per area and index, with seeded scene-to-scene noise.
function climate(aoi, index, t, seed) {
  const s = summer(t), n = (hash(`${aoi}|${index}|${t}`, seed) * 2 - 1);
  switch (index) {
    case "ndti": return (aoi === "AOI-INFLOW" ? 0.04 + 0.08 * s : aoi === "AOI-INTAKE" ? 0.02 + 0.05 * s : 0.03 + 0.06 * s) + 0.015 * n;
    case "ndci": return 0.03 + 0.05 * s + 0.015 * n;
    case "ndwi": return 0.42 + 0.03 * n;
    case "mndwi": return 0.55 + 0.03 * n;
    default: return -18.5 + 0.6 * n; // vv, dB
  }
}

// Mean ± 2σ over the usable scenes of the same mission in the 90 days before; null when fewer than three.
export function baseline(scenes, aoiId, index, atIso) {
  const t = Date.parse(atIso), mission = index === "vv" ? "S1" : "S2";
  const xs = scenes.filter((s) => s.mission === mission && s.usable[aoiId] && Date.parse(s.acquiredAt) < t && Date.parse(s.acquiredAt) >= t - 90 * DAY && s.stats[aoiId] && s.stats[aoiId][index])
    .map((s) => s.stats[aoiId][index].mean);
  if (xs.length < 3) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length, std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, std, n: xs.length };
}

export function bandOf(value, base) {
  if (!base || !base.std || !Number.isFinite(value)) return "unknown";
  const z = (value - base.mean) / base.std;
  return z > 3 ? "high" : z > 2 ? "raised" : "normal";
}

export function makeScenes({ seed = 7, historyFrom = "2025-10-01T00:00:00Z", windowStart = "2026-10-01T00:00:00Z", windowEnd = "2026-10-15T00:00:00Z" } = {}) {
  const w0 = Date.parse(windowStart), w1 = Date.parse(windowEnd), h0 = Date.parse(historyFrom);
  const times = (anchor, every) => { const out = []; for (let t = anchor; t >= h0; t -= every * DAY) out.unshift(t); for (let t = anchor + every * DAY; t < w1; t += every * DAY) out.push(t); return out; };
  const forced = { [`S2-20261002`]: 12, [`S2-20261007`]: 72, [`S2-20261012`]: 31 };
  const raw = [
    ...times(w0 + DAY + 8 * 3600000, 5).map((t) => ({ mission: "S2", t })),
    ...times(w0 + 4 * DAY + 16.5 * 3600000, 6).map((t) => ({ mission: "S1", t }))
  ].sort((a, b) => a.t - b.t);
  const scenes = [];
  for (const { mission, t } of raw) {
    const id = idFor(mission, t), s = summer(t), u = hash(`${id}|cloud`, seed);
    const cloudPct = mission === "S1" ? null : forced[id] ?? Math.round(s > 0.5 ? 100 * Math.pow(u, 0.7) : 60 * u * u);
    const usable = Object.fromEntries(AOIS.map((a) => [a, usableCloud(cloudPct)]));
    const validPct = mission === "S1" ? 100 : Math.max(0, 100 - cloudPct);
    const stats = {};
    for (const a of AOIS) {
      stats[a] = mission === "S1" ? { vv: stat(climate(a, "vv", t, seed), 0.8, AREA_M2[a], 100) } : Object.fromEntries(OPTICAL.map((ix) => [ix, stat(climate(a, ix, t, seed), 0.01, AREA_M2[a], validPct)]));
      if (mission === "S1" && a === "AOI-DAM") stats[a].waterAreaKm2 = r4(5.8 + 0.08 * (hash(`${id}|area`, seed) * 2 - 1));
    }
    const scene = { id, type: "Scene", mission, acquiredAt: new Date(t).toISOString(), cloudPct, usable, stats, inWindow: t >= w0, zoneId: null };
    // The plume scene: turbid water in the inflow arm at z = 2.6 against its own baseline; the rest of the dam at its usual level.
    if (id === idFor("S2", w0 + PLUME.sceneDay * DAY + 8 * 3600000)) {
      for (const a of AOIS) {
        const b = baseline(scenes, a, "ndti", scene.acquiredAt);
        if (b) stats[a].ndti = stat(a === "AOI-INFLOW" ? b.mean + 2.6 * b.std : b.mean, 0.01, AREA_M2[a], validPct);
      }
    }
    scenes.push(scene);
  }
  return scenes;
}

const ring = (id) => REGION.find((r) => r.id === id).geometry;
// The banded grid over the dam for one scene in the telemetry window (history scenes carry statistics only).
export function sceneGrid(scene, index = "ndti", cellM = 60, scenes = []) {
  if (!scene || !scene.inWindow || (scene.mission === "S1") !== (index === "vv")) return null;
  const dam = ring("AOI-DAM"), pts = dam.coordinates[0].map(toLocal), xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const areaOf = (ll) => (within(ll, ring("AOI-INFLOW")) ? "AOI-INFLOW" : within(ll, ring("AOI-INTAKE")) ? "AOI-INTAKE" : "AOI-DAM");
  const bases = Object.fromEntries(AOIS.map((a) => [a, baseline(scenes, a, index, scene.acquiredAt)]));
  const cells = [], band = [];
  for (let x = Math.min(...xs) + cellM / 2; x < Math.max(...xs); x += cellM) {
    for (let y = Math.min(...ys) + cellM / 2; y < Math.max(...ys); y += cellM) {
      const ll = toLonLat([x, y]);
      if (!within(ll, dam)) continue;
      const a = areaOf(ll), st = scene.stats[a][index], b = bases[a];
      const v = st.mean + (hash(`${scene.id}|${x}|${y}`, 1) * 2 - 1) * 0.25 * (b ? b.std : st.std);
      cells.push([Math.round(ll[0] * 1e6) / 1e6, Math.round(ll[1] * 1e6) / 1e6, r4(v)]);
      band.push(scene.usable[a] ? bandOf(v, b) : "unknown");
    }
  }
  return { sceneId: scene.id, index, cellM, cells, band, usable: Object.values(scene.usable).some(Boolean), note: "index, not calibrated" };
}
