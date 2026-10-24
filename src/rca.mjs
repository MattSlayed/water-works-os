// Root cause (agents design §5): deterministic, over the released plant model's process graph, the region's raw-water
// inputs and the telemetry history. Claude never decides a cause; at most it words the summary.
import { graphFrom, upstreamOf, processPaths, travelWindow, onsetMinute } from "./functions.mjs";

const DAY = 1440;
// shortcut: a fixed 78 h of history before the symptom's alert (or `at`); an older symptom needs `at`
const LOOKBACK_MIN = 78 * 60;
const FILTER = "Rapid gravity filter";
const RAW = "SEN-RAW-turb";
const WATER = /-(turb|headloss)$/; // upstream water can change these; it cannot make a bearing vibrate
const minutesBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);
const plus = (iso, m) => new Date(Date.parse(iso) + m * 60000).toISOString();

// A sensor's samples up to `at` (at most the lookback), with the time of the first one.
function seriesTo(ctx, id, at, lookback = LOOKBACK_MIN) {
  const l = ctx.latest(id);
  if (!l) return null;
  const all = ctx.history(id, 1e6), end = all.length - 1 - Math.max(0, minutesBetween(at, l.at));
  if (end < 0) return null;
  const from = Math.max(0, end - lookback);
  return { values: all.slice(from, end + 1), t0: plus(l.at, -(all.length - 1 - from)) };
}
// Filters back-wash every 30 h, so each sample is compared with one a filter run earlier; raw water swings daily.
const optsFor = (id, filter) => (filter ? { baseline: 2 * DAY, period: 1800 } : id === RAW ? { baseline: DAY, period: DAY } : { baseline: 2 * DAY });
function onsetAt(ctx, id, at, filter = false) {
  const s = seriesTo(ctx, id, at);
  const i = s ? onsetMinute(s.values, optsFor(id, filter)) : null;
  return i === null ? null : plus(s.t0, i);
}

function symptomOf(ctx, targetId, at) {
  const t = ctx.get(targetId);
  if (!t) return null;
  const alert = t.type === "Alert" ? t : null;
  const asset = alert ? ctx.get(alert.assetId) : t.type === "Asset" ? t : t.type === "Sensor" ? ctx.get(t.assetId) : t.type === "Position" ? ctx.list("Asset", (a) => a.positionId === t.id)[0] : null;
  if (!asset) return null;
  // an asset with an active alert is read at the alert's moment, so the report does not drift with the plant clock
  const active = alert || ctx.list("Alert", (a) => a.assetId === asset.id && a.state === "active").sort((a, b) => a.at.localeCompare(b.at))[0];
  const when = at || (active && active.at) || ctx.now, filter = asset.assetClass === FILTER;
  const ids = t.type === "Sensor" ? [t.id] : filter ? [`SEN-${asset.positionTag}-headloss`] : [...((alert && alert.evidence) || []).filter((x) => /^SEN-/.test(x)), ...ctx.sensorsFor(asset.id).map((s) => s.id)];
  for (const id of new Set(ids)) {
    const on = onsetAt(ctx, id, when, filter);
    if (on) return { asset, sensorId: id, onsetAt: on, at: when, filter };
  }
  return { asset, sensorId: ids[0] || null, onsetAt: null, at: when, filter };
}

// "too late" or "too early" against a travel window, or null when the lag is inside it.
function timing(lag, w, tag) {
  if (lag < w.onsetH * 60) return lag < 0 ? `too late: its onset came ${-lag} min after ${tag}'s` : `too late: its onset was ${lag} min before ${tag}'s, but water needs at least ${Math.round(w.onsetH * 60)} min to arrive`;
  if (lag > w.tailH * 60) return `too early: its onset was ${lag} min before ${tag}'s, after the ${Math.round(w.tailH * 60)} min tail had passed`;
  return null;
}

