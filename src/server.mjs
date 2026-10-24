// HTTP API, server-sent events and static web for Water Works OS.
// Usage: node src/server.mjs [port]  (default 8830). Every response is pruned to the acting person (x-acting-user).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSystem } from "./system.mjs";
import { dropPackEvidence } from "./agents.mjs";
import { runEvals } from "./evals.mjs";
import { rank } from "./ontology.mjs";
import { llmEnabled } from "./llm.mjs";
import { dueStudioAgents } from "./studio.mjs";
import { currentProcedure, performanceFor, projectStatus, graphFrom, upstreamOf, downstreamOf, processPaths, travelWindow } from "./functions.mjs";
import { currentPlantModel } from "./plant.mjs";
import { siteBounds, toLocal, toLonLat } from "./layout.mjs";
import { regionPayload, sinceYouLeft, supplyRisks, focusOf, projectPanel } from "./regionview.mjs";
import { sceneGrid } from "./scenes.mjs";
import { liveStats } from "./geolive.mjs";
import { applyTimeouts, matchShadow, specFor, statementSentences, shadowRecord, promotionGap, MODES } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "..", "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const SYSTEM_USER = { id: "SYSTEM", kind: "person", clearance: "manager", role: "system" };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export const disclosureFor = (rev) => `Generated from plant model rev ${rev} (drawing set RB-DS rev ${rev}). Template geometry, not survey or CAD. Synthetic works.`;
// Liang–Barsky: the parameter range [t0, t1] of segment a→b inside rect [x, y, w, h], or null.
function segInside(a, b, [rx, ry, w, h]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0] - rx], [dx, rx + w - a[0]], [-dy, a[1] - ry], [dy, ry + h - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return t1 > t0 ? [t0, t1] : null;
}
// The visible parts of a polyline [[x, y, z]...] after cutting out every hidden rect; z is interpolated at the cut.
export function clipPath(path, rects) {
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  let parts = [path];
  for (const r of rects) parts = parts.flatMap((pts) => {
    const out = [];
    let cur = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], cut = segInside(a, b, r);
      if (!cut) { if (!cur.length) cur.push(a); cur.push(b); continue; }
      if (cut[0] > 0) { if (!cur.length) cur.push(a); cur.push(lerp(a, b, cut[0])); }
      if (cur.length >= 2) out.push(cur);
      cur = cut[1] < 1 ? [lerp(a, b, cut[1]), b] : [];
    }
    if (cur.length >= 2) out.push(cur);
    return out;
  });
  return parts.filter((p) => p.length >= 2);
}

