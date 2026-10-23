import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorks } from "../src/generate.mjs";

const w = generateWorks(7);
const byId = new Map(w.objects.map((o) => [o.id, o]));
const ofType = (t) => w.objects.filter((o) => o.type === t);

test("same seed is deterministic, different seed changes people", () => {
  assert.equal(JSON.stringify(generateWorks(7)), JSON.stringify(w));
  const a = ofType("Person").map((p) => p.name).join();
  const b = generateWorks(8).objects.filter((o) => o.type === "Person").map((p) => p.name).join();
  assert.notEqual(a, b);
});

test("12 zones and the hero pump positions exist", () => {
  assert.equal(ofType("Zone").length, 12);
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

test("42 people, hero assets have sensors, an intrusive procedure step exists", () => {
  assert.equal(ofType("Person").length, 42);
  for (const a of ofType("Asset").filter((x) => x.hero)) {
    const n = ofType("Sensor").filter((s) => s.assetId === a.id).length;
    assert.ok(n >= 3, `${a.id} sensors ${n}`);
  }
  assert.ok(ofType("Procedure").some((p) => p.steps.some((s) => s.intrusive)));
});