export function rootCause(ctx, { targetId, at } = {}) {
  const insufficient = (why, symptom = null, rejected = []) => ({ symptom, causes: [], rejected, verdict: "Insufficient evidence", why, window: null });
  const model = ctx.list("PlantModel", (m) => m.status === "released")[0];
  if (!model) return insufficient("no released plant model");
  const sym = symptomOf(ctx, targetId, at);
  if (!sym) return insufficient(`${targetId} is not an asset, a sensor or an alert on an asset`);
  const { asset } = sym, tag = asset.positionTag || asset.id;
  const symptom = { id: asset.id, sensorId: sym.sensorId, onsetAt: sym.onsetAt };
  if (!sym.onsetAt) return insufficient(`no onset on ${sym.sensorId || tag} in the ${LOOKBACK_MIN / 60} h before ${sym.at}`, symptom);
  const age = (iso) => (iso ? minutesBetween(iso, ctx.now) : null);
  const g = graphFrom(ctx.list(null, (o) => o.modelId === model.id));
  const node = g.alias.get(asset.positionId) || asset.positionId;
  const causes = [], rejected = [];
  let window = null;

  if (sym.filter || WATER.test(sym.sensorId)) {
    // the raw water at the intake, and the plume on the dam behind it (every area of interest drains to the intake)
    const raw = ctx.get(RAW), zone = raw && (ctx.get(raw.processUnitId) || {}).zoneId;
    const intake = [...g.nodes.values()].find((n) => n.type === "Structure" && n.zoneId === zone && !(g.in.get(n.id) || []).some((e) => e.kind === "flow"));
    const path = intake && processPaths(intake.id, node, g, { limit: 1 })[0];
    if (path) {
      window = travelWindow(path, g, { flowMlD: 120 });
      const rawOn = onsetAt(ctx, RAW, sym.at);
      if (rawOn) {
        const lag = minutesBetween(rawOn, sym.onsetAt), late = timing(lag, window, tag);
        const ev = { id: RAW, ageMin: age(rawOn), note: `raw-water turbidity rose ${lag} min before ${tag}; travel window ${window.onsetH}–${window.tailH} h` };
        const det = ctx.list("GeoDetection", (d) => d.kind === "plume" && d.status !== "rejected").sort((a, b) => (b.status === "confirmed") - (a.status === "confirmed"))[0];
        if (late) rejected.push({ id: RAW, label: "Raw-water turbidity", reason: late });
        else if (det) causes.push({ id: det.id, label: `Storm plume in the ${((ctx.get(det.aoiId) || {}).name || det.aoiId).toLowerCase()} (${det.status})`, kind: "contributing", status: det.status, weight: det.status === "confirmed" ? 0.7 : 0.5, onsetAt: rawOn,
          evidence: [{ id: det.id, ageMin: age(det.at), note: `${det.status} plume, confidence ${det.confidence}, scene ${det.sceneId}` }, ev], showMe: `#/region/focus=detection:${det.id}` });
        else causes.push({ id: RAW, label: "Raw-water turbidity rise", kind: "contributing", weight: 0.5, onsetAt: rawOn, evidence: [ev], showMe: `#/object/${RAW}` });
      }
    }
    // machines and structures upstream that changed: inside the travel window they contribute, outside they are rejected
    for (const u of upstreamOf(node, g)) {
      const n = g.nodes.get(u.id), pid = n && (n.type === "MachinePlacement" ? n.positionId || u.id : n.positionId);
      const a = pid && ctx.list("Asset", (x) => x.positionId === pid)[0];
      if (!a || a.id === asset.id) continue;
      const on = ctx.sensorsFor(a.id).map((s) => ({ id: s.id, at: onsetAt(ctx, s.id, sym.at) })).filter((x) => x.at).sort((x, y) => x.at.localeCompare(y.at))[0];
      const p = on && processPaths(u.id, node, g, { limit: 1 })[0];
      if (!p) continue;
      const w = travelWindow(p, g, { flowMlD: 120 }), lag = minutesBetween(on.at, sym.onsetAt), late = timing(lag, w, tag);
      const label = `${a.positionTag} ${String(a.template || a.assetClass || "").replace(/_/g, " ")}`.trim();
      if (late) rejected.push({ id: a.id, label, reason: late });
      else causes.push({ id: a.id, label, kind: "contributing", weight: 0.5, onsetAt: on.at, evidence: [{ id: on.id, ageMin: age(on.at), note: `onset ${lag} min before ${tag}, inside ${w.onsetH}–${w.tailH} h` }], showMe: `#/plant/${a.positionId || a.id}` });
    }
  } else rejected.push({ id: "upstream", label: "Upstream water", reason: `${sym.sensorId} is not a water-quality measure; upstream water cannot cause it` });

  // breadth: one unit alone points to a local cause; several siblings to a common one
  const suffix = sym.sensorId.slice(`SEN-${tag}`.length);
  const siblings = ctx.list("Asset", (a) => a.assetClass === asset.assetClass && a.id !== asset.id && a.positionTag);
  const alike = siblings.filter((a) => onsetAt(ctx, `SEN-${a.positionTag}${suffix}`, sym.at, sym.filter)).map((a) => a.positionTag);
  if (alike.length < 2) {
    const history = [...ctx.list("Finding", (f) => f.assetId === asset.id && f.verified), ...ctx.list("WorkOrder", (w) => w.assetId === asset.id)].slice(-3);
    causes.push({ id: asset.id, label: `${tag} ${String(asset.assetClass || "").toLowerCase()}`.trim(), kind: "local", weight: 1, onsetAt: sym.onsetAt, showMe: `#/plant/${asset.positionId || asset.id}`,
      evidence: [{ id: sym.sensorId, ageMin: age(sym.onsetAt), note: `onset ${sym.onsetAt.slice(0, 16)}; ${alike.length} of ${siblings.length} siblings show one` },
        ...history.map((h) => ({ id: h.id, ageMin: age(h.at || h.requested || null), note: h.text || h.title || h.type }))] });
  } else rejected.push({ id: asset.id, label: `${tag} (local)`, reason: `${alike.length} siblings (${alike.join(", ")}) show the same onset: a common cause, not a local one` });

  causes.sort((a, b) => b.weight - a.weight);
  return { symptom, causes, rejected, verdict: causes.length ? "explained" : "Insufficient evidence", window: window && { onsetH: window.onsetH, meanH: window.meanH, tailH: window.tailH } };
}

