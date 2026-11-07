// Atlas under the free licence: the core model and its cost, the sync and write-through, and the graph view reading Atlas.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { atlasModel, coreModel, slimModel, atlasCost, ATLAS_INSTANCE_LIMIT, CORE_TYPES } from "../src/timebase/atlas-model.mjs";
import { createAtlasSync, atlasWriteThrough } from "../src/timebase/atlas-sync.mjs";
import { createKgTools } from "../src/kg/tools.mjs";
import { createMemoryBackend } from "../src/kg/backend-memory.mjs";
import { plantGraph, atlasGraph } from "../web/bloom.js";

const sys = createSystem({ seed: 7 });
const crosswalk = JSON.parse(fs.readFileSync(new URL("../data/crosswalk.json", import.meta.url), "utf8"));
const O = (n) => `urn:atlas:ontology:riverbend:${n}`;
const full = atlasModel(sys.ont), core = coreModel(full);
const person = (clearance) => { const p = sys.ont.list("Person", (x) => x.clearance === clearance)[0]; return { id: p.id, kind: "person", clearance: p.clearance }; };
const tech = person("technician"), mgr = person("manager");

// What Atlas answers after a sync of `model`: lean feeds edges (kind and lineId only) and its whole graph.
const atlasLike = (model) => {
  const wos = new Map(model.instances.map((x) => [x.instanceId, x.name]));
  const val = (x, k) => x.properties?.[O(k)]?.[0]?.value ?? null;
  return {
    ...createMemoryBackend(sys),
    flowEdges: async () => model.edges.filter((e) => e.type === O("feeds")).map((e) => ({ from: wos.get(e.source), to: wos.get(e.target), kind: val(e, "kind"), lineId: val(e, "lineId"), split: null, mode: null, recycle: null, length: null, pumped: null })),
    graph: async () => ({ nodes: model.instances.map((x) => ({ id: x.name, type: x.type.split(":").pop(), label: x.label })), edges: model.edges.map((e) => ({ from: wos.get(e.source), to: wos.get(e.target), rel: e.type.split(":").pop(), lineId: val(e, "lineId") })) })
  };
};

test("cost: the formula reproduces Atlas's counts, and core fits the 1,000 with room to grow", () => {
  assert.equal(atlasCost(full), 6241, "Atlas refused the full model at proposed 6241");
  assert.equal(atlasCost(core), 733);
  assert.ok(atlasCost(core) <= ATLAS_INSTANCE_LIMIT - 200);
  const slim = slimModel(full);
  assert.deepEqual(slim.entityTypes.map((t) => [t.name, t.properties]), [["WosObject", ["wosId"]], ["Structure", ["kind"]]], "Types are counted across branches");
});

test("core: only the core types, every edge end kept, types declare only what is sent", () => {
  assert.ok(core.instances.every((x) => CORE_TYPES.includes(x.type.split(":").pop())));
  const ids = new Set(core.instances.map((x) => x.instanceId));
  assert.ok(core.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
  assert.equal(core.edges.filter((e) => e.type === O("feeds")).length, full.edges.filter((e) => e.type === O("feeds")).length, "the whole flow graph");
  assert.ok(core.instances.every((x) => Object.keys(x.properties).join() === O("wosId")));
  assert.deepEqual(core.entityTypes.find((t) => t.name === "WosObject").properties, ["wosId"]);
  assert.deepEqual(core.relationshipTypes.find((t) => t.name === "feeds").properties, ["kind", "lineId"]);
});

test("atlasModel refuses two ids that would become one Atlas instance", () => {
  const s = createSystem({ seed: 7 });
  s.ont.upsert({ id: "pos-hlp-b", type: "Position", tag: "dup" });
  assert.throws(() => atlasModel(s.ont), /slug collision: .*POS-HLP-B.*pos-hlp-b|slug collision: .*pos-hlp-b.*POS-HLP-B/);
});

// A fake Atlas REST API: the instance map, definitions (one library-owned) and the calls made.
function fakeAtlas() {
  const inst = new Map(), defs = { properties: new Map(), "entity-types": new Map(), "relationship-types": new Map([["contains", { label: "contains", sourceLibrary: "atlas-common" }]]) };
  const calls = [];
  const call = async (method, path, body) => {
    calls.push(`${method} ${path.replace(/^\/api\/v1\/branches\/[^/]+\/domains\/[^/]+/, "")}`);
    const kind = Object.keys(defs).find((k) => path.endsWith(`/${k}`) || path.includes(`/${k}/`));
    if (/\/instance-maps\/plant\/instances$/.test(path)) {
      if (method === "GET") return { status: 200, body: [...inst.values()].map((x) => structuredClone(x)) };
      inst.set(body.id, structuredClone(body));
      return { status: 201, body };
    }
    const m = /\/instance-maps\/instances\/([^/]+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === "DELETE") { inst.delete(id); return { status: 204, body: null }; }
      const x = inst.get(id);
      if (body.clear) x.properties = {};
      else Object.assign(x, { ...body, properties: { ...x.properties, ...body.properties } });
      return { status: 200, body: x };
    }
    if (kind) {
      const name = decodeURIComponent(path.split(`/${kind}/`)[1] || "");
      if (method === "GET") return { status: 200, body: [...defs[kind].values()] };
      if (method === "DELETE") { defs[kind].delete(name); return { status: 204, body: null }; }
      if (method === "POST") { if (defs[kind].has(body.name)) return { status: 409, body: {} }; defs[kind].set(body.name, { ...body, label: body.name }); return { status: 201, body }; }
      return { status: 200, body: {} };
    }
    // as the real Atlas answers when only instances changed
    if (path.endsWith("/draft/publish")) return { status: 404, body: { title: "Not Found", detail: "You have no draft session on branch 'riverbend'. Everything you have saved there is already published." } };
    if (path.endsWith("/world")) {
      if (fake.failCompile) { fake.failCompile = false; return { status: 503, body: { title: "down" } }; }
      return { status: 200, body: { edgeCount: [...inst.values()].filter((x) => x.source).length } };
    }
    return { status: 201, body: {} };
  };
  const fake = { call, calls, inst, defs, failCompile: false };
  return fake;
}

