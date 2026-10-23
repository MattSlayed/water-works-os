// Read models for the Region view (Region design §6, §9): capacity and supply, since-you-left, risks, focus, project panels.
import { STAGE_CAPACITY, DESIGN_ML_D } from "./region.mjs";
import { toLonLat } from "./layout.mjs";
import { within, projectStatus, graphFrom, downstreamOf } from "./functions.mjs";
import { pingState } from "./trackers.mjs";
import { baseline, bandOf } from "./scenes.mjs";
import { currentPlantModel } from "./plant.mjs";

const activeOn = (p, day) => p.start <= day && day <= p.end;

// Committed spend at a time: the last commitment on or before it.
export const spendAt = (p, iso) => (p.spend || []).filter((s) => s.at <= String(iso).slice(0, 10)).reduce((z, s) => s.zar, 0);

// Treatment capacity is the smallest stage capacity (the stages run in series), not a sum of losses.
export function treatmentCapacity(ont, isoDay) {
  const day = String(isoDay).slice(0, 10), byStage = { ...STAGE_CAPACITY };
  for (const p of ont.list("Project", (x) => activeOn(x, day))) {
    const c = p.capacityImpact;
    if (c && c.stage in byStage && Number.isFinite(c.capacityMlD)) byStage[c.stage] = Math.min(byStage[c.stage], c.capacityMlD);
  }
  const limiting = Object.keys(byStage).reduce((a, b) => (byStage[b] < byStage[a] ? b : a));
  const capacityMlD = Math.min(DESIGN_ML_D, byStage[limiting]);
  return { capacityMlD, byStage, limiting, outOfServiceMlD: DESIGN_ML_D - capacityMlD };
}

// Outbound effects (pumping, storage) count against supply, not treatment.
export function supplyImpacts(ont, isoDay) {
  const day = String(isoDay).slice(0, 10);
  return ont.list("Project", (p) => activeOn(p, day) && p.capacityImpact && ["storage", "supply"].includes(p.capacityImpact.stage))
    .map((p) => ({ projectId: p.id, text: p.capacityImpact.text, ...(p.capacityImpact.storagePct ? { storagePct: p.capacityImpact.storagePct } : {}) }));
}

// ---------- Region read models (Region design §6, §9). Every list goes through the viewer's view, so pruning holds. ----------
const DAY = 86400000;
const nameOf = (o) => (o && (o.name || o.title)) || null;
const inside = (o, poly) => Number.isFinite(o.lat) && within([o.lon, o.lat], poly);
const dataEndIso = (sys) => new Date(Date.parse("2026-10-01T00:00:00Z") + sys.trackers.dataEndMin * 60000).toISOString();
const auditIdOf = (sys, id) => { const e = sys.audit.all().find((x) => (x.objects || []).includes(id)); return e ? e.seq : null; };

function trackerView(sys, t) {
  return { id: t.id, kind: t.kind, name: t.name, projectId: t.projectId, boundTo: t.boundTo, lat: t.lat, lon: t.lon, zoneId: t.zoneId, pingAt: t.pingAt, speedKmh: t.speedKmh, headingDeg: t.headingDeg,
    batteryPct: t.batteryPct, eta: t.eta || null, state: t.state || null, runHours: t.runHours ?? null, fuelPct: t.fuelPct ?? null, signal: pingState(t.pingAt, sys.tel.now(), dataEndIso(sys)) };
}
// the latest usable Sentinel-2 scene at or before now, and the NDTI band of an area in it
function rawWaterBand(sys, view, aoi) {
  const scenes = view.list("Scene").sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt));
  const s = scenes.filter((x) => x.mission === "S2" && x.usable[aoi] && Date.parse(x.acquiredAt) + 3 * 3600000 <= Date.parse(sys.tel.now())).pop();
  if (!s) return { band: "unknown", sceneId: null };
  return { band: bandOf(s.stats[aoi].ndti.mean, baseline(scenes, aoi, "ndti", s.acquiredAt)), sceneId: s.id, value: s.stats[aoi].ndti.mean };
}
const WORST = ["unknown", "normal", "raised", "high"];

