// Synthetic tags on vehicles and portable plant (Region design §4.3): position pings computed from routes and trip
// schedules, every minute while moving and every five while parked. People are never tracked.
// shortcut: pings are pure functions of (seed, tracker, minute); a real feed (AVL/GPS connector) would append to a store.
import { ZONES, toLonLat } from "./layout.mjs";
import { TRACKERS, zoneAtLocal } from "./region.mjs";
import { within } from "./functions.mjs";

const MIN = 60000, DAY = 1440;
// geofence events depend only on (seed, window), like telemetry series, so systems share them
const EVENTS = new Map();
const hash = (s, seed) => { let h = 2166136261 ^ seed; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };

// live up to 15 min, stale up to 24 h, then lost; age runs against the end of the data, so a demo clock running on does not age tags
export function pingState(pingAt, now, dataEnd) {
  const ref = Math.min(Date.parse(now), Date.parse(dataEnd)), age = ref - Date.parse(pingAt);
  return age <= 15 * MIN ? "live" : age < 24 * 3600000 ? "stale" : "lost";
}

const lengths = (r) => r.slice(1).map((p, i) => Math.hypot(p[0] - r[i][0], p[1] - r[i][1]));
function along(route, f) {
  const L = lengths(route), total = L.reduce((a, b) => a + b, 0);
  let d = f * total;
  for (let i = 0; i < L.length; i++) {
    if (d <= L[i] || i === L.length - 1) {
      const t = L[i] ? Math.min(1, d / L[i]) : 0, a = route[i], b = route[i + 1];
      return { xy: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], seg: [a, b], total };
    }
    d -= L[i];
  }
  return { xy: route[0], seg: [route[0], route[0]], total: 0 };
}