test("sync: creates the core, then does nothing; clears before narrowing; drops stale WaterOS definitions, never a library's", async () => {
  const a = fakeAtlas();
  a.defs.properties.set("geometry", { label: "geometry", comment: "WaterOS geometry" });
  const sync = createAtlasSync({ call: a.call });
  const r1 = await sync.sync(sys.ont);
  assert.deepEqual([r1.create, r1.update, r1.remove, r1.cost], [core.instances.length + core.edges.length, 0, 0, 733]);
  assert.ok(!a.defs.properties.has("geometry"), "a WaterOS property the model dropped");
  assert.ok(a.defs["relationship-types"].has("contains") && a.defs["relationship-types"].get("contains").sourceLibrary, "the library's own type stays");
  assert.ok(a.calls.includes("PUT /world"));

  a.calls.length = 0;
  const r2 = await sync.sync(sys.ont);
  assert.deepEqual([r2.create, r2.update, r2.remove], [0, 0, 0]);
  assert.ok(!a.calls.some((c) => c.startsWith("PUT") || c.includes("publish")), "nothing changed: no publish, no compile");

  // an instance left holding a property the core model does not send (as after a full load)
  const x = a.inst.get("pos-hlp-b");
  x.properties[O("kks")] = [{ type: "StaticStrategy", value: "x" }];
  a.calls.length = 0;
  const r3 = await sync.sync(sys.ont);
  assert.equal(r3.update, 1);
  const patches = a.calls.filter((c) => c.startsWith("PATCH /instance-maps/instances/pos-hlp-b"));
  assert.equal(patches.length, 2, "clear, then the full set");
  assert.deepEqual(Object.keys(a.inst.get("pos-hlp-b").properties), [O("wosId")]);
});

test("sync: a compile that failed after the writes is retried by the next sync, which has nothing left to write", async () => {
  const a = fakeAtlas(), sync = createAtlasSync({ call: a.call });
  a.failCompile = true;
  await assert.rejects(sync.sync(sys.ont), /compile: HTTP 503/);
  a.calls.length = 0;
  const r = await sync.sync(sys.ont);
  assert.deepEqual([r.create, r.update, r.remove], [0, 0, 0]);
  assert.ok(a.calls.includes("PUT /world"), "the world is built though nothing was written");
});

test("a tag names the current revision's object, not an older revision's", async () => {
  const s = createSystem({ seed: 7 });
  // after a release the older revision's object is the one search meets first (insertion order); stage that here
  const cur = s.ont.get("PM-RB-A:STR-20UBA02");
  s.ont.upsert({ ...cur, id: "PM-RB-0:STR-20UBA02", modelId: "PM-RB-0" });
  s.ont.remove(cur.id);
  s.ont.upsert(cur);
  const tools = createKgTools({ backend: createMemoryBackend(s), ont: s.ont, tel: s.tel, crosswalk });
  const r = await tools.find((t) => t.name === "upstream").run({ id: "RES-2" }, mgr);
  assert.equal(r.id, "PM-RB-A:STR-20UBA02");
});

test("sync: a model over the licence is refused before any call, and the ontology keeps the change", async () => {
  const a = fakeAtlas();
  await assert.rejects(createAtlasSync({ call: a.call, scope: "full" }).sync(sys.ont), (e) => e.code === "ATLAS_LIMIT" && /6241 instances and the licence allows 1000/.test(e.message));
  assert.equal(a.calls.length, 0);
  assert.throws(() => createAtlasSync({ call: a.call, branch: "main" }), /Refusing branch "main"/);
});

