import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDxf } from "../src/ingest/dxf.mjs";
import { parseDexpi } from "../src/ingest/dexpi.mjs";
import { parseCsv } from "../src/ingest/csv.mjs";
import { STRUCTURES, MACHINES } from "../src/layout.mjs";
import { LINES, INSTRUMENTS } from "../src/drawings/make.mjs";

const sheet = (f) => readFileSync(new URL(`../data/drawings/${f}`, import.meta.url), "utf8");

test("parseDxf reads the GA: title block, structures, machines, tagged polylines", () => {
  const d = parseDxf(sheet("RB-GA-001_A.dxf"));
  assert.equal(d.header.$ACADVER, "AC1015");
  assert.ok(d.layers.includes("PIPE") && d.layers.includes("EQUIP"));
  const title = d.inserts.find((i) => i.block === "TITLE");
  assert.deepEqual([title.attribs.DWGNO, title.attribs.REV, title.attribs.ORIGIN], ["RB-GA-001", "A", "-25.86,28.62"]);
  const structs = d.inserts.filter((i) => i.block === "STRUCT");
  assert.equal(structs.length, STRUCTURES.length + 1); // + the GA-only sump 17BBB01
  const f07 = structs.find((i) => i.attribs.TAG === "15HFA07");
  assert.deepEqual(f07.at, STRUCTURES.find((s) => s.tag === "15HFA07").centre);
  assert.equal(d.inserts.filter((i) => i.block === "MACHINE").length, MACHINES.length);
  const tagged = d.entities.filter((e) => e.type === "LWPOLYLINE" && e.tag);
  assert.equal(tagged.length, LINES.length);
  const l001 = tagged.find((e) => e.tag === "RB-L-001");
  assert.equal(l001.layer, "PIPE");
  assert.equal(l001.points.length, 3);
  assert.equal(typeof l001.elevation, "number");
  assert.ok(d.entities.some((e) => e.type === "CIRCLE" && e.radius === 16));
});

test("parseDxf rev B carries RB-L-421X and filter-to-waste lines", () => {
  const tags = parseDxf(sheet("RB-GA-001_B.dxf")).entities.map((e) => e.tag).filter(Boolean);
  assert.ok(tags.includes("RB-L-421X"));
  assert.equal(tags.filter((t) => /^RB-L-60\d$/.test(t)).length, 4);
});

test("parseDexpi reads P&IDs, the PFD and the typical filter tag table", () => {
  const p5 = parseDexpi(sheet("RB-PID-05_A.xml"));
  assert.equal(p5.meta.Number, "RB-PID-05");
  assert.equal(Object.keys(p5.tagTable).length, 12);
  assert.equal(p5.tagTable.F07.kks, "15HFA07");
  assert.equal(p5.tagTable.F07.inlet, "RB-L-107");
  assert.equal(p5.tagTable.F07.valves.length, 6);
  assert.ok(p5.tagTable.F07.valves.includes("15AA07-outlet"));
  const typ = p5.segments.find((s) => s.line === "RB-L-2##");
  assert.deepEqual([typ.from, typ.to, typ.dn], ["15HFA##", "16UGH01", 450]);
  assert.ok(p5.components.some((c) => c.cls === "ControlValve" && c.tag === "15AA##-outlet"));
  assert.equal(parseDexpi(sheet("RB-PID-05_B.xml")).tagTable.F02.filterToWaste, true);

  const p1 = parseDexpi(sheet("RB-PID-01_A.xml"));
  const eq = p1.equipment.find((e) => e.tag === "10UPA01");
  assert.deepEqual([eq.cls, eq.kks, eq.nozzles], ["pump_house", "10UPA01", ["N-10UPA01-1"]]);
  assert.ok(p1.equipment.some((e) => e.tag === "RWP-A" && e.inStructure === "10UPA01"));
  assert.ok(p1.instruments.some((i) => i.tag === "10CQ01" && i.measuredAt === "RB-L-001"));

  const pfd = parseDexpi(sheet("RB-PFD-001_A.xml"));
  assert.equal(pfd.streams.length, LINES.filter((l) => l.causal && !l.injectionAt).length);
  const ret = pfd.streams.find((s) => s.id === "RB-L-431");
  assert.deepEqual([ret.from, ret.to, ret.recycle, ret.split, ret.mode], ["17UGW01", "11UGA01", true, 0.05, "continuous"]);
  assert.equal(pfd.streams.find((s) => s.id === "RB-L-001").flow, 5000);
});

test("every instrument in the set appears on a P&ID or the PID-05 typical", () => {
  const all = ["01", "02", "03", "04", "05", "06", "07", "08"].flatMap((n) => parseDexpi(sheet(`RB-PID-${n}_A.xml`)).instruments.map((i) => i.tag));
  const onSheets = INSTRUMENTS.map(([t]) => t).filter((t) => !/^15C[QP]\d\d$/.test(t) || t === "15CQ00");
  for (const t of onSheets) assert.ok(all.includes(t), t);
});

test("parseCsv reads the lists; quoted commas and quotes survive", () => {
  assert.equal(parseCsv(sheet("RB-LL-001_A.csv")).length, LINES.length);
  assert.equal(parseCsv(sheet("RB-EL-001_A.csv")).length, STRUCTURES.length + MACHINES.length);
  const il = parseCsv(sheet("RB-IL-001_A.csv"));
  assert.equal(il.length, INSTRUMENTS.length);
  assert.deepEqual(il.find((r) => r.Tag === "15CQ13"), { Tag: "15CQ13", HistorianTag: "15HFA13.TURB", MeasuredAt: "RB-L-213", SamplePosition: "outlet", LagMin: "3" });
  assert.deepEqual(parseCsv('A,B\n"x, y","say ""hi"""\n'), [{ A: "x, y", B: 'say "hi"' }]);
});

test("malformed input throws", () => {
  const ga = sheet("RB-GA-001_A.dxf");
  assert.throws(() => parseDxf(ga.slice(0, ga.length / 2)), /malformed/);
  assert.throws(() => parseDxf("0\nSECTION\n2"), /malformed/);
  assert.throws(() => parseDexpi('<PlantModel Number="X"><Equipment ID="a">'), /malformed/);
  assert.throws(() => parseDexpi('<PlantModel><A></B></PlantModel>'), /malformed/);
  assert.throws(() => parseCsv('A,B\n"open,1\n'), /malformed/);
});
