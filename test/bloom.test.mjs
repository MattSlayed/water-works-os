// The plant graph (Bloom) view: query phrases, the plant as a graph per viewer, and its door to the KG (/mcp).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { plantGraph, parseQuery, colourOf } from "../web/bloom.js";

const sys = createSystem({ seed: 7 });
const as = (clearance) => sys.ont.list("Person", (p) => p.clearance === clearance)[0].id;
const tech = as("technician"), mgr = as("manager");
let srv, base;
before(async () => {
  srv = createServer(sys);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());
const plantAs = async (who) => (await fetch(`${base}/api/plant`, { headers: { "x-acting-user": who } })).json();
const mcp = async (who, name, args) => {
  const r = await (await fetch(`${base}/mcp`, { method: "POST", headers: { "x-acting-user": who, "content-type": "application/json", origin: base }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json();
  return JSON.parse(r.result.content[0].text);
};

test("query phrases map to one KG tool each; anything else is a search", () => {
  assert.deepEqual(parseQuery("upstream of 16UHC01"), { tool: "upstream", args: { id: "16UHC01" } });
  assert.deepEqual(parseQuery("Downstream RWP-A"), { tool: "downstream", args: { id: "RWP-A" } });
  assert.deepEqual(parseQuery("neighbours of SITE-RB"), { tool: "neighbors", args: { id: "SITE-RB" } });
  assert.deepEqual(parseQuery("expand CL-4"), { tool: "neighbors", args: { id: "CL-4" } });
  assert.deepEqual(parseQuery("  chlorine "), { tool: "search", args: { q: "chlorine", limit: 25 } });
  assert.equal(parseQuery("   "), null);
  assert.equal(colourOf("Structure"), colourOf("Structure"));
  assert.match(colourOf("SomeNewType"), /^#[0-9a-f]{6}$/);
});

test("the plant graph: structures, machines on their KG positions, process lines between drawn nodes", async () => {
  const d = await plantAs(mgr), g = plantGraph(d), ids = new Set(g.nodes.map((n) => n.id));
  assert.equal(g.nodes.filter((n) => n.type === "Structure").length, d.structures.length);
  const rwp = d.machines.find((m) => m.positionId);
  assert.ok(ids.has(rwp.positionId) && !ids.has(rwp.id), "a machine is drawn on its position id");
  assert.equal(g.alias.get(rwp.id), rwp.positionId);
  assert.ok(g.edges.some((e) => e.rel === "FEEDS") && g.edges.some((e) => e.rel === "CONTAINS"));
  for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `${e.from} -> ${e.to}`);
  assert.equal(new Set(g.edges.map((e) => `${e.from}|${e.to}|${e.rel}`)).size, g.edges.length, "parallel lines merge into one edge");
  for (const n of g.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), n.id);
});

test("a technician's plant graph and graph queries never show Z06", async () => {
  const g = plantGraph(await plantAs(tech));
  assert.ok(!g.nodes.some((n) => n.id === "PM-RB-A:STR-16UHC01"), "the chlorine house is not drawn");
  const found = await mcp(tech, "search", { q: "16UHC01" });
  assert.ok(!found.items.some((i) => i.id === "PM-RB-A:STR-16UHC01"));
  const site = await mcp(tech, "neighbors", { id: "SITE-RB" });
  assert.ok(site.items.length && site.items.every((i) => i.type && i.label), "neighbours arrive drawable");
  assert.ok(!site.items.some((i) => i.id === "Z06"));
  assert.ok((await mcp(mgr, "neighbors", { id: "SITE-RB" })).items.some((i) => i.id === "Z06"), "a manager sees it");
});

test("the plant view opens on 3D, the graph follows it and queries through /mcp", async () => {
  const app = await (await fetch(`${base}/app.js`)).text();
  assert.ok(app.indexOf('data-ptab="3d"') < app.indexOf('data-ptab="graph"'), "3D is the first tab");
  assert.ok(app.includes('await setTab("3d")'), "3D is the default");
  assert.ok(app.includes('fetch("/mcp"'));
  const src = await (await fetch(`${base}/bloom.js`)).text();
  for (const s of ["export function mountBloom", "export function plantGraph", "export function parseQuery", "highlight", "frame", "dispose", "prefers-reduced-motion"]) assert.ok(src.includes(s), s);
});