test("write-through: plant changes sync once after a pause, other changes never, a failure leaves Atlas behind and retries", async () => {
  const s = createSystem({ seed: 7 });
  let n = 0, fail = false;
  const wt = atlasWriteThrough(s.ont, { sync: async () => { n++; if (fail) throw new Error("Atlas licence: over"); return { create: 1 }; } }, { delayMs: 20, log: () => {} });
  s.ont.upsert({ ...s.ont.get("POS-HLP-B"), name: "renamed" });
  s.ont.upsert({ ...s.ont.get("POS-HLP-B"), name: "renamed again" });
  s.ont.upsert({ id: "ALT-TEST", type: "Alert", title: "not mirrored" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(n, 1, "two plant changes, one sync; the alert none");
  assert.equal(wt.status().state, "in step");
  fail = true;
  s.ont.upsert({ ...s.ont.get("POS-HLP-B"), name: "third" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(wt.status().state, "behind");
  assert.match(wt.status().error, /licence/);
  fail = false;
  s.ont.upsert({ ...s.ont.get("POS-HLP-B"), name: "fourth" });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(wt.status().state, "in step");
});

test("tools on lean Atlas edges walk the same as memory; RES-2 walks from its structure", async () => {
  const mem = createKgTools({ backend: createMemoryBackend(sys), ont: sys.ont, tel: sys.tel, crosswalk });
  const atl = createKgTools({ backend: atlasLike(core), ont: sys.ont, tel: sys.tel, crosswalk });
  const up = (tools, id) => tools.find((t) => t.name === "upstream").run({ id }, mgr);
  const a = await up(mem, "PM-RB-A:STR-20UBA02"), b = await up(atl, "PM-RB-A:STR-20UBA02");
  assert.ok(a.items.length > 20);
  assert.deepEqual(b.items.map((i) => [i.id, i.share, i.window?.meanH]), a.items.map((i) => [i.id, i.share, i.window?.meanH]), "line attributes come from WaterOS by lineId");
  const res2 = await up(atl, "RES-2");
  assert.equal(res2.id, "PM-RB-A:STR-20UBA02", "the crosswalk names RES-2 20UBA02");
  const hlp = await up(mem, "AST-85704");
  assert.notEqual(hlp.found, false, "an installed asset walks from its position");
});

test("graph: Atlas's graph pruned to the viewer; memory has none", async () => {
  const atl = createKgTools({ backend: atlasLike(core), ont: sys.ont, tel: sys.tel, crosswalk });
  const [gt, gm] = [await atl.graph(tech), await atl.graph(mgr)];
  const hidden = core.instances.map((x) => x.name).filter((id) => !sys.ont.view(tech).get(id));
  assert.ok(hidden.length > 0, "some core objects sit above a technician");
  const ids = new Set(gt.nodes.map((n) => n.id));
  assert.ok(hidden.every((id) => !ids.has(id)));
  assert.ok(gt.edges.every((e) => ids.has(e.from) && ids.has(e.to)));
  assert.ok(gm.nodes.length > gt.nodes.length);
  assert.equal(await createKgTools({ backend: createMemoryBackend(sys), ont: sys.ont, tel: sys.tel, crosswalk }).graph(mgr), null);
});

let srv, base;
before(async () => {
  const kgTools = createKgTools({ backend: atlasLike(core), ont: sys.ont, tel: sys.tel, crosswalk });
  srv = createServer(sys, { kgTools });
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

test("graph view: /api/plant/kg feeds atlasGraph, laid out on the site plan, lines drawn as edges", async () => {
  const get = async (p) => (await fetch(base + p, { headers: { "x-acting-user": mgr.id } })).json();
  const [d, kg] = [await get("/api/plant"), await get("/api/plant/kg")];
  assert.equal(kg.source, "atlas");
  const g = atlasGraph(d, kg), placed = new Map(plantGraph(d).nodes.map((n) => [n.id, n]));
  assert.ok(g.nodes.length > 100 && !g.nodes.some((n) => n.type === "Line"));
  assert.ok(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  for (const n of g.nodes) if (placed.has(n.id)) assert.deepEqual([n.x, n.y], [placed.get(n.id).x, placed.get(n.id).y]);
  assert.ok(g.edges.some((e) => e.rel === "feeds" && e.title) && g.edges.some((e) => e.rel === "installedAt"));
  const memSrv = createServer(sys);
  await new Promise((r) => memSrv.listen(0, r));
  const m = await (await fetch(`http://127.0.0.1:${memSrv.address().port}/api/plant/kg`, { headers: { "x-acting-user": mgr.id } })).json();
  memSrv.close();
  assert.equal(m.source, "memory");
});
