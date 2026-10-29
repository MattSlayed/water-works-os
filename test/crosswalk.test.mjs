import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { assignTags } from "../src/crosswalk.mjs";
import { buildCrosswalk } from "../scripts/build-crosswalk.mjs";
import { generateWorks } from "../src/generate.mjs";

// Seven sensors: an override pair, a filter, a numbered on-site sensor, a non-bay Z05 sensor, a remote one.
const FIX = [
  { id: "SEN-HLP-B-temp_de", key: "temp_de", zoneId: "Z07", assetId: "AST-85704" },
  { id: "SEN-HLP-B-vib_de", key: "vib_de", zoneId: "Z07", assetId: "AST-85704" },
  { id: "SEN-F03-turb", key: "turb", zoneId: "Z05", assetId: "AST-FLT-F03" },
  { id: "SEN-RAW-turb", key: "turb", zoneId: "Z01", processUnitId: "PU-intake" },
  { id: "SEN-RWP-A-flow", key: "flow", zoneId: "Z01", assetId: "AST-30819" },
  { id: "SEN-FW-turb", key: "turb", zoneId: "Z05", processUnitId: "PU-filt" },
  { id: "SEN-RES1-level", key: "level", zoneId: "Z14", processUnitId: "RS-RES1" }
];

test("overrides win", () => {
  const t = assignTags(FIX);
  assert.equal(t.get("SEN-HLP-B-temp_de"), "TT-612");
  assert.match(t.get("SEN-HLP-B-vib_de"), /^VT-6\d\d$/);
  assert.notEqual(t.get("SEN-HLP-B-vib_de"), "VT-612");
  assert.equal(t.get("SEN-RAW-turb"), "AIT-101");
});

test("filter bay rule", () => {
  assert.equal(assignTags(FIX).get("SEN-F03-turb"), "AIT-153");
});

test("numbering follows area: on-site by zone, remote 8", () => {
  const t = assignTags(FIX);
  assert.equal(t.get("SEN-RWP-A-flow"), "FIT-101");
  assert.equal(t.get("SEN-RES1-level"), "LIT-801");
});

test("non-bay Z05 sensors number from 160, clear of the 15x bays", () => {
  const n = +assignTags(FIX).get("SEN-FW-turb").slice(-3);
  assert.ok(n >= 160 && n <= 199, `got ${n}`);
});

test("unknown key throws, naming the sensor and key", () => {
  assert.throws(() => assignTags([{ id: "SEN-X-zap", key: "zap", zoneId: "Z01" }]), /SEN-X-zap.*zap/);
});

test("tags are unique and well-formed", () => {
  const t = assignTags(FIX);
  const tags = [...t.values()];
  for (const x of tags) assert.match(x, /^[A-Z]{2,3}-\d{3}$/);
  assert.equal(new Set(tags).size, FIX.length);
  assert.deepEqual(tags.filter((x) => FIX.some((s) => s.id === x)), []);
});

test("crosswalk file is current", { skip: "until Task 5 rebuilds generateWorks on the new plant" }, () => {
  const file = JSON.parse(fs.readFileSync(new URL("../data/crosswalk.json", import.meta.url), "utf8"));
  assert.deepEqual(file, buildCrosswalk(generateWorks()));
});
