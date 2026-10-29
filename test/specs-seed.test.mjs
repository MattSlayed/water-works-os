// Plan 4 Task 2: specs from the bands, DP-2 delivery at version 2, organisations and the 2025 dosing corrections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { regionPayload } from "../src/regionview.mjs";
import { isAnalyser } from "../src/functions.mjs";

const tagOf = (s, tag) => s.ont.list("Asset").find((a) => a.positionTag === tag);

test("every banded part has a version 1 spec from the SOP", () => {
  const s = createSystem();
  const v1 = s.ont.list("Spec", (x) => x.version === 1 && x.reason === "From SOP revision C");
  assert.equal(v1.length, s.ont.list("Part", (p) => p.band).length);
  const sp = s.ont.get("SPC-HLP-A-de-bore-diameter");
  assert.deepEqual([sp.lo, sp.hi, sp.unit, sp.partName, sp.sourceRefs[0].title, sp.confirmedBy], [110, 110.035, "mm", "Bearing housing", "SOP revision C", "P-001"]);
  assert.ok(Number.isInteger(sp.step));
});

test("DP-2 delivery is at version 2 from the owner spec, with version 1 in its history", () => {
  const s = createSystem(), sp = s.ont.get("SPC-DP-2-delivery");
  assert.deepEqual([sp.version, sp.lo, sp.hi, sp.target, sp.step, sp.partName, sp.sourceRefs[0].title, sp.history[0].lo, sp.history[0].version], [2, 114, 126, 120, 2, "Dosing head", "owner spec rev B", 100, 1]);
  assert.equal(sp.assetId, tagOf(s, "DP-2").id);
});

test("the chlorinators get no delivery spec", () => {
  assert.deepEqual(createSystem().ont.list("Spec", (x) => x.key === "delivery").map((x) => x.id).sort(), ["SPC-DP-1-delivery", "SPC-DP-2-delivery"]);
});

test("the 2025 dosing project, its corrections and the organisations are seeded", () => {
  const s = createSystem(), prj = s.ont.get("PRJ-H2025-DOSE");
  assert.deepEqual([prj.state, prj.clientOrgId, prj.contractorOrgId], ["closed", "ORG-OWNER", "ORG-SYNCON"]);
  assert.ok(prj.assetIds.includes(tagOf(s, "DP-2").id) && prj.assetIds.includes(tagOf(s, "DP-1").id));
  assert.deepEqual(s.ont.list("Organisation").map((o) => [o.id, o.kind]).sort(), [["ORG-DOSATEC", "oem"], ["ORG-OWNER", "owner"], ["ORG-SYNCON", "contractor"]]);
  assert.ok(s.ont.list("Project").every((p) => p.clientOrgId === "ORG-OWNER"));
  assert.deepEqual(s.ont.get("COR-H01").scope, { template: "dosing_pump" });
  assert.deepEqual(s.ont.get("COR-H02").scope, { orgId: "ORG-SYNCON" });
  assert.deepEqual([s.ont.get("COR-H03").scope, s.ont.get("COR-H03").fromId], [{ assetId: tagOf(s, "DP-1").id }, "FND-003"]);
  assert.equal(s.ont.get("COR-H02").line, "Synthetic Contractor sheets give mL/min: ×0.06 for L/h.");
  assert.equal(s.ont.get("MSG-H-SPEC1").text, "we've had DP-2 delivering 125 L/h since the storm");
});

test("a closed project stays off the region", async () => {
  const s = createSystem();
  assert.ok(!regionPayload(s, { id: "P-001", clearance: "manager" }).projects.some((p) => p.id === "PRJ-H2025-DOSE"));
  const srv = createServer(s);
  await new Promise((r) => srv.listen(0, r));
  try {
    const list = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/projects`, { headers: { "x-acting-user": "P-001" } })).json();
    assert.ok(list.some((p) => p.id === "PRJ-H2025-DOSE"));
  } finally { srv.close(); }
});

test("Drop Pack's calibration gap is unchanged by isAnalyser", async () => {
  const s = createSystem(), srv = createServer(s);
  assert.equal(s.ont.list("Sensor").filter(isAnalyser).length > 0, true);
  await new Promise((r) => srv.listen(0, r));
  try {
    const j = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/compliance`, { headers: { "x-acting-user": "P-001" } })).json();
    assert.equal(j.items.find((i) => i.requirementId === "REQ-BD-CAL").detail, "No current calibration certificate for: Clarified turbidity, Final chlorine residual, Final pH.");
  } finally { srv.close(); }
});