export function regionPayload(sys, v, { clipLine = (c) => [c], trails = [], live = null } = {}) {
  const view = sys.ont.view(v), now = sys.tel.now();
  const region = view.list("Region").map((r) => (r.geometry.type === "LineString" ? { ...r, geometry: { type: "MultiLineString", coordinates: clipLine(r.geometry.coordinates) } } : r));
  const sensorsOf = (id) => sys.tel.sensorsFor(id).filter((s) => view.get(s.id)).map((s) => ({ id: s.id, name: s.name, unit: s.unit, alarmLo: s.alarmLo ?? null, alarmHi: s.alarmHi ?? null, ...(sys.tel.latest(s.id) || {}) }));
  const trackers = view.list("Tracker").map((t) => trackerView(sys, t));
  const want = new Set(trails.filter((id) => view.get(id)));
  for (const t of trackers) if (want.has(t.id)) t.trail = sys.trackers.history(t.id, 6, sys.tel.cursor()).filter((p) => !p.zoneId || view.get(p.zoneId)).map((p) => [p.lon, p.lat]);
  const cutoff = Date.parse(now) - 60 * DAY;
  return {
    clock: now, dataEnd: dataEndIso(sys), disclosure: "Synthetic works: every place, scene and value here is synthetic. Satellite indices are indices, not calibrated.",
    works: { id: "SITE-RB", name: nameOf(sys.ont.get("SITE-RB")), centre: toLonLat([380, 90]) },
    region, zones: view.list("Zone", (z) => z.remote).map((z) => ({ id: z.id, name: z.name, clearance: z.clearance, geo: z.geo })),
    sites: view.list("RemoteSite").map((s) => ({ ...s, readings: sensorsOf(s.id) })),
    trackers,
    projects: view.list("Project").map((p) => ({ id: p.id, title: p.title, start: p.start, end: p.end, ownerId: p.ownerId, footprint: p.footprint, capacityImpact: p.capacityImpact,
      status: projectStatus(p, sys.ont.list("ProgressClaim"), view.list("Issue"), now) })),
    detections: view.list("GeoDetection"),
    alerts: view.list("Alert", (a) => a.state === "active" && (String(a.targetId || "").startsWith("GEO-") || ["Z13", "Z14", "Z15"].includes(a.zoneId))),
    scenes: view.list("Scene", (s) => s.inWindow || Date.parse(s.acquiredAt) >= cutoff).sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt))
      .map((s) => ({ id: s.id, mission: s.mission, acquiredAt: s.acquiredAt, cloudPct: s.cloudPct, usable: s.usable, inWindow: s.inWindow, processed: Date.parse(s.acquiredAt) + 3 * 3600000 <= Date.parse(now) })),
    live
  };
}

export function sinceYouLeft(sys, v, lastSeenIso) {
  const view = sys.ont.view(v), now = sys.tel.now(), after = (at) => at && at > lastSeenIso, items = [];
  for (const d of view.list("GeoDetection")) {
    const open = d.status === "suggested";
    if (open || after(d.at)) items.push({ kind: "detection", id: d.id, at: d.at, stillOpen: open, text: `${d.kind.replace("_", " ")} ${d.status} in the ${(nameOf(sys.ont.get(d.aoiId)) || d.aoiId).toLowerCase()} (${d.sceneId})` });
  }
  const events = view.list("GeofenceEvent").sort((a, b) => a.at.localeCompare(b.at));
  for (const e of events.filter((x) => x.kind === "left")) {
    const t = view.get(e.trackerId), area = sys.ont.get(e.regionId), poly = area && (area.footprint || area.geometry);
    const later = events.some((x) => x.trackerId === e.trackerId && x.regionId === e.regionId && x.at > e.at);
    const open = !later && !!t && !!poly && !inside(t, poly);
    if (t && (open || after(e.at))) items.push({ kind: "geofence", id: e.id, trackerId: t.id, at: e.at, stillOpen: open, text: `${t.name} left ${nameOf(area) || e.regionId}` });
  }
  for (const t of view.list("Tracker")) {
    const s = pingState(t.pingAt, now, dataEndIso(sys));
    if (s !== "live") items.push({ kind: "tracker", id: t.id, at: t.pingAt, stillOpen: true, text: `${t.name}: ${s}, last ping ${t.pingAt.slice(0, 16).replace("T", " ")}` });
  }
  for (const s of view.list("Sensor", (x) => String(x.processUnitId || "").startsWith("RS-"))) {
    const l = sys.tel.latest(s.id);
    if (l && ((s.alarmHi != null && l.value > s.alarmHi) || (s.alarmLo != null && l.value < s.alarmLo))) items.push({ kind: "site", id: s.processUnitId, at: l.at, stillOpen: true, text: `${s.name} ${l.value} ${s.unit}: out of range` });
  }
  const today = now.slice(0, 10);
  for (const p of view.list("Project")) {
    for (const m of (p.milestones || []).filter((x) => x.due < today && !x.claimedAt && !x.confirmedAt)) items.push({ kind: "project", id: p.id, at: `${m.due}T23:59:00Z`, stillOpen: true, text: `${p.title}: milestone "${m.title}" slipped (due ${m.due})` });
    for (const i of view.list("Issue", (x) => x.projectId === p.id && after(x.at))) items.push({ kind: "issue", id: i.id, projectId: p.id, at: i.at, stillOpen: !["done", "dropped"].includes(i.state), text: `${p.title}: new issue "${i.title}"` });
  }
  items.sort((a, b) => Number(b.stillOpen) - Number(a.stillOpen) || String(b.at).localeCompare(String(a.at)));
  return { since: lastSeenIso, items: items.slice(0, 8), more: Math.max(0, items.length - 8) };
}

