import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { stepLock, currentProcedure } from "../src/functions.mjs";

const person = (sys, id) => { const p = sys.ont.get(id); return { kind: "person", id, clearance: p.clearance }; };

test("every SOP template has a released v3 procedure with locks and readings", () => {
  const sys = createSystem({ seed: 7 });
  const p = sys.ont.get("PRC-CENTRIFUGAL_PUMP-v3");
  assert.equal(p.type, "Procedure");
  assert.equal(p.state, "released");
  assert.equal(p.version, 3);
  assert.equal(p.steps.length, 11);
  assert.equal(p.steps[0].requires.permit, true);
  assert.equal(p.steps[1].requires.permit, false);
  assert.equal(p.steps[6].requires.reading.partName, "Bearing housing");
  assert.equal(p.steps[6].requires.reading.unit, "mm");
  assert.equal(p.steps[5].expectedMinutes, 45);
  assert.equal(p.steps[0].id, "PRC-CENTRIFUGAL_PUMP-v3-S01");
  for (const tpl of ["BLOWER", "DOSING_PUMP", "CLARIFIER_DRIVE"]) assert.equal(sys.ont.get(`PRC-${tpl}-v3`).state, "released", tpl);
  assert.equal(sys.ont.list("ProcedureStep").length, 0);
  assert.equal(currentProcedure(sys.ont.list("Procedure"), "centrifugal_pump").id, p.id);
});

test("SOP documents carry their SharePoint source", () => {
  const d = createSystem({ seed: 7 }).ont.get("DOC-SOP-CENTRIFUGAL_PUMP");
  assert.equal(d.sourceRef.system, "sharepoint");
  assert.equal(d.sourceRef.revision, "C");
  assert.equal(d.sourceBehind, false);
});

test("stepLock withholds a permit step until permit and isolation exist", () => {
  const s = createSystem({ seed: 7 }).ont.get("PRC-CENTRIFUGAL_PUMP-v3").steps[2];
  const l = stepLock(s, { permit: null, isolated: false });
  assert.equal(l.locked, true);
  assert.match(l.reason, /permit/);
  assert.equal(stepLock(s, { permit: { id: "PTW-1" }, isolated: false }).locked, true);
  assert.deepEqual(stepLock(s, { permit: { id: "PTW-1" }, isolated: true }), { locked: false, reason: null });
});

test("people seed: supervisors, consent flag, author competence and the HLP-B survey assigned to P-028", () => {
  const sys = createSystem({ seed: 7 });
  assert.equal(sys.ont.get("P-028").role, "millwright");
  assert.equal(sys.ont.get("P-028").supervisorId, "P-009");
  assert.equal(sys.ont.list("Person", (p) => p.role === "fitter")[0].supervisorId, "P-008");
  assert.equal(sys.ont.get("P-030").autoSubmit, true);
  assert.equal(sys.ont.get("P-028").autoSubmit, false);
  assert.ok(sys.ont.list("Competency", (c) => c.personId === "P-002" && c.competency === "c-author").length);
  const survey = sys.ont.list("WorkOrder", (w) => w.title === "HLP-B: 6-monthly vibration survey")[0];
  assert.equal(survey.assigneeId, "P-028");
});

test("engineer with c-author proposes v4; manager releases; SOP flagged behind", () => {
  const sys = createSystem({ seed: 7 });
  const v3 = sys.ont.get("PRC-CENTRIFUGAL_PUMP-v3");
  const steps = v3.steps.map((s) => (s.step === 8 ? { ...s, text: "Inspect the shaft sleeve for scoring and fretting; measure the OD at three points" } : s));
  const p = sys.actions.invoke({ action: "propose_procedure_version", params: { procedureId: v3.id, steps, reason: "Three field notes on sleeve scoring" }, actor: person(sys, "P-002") });
  assert.equal(p.status, "done", p.reason);
  const v4 = sys.ont.get("PRC-CENTRIFUGAL_PUMP-v4");
  assert.equal(v4.state, "draft");
  assert.equal(v4.version, 4);
  assert.equal(v4.steps[7].id, "PRC-CENTRIFUGAL_PUMP-v4-S08");
  const r = sys.actions.invoke({ action: "release_procedure", params: { procedureId: v4.id }, actor: person(sys, "P-001") });
  assert.equal(r.status, "done", r.reason);
  assert.equal(sys.ont.get(v4.id).state, "released");
  assert.equal(sys.ont.get(v3.id).state, "superseded");
  assert.equal(sys.ont.get("DOC-SOP-CENTRIFUGAL_PUMP").sourceBehind, true);
  assert.equal(currentProcedure(sys.ont.list("Procedure"), "centrifugal_pump").id, v4.id);
});

test("proposing a version needs the c-author competence and is human-only", () => {
  const sys = createSystem({ seed: 7 });
  const v3 = sys.ont.get("PRC-CENTRIFUGAL_PUMP-v3");
  const params = { procedureId: v3.id, steps: v3.steps, reason: "x" };
  const m = sys.actions.invoke({ action: "propose_procedure_version", params, actor: person(sys, "P-001") });
  assert.equal(m.status, "refused");
  assert.match(m.reason, /c-author/);
  const a = sys.actions.invoke({ action: "propose_procedure_version", params, actor: { kind: "agent", id: "Procedure Steward", clearance: "manager" } });
  assert.match(a.reason, /human-only/);
  const t = sys.actions.invoke({ action: "release_procedure", params: { procedureId: v3.id }, actor: person(sys, "P-002") });
  assert.match(t.reason, /manager/);
});

test("Copilot next checks and the asset model read the released procedure", async () => {
  const sys = createSystem({ seed: 7 });
  const hlpb = sys.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const s = sys.copilot.open({ assetId: hlpb.id, user: { id: "P-028", clearance: "technician" } });
  const res = await s.ask("what should I check next");
  assert.ok(res.checks.length > 0);
  assert.match(res.withheld, /permit/);
  assert.equal(s.insight.allSteps[0].id, "PRC-CENTRIFUGAL_PUMP-v3-S01");
});
