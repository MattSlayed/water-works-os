import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { projectStatus } from "../src/functions.mjs";
import { treatmentCapacity, supplyImpacts, spendAt } from "../src/regionview.mjs";

const sys = createSystem();
const ids = ["PRJ-CL3", "PRJ-RWM", "PRJ-RES2", "PRJ-FMR", "PRJ-INT", "PRJ-SLG", "PRJ-PS2"];

test("projects: seven live ones (the closed 2025 dosing project is history), each with a footprint, money, impact, milestones and an owner", () => {
  assert.deepEqual(sys.ont.list("Project", (p) => p.state !== "closed").map((p) => p.id).sort(), [...ids].sort());
  for (const id of ids) {
    const p = sys.ont.get(id), ring = p.footprint.coordinates[0];
    assert.ok(ring.length >= 4 && JSON.stringify(ring[0]) === JSON.stringify(ring[ring.length - 1]), `${id} ring`);
    assert.ok(p.budgetZar > 0 && Array.isArray(p.spend) && p.capacityImpact && p.capacityImpact.text, id);
    assert.ok(Array.isArray(p.takesOutOfService) && p.milestones.length >= 3 && p.ownerId, id);
  }
});

test("capacity on 14 October: the clarifiers limit the works to 90 ML/d, so 30 ML/d is out of service", () => {
  const c = treatmentCapacity(sys.ont, "2026-10-14");
  assert.deepEqual([c.capacityMlD, c.limiting, c.outOfServiceMlD], [90, "clar", 30]);
  assert.equal(c.byStage.main, 100);
  assert.equal(c.byStage.filt, 110);
  const after = treatmentCapacity(sys.ont, "2026-12-15"); // after every project has ended
  assert.deepEqual([after.capacityMlD, after.outOfServiceMlD], [120, 0]);
});

test("money and progress: RES-2 has R1.9m committed of R2.4m; the raw-water main has a slipped milestone", () => {
  const r = sys.ont.get("PRJ-RES2");
  assert.equal(spendAt(r, sys.tel.now()), 1900000);
  assert.equal(r.budgetZar, 2400000);
  const rwm = sys.ont.get("PRJ-RWM"), st = projectStatus(rwm, sys.ont.list("ProgressClaim"), sys.ont.list("Issue"), sys.tel.now());
  assert.ok(st.overdue.length >= 1);
  assert.ok(st.overdue.some((id) => !rwm.milestones.find((m) => m.id === id).claimedAt), "an overdue milestone nobody has claimed");
});

test("outbound projects count against supply, not treatment", () => {
  const s = supplyImpacts(sys.ont, "2026-10-14").map((x) => x.projectId);
  assert.ok(s.includes("PRJ-PS2") && s.includes("PRJ-RES2"));
  assert.ok(!Object.values(treatmentCapacity(sys.ont, "2026-10-14").byStage).some((v) => v < 0));
  assert.equal(supplyImpacts(sys.ont, "2026-10-14").find((x) => x.projectId === "PRJ-RES2").storagePct, -50);
});
