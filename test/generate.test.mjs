import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorks } from "../src/generate.mjs";
import fs from "node:fs";

const w = generateWorks(7);
const byId = new Map(w.objects.map((o) => [o.id, o]));
const ofType = (t) => w.objects.filter((o) => o.type === t);

test("same seed is deterministic, different seed changes people", () => {
  assert.equal(JSON.stringify(generateWorks(7)), JSON.stringify(w));
  const a = ofType("Person").map((p) => p.name).join();
  const b = generateWorks(8).objects.filter((o) => o.type === "Person").map((p) => p.name).join();
  assert.notEqual(a, b);
});

test("15 zones (12 plant, 3 on the bulk line) and the hero pump positions exist", () => {
  assert.equal(ofType("Zone").length, 15);
  for (const t of ["HLP-A", "HLP-B", "HLP-C", "HLP-D", "RWP-A", "RWP-B", "RWP-C"]) {
    assert.ok(ofType("Position").some((p) => p.tag === t), `position ${t}`);
  }
});

test("HLP-B unit has at least 12 parts with explode and geometry", () => {
  const unit = ofType("Asset").find((a) => a.positionTag === "HLP-B");
  assert.ok(unit);
  const parts = ofType("Part").filter((p) => p.assetId === unit.id);
  assert.ok(parts.length >= 12, `parts ${parts.length}`);
  for (const p of parts) {
    assert.ok(p.explode && Array.isArray(p.explode.dir), `${p.id} explode`);
    assert.ok(p.geom && p.geom.shape, `${p.id} geom`);
  }
});

test("every link endpoint exists and every object has provenance", () => {
  for (const l of w.links) {
    assert.ok(byId.has(l.from), `from ${l.from}`);
    assert.ok(byId.has(l.to), `to ${l.to}`);
  }
  for (const o of w.objects) assert.ok(o.prov && o.prov.source, `prov ${o.id}`);
});

test("45 people, hero assets have sensors, an intrusive procedure step exists", () => {
  assert.equal(ofType("Person").length, 45);
  for (const a of ofType("Asset").filter((x) => x.hero)) {
    const n = ofType("Sensor").filter((s) => s.assetId === a.id).length;
    assert.ok(n >= 3, `${a.id} sensors ${n}`);
  }
  assert.ok(ofType("Procedure").some((p) => p.steps.some((s) => s.intrusive)));
});

test("canonical plant: 100 ML/d, F01..F08, HLP-A..E, AST-RES-1/2 and no CWR ids", () => {
  assert.equal(byId.get("SITE-RB").capacityMlD, 100);
  const tags = (re) => ofType("Position").map((p) => p.tag).filter((t) => re.test(t)).sort();
  assert.deepEqual(tags(/^F\d\d$/), ["F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08"]);
  assert.deepEqual(tags(/^HLP-/), ["HLP-A", "HLP-B", "HLP-C", "HLP-D", "HLP-E"]);
  const hlp = (t) => ofType("Asset").find((a) => a.positionTag === t);
  assert.equal(hlp("HLP-D").state, "standby");
  assert.equal(hlp("HLP-E").state, "running");
  for (const n of [1, 2]) {
    const a = byId.get(`AST-RES-${n}`);
    assert.equal(a.positionTag, `RES-${n}`);
    assert.equal(a.levelSensor, `SEN-RES-${n}-level`);
    assert.ok(byId.has(`SEN-RES-${n}-level`));
  }
  assert.deepEqual(w.objects.filter((o) => /CWR/.test(o.id)).map((o) => o.id), []);
});

test("contract tags land on the right sensors", () => {
  const contract = JSON.parse(fs.readFileSync(new URL("../data/riverbend/contract.json", import.meta.url), "utf8"));
  const want = {
    "AIT-101": "SEN-RAW-turb", "FIT-102": "SEN-RAW-flow", "FIT-201": "SEN-DP-2-flow", "AIT-301": "SEN-CLR-turb",
    "AIT-157": "SEN-F07-turb", "PDT-157": "SEN-F07-headloss", "AIT-401": "SEN-FIN-cl",
    "LIT-501": byId.get("AST-RES-2").levelSensor, "TT-612": "SEN-HLP-B-temp_de"
  };
  assert.deepEqual(Object.keys(contract.tags).sort(), Object.keys(want).sort());
  for (const [tag, id] of Object.entries(want)) assert.equal(ofType("Sensor").find((s) => s.tag === tag)?.id, id, tag);
  const tt = byId.get("SEN-HLP-B-temp_de");
  assert.equal(byId.get(tt.assetId).positionTag, contract.tags["TT-612"].asset);
});

test("every sensor has a unique tag", () => {
  const sensors = ofType("Sensor");
  assert.deepEqual(sensors.filter((s) => !s.tag).map((s) => s.id), []);
  assert.equal(new Set(sensors.map((s) => s.tag)).size, sensors.length);
});
