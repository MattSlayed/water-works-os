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
import { currentProcedure } from "./functions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "..", "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const SYSTEM_USER = { id: "SYSTEM", kind: "person", clearance: "manager", role: "system" };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export function createServer(sys) {
  const { ont, tel, actions, runtime, copilot, audit } = sys;
  const clients = new Map(); // response -> viewer
  const muster = { on: false, since: null, checkins: new Set() };
  // Each client hears only about objects it may see.
  const broadcast = (e) => {
    for (const [c, v] of clients) {
      const ref = e.partId || (String(e.kind).startsWith("ontology.") ? e.id : null);
      if (ref && !ont.view(v).get(ref)) continue;
      c.write(`data: ${JSON.stringify(e)}\n\n`);
    }
  };
  ont.on((e) => broadcast({ ...e, kind: `ontology.${e.kind}` }));
  copilot.on((e) => broadcast(e));

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
    const zones = view.list("Zone").map((z) => {
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
    return { site: ont.get("SITE-RB"), zones, muster: { on: muster.on, since: muster.since, people }, permits: view.list("Permit", (p) => p.state === "open") };
  }

  function objectPayload(v, id) {
    const view = ont.view(v);
    const o = view.get(id);
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

  const routes = [
    ["GET", /^\/api\/me$/, (v) => v],
    ["GET", /^\/api\/people$/, () => ont.list("Person").map((p) => ({ id: p.id, name: p.name, role: p.role, clearance: p.clearance }))],
    ["GET", /^\/api\/console$/, (v) => consolePayload(v)],
    ["GET", /^\/api\/map$/, (v) => mapPayload(v)],
    ["GET", /^\/api\/objects$/, (v, m, url) => { const view = ont.view(v); const q = url.searchParams.get("q"); const type = url.searchParams.get("type"); return (q ? view.search(q, 50) : view.list(type || null)).filter((o) => !type || o.type === type).slice(0, 500); }],
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
      const r = actions.invoke({ action: decodeURIComponent(m[1]), params: b.params || {}, actor: v });
      if (r.status === "refused") throw new HttpError(400, r.reason);
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
    ["GET", /^\/api\/evals\/([^/]+)$/, (v, m) => runEvals(() => createSystem({ seed: sys.seed }), decodeURIComponent(m[1]))],
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
    ["POST", /^\/api\/clock\/tick$/, async (v, m, url, req) => { const b = await body(req); tick(Math.max(1, Math.min(1440, Number(b.minutes) || 15))); return { clock: tel.now() }; }]
  ];

  // Plant clock: scheduled agents run every 15 plant minutes, as the system user.
  let since = 0;
  function tick(minutes) {
    tel.tick(minutes);
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
  for (const a of ["Shift Handover", "Process Watch", "Asset Watch", "Permit Guard", "Shift Cover", "Drop Pack"]) sys.runtime.run(a, { actingUser: SYSTEM_USER, trigger: { kind: "startup" } });
  setInterval(() => server.tick(1), 2000).unref();
  server.listen(port, "127.0.0.1", () => console.log(`Water Works OS on http://localhost:${port}  (plant clock ${sys.tel.now()}, Claude ${llmEnabled() ? "on" : "off: deterministic agents"})`));
}
