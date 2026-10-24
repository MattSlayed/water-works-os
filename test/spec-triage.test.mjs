// Plan 4 Task 4: the Spec Triage agent, update_spec for the site manager alone, corrections and reject memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { runEvals } from "../src/evals.mjs";

const SM = { id: "P-001", kind: "person", clearance: "manager", role: "works_manager" };
const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance, role: s.ont.get(id).role });
const triage = (s, scope) => s.runtime.run("Spec Triage", { actingUser: SM, chain: false, scope });
const open = (s) => s.ont.list("Proposal", (x) => x.action === "update_spec" && x.state === "open");
const dp = (s, tag) => s.ont.list("Asset").find((a) => a.positionTag === tag);

test("J29: triage proposes DP-2 delivery 128.25–141.75 from the mail and passes over four", () => {
  const s = createSystem();
  assert.equal(triage(s).status, "completed");
  const p = open(s);
  assert.deepEqual(p.map((x) => [x.params.specId, x.params.lo, x.params.hi, x.params.target, x.approver]), [["SPC-DP-2-delivery", 128.25, 141.75, 135, "P-001"]]);
  assert.equal(p[0].params.sourceId, "M365-WRK-001");
  assert.equal(p[0].params.condition, "raw turbidity settles");
  assert.deepEqual(p[0].params.passedOver.map((x) => x.reason).sort(), ["lower authority", "lower authority", "lower authority", "older than the site manager's instruction", "unsure"]);
  assert.equal(s.ont.get("SCD-ATT-ENG-03-DP-2").grade, "AMBIGUOUS");
  assert.equal(s.ont.get("SCD-ATT-ENG-03-DP-2").minClearance, "engineer");
});

test("DP-1 agrees with its owner spec, so it gets no proposal", () => {
  const s = createSystem();
  triage(s);
  assert.ok(!open(s).some((x) => x.params.specId === "SPC-DP-1-delivery"));
  assert.ok(s.ont.list("SpecCandidate", (c) => c.specId === "SPC-DP-1-delivery" && c.verdict === "supports").length >= 1);
});

test("triage is idempotent", () => {
  const s = createSystem();
  triage(s);
  const n = s.ont.list("SpecCandidate").length;
  triage(s);
  triage(s, { assetId: dp(s, "DP-2").id });
  assert.equal(open(s).length, 1);
  assert.equal(s.ont.list("SpecCandidate").length, n);
});

test("only the site manager confirms; a supervisor and another manager are refused", () => {
  const s = createSystem();
  triage(s);
  const p = open(s)[0];
  assert.match(s.actions.resolve(p.id, { verdict: "approve", by: as(s, "P-008") }).reason, /insufficient clearance/);
  s.ont.upsert({ id: "P-099", type: "Person", name: "Temp Planner", role: "works_planner", clearance: "manager" });
  assert.match(s.actions.resolve(p.id, { verdict: "approve", by: as(s, "P-099") }).reason, /waiting for P-001/);
  assert.equal(s.actions.resolve(p.id, { verdict: "approve", by: as(s, "P-001") }).status, "done");
  const sp = s.ont.get("SPC-DP-2-delivery");
  assert.deepEqual([sp.version, sp.lo, sp.hi, sp.target, sp.confirmedBy, sp.history.length, sp.condition, sp.sourceRefs[0].id], [3, 128.25, 141.75, 135, "P-001", 2, "raw turbidity settles", "M365-WRK-001"]);
  assert.equal(s.ont.get(p.params.candidateId).status, "approved");
  // a later run does not propose what is now confirmed
  triage(s);
  assert.equal(open(s).length, 0);
});

test("reject memory: a rejected value is not proposed again; a different value from the same source is", () => {
  const s = createSystem();
  triage(s);
  assert.equal(s.actions.resolve(open(s)[0].id, { verdict: "reject", reason: "the storm instruction was for one shift", by: as(s, "P-001") }).status, "rejected");
  triage(s);
  assert.equal(open(s).length, 0);
  const list = s.connectors.m365.mail.list;
  s.connectors.m365.mail.list = (box, o) => list(box, o).map((m) => (m.id === "M365-WRK-001" ? { ...m, body: { ...m.body, content: m.body.content.replace("135", "130") } } : m));
  triage(s);
  assert.deepEqual(open(s).map((x) => x.params.target), [130]);
});

test("record_correction is the site manager's alone and blocks the sheet's 110 on DP-2", () => {
  const s = createSystem(), dp2 = dp(s, "DP-2").id;
  const params = { line: "Dose calc sheet row DP-2 still says 110 L/h (the 2025 figure).", scope: { assetId: dp2 }, wrongSourceRef: { kind: "google.sheets", id: "Coagulant dose calc!A1:F20#3" }, wrongValue: 110 };
  assert.match(s.actions.invoke({ action: "record_correction", params, actor: as(s, "P-008") }).reason, /only the site manager|needs manager clearance/);
  const r = s.actions.invoke({ action: "record_correction", params, actor: as(s, "P-001") });
  assert.equal(r.status, "done");
  const cor = s.ont.get(r.decision.objects[0]);
  assert.deepEqual([cor.type, cor.by, cor.text], ["Correction", "P-001", params.line]);
  triage(s);
  const pass = open(s)[0].params.passedOver.find((x) => x.candidateId === "SCD-Coagulant_dose_calc_A1_F20_3-DP-2");
  assert.equal(pass.reason, `blocked by ${cor.id}`);
  assert.match(s.actions.invoke({ action: "record_correction", params: { ...params, scope: {} }, actor: as(s, "P-001") }).reason, /scope/);
});

test("the server runs triage at start and rechecks one asset on demand", async () => {
  const s = createSystem(), srv = createServer(s);
  assert.equal(open(s).length, 1);
  await new Promise((r) => srv.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/assets/${dp(s, "DP-2").id}/recheck-specs`, { method: "POST", headers: { "x-acting-user": "P-032" } });
    const j = await res.json();
    assert.equal(res.status, 200);
    assert.equal(j.proposals.length, 1);
    assert.ok(j.runId);
  } finally { srv.close(); }
});

test("evals for Spec Triage pass", async () => {
  const r = await runEvals(() => createSystem(), "Spec Triage");
  assert.ok(r.cases.length >= 5);
  assert.deepEqual(r.cases.filter((c) => !c.pass).map((c) => c.name), []);
});
