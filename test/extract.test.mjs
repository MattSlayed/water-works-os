import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPlant } from "../src/ingest/extract.mjs";
import { drawingSet, INSTRUMENTS } from "../src/drawings/make.mjs";
import { generateWorks } from "../src/generate.mjs";
import { createOntology } from "../src/ontology.mjs";

const ont = createOntology(generateWorks(7));
const A = extractPlant(drawingSet("A"), ont);
const item = (x, tag) => x.items.find((i) => i.tag === tag);
const cell = (x, key) => x.cells.find((c) => c.key === key);

test("sources: one per sheet with number, rev, kind and sha256", () => {
  assert.equal(A.sources.length, 14);
  const ga = A.sources.find((s) => s.number === "RB-GA-001");
  assert.deepEqual([ga.rev, ga.kind], ["A", "ga"]);
  assert.match(ga.sha256, /^[0-9a-f]{64}$/);
});

test("rev A has exactly the three seeded AMBIGUOUS cells, each naming its sheets", () => {
  const amb = A.cells.filter((c) => c.grade === "AMBIGUOUS");
  assert.deepEqual(amb.map((c) => c.key).sort(), ["15CQ13|binding", "17BBB01|presence", "RB-L-210|dn"]);
  assert.match(cell(A, "RB-L-210|dn").reasoning, /RB-LL-001.*RB-PID-05|RB-PID-05.*RB-LL-001/);
  assert.match(cell(A, "17BBB01|presence").reasoning, /RB-GA-001/);
});

test("cells have the global shape and unique keys; grades are the three allowed", () => {
  assert.ok(A.cells.length > 900, `${A.cells.length} cells`);
  assert.equal(new Set(A.cells.map((c) => c.key)).size, A.cells.length);
  for (const c of A.cells) {
    assert.deepEqual(Object.keys(c).sort(), ["field", "grade", "key", "reasoning", "region", "reviewed", "sheet", "value"]);
    assert.ok(["EXTRACTED", "INFERRED", "AMBIGUOUS"].includes(c.grade));
    assert.equal(c.reviewed, null);
  }
  assert.equal(cell(A, "RB-L-001|length").grade, "INFERRED");
  assert.equal(cell(A, "17BBB01|zoneId").grade, "INFERRED");
  assert.equal(cell(A, "14UGE01|diameter").grade, "EXTRACTED");
});

test("every hero position binds EXTRACTED; F01 binds POS-F01, not F10", () => {
  for (const t of ["RWP-A", "RWP-B", "RWP-C", "DP-1", "DP-2", "CL-1", "CL-2", "CL-3", "CL-4", "BWP-A", "BWP-B", "BLW-A", "BLW-B", "CHL-A", "CHL-B", "HLP-A", "HLP-B", "HLP-C", "HLP-D"]) {
    assert.deepEqual(A.bindings[t], { id: `POS-${t}`, grade: "EXTRACTED" }, t);
  }
  assert.deepEqual(A.bindings["15HFA01"], { id: "POS-F01", grade: "EXTRACTED" });
  assert.equal(A.bindings["15CQ07"].id, "SEN-F07-turb");
  assert.equal(A.bindings["10CQ01"].id, "SEN-RAW-turb");
  assert.equal(A.bindings["15CQ13"].grade, "AMBIGUOUS");
});

test("lines carry process semantics from the LL and PFD", () => {
  const coag = item(A, "RB-L-501").fields;
  assert.deepEqual([coag.causal, coag.injectionAt, coag.service], [true, "13UGB01", "coagulant"]);
  assert.equal(item(A, "RB-L-431").fields.recycle, true);
  assert.equal(item(A, "RB-L-401").fields.mode, "intermittent");
  const l = item(A, "RB-L-107").fields;
  assert.deepEqual([l.conveyance, l.dn, l.from, l.to, l.splitFraction, l.designFlow], ["pipe", 450, "15UGS01", "15HFA07", 0.083, 416.667]);
  assert.equal(l.path.length, 3);
  assert.equal(l.path[0].length, 3);
  assert.deepEqual([item(A, "RB-L-002").fields.width, item(A, "RB-L-002").fields.depth], [2, 1.2]);
});

test("valves from the PID-05 tag table; sample points carry lag", () => {
  const valves = A.items.filter((i) => i.kind === "valve");
  assert.equal(valves.length, 72);
  assert.deepEqual([item(A, "15AA07-outlet").fields.lineId, item(A, "15AA07-outlet").fields.kind], ["RB-L-207", "ControlValve"]);
  const sps = A.items.filter((i) => i.kind === "samplepoint");
  assert.equal(sps.length, INSTRUMENTS.filter((r) => r[3] !== "inline").length);
  for (const s of sps) assert.ok(s.fields.lagMin >= 2 && s.fields.lagMin <= 10, s.tag);
  assert.equal(item(A, "SP-15CQ07").fields.at, "RB-L-207");
});

test("rev B: filter-to-waste lines and the GA-only old washwater outlet", () => {
  const B = extractPlant(drawingSet("B"), ont);
  assert.deepEqual(B.items.filter((i) => i.kind === "line" && i.fields.service === "filter-to-waste").map((i) => i.tag).sort(), ["RB-L-601", "RB-L-602", "RB-L-603", "RB-L-604"]);
  assert.equal(cell(B, "RB-L-421X|presence").grade, "AMBIGUOUS");
  assert.equal(B.cells.filter((c) => c.grade === "AMBIGUOUS").length, 4);
});
