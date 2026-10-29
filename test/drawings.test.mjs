import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drawingSet, DRAWING_META, LINES } from "../src/drawings/make.mjs";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "drawings");

test("rev A is 14 sheets; rev B changes exactly GA, LL and PID-05", () => {
  const a = drawingSet("A"), b = drawingSet("B");
  assert.equal(Object.keys(a).length, 14);
  assert.ok(Object.keys(DRAWING_META).length >= 14);
  const changed = Object.keys(b).filter((f) => !a[f]);
  assert.deepEqual(changed.sort(), ["RB-GA-001_B.dxf", "RB-LL-001_B.csv", "RB-PID-05_B.xml"]);
  assert.equal(Object.keys(b).length, 14);
});

test("rev B adds filter-to-waste on F01–F04 only", () => {
  const b = drawingSet("B")["RB-PID-05_B.xml"];
  const rows = b.match(/<TagRow [^>]*>/g);
  assert.equal(rows.length, 8);
  const ftw = rows.filter((r) => /FilterToWaste="yes"/.test(r)).map((r) => r.match(/Filter="(F\d\d)"/)[1]);
  assert.deepEqual(ftw, ["F01", "F02", "F03", "F04"]);
  assert.match(b, /filter-to-waste/);
  assert.doesNotMatch(drawingSet("A")["RB-PID-05_A.xml"], /filter-to-waste/);
});

test("the GA is DXF R2000 ASCII with a georeferenced title block", () => {
  const ga = drawingSet("A")["RB-GA-001_A.dxf"];
  assert.ok(ga.startsWith("0\nSECTION"));
  assert.match(ga, /\$ACADVER\n1\nAC1015/);
  assert.match(ga, /ORIGIN\n1\n-25\.86,28\.62/);
  assert.ok(LINES.some((l) => l.line === "RB-L-210"));
});

test("committed drawings equal the generator output byte for byte", () => {
  for (const rev of ["A", "B"]) for (const [name, text] of Object.entries(drawingSet(rev))) {
    assert.equal(fs.readFileSync(path.join(DIR, name), "utf8"), text, name);
  }
});
