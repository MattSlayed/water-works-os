// KG tools over the Atlas backend with fake Atlas and Historian MCP clients that return canned tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { createKgTools } from "../src/kg/tools.mjs";
import { createAtlasBackend } from "../src/kg/backend-atlas.mjs";
import { createMemoryBackend } from "../src/kg/backend-memory.mjs";

const sys = createSystem({ seed: 7 });
const crosswalk = JSON.parse(readFileSync(new URL("../data/crosswalk.json", import.meta.url), "utf8"));
const as = (clearance) => ({ id: sys.ont.list("Person", (p) => p.clearance === clearance)[0].id, clearance });
const tech = as("technician"), sup = as("supervisor"), mgr = as("manager");
const CLB = "PM-RB-A:STR-16UHC01";
const T = (n) => `urn:atlas:ontology:riverbend:${n}`;
const table = (columns, rows) => ({ content: [{ type: "text", text: JSON.stringify({ columns, rows }) }] });

// Canned Atlas: Atlas answers every zone to any token, like the real one.
const queries = [];
const atlas = {
  async callTool(name, args) {
    assert.equal(name, "ExecuteCypherQuery");
    assert.equal(args.domain, "riverbend");
    assert.equal(args.branch, "riverbend");
    queries.push(args.cypher);
    const q = args.cypher, p = args.parameters || {};
    if (/\[r:feeds\]/.test(q)) return table(["src", "dst", "kind", "lineId", "split", "mode", "recycle", "len", "pumped"],
      createMemoryBackend(sys).flowEdges().map((e) => [e.from, e.to, e.kind, e.lineId, e.split, e.mode, e.recycle, e.length, e.pumped]));
    if (/CONTAINS \$q/.test(q)) return table(["id", "type", "label"], [[CLB, [T("Structure")], "16UHC01"], ["POS-CHL-A", [T("Position")], "CHL-A"], ["PM-RB-A:LIN-RB-L-301", [T("Line")], "RB-L-301"]]);
    if (/properties\(n\)/.test(q)) return table(["id", "type", "label", "props"], p.id === CLB
      ? [[CLB, [T("Structure")], "16UHC01", { [T("wosId")]: CLB, [T("zone")]: "Z06", [T("kind")]: "chlorine_house", "@entity:Label": "16UHC01" }]] : []);
    if (/UNION/.test(q)) return table(["rel", "dir", "id"], [[T("hasZone"), "out", "Z05"], [T("hasZone"), "out", "Z06"], ["contains", "out", "PM-RB-A:STR-15UFB02"]]);
    return table(["id"], [[CLB], ["Z05"]]);
  }
};
const historianReplies = [];
const historian = {
  async callTool(name, args) {
    assert.equal(name, "GetDataForMultipleTags");
    historianReplies.push(args);
    return { content: [{ type: "text", text: historianText }] };
  }
};
let historianText = "";
const backend = createAtlasBackend({ atlas, historian });
const tools = createKgTools({ backend, ont: sys.ont, tel: sys.tel, crosswalk });
const run = (name, input, viewer, ts = tools) => ts.find((t) => t.name === name).run(input, viewer);

test("technician cannot see Z06 (Atlas backend)", async () => {
  assert.deepEqual(await run("get", { id: CLB }, tech), { found: false });
  const techHits = (await run("search", { q: "chlor" }, tech)).items.map((i) => i.id);
  assert.deepEqual(techHits, ["PM-RB-A:LIN-RB-L-301"]);
  const got = await run("get", { id: CLB }, sup);
  assert.equal(got.found, true);
  assert.deepEqual([got.item.id, got.item.type, got.item.zone, got.item.cite], [CLB, "Structure", "Z06", CLB]);
  assert.deepEqual((await run("search", { q: "chlor" }, sup)).items.map((i) => [i.id, i.type]), [[CLB, "Structure"], ["POS-CHL-A", "Position"], ["PM-RB-A:LIN-RB-L-301", "Line"]]);
  const zones = (await run("neighbors", { id: "SITE-RB", rel: "HAS_ZONE" }, tech)).items;
  assert.deepEqual(zones.map((z) => z.id), ["Z05"], "Z06 dropped, the contains row filtered by rel");
});

test("upstream over Atlas feeds equals upstream over memory, pruned the same way", async () => {
  const mem = createKgTools({ backend: createMemoryBackend(sys), ont: sys.ont, tel: sys.tel, crosswalk });
  for (const id of ["F07", "PM-RB-A:STR-20UBA02"]) for (const v of [tech, mgr]) for (const dir of ["upstream", "downstream"]) {
    const a = await run(dir, { id }, v), m = await run(dir, { id }, v, mem);
    assert.deepEqual(a.items.map((i) => i.id).sort(), m.items.map((i) => i.id).sort(), `${dir} of ${id} as ${v.clearance}`);
  }
  assert.ok(!(await run("upstream", { id: "PM-RB-A:STR-20UBA02" }, tech)).items.some((i) => i.id === CLB));
});

test("no data is not zero", async () => {
  historianText = "Data for 1 tag(s) in dataset 'Riverbend' (a .. b):\n## AIT-157 - 1 point(s)\n- 0001-01-01T00:00:00Z  v=0  q=0\n";
  const from = sys.tel.start, to = sys.tel.end;
  assert.deepEqual(await run("readings", { sensorId: "SEN-F07-turb", from, to }, tech), { id: "SEN-F07-turb", points: [], note: "no data", cite: `SEN-F07-turb@${from}..${to}` });
  assert.equal(JSON.parse(historianReplies.at(-1).tagNamesJson)[0], "AIT-157", "Historian is keyed by the ISA tag");
  historianText = "## AIT-157 - 3 point(s)\n- 2026-10-01T00:00:00Z  v=0.2  q=192\n- 2026-10-01T00:05:00Z  v=0  q=0\n- 2026-10-01T00:10:00Z  v=0.4  q=192\n";
  const s = await run("readings", { sensorId: "SEN-F07-turb", from: "2026-10-01T00:00:00Z", to: "2026-10-01T00:20:00Z" }, tech);
  assert.deepEqual([s.n, s.min, s.max, s.first, s.last], [2, 0.2, 0.4, 0.2, 0.4]);
  assert.equal(s.mean, 0.3, "changes-only: each value holds until the next point (0.2 for 10 min, 0.4 for 10 min)");
  assert.equal(s.slopePerH, 1.2);
});

test("cypher on Atlas: linted before it is sent", async () => {
  process.env.WWOS_KG_CYPHER = "1";
  const ts = createKgTools({ backend, ont: sys.ont, tel: sys.tel, crosswalk });
  delete process.env.WWOS_KG_CYPHER;
  const n = queries.length;
  assert.equal((await run("cypher", { query: "MATCH (p)-[:feeds*]->(f:Filter) RETURN f" }, mgr, ts)).ok, false);
  assert.equal(queries.length, n, "a query that fails lint is never sent");
  const r = await run("cypher", { query: "MATCH (r)<-[:feeds*]-(u) WHERE u:Filter RETURN u.wosId" }, mgr, ts);
  assert.deepEqual(r.rows, [[CLB], ["Z05"]]);
});
