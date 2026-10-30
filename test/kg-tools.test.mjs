// KG tools over the memory backend: clearance pruning, citations, the cypher gate and the no-REST rule.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { createKgTools, toolsFor } from "../src/kg/tools.mjs";
import { createMemoryBackend } from "../src/kg/backend-memory.mjs";
import { lintCypher } from "../src/kg/cypher-lint.mjs";

const sys = createSystem({ seed: 7 });
const crosswalk = JSON.parse(readFileSync(new URL("../data/crosswalk.json", import.meta.url), "utf8"));
const backend = createMemoryBackend(sys);
const tools = createKgTools({ backend, ont: sys.ont, tel: sys.tel, crosswalk });
const run = (name, input, viewer, ts = tools) => ts.find((t) => t.name === name).run(input, viewer);
const as = (clearance) => ({ id: sys.ont.list("Person", (p) => p.clearance === clearance)[0].id, clearance });
const tech = as("technician"), sup = as("supervisor"), mgr = as("manager");
const CLB = "PM-RB-A:STR-16UHC01"; // the chlorine house, zone Z06

let srv, base;
before(async () => {
  srv = createServer(sys);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

test("technician cannot see Z06 (memory backend)", async () => {
  assert.deepEqual(await run("get", { id: CLB }, tech), { found: false });
  assert.deepEqual(await run("get", { id: "CLB-1" }, tech), { found: false });
  const techHits = (await run("search", { q: "chlor" }, tech)).items.map((i) => i.id);
  assert.ok(!techHits.includes(CLB) && techHits.length > 0);
  const got = await run("get", { id: CLB }, sup);
  assert.equal(got.found, true);
  assert.equal(got.item.cite, CLB);
  assert.equal((await run("get", { id: "CLB-1" }, sup)).item.id, CLB, "a crosswalk canonical name resolves");
  const supHits = (await run("search", { q: "chlor" }, sup)).items;
  assert.ok(supHits.some((i) => i.id === CLB && i.cite === CLB));
  assert.deepEqual(await run("neighbors", { id: CLB }, tech), { found: false, items: [] });
  assert.deepEqual(await run("readings", { sensorId: "SEN-FIN-cl", from: sys.tel.start, to: sys.tel.end }, tech), { found: false });
});

test("cypher is manager only and linted", async () => {
  delete process.env.WWOS_KG_CYPHER;
  assert.ok(!createKgTools({ backend, ont: sys.ont, tel: sys.tel, crosswalk }).some((t) => t.name === "cypher"), "off by default");
  process.env.WWOS_KG_CYPHER = "1";
  const ts = createKgTools({ backend, ont: sys.ont, tel: sys.tel, crosswalk });
  delete process.env.WWOS_KG_CYPHER;
  assert.ok(!toolsFor(ts, sup).some((t) => t.name === "cypher"));
  assert.equal(toolsFor(ts, mgr).find((t) => t.name === "cypher").minClearance, "manager");
  assert.equal((await run("cypher", { query: "MATCH (n) RETURN n.wosId" }, sup, ts)).ok, false, "run refuses below manager too");
  const far = await run("cypher", { query: "MATCH (p)-[:feeds*]->(f:Filter) RETURN f" }, mgr, ts);
  assert.equal(far.ok, false);
  assert.match(far.errors.join("\n"), /move the label to WHERE x:Label/);
  const del = await run("cypher", { query: "MATCH (n) DETACH DELETE n" }, mgr, ts);
  assert.equal(del.ok, false);
  assert.match(del.errors.join("\n"), /DELETE.*read-only/);
  assert.deepEqual(lintCypher("MATCH (r)<-[:feeds*]-(u) WHERE u:Filter RETURN u.wosId"), { ok: true, errors: [] });
  assert.equal(lintCypher("MATCH (n) WHERE n.Label = 'CREATE SET' RETURN n.wosId").ok, true, "keywords inside a string literal pass");
  assert.match(lintCypher("MATCH (n:Pump {Label: 'P-1'}) RETURN n").errors.join(), /use WHERE/);
  for (const w of ["CREATE (n)", "MERGE (n)", "MATCH (n) SET n.x = 1", "MATCH (n) REMOVE n.x", "DROP INDEX i", "CALL db.labels()", "LOAD CSV FROM 'f' AS r RETURN r"]) assert.equal(lintCypher(w).ok, false, w);
});

test("retired and invented ids", async () => {
  const f12 = await run("get", { id: "F12" }, mgr);
  assert.equal(f12.found, false);
  assert.equal(f12.retired, true);
  assert.ok(f12.ids.includes("POS-F12"));
  assert.deepEqual(await run("get", { id: "PMP-999" }, mgr), { found: false });
});

test("upstream and downstream of F07 (and of 20UBA02, past the Z06 dose) match the existing route", async () => {
  const byId = (xs) => xs.map(({ id, share, recycle }) => ({ id, share, recycle: !!recycle })).sort((a, b) => a.id.localeCompare(b.id));
  for (const [routeId, toolId] of [["POS-F07", "F07"], ["PM-RB-A:STR-20UBA02", "PM-RB-A:STR-20UBA02"]]) for (const v of [tech, mgr]) for (const dir of ["upstream", "downstream"]) {
    const route = await (await fetch(`${base}/api/plant/graph/${dir}/${encodeURIComponent(routeId)}`, { headers: { "x-acting-user": v.id } })).json();
    const tool = await run(dir, { id: toolId }, v);
    assert.deepEqual(byId(tool.items), byId(route.items), `${dir} of ${toolId} as ${v.clearance}`);
    assert.ok(tool.items.every((i) => i.cite === i.id));
  }
  const up = async (v) => (await run("upstream", { id: "PM-RB-A:STR-20UBA02" }, v)).items.map((i) => i.id);
  assert.ok(!(await up(tech)).includes(CLB) && (await up(mgr)).includes(CLB), "the technician's walk never reaches the chlorine house");
  const down = await run("downstream", { id: "POS-F07" }, mgr);
  assert.ok(down.items.some((i) => i.window && i.window.meanH > 0), "travel windows on reachable items");
});

test("documents cite chunks; read returns one passage; chunkless documents fall back to procedure steps", async () => {
  const hits = (await run("documents", { q: "Filtration" }, tech)).items;
  const c05 = hits.find((i) => i.id === "DOC-DESIGN-BASIS#c05");
  assert.equal(c05.cite, "DOC-DESIGN-BASIS#c05");
  assert.equal(hits[0].id, "DOC-DESIGN-BASIS#c05", "a heading match ranks first");
  assert.ok((await run("documents", { aboutId: "F07" }, tech)).items.some((i) => i.id === "DOC-DESIGN-BASIS#c05"));
  const passage = await run("read", { chunkId: "DOC-DESIGN-BASIS#c05" }, tech);
  assert.match(passage.text, /Eight rapid gravity filters/);
  assert.equal(passage.cite, "DOC-DESIGN-BASIS#c05");
  const steps = (await run("documents", { aboutId: "DOC-SOP-BLOWER" }, tech)).items;
  assert.ok(steps.length > 0 && steps.every((s) => /^PRC-BLOWER-v3#PRC-BLOWER-v3-S\d+$/.test(s.cite)));
  assert.match((await run("read", { chunkId: steps[0].cite }, tech)).text, /\w/);
});

test("readings: summary and raw over the telemetry window, cited by sensor and window", async () => {
  const from = sys.tel.start, to = new Date(Date.parse(from) + 3600e3).toISOString();
  const sum = await run("readings", { sensorId: "AIT-157", from, to }, tech);
  const series = sys.tel.series("SEN-F07-turb", from, to);
  assert.equal(sum.n, series.length);
  assert.equal(sum.first, series[0].v);
  assert.equal(sum.last, series.at(-1).v);
  assert.equal(sum.cite, `SEN-F07-turb@${from}..${to}`);
  for (const k of ["min", "max", "mean", "slopePerH"]) assert.ok(Number.isFinite(sum[k]), k);
  assert.ok("firstAboveAlarmAt" in sum);
  const raw = await run("readings", { sensorId: "SEN-F07-turb", from, to, agg: "raw" }, tech);
  assert.equal(raw.points.length, series.length);
});

test("locate: own geometry, the position's, or the sensor anchor; [] when none", async () => {
  const f07 = (await run("locate", { id: "F07" }, tech)).items.map((i) => i.id);
  assert.ok(f07.includes("GEO-F07_Sand"));
  assert.deepEqual((await run("locate", { id: "PM-RB-A:STR-15HFA07" }, tech)).items.map((i) => i.id), f07, "a structure reaches its position's meshes");
  assert.deepEqual((await run("locate", { id: "SEN-F07-turb" }, tech)).items.map((i) => i.cite), ["GEO-F07_Sand"]);
  assert.deepEqual((await run("locate", { id: CLB }, tech)).items, []);
  assert.deepEqual((await run("locate", { id: "PMP-999" }, tech)).items, []);
});

test("events read alerts, work orders and samples only", async () => {
  const all = (await run("events", { kinds: ["Alert", "WorkOrder", "Sample", "Person"] }, mgr)).items;
  assert.ok(all.length > 0 && all.every((e) => ["Alert", "WorkOrder", "Sample"].includes(e.type) && e.cite === e.id));
  assert.deepEqual(await run("events", { scope: "Z06" }, tech), { found: false, items: [] });
  const z11 = (await run("events", { scope: "Z11", kinds: ["Sample"], from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" }, tech)).items;
  assert.ok(z11.length > 0 && z11.every((s) => s.zoneId === "Z11" && s.at < "2026-10-02"));
});

test("people never touches the backend", async () => {
  const calls = [];
  const spy = new Proxy(backend, { get: (t, k) => (...a) => (calls.push(k), t[k](...a)) });
  const ts = createKgTools({ backend: spy, ont: sys.ont, tel: sys.tel, crosswalk });
  const r = await run("people", { zoneId: "Z11" }, tech, ts);
  assert.ok(r.presence.length > 0 && r.presence.every((p) => p.zoneId === "Z11" && p.cite === p.id));
  const named = await run("people", { q: sys.ont.get(tech.id).name }, tech, ts);
  assert.deepEqual(Object.keys(named.people[0]).sort(), ["cite", "id", "name", "role"]);
  assert.deepEqual(calls, []);
});

test("agents never import REST", () => {
  const dir = new URL("../src/kg/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => new URL(f, dir));
  const mcp = new URL("../src/mcp-server.mjs", import.meta.url);
  if (existsSync(mcp)) files.push(mcp);
  assert.ok(files.length >= 4);
  for (const f of files) {
    const imports = readFileSync(f, "utf8").split("\n").filter((l) => /^\s*(import|export)\b|import\s*\(/.test(l));
    assert.ok(!imports.some((l) => /timebase\/rest\.mjs/.test(l)), `${f.pathname} imports the REST client`);
  }
});