export function supplyRisks(sys, v) {
  const view = sys.ont.view(v), now = sys.tel.now(), day = now.slice(0, 10);
  const inflow = rawWaterBand(sys, view, "AOI-INFLOW"), intake = rawWaterBand(sys, view, "AOI-INTAKE");
  const plumes = view.list("GeoDetection", (d) => d.kind === "plume" && d.status !== "rejected" && d.status !== "withdrawn");
  const raw = view.get("SEN-RAW-turb") ? sys.tel.latest("SEN-RAW-turb") : null;
  let band = [inflow.band, intake.band].reduce((a, b) => (WORST.indexOf(b) > WORST.indexOf(a) ? b : a));
  if (plumes.length && WORST.indexOf(band) < WORST.indexOf("raised")) band = "raised";
  const cap = treatmentCapacity(sys.ont, day), demand = view.get("SEN-OUT-flow") ? sys.tel.latest("SEN-OUT-flow") : null;
  const impacts = supplyImpacts(sys.ont, day);
  const sites = view.list("RemoteSite", (s) => s.kind === "reservoir").map((s) => {
    const k = s.id.slice(3), lv = sys.tel.latest(`SEN-${k}-level`), out = sys.tel.latest(`SEN-${k}-out`);
    const cut = impacts.find((x) => sys.ont.get(x.projectId).takesOutOfService.some((t) => t.id === s.id) && x.storagePct);
    const usableMl = s.capacityMl * (1 + (cut ? cut.storagePct : 0) / 100);
    const storageHours = lv && out && out.value ? Math.round((((lv.value / 100) * usableMl) / out.value) * 24 * 10) / 10 : null;
    return { id: s.id, name: s.name, levelPct: lv && lv.value, outflowMlD: out && out.value, usableMl, storageHours, flagged: storageHours !== null && storageHours < 12, project: cut ? cut.projectId : null };
  });
  return {
    rawWater: { band, note: "index, not calibrated", inputs: [
      { name: "NDTI band, dam inflow arm", band: inflow.band, sceneId: inflow.sceneId }, { name: "NDTI band, intake approach", band: intake.band, sceneId: intake.sceneId },
      { name: "Raw-water turbidity at the intake", value: raw && raw.value, unit: "NTU", at: raw && raw.at }, { name: "Open plume detections", value: plumes.map((d) => `${d.id} (${d.status})`) }] },
    capacity: { ...cap, demandMlD: demand && demand.value, inputs: view.list("Project", (p) => p.start <= day && day <= p.end && p.capacityImpact && Number.isFinite(p.capacityImpact.capacityMlD)).map((p) => ({ projectId: p.id, text: p.capacityImpact.text })) },
    storage: { sites, inputs: impacts, note: "Hours of storage at today's outflow; flagged under 12 h." }
  };
}

