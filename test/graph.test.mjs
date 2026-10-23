import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { currentPlantModel } from "../src/plant.mjs";
import { graphFrom, upstreamOf, downstreamOf, processPaths, travelWindow, onsetMinute } from "../src/functions.mjs";

const sys = createSystem();
const m = currentPlantModel(sys.ont);
const g = graphFrom(sys.ont.list(null, (o) => o.modelId === m.id));
const S = (tag) => `${m.id}:STR-${tag}`;
const ids = (xs) => xs.map((x) => x.id);

test("upstream of F07: four clarifiers at a quarter each, both coagulant dosing pumps", () => {
  const up = upstreamOf(S("15HFA07"), g);
  for (const n of [1, 2, 3, 4]) assert.equal(up.find((x) => x.id === S(`14UGE0${n}`)).share, 0.25, `clarifier ${n}`);
  assert.equal(up.find((x) => x.id === S("15UGS01")).share, 1);
  for (const p of ["POS-DP-1", "POS-DP-2"]) assert.ok(ids(up).includes(p), p);
  assert.ok(!ids(up).some((id) => /15HFA(0[1-689]|1\d)/.test(id)), "no sibling filters upstream");
  assert.deepEqual(upstreamOf("POS-F07", g), up); // a bound Position resolves to its structure
});

test("Review Focus 4: walks over the recycle loop terminate; backwash is not walked in normal mode", () => {
  const up = upstreamOf(S("11UGA01"), g);
  const ret = up.find((x) => x.id === S("17UGW01"));
  assert.ok(ret && ret.recycle, "washwater return marked as recycle");
  assert.ok(!ids(up).includes(S("15UGG01")), "the walk stops at the recycle edge");
  const resUp = upstreamOf(S("20UBA01"), g);
  assert.ok(ids(resUp).includes(S("15HFA07")), "filtered water feeds the reservoir");
  const down = downstreamOf(S("20UBA01"), g);
  assert.ok(!ids(down).includes(S("15UMB01")) && !ids(down).some((id) => id.includes("15HFA")), "no backwash loop in normal mode");
  assert.ok(ids(downstreamOf(S("20UBA01"), g, { mode: "backwash" })).includes(S("15UMB01")));
  assert.ok(ids(upstreamOf(S("15UGG01"), g, { mode: "backwash" })).includes(S("20UBA01")));
});

test("processPaths lists all simple paths up to the limit", () => {
  const paths = processPaths(S("13UGB01"), S("15HFA07"), g);
  assert.equal(paths.length, 4);
  for (const p of paths) assert.deepEqual([p[0], p[p.length - 1]], [S("13UGB01"), S("15HFA07")]);
  assert.equal(processPaths(S("13UGB01"), S("15HFA07"), g, { limit: 2 }).length, 2);
  assert.deepEqual(processPaths(S("15HFA07"), S("13UGB01"), g), []);
});

test("travel window intake → F07 outlet: mean 3–5 h, onset 0.8–1.8 h; half the flow doubles it", () => {
  const [path] = processPaths(S("10UPA01"), S("15HFA07"), g);
  const w = travelWindow(path, g, { flowMlD: 120, lagMin: 3 });
  assert.ok(w.meanH >= 3 && w.meanH <= 5, `mean ${w.meanH}`);
  assert.ok(w.onsetH >= 0.8 && w.onsetH <= 1.8, `onset ${w.onsetH}`);
  assert.ok(w.tailH > w.meanH && w.meanH > w.onsetH);
  assert.match(w.basis, /Q=120 ML\/d/);
  const a = travelWindow(path, g, { flowMlD: 120 }), b = travelWindow(path, g, { flowMlD: 60 });
  assert.ok(Math.abs(b.meanH - 2 * a.meanH) < 0.02, `${b.meanH} vs 2×${a.meanH}`);
});

test("onsetMinute: first sample off the baseline; a known duty cycle can be removed", () => {
  assert.equal(onsetMinute([...Array(200).fill(10), 10.5, 14, 15]), 201);
  assert.equal(onsetMinute(Array(300).fill(10)), null);
  const saw = Array.from({ length: 900 }, (_, i) => 1 + (i % 100) / 100);
  assert.notEqual(onsetMinute(saw, { baseline: 100 }), null);
  assert.equal(onsetMinute(saw, { baseline: 100, period: 100 }), null);
});

test("timing argument: F07 is a local fault; DP-2 is real but not its cause", () => {
  const n = sys.tel.cursor() + 1, day = 1440, from = 10 * day; // day 10 to now (day 13+)
  assert.ok(sys.tel.cursor() >= 13 * day);
  const hist = (id) => sys.tel.history(id, n).slice(from);
  const opts = { baseline: 2 * day, period: 1800 }; // filters backwash every 30 h
  const dp2 = onsetMinute(hist("SEN-DP-2-flow"), { baseline: 2 * day });
  const f07 = onsetMinute(hist("SEN-F07-headloss"), opts);
  assert.ok(dp2 !== null && f07 !== null);
  assert.notEqual(onsetMinute(hist("SEN-F07-turb"), opts), null, "the breakthrough itself is real");
  const [path] = processPaths(S("13UGB01"), S("15HFA07"), g);
  const w = travelWindow(path, g, { flowMlD: 120 });
  assert.ok(f07 < dp2 + w.onsetH * 60, `F07 at ${f07} min, DP-2 at ${dp2} min + window onset ${w.onsetH} h`);
  const others = Array.from({ length: 12 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`).filter((f) => f !== "F07")
    .filter((f) => onsetMinute(hist(`SEN-${f}-turb`), opts) !== null || onsetMinute(hist(`SEN-${f}-headloss`), opts) !== null);
  assert.ok(others.length < 2, `other filters with an onset: ${others}`);
});

test("shares never exceed 1, even when a dose reaches a node by two routes", () => {
  const up = upstreamOf(S("15HFA07"), g);
  assert.ok(up.every((x) => x.share <= 1), JSON.stringify(up.filter((x) => x.share > 1)));
  assert.equal(up.find((x) => x.id === S("12UHB01")).share, 1);
});

test("final: backwash mode walks washwater back to the recycle; the loop terminates", () => {
  const down = downstreamOf(S("15UGG01"), g, { mode: "backwash" });
  assert.ok(ids(down).includes(S("17UGW01")), "dirty washwater reaches the washwater tank");
  const up = upstreamOf(S("17UGW01"), g, { mode: "backwash" });
  for (const t of ["15UGG01", "15UMB01", "20UBA01", "15HFA07", "11UGA01"]) assert.ok(ids(up).includes(S(t)), t);
  assert.ok(!ids(upstreamOf(S("17UGW01"), g)).includes(S("15UGG01")), "not in normal mode");
});

test("final: a machine's upstream is its structure's upstream", () => {
  const up = upstreamOf("PM-RB-A:MCH-HLP-B", g);
  assert.ok(ids(up).includes(S("20UBA01")) && ids(up).includes(S("15HFA07")));
  assert.deepEqual(upstreamOf("POS-HLP-B", g), up);
});