export function createServer(sys) {
  const { ont, tel, actions, runtime, copilot, audit, channels } = sys;
  const workforce = () => [ont.list("Execution"), ont.list("Procedure"), ont.list("Issue"), ont.list("KnowledgeNote")];
  const clients = new Map(); // response -> viewer
  const muster = { on: false, since: null, checkins: new Set() };
  // Each client hears only about objects it may see.
  const broadcast = (e) => {
    for (const [c, v] of clients) {
      const ref = e.partId || (String(e.kind).startsWith("ontology.") || e.kind === "message" ? e.id : null);
      if (ref && !ont.view(v).get(ref)) continue;
      if (e.kind === "ontology.link" && e.to && !ont.view(v).get(e.to)) continue; // the far end of a link may be hidden too
      c.write(`data: ${JSON.stringify(e)}\n\n`);
    }
  };
  ont.on((e) => broadcast({ ...e, kind: `ontology.${e.kind}` }));
  copilot.on((e) => broadcast(e));
  channels.on((e) => broadcast(e));

  const viewerOf = (req, url) => {
    const id = req.headers["x-acting-user"] || url.searchParams.get("as");
    const p = id && ont.get(id);
    if (!p || p.type !== "Person") throw new HttpError(401, "unknown acting user");
    return { id: p.id, kind: "person", role: p.role, clearance: p.clearance, name: p.name };
  };
  const body = (req) => new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) { reject(new HttpError(413, "body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, "malformed JSON")); } });
    req.on("error", reject);
  });
  const latest = (s) => ({ id: s.id, name: s.name, unit: s.unit, ...(tel.latest(s.id) || {}), alarmHi: s.alarmHi ?? null, alarmLo: s.alarmLo ?? null });
  const brief = (o) => o && { id: o.id, type: o.type, name: o.name || o.title || o.tag || o.id };
  const ctxFor = (v) => {
    const view = ont.view(v);
    const today = tel.now().slice(0, 10);
    return { now: tel.now(), today, get: view.get, list: view.list };
  };

  function consolePayload(v) {
    const view = ont.view(v);
    const train = view.list("ProcessUnit").sort((a, b) => a.order - b.order).map((pu) => ({
      id: pu.id, stage: pu.stage, name: pu.name, zoneId: pu.zoneId,
      values: tel.sensorsFor(pu.id).filter((s) => view.get(s.id)).map(latest),
      assets: view.list("Position", (p) => p.stage === pu.stage).map((p) => { const a = view.list("Asset", (x) => x.positionId === p.id)[0]; return a && { id: a.id, tag: a.positionTag, state: a.state }; }).filter(Boolean),
      alerts: view.list("Alert", (a) => a.state === "active" && (ont.get(a.assetId) || {}).positionId && view.get(ont.get(a.assetId).positionId) && view.get(ont.get(a.assetId).positionId).stage === pu.stage).length
    }));
    const people = {};
    for (const pr of view.list("Presence")) {
      const p = ont.get(pr.personId);
      const z = (people[pr.zoneId] ||= { count: 0, roles: {} });
      z.count++;
      z.roles[p.role] = (z.roles[p.role] || 0) + 1;
    }
    return {
      clock: tel.now(), llm: llmEnabled(), muster: muster.on,
      train,
      alerts: view.list("Alert", (a) => a.state === "active").sort((a, b) => (b.score || 0) - (a.score || 0)),
      proposals: view.list("Proposal", (p) => p.state === "open"),
      runs: runtime.runs().filter((r) => view.get(r.id)).slice(-15).reverse().map((r) => ({ id: r.id, agent: r.agent, status: r.status, plantTime: r.plantTime, outputs: r.outputs.length, refusals: r.refusals.length, reasoning: r.reasoning.slice(0, 2) })),
      people,
      chemicals: view.list("Chemical"),
      workOrders: view.list("WorkOrder", (w) => !["closed", "cancelled"].includes(w.state)),
      drafts: view.list("Draft").slice(-10).reverse()
    };
  }

  function mapPayload(v) {
    const view = ont.view(v);
    const zones = view.list("Zone", (z) => !z.remote).map((z) => {
      const [x, y, w, h] = z.rect;
      const positions = view.list("Position", (p) => p.zoneId === z.id);
      const cols = Math.max(1, Math.ceil(Math.sqrt(positions.length * (w / h))));
      const assets = positions.map((p, i) => {
        const a = view.list("Asset", (x2) => x2.positionId === p.id)[0];
        const col = i % cols, row = Math.floor(i / cols), rows = Math.ceil(positions.length / cols);
        return { id: a ? a.id : p.id, positionId: p.id, tag: p.tag, name: p.name, state: a ? a.state : "empty", alert: a ? view.list("Alert", (al) => al.assetId === a.id && al.state === "active").length : 0, xy: [x + ((col + 0.5) * w) / cols, y + ((row + 0.5) * h) / rows] };
      });
      const presence = view.list("Presence", (p) => p.zoneId === z.id);
      return { id: z.id, name: z.name, hazard: z.hazard, clearance: z.clearance, rect: z.rect, assets, people: presence.length };
    });
    const people = muster.on ? view.list("Presence").map((pr) => {
      const p = ont.get(pr.personId);
      return { id: p.id, name: p.name, role: p.role, zoneId: pr.zoneId, checkedIn: muster.checkins.has(p.id) };
    }) : null;
    return { site: ont.get("SITE-RB"), bounds: siteBounds(), zones, muster: { on: muster.on, since: muster.since, people }, permits: view.list("Permit", (p) => p.state === "open") };
  }

  // ---------- Plant (design §5.5, §7): the current released model, pruned on the server ----------
  const hiddenZones = (v) => ont.list("Zone", (z) => rank(z.clearance) > rank(v.clearance));
  // a remote zone covers several yards, so it has rects (site metres) instead of one rect
  const hiddenRects = (v) => hiddenZones(v).flatMap((z) => z.rects || [z.rect]);
  const currentModel = () => { const m = currentPlantModel(ont); if (!m) throw new HttpError(404, "no released plant model"); return m; };
  const modelSummary = (m) => {
    const open = {};
    for (const c of m.cells) if (!c.reviewed) open[c.grade] = (open[c.grade] || 0) + 1;
    return { id: m.id, type: m.type, name: m.name, rev: m.rev, status: m.status, governs: m.governs, release: m.release, packageHash: m.packageHash, sources: m.sources, reviews: m.reviews, cells: m.cells.length, unreviewed: open, ingestedBy: m.ingestedBy || null, disclosure: disclosureFor(m.rev) };
  };
  function plantPayload(v) {
    const m = currentModel(), view = ont.view(v), rects = hiddenRects(v);
    const objs = ont.list(null, (o) => o.modelId === m.id), seen = (id) => !!(id && view.get(id));
    const of = (t) => objs.filter((o) => o.type === t && view.get(o.id));
    // Lines are cut at a hidden zone's edge rather than dropped whole; endpoints the viewer may not see are blanked.
    const lines = [];
    for (const l of objs.filter((o) => o.type === "Line")) {
      const parts = clipPath(l.path || [], rects);
      if (!parts.length) continue;
      const { path, zones, ...rest } = l, a = seen(l.fromId), b = seen(l.toId);
      lines.push({ ...rest, from: a ? l.from : null, fromId: a ? l.fromId : null, to: b ? l.to : null, toId: b ? l.toId : null, normalDirection: a && b ? l.normalDirection : null,
        injectionAt: l.injectionAt && seen(`${m.id}:STR-${l.injectionAt}`) ? l.injectionAt : null, zones: (zones || []).filter((z) => view.get(z)), parts });
    }
    const machines = of("MachinePlacement").map((p) => {
      const a = ont.list("Asset", (x) => x.positionId === p.positionId)[0];
      return { ...p, ...(a && view.get(a.id) ? { assetId: a.id, state: a.state, assetClass: a.assetClass, alerts: view.list("Alert", (al) => al.assetId === a.id && al.state === "active").length } : {}) };
    });
    return { model: { id: m.id, rev: m.rev, status: m.status, release: m.release, georef: m.georef, disclosure: disclosureFor(m.rev) }, structures: of("Structure"), machines, lines, valves: of("Valve"),
      samplePoints: of("SamplePoint").map((sp) => { const s = sp.sensorId && view.get(sp.sensorId); return { ...sp, reading: s ? latest(s) : null }; }), bounds: siteBounds() };
  }
  // One revision with its cells, less the cells of items in (or drawn through, or attached to) a hidden zone.
  function modelDetail(v, id) {
    const m = ont.get(id);
    if (!m || m.type !== "PlantModel") throw new HttpError(404, "not found");
    const hz = hiddenZones(v), ids = new Set(hz.map((z) => z.id)), rects = hiddenRects(v), hidden = new Set();
    for (const { tag, fields: f } of m.items) {
      const through = f.path && f.path.some((p, i) => i > 0 && rects.some((r) => segInside(f.path[i - 1], p, r)));
      if (ids.has(f.zoneId) || through || [f.from, f.to, f.at, f.structure, f.filter, f.injectionAt, f.instrument, f.measuredAt].some((t) => hidden.has(t))) hidden.add(tag);
    }
    return { ...modelSummary(m), cells: m.cells.filter((c) => !hidden.has(c.key.split("|")[0])) };
  }
  // Graph functions run over the viewer's pruned released model.
  function plantGraph(v) {
    const m = currentModel(), view = ont.view(v);
    return graphFrom(ont.list(null, (o) => o.modelId === m.id && view.get(o.id)));
  }
  const nodeOf = (g, id) => { const n = g.alias.get(id) || id; if (!id || !g.nodes.has(n)) throw new HttpError(404, "not found"); return n; };

  // A PlantModel's cells describe every zone; the generic routes give its summary only (cells come from /api/plant/models/:id, pruned).
  const shown = (o) => (o && o.type === "PlantModel" ? modelSummary(o) : o);
  function objectPayload(v, id) {
    const view = ont.view(v);
    const o = shown(view.get(id));
    if (!o) throw new HttpError(404, "not found");
    const links = view.links(id).map((l) => ({ rel: l.rel, dir: l.from === id ? "out" : "in", props: l.props || null, other: brief(view.get(l.from === id ? l.to : l.from)) }));
    const sensors = tel.sensorsFor(id).filter((s) => view.get(s.id)).map(latest);
    const runs = runtime.runs().filter((r) => r.read.includes(id)).slice(-10).map((r) => ({ id: r.id, agent: r.agent, plantTime: r.plantTime }));
    const related = {
      alerts: view.list("Alert", (a) => a.assetId === id || a.targetId === id),
      workOrders: view.list("WorkOrder", (w) => w.assetId === id),
      findings: view.list("Finding", (f) => f.assetId === id || f.partId === id),
      decisions: view.list("Decision", (d) => d.assetId === id || (d.objects || []).includes(id))
    };
    return { object: o, links, sensors, runs, related };
  }

  // ---------- Region (Region design §6, §9): pruned like the plant; lines are cut at hidden zones in site metres ----------
  const lastSeen = new Map(); // person -> ISO time of their last "Mark seen"; in memory like the rest of the state
  const seenOf = (v) => lastSeen.get(v.id) || new Date(Date.parse(tel.now()) - 86400000).toISOString();
  const clipLineFor = (v) => { const rects = hiddenRects(v); return (coords) => clipPath(coords.map(toLocal), rects).map((part) => part.map(toLonLat)); };
  let live = null; // GEO_LIVE=1: real statistics for a user-supplied area, fetched once at start
  if (process.env.GEO_LIVE === "1") {
    let aoi = null;
    try { aoi = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "geo", "live-aoi.geojson"), "utf8")); } catch (e) { live = { ok: false, reason: `live data unavailable: ${e.message}` }; }
    if (aoi) liveStats({ aoi }).then((r) => { live = r; broadcast({ kind: "region.live", ok: r.ok }); });
  }
  const notFound = (x) => { if (!x) throw new HttpError(404, "not found"); return x; };

  const routes = [
    ["GET", /^\/api\/region$/, (v, m, url) => regionPayload(sys, v, { clipLine: clipLineFor(v), trails: (url.searchParams.get("trails") || "").split(",").filter(Boolean), live })],
    ["GET", /^\/api\/region\/since$/, (v) => sinceYouLeft(sys, v, seenOf(v))],
    ["POST", /^\/api\/region\/since$/, (v) => { lastSeen.set(v.id, tel.now()); return { lastSeen: tel.now() }; }],
    ["GET", /^\/api\/region\/risks$/, (v) => supplyRisks(sys, v)],
    ["GET", /^\/api\/region\/focus\/(alert|workorder|project|detection)\/([^/]+)$/, (v, m) => notFound(focusOf(sys, v, m[1], decodeURIComponent(m[2])))],
    ["GET", /^\/api\/region\/scenes\/([^/]+)\/grid$/, (v, m, url) => {
      const view = ont.view(v), s = view.get(decodeURIComponent(m[1])), index = url.searchParams.get("index") || "ndti";
      const g = s && s.type === "Scene" ? sceneGrid(s, index, 60, view.list("Scene")) : null;
      if (!g) throw new HttpError(404, "no grid for that scene and index");
      return { sceneId: g.sceneId, index: g.index, cellM: g.cellM, cells: g.cells, bands: g.band, usable: g.usable, note: g.note };
    }],
    ["GET", /^\/api\/projects\/([^/]+)\/panel$/, (v, m) => notFound(projectPanel(sys, v, decodeURIComponent(m[1])))],
    ["GET", /^\/api\/me$/, (v) => ({ ...v, autoSubmit: !!ont.get(v.id).autoSubmit, supervisorId: ont.get(v.id).supervisorId || null })],
    ["GET", /^\/api\/people$/, () => ont.list("Person").map((p) => ({ id: p.id, name: p.name, role: p.role, clearance: p.clearance }))],
    ["GET", /^\/api\/console$/, (v) => consolePayload(v)],
    ["GET", /^\/api\/map$/, (v) => mapPayload(v)],
    ["GET", /^\/api\/plant$/, (v) => plantPayload(v)],
    ["GET", /^\/api\/plant\/models$/, () => ont.list("PlantModel").sort((a, b) => a.rev.localeCompare(b.rev)).map(modelSummary)],
    ["GET", /^\/api\/plant\/models\/([^/]+)$/, (v, m) => modelDetail(v, decodeURIComponent(m[1]))],
    ["POST", /^\/api\/plant\/ingest$/, async (v, m, url, req) => {
      if (rank(v.clearance) < rank("engineer")) throw new HttpError(403, "engineer clearance needed to ingest drawings");
      const b = await body(req);
      try { return modelSummary(sys.plant.ingest(Array.isArray(b.drawingIds) ? b.drawingIds : [], v)); } catch (e) { throw new HttpError(409, e.message); }
    }],
    ["GET", /^\/api\/plant\/graph\/(upstream|downstream)\/([^/]+)$/, (v, m, url) => {
      const g = plantGraph(v), id = nodeOf(g, decodeURIComponent(m[2])), mode = url.searchParams.get("mode") === "backwash" ? "backwash" : "normal";
      const items = (m[1] === "upstream" ? upstreamOf : downstreamOf)(id, g, { mode });
      // where the walk starts in the works: structures with no flow in and a main-stream flow out (not a recycle or a dose)
      const flowIn = (n) => (g.in.get(n) || []).some((e) => e.kind === "flow" && (mode === "backwash" || e.mode !== "intermittent"));
      const sources = items.filter((x) => !x.recycle && g.nodes.get(x.id)?.type === "Structure" && !flowIn(x.id) && (g.out.get(x.id) || []).some((e) => e.kind === "flow" && !e.recycle)).map((x) => x.id);
      return { id, mode, items, sources };
    }],
    ["GET", /^\/api\/plant\/graph\/paths$/, (v, m, url) => {
      const g = plantGraph(v), from = nodeOf(g, url.searchParams.get("from")), to = nodeOf(g, url.searchParams.get("to"));
      return { from, to, paths: processPaths(from, to, g) };
    }],
    ["GET", /^\/api\/plant\/graph\/window$/, (v, m, url) => {
      const g = plantGraph(v), from = nodeOf(g, url.searchParams.get("from")), to = nodeOf(g, url.searchParams.get("to"));
      const [path] = processPaths(from, to, g);
      if (!path) throw new HttpError(404, "no process path between them");
      const given = Number(url.searchParams.get("flow")), meas = (tel.latest("SEN-RAW-flow") || {}).value;
      const flowMlD = given || Math.round(meas * 10) / 10 || 120;
      return { path, flowMlD, measured: !given && !!meas, window: travelWindow(path, g, { flowMlD, lagMin: Number(url.searchParams.get("lag")) || 0 }) };
    }],
    ["GET", /^\/api\/objects$/, (v, m, url) => { const view = ont.view(v); const q = url.searchParams.get("q"); const type = url.searchParams.get("type"); return (q ? view.search(q, 50) : view.list(type || null)).filter((o) => !type || o.type === type).slice(0, 500).map(shown); }],
    ["GET", /^\/api\/objects\/([^/]+)$/, (v, m) => objectPayload(v, decodeURIComponent(m[1]))],
    ["GET", /^\/api\/schema$/, (v) => { const view = ont.view(v); const types = {}; for (const o of view.list()) types[o.type] = (types[o.type] || 0) + 1; return { types }; }],
    ["GET", /^\/api\/assets\/([^/]+)\/model$/, (v, m) => {
      const view = ont.view(v);
      const a = view.get(decodeURIComponent(m[1]));
      if (!a || a.type !== "Asset") throw new HttpError(404, "not found");
      return { asset: a, parts: view.list("Part", (p) => p.assetId === a.id), sensors: tel.sensorsFor(a.id).filter((s) => view.get(s.id)).map(latest), procedure: (currentProcedure(view.list("Procedure"), a.template) || { steps: [] }).steps, procedureId: (currentProcedure(view.list("Procedure"), a.template) || {}).id || null, findings: view.list("Finding", (f) => f.assetId === a.id) };
    }],
    ["GET", /^\/api\/telemetry\/([^/]+)$/, (v, m, url) => { const id = decodeURIComponent(m[1]); if (!ont.view(v).get(id)) throw new HttpError(404, "not found"); return { id, now: tel.now(), values: tel.history(id, Math.min(20160, Number(url.searchParams.get("n")) || 240)) }; }],
    ["GET", /^\/api\/agents$/, () => runtime.specs().map((s) => {
      const props = ont.list("Proposal", (p) => p.actorId === s.name);
      const decided = props.filter((p) => p.state !== "open");
      return { ...s, runs: runtime.runs().filter((r) => r.agent === s.name).length, proposals: props.length, acceptance: decided.length ? Math.round((decided.filter((p) => p.state === "approved").length / decided.length) * 100) : null };
    })],
    // the decision statement read back, with the shadow record against the promotion criteria (agents design §4)
    ["GET", /^\/api\/agents\/([^/]+)\/spec$/, (v, m) => {
      const spec = specFor(ont, decodeURIComponent(m[1]));
      if (!spec || !ont.view(v).get(spec.id)) throw new HttpError(404, "unknown agent");
      const i = MODES.indexOf(spec.mode);
      return { spec, sentences: statementSentences(spec, ont), shadow: shadowRecord(ont, spec.name), promotion: { criteria: spec.promotion, gap: promotionGap(ont, spec), next: MODES[i + 1] || null, previous: MODES[i - 1] || null } };
    }],
    // root cause for the viewer: the agent runs as the person asking, so the report holds only what they may see
    ["POST", /^\/api\/rca$/, async (v, m, url, req) => {
      const b = await body(req);
      if (!b.targetId || !ont.view(v).get(b.targetId)) throw new HttpError(404, "not found");
      const r = runtime.run("Root Cause", { actingUser: v, scope: { targetId: b.targetId }, chain: false, trigger: { kind: "console", by: v.id } });
      const out = r.outputs.find((o) => o.action === "draft_document" && o.status === "done");
      if (!out) throw new HttpError(400, (r.refusals[0] || {}).reason || r.error || "no report");
      return ont.view(v).get(ont.get(out.ref).objects[0]);
    }],
    ["GET", /^\/api\/rca\/([^/]+)$/, (v, m) => { const d = ont.view(v).get(decodeURIComponent(m[1])); if (!d || d.type !== "Draft" || d.kind !== "rca") throw new HttpError(404, "not found"); return d; }],
    ["POST", /^\/api\/agents\/([^/]+)\/run$/, async (v, m, url, req) => {
      const name = decodeURIComponent(m[1]);
      if (!runtime.spec(name)) throw new HttpError(404, "unknown agent");
      const b = await body(req);
      return runtime.run(name, { actingUser: v, mission: b.mission, scope: b.scope, chain: b.chain !== false, trigger: { kind: "console", by: v.id } });
    }],
    ["PUT", /^\/api\/agents\/([^/]+)\/autonomy$/, async (v, m, url, req) => {
      const name = decodeURIComponent(m[1]);
      if (!runtime.spec(name)) throw new HttpError(404, "unknown agent");
      if (rank(v.clearance) < rank("engineer")) throw new HttpError(403, "engineer clearance needed to change the autonomy dial");
      const b = await body(req);
      try { const s = runtime.setAutonomy(name, b.action, b.level); audit.append({ actor: v.id, actorKind: "person", action: "set_autonomy", ref: name, detail: `${b.action}=${b.level}` }); return s; } catch (e) { throw new HttpError(400, e.message); }
    }],
    ["GET", /^\/api\/runs$/, (v) => { const view = ont.view(v); return runtime.runs().filter((r) => view.get(r.id)).slice(-100).reverse(); }],
    ["GET", /^\/api\/runs\/([^/]+)$/, (v, m) => { const id = decodeURIComponent(m[1]); if (!ont.view(v).get(id) || !runtime.getRun(id)) throw new HttpError(404, "not found"); return runtime.getRun(id); }],
    ["GET", /^\/api\/proposals$/, (v, m, url) => ont.view(v).list("Proposal", (p) => !url.searchParams.get("state") || p.state === url.searchParams.get("state"))],
    ["POST", /^\/api\/proposals\/([^/]+)\/resolve$/, async (v, m, url, req) => {
      const id = decodeURIComponent(m[1]);
      if (!ont.view(v).get(id)) throw new HttpError(404, "not found");
      const b = await body(req);
      const r = actions.resolve(id, { verdict: b.verdict, params: b.params, reason: b.reason, by: v });
      if (r.status === "refused") throw new HttpError(/already/.test(r.reason) ? 409 : 400, r.reason);
      return r;
    }],
    ["POST", /^\/api\/actions\/([^/]+)$/, async (v, m, url, req) => {
      const b = await body(req);
      const action = decodeURIComponent(m[1]);
      const r = actions.invoke({ action, params: b.params || {}, actor: v });
      if (r.status === "refused") throw new HttpError(/ needs \w+ clearance$/.test(r.reason) ? 403 : 400, r.reason);
      if (action === "update_issue" && b.params.patch && b.params.patch.state === "done") runtime.run("Scribe", { actingUser: v, scope: { issueId: b.params.issueId }, trigger: { kind: "event", on: "issue done" } });
      return r;
    }],
    ["POST", /^\/api\/decisions\/([^/]+)\/reverse$/, (v, m) => { const r = actions.reverse(decodeURIComponent(m[1]), v); if (r.status === "refused") throw new HttpError(409, r.reason); return r; }],
    ["POST", /^\/api\/copilot\/open$/, async (v, m, url, req) => {
      const b = await body(req);
      try { const s = copilot.open({ ...b, user: v }); return { id: s.id, insight: s.insight }; } catch (e) { throw new HttpError(404, e.message); }
    }],
    ["POST", /^\/api\/copilot\/([^/]+)\/ask$/, async (v, m, url, req) => {
      const s = copilot.get(decodeURIComponent(m[1]));
      if (!s || s.user.id !== v.id) throw new HttpError(404, "session not found");
      return copilot.ask(s.id, (await body(req)).question);
    }],
    ["POST", /^\/api\/copilot\/([^/]+)\/tag$/, async (v, m, url, req) => {
      const s = copilot.get(decodeURIComponent(m[1]));
      if (!s || s.user.id !== v.id) throw new HttpError(404, "session not found");
      try { return copilot.tag({ sessionId: s.id, ...(await body(req)) }); } catch (e) { throw new HttpError(400, e.message); }
    }],
    ["GET", /^\/api\/evals\/([^/]+)$/, (v, m) => runEvals(() => createSystem({ seed: sys.seed }), decodeURIComponent(m[1]), ont)],
    ["GET", /^\/api\/knowledge$/, (v) => { const view = ont.view(v); return { findings: view.list("Finding"), feedback: view.list("Feedback") }; }],
    ["GET", /^\/api\/compliance$/, (v) => ({ items: dropPackEvidence(ctxFor(v)), submissions: ont.list("Submission") })],
    ["GET", /^\/api\/audit$/, (v) => { if (rank(v.clearance) < rank("supervisor")) throw new HttpError(403, "supervisor clearance needed for the audit log"); return { verified: audit.verify(), entries: audit.all().slice(-200).reverse() }; }],
    ["POST", /^\/api\/muster$/, async (v, m, url, req) => {
      if (rank(v.clearance) < rank("supervisor")) throw new HttpError(403, "supervisor clearance needed");
      const b = await body(req);
      muster.on = !!b.on; muster.since = muster.on ? tel.now() : null; muster.checkins.clear();
      audit.append({ actor: v.id, actorKind: "person", action: "muster", detail: muster.on ? "on" : "off" });
      broadcast({ kind: "muster", on: muster.on });
      return { on: muster.on };
    }],
    ["POST", /^\/api\/muster\/checkin$/, async (v, m, url, req) => { const b = await body(req); if (!ont.get(b.personId)) throw new HttpError(404, "not found"); muster.checkins.add(b.personId); broadcast({ kind: "muster.checkin", personId: b.personId }); return { ok: true }; }],
    ["POST", /^\/api\/clock\/tick$/, async (v, m, url, req) => { const b = await body(req); tick(Math.max(1, Math.min(1440, Number(b.minutes) || 15))); return { clock: tel.now() }; }],

    // ---- Workforce intelligence (Phase 2) ----
    ["PUT", /^\/api\/me\/consent$/, async (v, m, url, req) => {
      const b = await body(req);
      if (typeof b.autoSubmit !== "boolean") throw new HttpError(400, "autoSubmit must be true or false");
      ont.upsert({ id: v.id, type: "Person", autoSubmit: b.autoSubmit });
      audit.append({ actor: v.id, actorKind: "person", action: "consent", detail: `autoSubmit=${b.autoSubmit}` });
      return { autoSubmit: b.autoSubmit };
    }],
    ["GET", /^\/api\/channels$/, (v) => {
      const view = ont.view(v);
      return view.list("Channel").map((c) => {
        const msgs = view.list("Message", (x) => x.channelId === c.id);
        const last = msgs[msgs.length - 1];
        return { ...c, label: c.groupName || (ont.get(c.personId) || {}).name || c.id, last: last ? { text: last.text, at: last.at, direction: last.direction } : null, count: msgs.length };
      });
    }],
    ["GET", /^\/api\/channels\/([^/]+)\/messages$/, (v, m) => {
      const view = ont.view(v), id = decodeURIComponent(m[1]);
      if (!view.get(id)) throw new HttpError(404, "not found");
      return view.list("Message", (x) => x.channelId === id).map((x) => ({ ...x, fromName: (ont.get(x.from) || {}).name || (ont.get(x.from) || {}).label || x.from }));
    }],
    ["GET", /^\/api\/executions$/, (v, m, url) => { const pid = url.searchParams.get("personId"); return ont.view(v).list("Execution", (e) => !pid || e.personId === pid); }],
    ["GET", /^\/api\/issues$/, (v) => ont.view(v).list("Issue")],
    ["GET", /^\/api\/procedures$/, (v) => ont.view(v).list("Procedure").map(({ steps, ...p }) => ({ ...p, steps: steps.length, sourceBehind: !!(ont.get(p.documentId) || {}).sourceBehind, sourceRef: (ont.get(p.documentId) || {}).sourceRef || null }))],
    ["GET", /^\/api\/procedures\/([^/]+)$/, (v, m) => {
      const view = ont.view(v), id = decodeURIComponent(m[1]);
      const p = view.get(id);
      if (!p || p.type !== "Procedure") throw new HttpError(404, "not found");
      return {
        procedure: p, document: view.get(p.documentId), versions: view.list("Procedure", (x) => x.template === p.template).map(({ steps, ...x }) => x),
        notes: view.list("KnowledgeNote", (n) => n.procedureId === id), issues: view.list("Issue", (i) => i.procedureId === id),
        perf: rank(v.clearance) >= rank("engineer") ? performanceFor({ procedureId: id }, ...workforce()) : null
      };
    }],
    ["GET", /^\/api\/projects$/, (v) => { const view = ont.view(v); return view.list("Project").map((p) => ({ ...p, status: projectStatus(p, ont.list("ProgressClaim"), ont.list("Issue"), tel.now()) })); }],
    ["GET", /^\/api\/projects\/([^/]+)$/, (v, m) => {
      const view = ont.view(v), id = decodeURIComponent(m[1]);
      const p = view.get(id);
      if (!p || p.type !== "Project") throw new HttpError(404, "not found");
      return { project: p, status: projectStatus(p, ont.list("ProgressClaim"), ont.list("Issue"), tel.now()), claims: view.list("ProgressClaim", (c) => c.projectId === id), issues: view.list("Issue", (i) => i.projectId === id), channel: view.get(p.channelId) };
    }],
    ["GET", /^\/api\/performance\/person\/([^/]+)$/, (v, m) => {
      const id = decodeURIComponent(m[1]), p = ont.get(id);
      if (!p || p.type !== "Person") throw new HttpError(404, "not found");
      if (v.id !== id && v.id !== p.supervisorId && rank(v.clearance) < rank("engineer")) throw new HttpError(403, "only the person, their supervisor, engineers and the manager");
      return { person: { id: p.id, name: p.name, role: p.role }, ...performanceFor({ personId: id }, ...workforce()) };
    }],
    ["GET", /^\/api\/performance\/procedure\/([^/]+)$/, (v, m) => {
      if (rank(v.clearance) < rank("engineer")) throw new HttpError(403, "engineer clearance needed");
      const id = decodeURIComponent(m[1]);
      if ((ont.get(id) || {}).type !== "Procedure") throw new HttpError(404, "not found");
      return performanceFor({ procedureId: id }, ...workforce());
    }],
    // Crew rollup: per procedure, never per person.
    ["GET", /^\/api\/performance\/crew$/, (v) => {
      if (rank(v.clearance) < rank("supervisor")) throw new HttpError(403, "supervisor clearance needed");
      const w = workforce();
      return { procedures: ont.list("Procedure", (p) => p.state === "released").map((p) => { const f = performanceFor({ procedureId: p.id }, ...w); return { procedureId: p.id, title: p.title, version: p.version, executions: f.executions, firstTimeRight: f.firstTimeRight, issues: f.issuesRaised, notes: f.notesContributed, longSteps: f.steps.filter((s) => s.ratio >= 1.5).map((s) => ({ step: s.step, ratio: s.ratio })) }; }) };
    }],
  ];

  // Plant clock: scheduled agents run every 15 plant minutes, as the system user; Project Watch every plant hour
  // (it posts the weekly status from Friday 15:00), Procedure Steward each plant day (it notifies once a week).
  let since = 0, hour = tel.now().slice(0, 13), day = tel.now().slice(0, 10);
  // the Recommender, once each plant day, for each person as that person; its runs are theirs alone (agents design §9)
  const recommendAll = () => { for (const p of ont.list("Person")) runtime.run("Recommender", { actingUser: { id: p.id, kind: "person", clearance: p.clearance, role: p.role }, chain: false, audience: [p.id], trigger: { kind: "schedule" } }); };
  recommendAll();
  // a scene is processed 3 h after acquisition; Geo Watch runs when one becomes due (Region design §5.4)
  const dueScenes = () => ont.list("Scene", (s) => s.inWindow && Date.parse(s.acquiredAt) + 3 * 3600000 <= Date.parse(tel.now())).length;
  function tick(minutes) {
    const before = dueScenes(), last = tel.now();
    tel.tick(minutes);
    sys.trackers.syncTo(ont, tel.cursor(), audit); // pings and geofence events reach viewers as pruned ontology updates
    applyTimeouts(ont, tel.now()); // unanswered proposals are dropped or held, never applied (agents design §4.5)
    matchShadow(ont, tel.now()); // shadow actions against what people did (agents design §4.2)
    for (const name of dueStudioAgents(ont, tel.now(), last)) runtime.run(name, { actingUser: SYSTEM_USER, trigger: { kind: "schedule" } }); // as their builders
    if (dueScenes() > before) runtime.run("Geo Watch", { actingUser: SYSTEM_USER, trigger: { kind: "event", on: "Scene ingested" } });
    if (tel.now().slice(0, 13) !== hour) { hour = tel.now().slice(0, 13); runtime.run("Project Watch", { actingUser: SYSTEM_USER, trigger: { kind: "schedule" } }); }
    if (tel.now().slice(0, 10) !== day) { day = tel.now().slice(0, 10); runtime.run("Procedure Steward", { actingUser: SYSTEM_USER, trigger: { kind: "schedule" } }); recommendAll(); }
    since += minutes;
    if (since >= 15) {
      since = 0;
      for (const a of ["Process Watch", "Asset Watch", "Permit Guard"]) runtime.run(a, { actingUser: SYSTEM_USER, trigger: { kind: "schedule" } });
    }
    broadcast({ kind: "clock", clock: tel.now() });
  }

  function serveStatic(url, res) {
    let rel;
    try { rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname); } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("bad request");
    }
    const file = path.resolve(WEB, "." + rel);
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return serveStatic(url, res);
    try {
      // The chat stub's webhook: the sender is the channel member, not a console user.
      // shortcut: header-trusted sender, like x-acting-user; a real WhatsApp webhook verifies Meta's signature.
      const inbound = req.method === "POST" && url.pathname.match(/^\/api\/channels\/([^/]+)\/inbound$/);
      if (inbound) {
        const sender = req.headers["x-channel-sender"];
        if (!sender || !ont.get(sender)) throw new HttpError(401, "unknown sender");
        const b = await body(req);
        let out;
        try { out = await channels.inbound(decodeURIComponent(inbound[1]), sender, { text: b.text, media: b.media }); } catch (e) {
          throw new HttpError(/not a member/.test(e.message) ? 403 : /not found/.test(e.message) ? 404 : 400, e.message);
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(out));
      }
      if (url.pathname === "/api/events") {
        const sv = viewerOf(req, url);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ kind: "hello", clock: tel.now() })}\n\n`);
        clients.set(res, sv);
        req.on("close", () => clients.delete(res));
        return;
      }
      const route = routes.find(([mth, re]) => mth === req.method && re.test(url.pathname));
      if (!route) throw new HttpError(404, "no such route");
      const v = viewerOf(req, url);
      const out = await route[2](v, url.pathname.match(route[1]), url, req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out, (k, val) => (val === Infinity ? null : val)));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.tick = tick;
  return server;
}

// Run directly: start the server and advance the plant clock one minute every two seconds.
const SELF = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
  const port = Number(process.argv[2]) || 8830;
  const sys = createSystem({ seed: 7 });
  const server = createServer(sys);
  for (const a of ["Shift Handover", "Process Watch", "Asset Watch", "Permit Guard", "Shift Cover", "Drop Pack", "Project Watch", "Procedure Steward"]) sys.runtime.run(a, { actingUser: SYSTEM_USER, trigger: { kind: "startup" } });
  setInterval(() => server.tick(1), 2000).unref();
  server.listen(port, "127.0.0.1", () => console.log(`Water Works OS on http://localhost:${port}  (plant clock ${sys.tel.now()}, Claude ${llmEnabled() ? "on" : "off: deterministic agents"})`));
}