export function createTrackers({ ont, seed = 7, start = "2026-10-01T00:00:00Z", minutes = 14 * DAY }) {
  const t0 = Date.parse(start), iso = (m) => new Date(t0 + m * MIN).toISOString();
  const byId = new Map(TRACKERS.map((t) => [t.id, t]));
  // trip starts that could cover minute m: today's and yesterday's daily trips, and one-offs; each start jittered ±3 min by seed
  const startsUpTo = (t, m) => {
    const out = [], d = Math.floor(m / DAY);
    for (const tr of t.trips) {
      const days = tr.day !== undefined ? [tr.day] : [d - 1, d];
      for (const dd of days) {
        if (dd < 0) continue;
        const s = dd * DAY + tr.at + Math.floor(hash(`${t.id}|${dd}|${tr.at}`, seed) * 7) - 3;
        if (s <= m) out.push({ s, ...tr });
      }
    }
    return out.sort((a, b) => a.s - b.s).pop() || null;
  };
  function stateAt(t, m) {
    const tr = startsUpTo(t, m);
    if (!tr) return { xy: t.route[0], moving: false };
    const route = tr.dir === 1 ? t.route : [...t.route].reverse();
    if (m < tr.s + tr.dur) {
      const a = along(route, (m - tr.s) / tr.dur), [p, q] = a.seg;
      return { xy: a.xy, moving: true, speedKmh: Math.round((a.total / tr.dur) * 0.06 * 10) / 10, headingDeg: Math.round(((Math.atan2(q[0] - p[0], -(q[1] - p[1])) * 180) / Math.PI + 360) % 360), eta: tr.day !== undefined ? iso(tr.s + tr.dur) : null };
    }
    return { xy: route[route.length - 1], moving: false };
  }
  const moving = (t, m) => stateAt(t, m).moving;
  const lastPingAtOrBefore = (t, m) => {
    m = Math.min(m, minutes);
    if (t.silentFrom !== undefined && m >= t.silentFrom) m = t.silentFrom - 1;
    for (let k = m; k >= Math.max(0, Math.floor(m / 5) * 5); k--) if (moving(t, k) || k % 5 === 0) return k;
    return 0;
  };
  function running(t, m) {
    if (!t.run) return false;
    if (Array.isArray(t.run)) { const tod = m % DAY; return tod >= t.run[0] && tod < t.run[1]; }
    return m >= t.run.from;
  }
  function runMinutes(t, m) {
    if (!t.run) return 0;
    if (Array.isArray(t.run)) { const per = t.run[1] - t.run[0], d = Math.floor(m / DAY), tod = m % DAY; return d * per + Math.max(0, Math.min(per, tod - t.run[0])); }
    return Math.max(0, m - t.run.from);
  }
  function ping(t, m) {
    const s = stateAt(t, m), j = (k) => (hash(`${t.id}|${m}|${k}`, seed) - 0.5) * 6; // GPS jitter ±3 m
    const xy = [s.xy[0] + j("x"), s.xy[1] + j("y")], [lon, lat] = toLonLat(xy);
    const p = { trackerId: t.id, at: iso(m), lat, lon, speedKmh: s.moving ? s.speedKmh : 0, headingDeg: s.moving ? s.headingDeg : null, batteryPct: t.kind === "vehicle" ? 100 : 60 + Math.round(35 * hash(`${t.id}|${Math.floor(m / DAY)}`, seed)), source: "synthetic", zoneId: zoneAtLocal(s.xy, ZONES) };
    if (t.silentFrom !== undefined && m >= t.silentFrom - 60) p.batteryPct = 12; // the tag's battery was failing before it went quiet
    if (s.eta) p.eta = s.eta;
    if (t.kind === "portable") {
      const run = running(t, m), rm = runMinutes(t, m);
      Object.assign(p, { state: run ? "running" : t.run ? "idle" : "off", runHours: Math.round((1200 + rm / 60) * 10) / 10, fuelPct: t.run ? Math.max(5, Math.round(100 - ((rm % DAY) / DAY) * 70)) : 100 });
    }
    return p;
  }
  const geofenceOf = (id) => { const o = ont.get(id); return o && (o.footprint || o.geometry); };
  function allEvents() {
    const key = `${seed}|${start}|${minutes}`;
    if (EVENTS.has(key)) return EVENTS.get(key);
    const events = [];
    EVENTS.set(key, events);
    for (const t of TRACKERS.filter((x) => x.geofences.length)) {
      let inside = null;
      for (let m = 0; m <= minutes; m += 5) {
        const p = ping(t, m), now = t.geofences.filter((g) => geofenceOf(g) && within([p.lon, p.lat], geofenceOf(g)));
        if (inside) {
          for (const g of inside.filter((g) => !now.includes(g))) events.push({ id: `GFE-${t.id}-${m}`, type: "GeofenceEvent", trackerId: t.id, at: p.at, regionId: g, kind: "left", zoneId: p.zoneId, minute: m });
          for (const g of now.filter((g) => !inside.includes(g))) events.push({ id: `GFE-${t.id}-${m}-in`, type: "GeofenceEvent", trackerId: t.id, at: p.at, regionId: g, kind: "entered", zoneId: p.zoneId, minute: m });
        }
        inside = now;
      }
    }
    return events;
  }
  return {
    dataEndMin: minutes,
    latest: (id, cursorMin) => { const t = byId.get(id); return t ? ping(t, lastPingAtOrBefore(t, cursorMin)) : null; },
    history(id, n, cursorMin) {
      const t = byId.get(id);
      if (!t) return [];
      const out = [];
      for (let m = lastPingAtOrBefore(t, cursorMin); out.length < n && m >= 0; m = m ? lastPingAtOrBefore(t, m - 1) : -1) out.unshift(ping(t, m));
      return out;
    },
    geofenceEvents: (fromMin, toMin) => allEvents().filter((e) => e.minute > fromMin && e.minute <= toMin),
    // Mirror the latest ping onto each Tracker and add the geofence events the clock has passed (both idempotent).
    syncTo(o, cursorMin) {
      for (const t of TRACKERS) {
        const { trackerId, at, ...p } = this.latest(t.id, cursorMin);
        o.upsert({ id: t.id, type: "Tracker", ...p, pingAt: at });
      }
      for (const e of allEvents().filter((x) => x.minute <= cursorMin && !o.get(x.id))) { const { minute, ...rest } = e; o.upsert(rest); }
    }
  };
}