export const rcaSummary = (r) => [
  `${r.verdict}.${r.why ? ` ${r.why}.` : ""}`,
  ...r.causes.map((c, i) => `${i + 1}. ${c.label}: ${c.kind}, weight ${c.weight}.`),
  ...r.rejected.map((x) => `Rejected: ${x.label}: ${x.reason}.`)
].join("\n");

// After a corrective action: compare the symptom sensor over the window with its pre-onset baseline.
export function outcomeOf(ctx, { reportId, actionAt, windowH = 24 }) {
  const d = ctx.get(reportId), sym = d && d.data && d.data.symptom;
  if (!sym || !sym.sensorId || !sym.onsetAt) return "Insufficient evidence";
  const s = seriesTo(ctx, sym.sensorId, plus(actionAt, windowH * 60), 1e6);
  if (!s) return "Insufficient evidence";
  const at = (iso) => minutesBetween(s.t0, iso), on = at(sym.onsetAt), act = at(actionAt);
  const before = s.values.slice(Math.max(0, on - 360), on), after = s.values.slice(act + 1);
  if (!before.length || !after.length || act < 0 || act >= s.values.length) return "Insufficient evidence";
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  // d0: the worst the symptom got between its onset and the action; d1: where it settled at the end of the window
  const base = med(before), tol = 0.25 * (Math.abs(base) || 1), d1 = Math.abs(med(after.slice(-60)) - base);
  const d0 = Math.max(...s.values.slice(on, act + 1).map((v) => Math.abs(v - base)));
  return d1 <= tol ? "Effective" : d1 <= d0 / 2 ? "Partially effective" : "Ineffective";
}
