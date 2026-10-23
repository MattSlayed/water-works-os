import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { baseline, bandOf, sceneGrid, usableCloud } from "../src/scenes.mjs";
import { within } from "../src/functions.mjs";

const sys = createSystem();
const scenes = sys.ont.list("Scene").sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt));
const sc = (id) => sys.ont.get(id);
const z = (s, aoi, index) => { const b = baseline(scenes, aoi, index, s.acquiredAt); return (s.stats[aoi][index].mean - b.mean) / b.std; };

test("scenes: the day-11 scene is usable at 31% cloud; the day-6 scene is too cloudy; 60% is the limit", () => {
  assert.equal(sc("S2-20261012").cloudPct, 31);
  assert.equal(sc("S2-20261012").usable["AOI-INFLOW"], true);
  assert.equal(sc("S2-20261007").cloudPct, 72);
  assert.equal(sc("S2-20261007").usable["AOI-INFLOW"], false);
  assert.equal(usableCloud(60), true);
  assert.equal(usableCloud(60.1), false);
});

test("scenes: the plume stands 2.4-2.8 sigma above the inflow arm's baseline, banded 'raised'", () => {
  const s = sc("S2-20261012"), v = z(s, "AOI-INFLOW", "ndti");
  assert.ok(v >= 2.4 && v <= 2.8, `z ${v}`);
  assert.equal(bandOf(s.stats["AOI-INFLOW"].ndti.mean, baseline(scenes, "AOI-INFLOW", "ndti", s.acquiredAt)), "raised");
});

test("scenes: no baseline means no band", () => {
  assert.equal(bandOf(0.1, null), "unknown");
  assert.equal(bandOf(0.1, { mean: 1, std: 0, n: 5 }), "unknown");
  assert.equal(baseline(scenes, "AOI-INFLOW", "ndti", scenes[0].acquiredAt), null);
});

test("scenes: a year of history, summer water more turbid than winter", () => {
  const hist = scenes.filter((s) => !s.inWindow), s2 = hist.filter((s) => s.mission === "S2"), s1 = hist.filter((s) => s.mission === "S1");
  assert.ok(Math.abs(s2.length - 70) <= 3, `S2 ${s2.length}`);
  assert.ok(Math.abs(s1.length - 60) <= 3, `S1 ${s1.length}`);
  const m = (months) => { const xs = s2.filter((s) => months.includes(Number(s.acquiredAt.slice(5, 7)))).map((s) => s.stats["AOI-DAM"].ndti.mean); return xs.reduce((a, b) => a + b, 0) / xs.length; };
  assert.ok(m([12, 1, 2]) > m([6, 7, 8]));
});

test("scenes: the day-11 grid has 1,500-2,500 cells and the raised ones are in the inflow arm", () => {
  const g = sceneGrid(sc("S2-20261012"), "ndti", 60, scenes), inflow = sys.ont.get("AOI-INFLOW").geometry;
  assert.ok(g.cells.length >= 1500 && g.cells.length <= 2500, `${g.cells.length}`);
  const raised = g.cells.filter((c, i) => ["raised", "high"].includes(g.band[i]));
  assert.ok(raised.length > 20);
  for (const [lon, lat] of raised) assert.ok(within([lon, lat], inflow));
  assert.equal(sceneGrid(scenes[0], "ndti", 60, scenes), null, "history scenes carry statistics only");
});

test("scenes: statistics have the Planetary Computer statistics shape", () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/pc-stats.json", import.meta.url)));
  const keys = Object.keys(Object.values(fx.properties.statistics)[0]).sort();
  assert.deepEqual(Object.keys(sc("S2-20261012").stats["AOI-DAM"].ndti).sort(), keys);
});