export function focusOf(sys, v, kind, id) {
  const view = sys.ont.view(v), o = view.get(id);
  if (!o) return null;
  const ids = new Set([id]), trackerIds = new Set(), zoneIds = new Set();
  const add = (x) => { if (x && view.get(x)) ids.add(x); };
  const track = (t) => { if (t && view.get(t)) trackerIds.add(t); };
  if (kind === "project") {
    for (const t of o.takesOutOfService || []) add(t.id);
    for (const a of o.assetIds || []) add(a);
    for (const t of view.list("Tracker", (x) => x.projectId === o.id || inside(x, o.footprint))) track(t.id);
    for (const i of view.list("Issue", (x) => x.projectId === o.id && !["done", "dropped"].includes(x.state))) add(i.id);
    for (const p of view.list("Permit", (x) => x.state === "open" && (o.assetIds || []).includes(x.assetId))) add(p.id);
  } else if (kind === "detection") {
    add(o.aoiId); add("INT-RB"); add(o.sceneId);
    track("TRK-BOAT");
    for (const w of view.list("WorkOrder", (x) => x.source === o.id)) { add(w.id); for (const e of view.list("Execution", (x) => x.workOrderId === w.id)) add(e.id); }
    const chems = new Set([...view.list("DoseChange", (x) => x.detectionId === o.id), ...view.list("Proposal", (x) => x.params && x.params.detectionId === o.id)].map((x) => x.chemicalId || (x.params && x.params.chemicalId)).filter(Boolean));
    for (const c of chems) { add(c); for (const t of view.list("Tracker", (x) => x.boundTo === c)) track(t.id); }
    for (const a of view.list("Alert", (x) => x.targetId === o.id)) add(a.id);
    // alerts downstream of the intake raised since the detection: what the plume reaches inside the works
    const m = currentPlantModel(sys.ont);
    if (m) {
      const g = graphFrom(sys.ont.list(null, (x) => x.modelId === m.id && view.get(x.id))), start = `${m.id}:STR-10UPA01`;
      const down = new Set(g.nodes.has(start) ? downstreamOf(start, g).map((x) => x.id) : []);
      for (const a of view.list("Alert", (x) => x.state === "active" && x.assetId && x.at >= o.at)) {
        const pos = (sys.ont.get(a.assetId) || {}).positionId;
        if (pos && down.has(g.alias.get(pos) || pos)) add(a.id);
      }
    }
  } else if (kind === "alert") {
    add(o.targetId); add(o.assetId);
    for (const w of view.list("WorkOrder", (x) => x.source === o.id)) add(w.id);
  } else if (kind === "workorder") {
    add(o.assetId);
    for (const e of view.list("Execution", (x) => x.workOrderId === o.id)) add(e.id);
  }
  for (const x of ids) { const z = sys.ont.zoneOf(x); if (z && view.get(z)) zoneIds.add(z); }
  for (const t of trackerIds) { const z = view.get(t).zoneId; if (z && view.get(z)) zoneIds.add(z); }
  return { kind, id, ids: [...ids], trackerIds: [...trackerIds], zoneIds: [...zoneIds] };
}

export function projectPanel(sys, v, id) {
  const view = sys.ont.view(v), p = view.get(id), now = sys.tel.now();
  if (!p || p.type !== "Project") return null;
  const day = now.slice(0, 10), claims = sys.ont.list("ProgressClaim", (c) => c.projectId === p.id).sort((a, b) => a.at.localeCompare(b.at));
  const status = projectStatus(p, sys.ont.list("ProgressClaim"), view.list("Issue"), now), last = claims.pop();
  const active = p.start <= day && day <= p.end, c = p.capacityImpact || {};
  const cap = treatmentCapacity(sys.ont, day);
  const line = !active ? `Not running today (${p.start} to ${p.end}).`
    : c.capacityMlD ? `Treatment capacity today ${cap.capacityMlD} ML/d (limited by ${cap.limiting}); this project holds ${c.stage} to ${c.capacityMlD} ML/d.`
    : c.stage === "storage" || c.stage === "supply" ? `Counts against supply and storage, not treatment.` : "No capacity effect.";
  return {
    id: p.id, title: p.title, ownerId: p.ownerId, start: p.start, end: p.end,
    footprint: { polygon: p.footprint, trackers: view.list("Tracker", (t) => inside(t, p.footprint)).map((t) => trackerView(sys, t)), permits: view.list("Permit", (x) => x.state === "open" && (p.assetIds || []).includes(x.assetId)) },
    progress: { status, spendZar: spendAt(p, now), budgetZar: p.budgetZar, lastReport: last ? { at: last.at, text: last.text, by: last.by } : null },
    impact: { text: c.text || null, active, outOfService: (p.takesOutOfService || []).map((t) => ({ ...t, name: nameOf(sys.ont.get(t.id)) || t.id })), supplyRisk: line },
    issues: [
      ...view.list("Issue", (i) => i.projectId === p.id && !["done", "dropped"].includes(i.state)).map((i) => ({ kind: "issue", id: i.id, text: i.title, at: i.at, auditId: auditIdOf(sys, i.id) })),
      ...(p.milestones || []).filter((m) => status.overdue.includes(m.id)).map((m) => ({ kind: "milestone", id: m.id, text: `${m.title} overdue (due ${m.due})`, at: m.due, auditId: null })),
      ...view.list("GeofenceEvent", (e) => e.regionId === p.id).map((e) => ({ kind: "geofence", id: e.id, text: `${(view.get(e.trackerId) || {}).name || e.trackerId} ${e.kind} the site`, at: e.at, auditId: auditIdOf(sys, e.id) }))
    ]
  };
}
