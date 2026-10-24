// Plan 4 Task 5: the job brief (job brief design §6, §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { jobBrief } from "../src/brief.mjs";

const SM = { id: "P-001", kind: "person", clearance: "manager", role: "works_manager" };
const P032 = { id: "P-032", kind: "person", clearance: "technician", role: "fitter" };
const triage = (s) => s.runtime.run("Spec Triage", { actingUser: SM, chain: false });
const brief = (s, wo = "WO-26044") => jobBrief(s.ont.view(P032), wo, { now: s.tel.now() });
const EIGHT = [
  "WO-26044 DP-2 losing prime intermittently. Before you start:",
  "Target: delivery at 60% stroke 114–126 L/h (owner spec rev B, confirmed by Precious Sithole). A newer value, 135 L/h, waits for the site manager.",
  "Same model: check delivery by draw-down, never from the DM 400 table (40 Hz drives).",
  "Synthetic Contractor sheets give mL/min: ×0.06 for L/h.",
  "Last time: WO-26013 planned inspection in May, no readings. On DP-1, loss of prime was the suction ball. Check it first.",
  "Open: ISS-H04, DP-2 suction line has no air-release valve.",
  "Step 2: air collects at the high point of the suction line; bleed it there (KN-H08).",
  "Reply \"brief\" for the full brief, \"start step 1\" to begin."
];

test("J30: the DP-2 brief before confirmation is exactly the spec's eight lines", () => {
  const s = createSystem();
  triage(s);
  assert.deepEqual(brief(s).lines, EIGHT);
});

test("without a pending change the target line has no waiting clause", () => {
  assert.equal(brief(createSystem()).lines[1], "Target: delivery at 60% stroke 114–126 L/h (owner spec rev B, confirmed by Precious Sithole).");
});

test("the brief records the spec versions and corrections it showed", () => {
  const b = brief(createSystem());
  assert.deepEqual(b.specVersions, [{ specId: "SPC-DP-2-delivery", version: 2 }]);
  assert.deepEqual(b.correctionIds, ["COR-H01", "COR-H02"]);
});

// each test file defines its own triage(s) helper, as in Task 4
test("the full brief holds all sections and refs, and caps corrections at three plus a count", () => {
  const s = createSystem();
  for (let i = 1; i <= 3; i++) s.ont.upsert({ id: `COR-T${i}`, type: "Correction", line: `extra ${i}`, text: `extra ${i}`, scope: { template: "dosing_pump" }, wrongValue: null, by: "P-001", at: `2026-01-0${i}T00:00:00Z` });
  const f = brief(s).full;
  assert.deepEqual(f.corrections.map((c) => c.text), ["extra 3", "extra 2", "extra 1", "and 2 more"]);
  assert.ok(f.target[0].refs.includes("SPC-DP-2-delivery"));
  assert.ok(f.open.some((x) => x.refs.includes("ISS-H04")));
  assert.ok(f.watchOuts.some((x) => x.refs.includes("KN-H08")));
  assert.ok(!f.watchOuts.some((x) => x.refs.includes("KN-H07")), "KN-H07 repeats FND-003");
  assert.ok(f.lastTime[0].refs.includes("WO-26013"));
});

test("after a confirmation the full brief lists what changed since the last job", () => {
  const s = createSystem();
  triage(s);
  const p = s.ont.list("Proposal", (x) => x.action === "update_spec" && x.state === "open")[0];
  s.actions.resolve(p.id, { verdict: "approve", by: SM });
  const b = brief(s);
  assert.ok(b.full.changed.some((x) => x.refs.includes("SPC-DP-2-delivery") && /v3/.test(x.text)));
  assert.match(b.lines[1], /^Target: delivery at 60% stroke 128\.25–141\.75 L\/h \(Coag dosing after the storm, confirmed by Precious Sithole\)/);
});

test("an asset with nothing to say gives an empty brief", () => {
  const s = createSystem(), f01 = s.ont.list("Asset").find((a) => a.positionTag === "F01");
  s.ont.upsert({ id: "WO-T1", type: "WorkOrder", kind: "CM", assetId: f01.id, title: "Check the F01 nozzles", state: "open", assigneeId: "P-032" });
  assert.deepEqual(jobBrief(s.ont.view(P032), "WO-T1", {}).lines, []);
});

test("a technician's brief never holds source text", () => {
  const s = createSystem();
  triage(s);
  const b = brief(s);
  assert.ok(!JSON.stringify(b).includes("Team, run DP-2"));
  assert.ok(!JSON.stringify(b).includes("delivering 125"));
});

test("a work order the viewer cannot see gives no brief", () => {
  const s = createSystem();
  assert.equal(jobBrief(s.ont.view(P032), "WO-NOPE", {}), null);
});
