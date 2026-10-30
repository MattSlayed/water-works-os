// Riverbend Atlas, Task 2: GeometryRefs tie graph objects to glTF meshes; sensors get an anchor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { createOntology } from "../src/ontology.mjs";
import { generateWorks } from "../src/generate.mjs";
import { seedPlant } from "../src/plant.mjs";
import { geometryRefs } from "../src/kg/geometry.mjs";
import { seedKg } from "../src/kg/seed.mjs";

const load = (f) => JSON.parse(readFileSync(new URL(`../data/riverbend/${f}`, import.meta.url), "utf8"));
const scene = load("scene-meta.json"), contract = load("contract.json");
const plantOnly = () => { const o = createOntology(generateWorks(7)); seedPlant(o); return o; };

test("every scene object with a known asset gets one GeometryRef", () => {
  const ont = plantOnly();
  const g = geometryRefs(scene, ont, contract);
  assert.equal(g.refs.length + g.skippedObjects.length, 121);
  assert.equal(new Set(g.refs.map((r) => r.id)).size, g.refs.length);
  assert.equal(g.links.length, g.refs.length);
  for (const [owner, rel, to] of g.links) { assert.equal(rel, "HAS_GEOMETRY"); assert.ok(ont.get(owner), owner); assert.ok(g.refs.some((r) => r.id === to)); }
  const bridge = g.refs.find((r) => r.id === "GEO-CL-1_Bridge");
  assert.deepEqual({ type: bridge.type, file: bridge.file, node: bridge.node, floor: bridge.floor, bbox: bridge.bbox }, { type: "GeometryRef", file: "riverbend.glb", node: "CL-1_Bridge", floor: "F-CLAR", bbox: { w: 9.22, l: 10.99, h: 1.24 } });
  assert.deepEqual(bridge.centroid.map((x) => +x.toFixed(2)), [842.21, 511.34, 1477.4]);
  // the owner is the CL-1 position, and the released CL-1 structure CONTAINS that position
  const owner = g.links.find(([, , to]) => to === "GEO-CL-1_Bridge")[0];
  assert.equal(ont.get(owner).tag, "CL-1");
  assert.ok(ont.links("PM-RB-A:STR-14UGE01", { rel: "CONTAINS", dir: "out" }).some((l) => l.to === owner));
});

test("the nine contract tags are anchored", () => {
  const ont = plantOnly();
  const g = geometryRefs(scene, ont, contract);
  const ids = new Set(g.refs.map((r) => r.id));
  for (const tag of ["AIT-101", "FIT-102", "FIT-201", "AIT-301", "AIT-157", "PDT-157", "AIT-401", "LIT-501", "TT-612"]) {
    const s = ont.list("Sensor", (x) => x.tag === tag)[0];
    assert.ok(s, `sensor ${tag}`);
    const a = g.anchors.get(s.id);
    assert.ok(a && ids.has(a.geometryId), `anchor for ${tag}`);
    assert.deepEqual(a.offset, [0, 0, 0]);
  }
  const tt = g.anchors.get(ont.list("Sensor", (x) => x.tag === "TT-612")[0].id);
  assert.match(tt.geometryId, /^GEO-HLP-B_/);
  assert.equal(g.anchors.size + g.skippedSensors.length, ont.list("Sensor").length);
});

test("seedKg is idempotent and createSystem seeds it", () => {
  const ont = plantOnly();
  seedKg(ont);
  const refs = ont.list("GeometryRef").length, links = ont.links("GEO-CL-1_Bridge", { rel: "HAS_GEOMETRY", dir: "in" }).length;
  const total = ont.list().length;
  seedKg(ont);
  assert.equal(ont.list("GeometryRef").length, refs);
  assert.equal(ont.list().length, total);
  assert.equal(ont.links("GEO-CL-1_Bridge", { rel: "HAS_GEOMETRY", dir: "in" }).length, links);
  assert.equal(links, 1);
  assert.ok(ont.get("GEO-CL-1_Bridge").prov.source === "SYNTH-3D");
  const { ont: sys } = createSystem();
  assert.equal(sys.list("GeometryRef").length, refs);
  assert.ok(sys.list("Sensor", (s) => s.tag === "TT-612")[0].anchor.geometryId.startsWith("GEO-HLP-B_"));
});
