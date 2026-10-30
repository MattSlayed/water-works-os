// Synthetic historian: 1-minute series for every sensor, with fault scenarios, replayed against a plant clock.
// shortcut: series are precomputed in memory for the 14-day window; replace with a TimescaleDB-backed reader for a real site.

const MIN = 60000;

function hash(str, seed) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// base value, noise amplitude, diurnal amplitude by sensor key and asset template
const PROFILE = {
  "centrifugal_pump:vib_de": [2.2, 0.15, 0.1], "centrifugal_pump:temp_de": [58, 0.6, 2], "centrifugal_pump:current": [290, 4, 10], "centrifugal_pump:flow": [30, 0.6, 3],
  "blower:vib": [3, 0.2, 0], "blower:temp_dis": [80, 1, 2], "blower:press": [55, 1, 0],
  "dosing_pump:flow": [180, 3, 15], "dosing_pump:press": [4, 0.1, 0.2], "dosing_pump:stroke": [60, 0.5, 0],
  "clarifier_drive:torque": [35, 1.5, 3], "clarifier_drive:current": [9, 0.2, 0.3], "clarifier_drive:temp": [50, 0.5, 2],
  "filter:turb": [0.12, 0.015, 0], "filter:headloss": [0.8, 0.02, 0],
  "RAW-turb": [25, 1.5, 8], "RAW-flow": [110, 1.5, 6], "FW-turb": [0.15, 0.015, 0.02], "FIN-cl": [0.9, 0.03, 0.05],
  "FIN-ph": [7.9, 0.03, 0.05], "RES-1-level": [62, 0.4, 14], "RES-2-level": [58, 0.4, 14], "CLR-turb": [2.5, 0.2, 0.3], "OUT-flow": [108, 1.5, 12],
  // bulk line (Region design §4.2)
  "PS1-flow": [70, 1, 8], "PS1-press": [6.2, 0.05, 0.3], "PS1-state": [1, 0, 0], "PS2-flow": [45, 1, 6], "PS2-press": [5.4, 0.05, 0.3], "PS2-state": [1, 0, 0],
  "CR1-level": [70, 0.4, 6], "CR1-in": [62, 1, 4], "CR1-out": [45, 1, 8], "CR2-level": [62, 0.4, 3], "CR2-in": [24, 0.6, 2], "CR2-out": [25, 0.5, 2],
  "VC1-press": [5.8, 0.05, 0.3], "VC1-pos": [100, 0, 0], "VC2-press": [5.6, 0.05, 0.3], "VC2-pos": [100, 0, 0], "VC3-press": [5.2, 0.05, 0.3], "VC3-pos": [100, 0, 0]
};

// Series are pure functions of (seed, sensor, asset state, window), so they are shared across systems.
const CACHE = new Map();

export function createTelemetry({ ont, seed = 7, start = "2026-10-01T00:00:00Z", minutes = 14 * 24 * 60, startCursorMin } = {}) {
  const t0 = Date.parse(start);
  const series = new Map();
  const sensors = ont.list("Sensor");
  const assetOf = (s) => (s.assetId ? ont.get(s.assetId) : null);
  const day = (i) => i / 1440;

  for (const s of sensors) {
    const a = assetOf(s);
    const tpl = a ? a.template || (a.assetClass === "Rapid gravity filter" ? "filter" : null) : null;
    const key = tpl ? `${tpl}:${s.key}` : s.id.replace("SEN-", "");
    const [base, noise, diurnal] = PROFILE[key] || [0, 0, 0];
    const ck = `${seed}|${start}|${minutes}|${s.id}|${a ? a.state : ""}`;
    if (CACHE.has(ck)) { series.set(s.id, CACHE.get(ck)); continue; }
    const rand = rng(hash(s.id, seed));
    const v = new Float32Array(minutes + 1);
    const tag = a ? a.positionTag : null;
    const off = a && (a.state === "standby" || a.state === "isolated");
    const filterIdx = tag && /^F\d\d$/.test(tag) ? Number(tag.slice(1)) : 0;
    for (let i = 0; i <= minutes; i++) {
      const d = day(i);
      let x = base + (rand() - 0.5) * 2 * noise + diurnal * Math.sin(((d % 1) - 0.25) * 2 * Math.PI);
      if (off) x = s.key === "vib_de" || s.key === "vib" ? 0.3 + rand() * 0.1 : s.key.startsWith("temp") ? 24 + rand() : 0;
      if (filterIdx) {
        // run-time sawtooth: each filter backwashes every 30 h, offset by filter number
        const phase = ((i / 60 + filterIdx * 2.5) % 30) / 30;
        if (s.key === "headloss") x = 0.6 + 1.4 * phase + (rand() - 0.5) * 0.04;
        if (s.key === "turb") x = 0.1 + 0.05 * phase * phase + (rand() - 0.5) * 0.02;
        if (tag === "F07" && d > 12) {
          const k = Math.min(1, (d - 12) / 2);
          if (s.key === "turb") x += 0.6 * k * k;
          if (s.key === "headloss") x = Math.max(x, 1.6 + 1.0 * k);
        }
      }
      if (tag === "HLP-B" && d > 9) {
        const k = Math.pow((d - 9) / 5, 1.6);
        if (s.key === "vib_de") x += 4.6 * k;
        if (s.key === "temp_de") x += 21 * k;
        if (s.key === "current") x += 12 * k;
      }
      if (tag === "DP-2" && d > 12 && s.key === "flow" && Math.floor(i / 47) % 5 === 0) x *= 0.35;
      if (s.id === "SEN-FW-turb" && d > 12) x += 0.05 * Math.min(1, (d - 12) / 2);
      // the storm plume reaches the intake on day 11.85 (Region design §5.3): a contributing cause, the filters absorb it
      if (s.id === "SEN-RAW-turb" && d >= 11.85) x += 65 * Math.min(1, (d - 11.85) / 0.6) * (d > 13 ? Math.exp(-(d - 13) / 2) : 1);
      v[i] = Math.max(0, x);
    }
    series.set(s.id, v);
    CACHE.set(ck, v);
  }

  let cursor = startCursorMin ?? minutes - 18 * 60; // replay begins 18 h before the end of the window
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    start,
    minutes,
    end: new Date(t0 + minutes * MIN).toISOString(),
    now: () => new Date(t0 + cursor * MIN).toISOString(),
    cursor: () => cursor,
    // the plant clock runs on past the replay window; readings hold the last sample
    tick: (n = 1) => { cursor += Math.max(0, n); return cursor; },
    latest(id) {
      const v = series.get(id);
      if (!v) return null;
      const i = Math.min(cursor, v.length - 1);
      return { value: round(v[i]), at: new Date(t0 + i * MIN).toISOString(), quality: "good" };
    },
    history(id, n = 60) {
      const v = series.get(id);
      if (!v) return [];
      const end = Math.min(cursor, v.length - 1), from = Math.max(0, end - n + 1);
      return Array.from(v.subarray(from, end + 1), round);
    },
    // 1-minute points clipped to [fromIso, toIso], rounded like history()
    series(id, fromIso, toIso) {
      const v = series.get(id);
      if (!v) return [];
      const a = Math.max(0, Math.ceil((Date.parse(fromIso) - t0) / MIN)), b = Math.min(v.length - 1, Math.floor((Date.parse(toIso) - t0) / MIN));
      const out = [];
      for (let i = a; i <= b; i++) out.push({ t: new Date(t0 + i * MIN).toISOString(), v: round(v[i]) });
      return out;
    },
    sensorsFor: (objId) => sensors.filter((s) => s.assetId === objId || s.processUnitId === objId)
  };
}
