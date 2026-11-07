// KG tools over the Atlas backend with fake Atlas and Historian MCP clients that return canned tables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { createKgTools } from "../src/kg/tools.mjs";
import { createAtlasBackend, createHybridBackend, parseCypherReply } from "../src/kg/backend-atlas.mjs";
import { createMemoryBackend } from "../src/kg/backend-memory.mjs";

const sys = createSystem({ seed: 7 });
const crosswalk = JSON.parse(readFileSync(new URL("../data/crosswalk.json", import.meta.url), "utf8"));
const as = (clearance) => ({ id: sys.ont.list("Person", (p) => p.clearance === clearance)[0].id, clearance });
const tech = as("technician"), sup = as("supervisor"), mgr = as("manager");
const CLB = "PM-RB-A:STR-16UHC01";
const T = (n) => `urn:atlas:ontology:riverbend:${n}`;
// Renders rows the way the real ExecuteCypherQuery does: a JSON string holding a text table.
const show = (v) => Array.isArray(v) ? `[${v.map(show).join(", ")}]` : v && typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(", ")}}` : String(v);
const table = (columns, rows) => ({ content: [{ type: "text", text: JSON.stringify(`${columns.join(" | ")}\n${columns.map(() => "---").join("+")}\n${rows.map((r) => r.map(show).join(" | ")).join("\n")}\n\n(${rows.length} rows)`) }] });

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

test("parses replies captured from the live Atlas, and refuses what doesn't fit", () => {
  const live = (text) => ({ content: [{ type: "text", text: JSON.stringify(text) }] });
  assert.deepEqual(parseCypherReply(live("a | b | share\n-----+------+------\nRWP-1 | MIX | null\nMIX | CL-1 | 0.5\n\n(2 rows)")), { columns: ["a", "b", "share"], rows: [["RWP-1", "MIX", null], ["MIX", "CL-1", 0.5]] });
  const { rows } = parseCypherReply(live("label | type | props\n---+---+---\nCL-1 | [urn:atlas:ontology:riverbend:Clarifier] | {@entity:Label: CL-1, urn:atlas:ontology:riverbend:kks: 14UGE01, urn:atlas:ontology:riverbend:geometry: [ 1, 2], urn:atlas:ontology:riverbend:height: 4.5}\n\n(1 rows)"));
  assert.deepEqual(rows[0][1], ["urn:atlas:ontology:riverbend:Clarifier"]);
  assert.deepEqual(rows[0][2], { "@entity:Label": "CL-1", "urn:atlas:ontology:riverbend:kks": "14UGE01", "urn:atlas:ontology:riverbend:geometry": "[ 1, 2]", "urn:atlas:ontology:riverbend:height": 4.5 });
  assert.deepEqual(parseCypherReply(live("n\n----\n\n(0 rows)")).rows, []);
  assert.throws(() => parseCypherReply(live("a | b\n--+--\nx | y | z\n\n(1 rows)")), /3 cells for 2 columns/);
  assert.throws(() => parseCypherReply(live("ERROR: Domain 'riverbend' on branch 'x' has not been compiled.")), /has not been compiled/);
  assert.throws(() => parseCypherReply({ content: [] }), /unrecognised reply/);
});

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
  const from = sys.tel.start, to = sys.tel.end, now = sys.tel.now();
  assert.deepEqual(await run("readings", { sensorId: "SEN-F07-turb", from, to }, tech), { id: "SEN-F07-turb", points: [], note: "no data", cite: `SEN-F07-turb@${from}..${now}` }, "to is clamped to the plant clock");
  const sent = historianReplies.at(-1);
  assert.equal(JSON.parse(sent.tagNamesJson)[0], "AIT-157", "Historian is keyed by the ISA tag");
  assert.equal(sent.endTime, new Date(Date.parse(now) + 1).toISOString(), "the Atlas path is clamped to the plant clock too (the tool's end is exclusive)");
  // a quality-0 row starts a gap (it is not held over), and the values are read on the 1-minute grid
  historianText = "## AIT-157 - 3 point(s)\n- 2026-10-01T00:00:00Z  v=0.2  q=192\n- 2026-10-01T00:05:00Z  v=0  q=0\n- 2026-10-01T00:10:00Z  v=0.4  q=192\n";
  const s = await run("readings", { sensorId: "SEN-F07-turb", from: "2026-10-01T00:00:00Z", to: "2026-10-01T00:20:00Z" }, tech);
  assert.deepEqual([s.n, s.min, s.max, s.first, s.last], [16, 0.2, 0.4, 0.2, 0.4], "00:00-00:04 at 0.2, 00:05-00:09 no data, 00:10-00:20 at 0.4");
  assert.equal(s.mean, 0.3375);
  assert.equal(s.slopePerH, 0.765);
  assert.equal(s.firstAboveAlarmAt, null, "alarmHi 0.5 is never passed");
});

test("a value steady across the whole window is read from before the window, not reported as no data", async () => {
  historianText = "## AIT-157 - 1 point(s)\n- 2026-10-01T00:00:00Z  v=0.25  q=192\n";
  const s = await run("readings", { sensorId: "SEN-F07-turb", from: "2026-10-01T06:00:00Z", to: "2026-10-01T06:10:00Z" }, tech);
  assert.deepEqual([s.n, s.min, s.max, s.mean, s.first, s.last, s.slopePerH], [11, 0.25, 0.25, 0.25, 0.25, 0.25, 0]);
  assert.ok(Date.parse(historianReplies.at(-1).startTime) < Date.parse("2026-10-01T06:00:00Z"), "the request looks back before from");
  historianText = "## AIT-157 - 2 point(s)\n- 2026-10-01T05:58:00Z  v=0.4  q=192\n- 2026-10-01T06:03:00Z  v=0.6  q=192\n";
  const a = await run("readings", { sensorId: "SEN-F07-turb", from: "2026-10-01T06:00:00Z", to: "2026-10-01T06:05:00Z" }, tech);
  assert.deepEqual([a.n, a.first, a.last, a.firstAboveAlarmAt], [6, 0.4, 0.6, "2026-10-01T06:03:00.000Z"], "from to the first change is the held earlier value");
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

test("hybrid: readings come from Historian by tag; the graph answers from memory; the viewer's clearance still holds", async () => {
  const calls = [];
  const fake = { async callTool(name, args) { calls.push(args); return { content: [{ type: "text", text: "## AIT-157 - 2 point(s)\n- 2026-10-14T05:00:00Z  v=7.5  q=192\n- 2026-10-14T05:30:00Z  v=8.5  q=192\n" }] }; } };
  const hybrid = createKgTools({ backend: createHybridBackend({ ont: sys.ont, tel: sys.tel, historian: fake }), ont: sys.ont, tel: sys.tel, crosswalk });
  const s = await run("readings", { sensorId: "SEN-F07-turb", from: "2026-10-14T05:00:00Z", to: "2026-10-14T06:00:00Z" }, tech, hybrid);
  assert.deepEqual([s.min, s.max, s.first, s.last], [7.5, 8.5, 7.5, 8.5], "values that only the fake Historian holds");
  assert.equal(JSON.parse(calls[0].tagNamesJson)[0], "AIT-157");
  calls.length = 0;
  assert.equal((await run("search", { q: "CHL-A" }, mgr, hybrid)).items.length > 0, true);
  assert.equal((await run("get", { id: CLB }, sup, hybrid)).found, true);
  assert.equal(calls.length, 0, "the graph never calls Historian");
  const hidden = sys.ont.list("Sensor", (x) => !sys.ont.view(tech).get(x.id))[0];
  assert.deepEqual(await run("readings", { sensorId: hidden.id }, tech, hybrid), { found: false });
  assert.equal(calls.length, 0, "a hidden sensor is never read");
});
