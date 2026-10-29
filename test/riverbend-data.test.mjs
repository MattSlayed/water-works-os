// Riverbend canonical plant, Task 1: scene footprints (site frame) and contract facts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = (f) => JSON.parse(readFileSync(new URL(`../data/riverbend/${f}`, import.meta.url), "utf8"));
const scene = load("scene-meta.json");
const contract = load("contract.json");
const objs = Object.entries(scene.objects);
const byAsset = (a) => objs.filter(([, o]) => o.asset === a).map(([, o]) => o);

test("scene-meta has the canonical units", () => {
  const assets = new Set(objs.map(([, o]) => o.asset));
  const want = [
    "CL-1", "CL-2", "CL-3", "CL-4",
    ...Array.from({ length: 8 }, (_, i) => `F0${i + 1}`),
    "HLP-A", "HLP-B", "HLP-C", "HLP-D", "HLP-E",
    "RES-1", "RES-2", "RWR-1", "RWR-2", "RWP-1", "FB-1", "FB-2", "HLP-H",
    "ELB-1", "CLB-1", "DOS-1", "FPR-1", "ADM-1",
  ];
  for (const a of want) assert.ok(assets.has(a), `missing asset ${a}`);
  assert.ok(!assets.has("F09"), "there is no F09");
});

test("scene-meta is in the site frame", () => {
  assert.equal(scene.frame.rotDeg, 21.2);
  for (const [name, o] of objs) {
    assert.ok(o.site.cx >= 0 && o.site.cy >= 0, `${name} centre is negative`);
    assert.ok(o.site.zMin > 1400, `${name} zMin ${o.site.zMin}`);
  }
});

test("buildings come out axis-aligned", () => {
  // The 29.96 x 17.62 m slab is the FB-1_CCT object (asset CCT-1); the FB-1 asset itself is the 29.96 x 4.22 gallery strip.
  const fb1 = scene.objects["FB-1_CCT"].site;
  const area = fb1.w * fb1.l;
  assert.ok(Math.abs(area / (29.96 * 17.62) - 1) < 0.1, `FB-1 footprint ${fb1.w} x ${fb1.l}`);
  assert.ok(Math.abs(byAsset("FB-1")[0].site.w - 29.96) < 0.1, "FB-1 gallery not axis-aligned");
  const filters = objs.filter(([n]) => /^F0[1-8]_Water$/.test(n)).map(([, o]) => o.site);
  assert.equal(filters.length, 8);
  for (const s of filters) {
    assert.ok(Math.abs(s.w - filters[0].w) <= 0.1 && Math.abs(s.l - filters[0].l) <= 0.1, "filter cells differ in size");
  }
});

test("contract tags", () => {
  assert.deepEqual(Object.keys(contract.tags).sort(),
    ["AIT-101", "AIT-157", "AIT-301", "AIT-401", "FIT-102", "FIT-201", "LIT-501", "PDT-157", "TT-612"]);
  assert.equal(contract.tags["TT-612"].asset, "HLP-B");
  assert.equal(contract.facts.length, 13);
  assert.match(contract.facts[6].text, /refurbishment/);
});
