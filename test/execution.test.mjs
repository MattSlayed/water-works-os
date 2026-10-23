import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { bandCheck } from "../src/functions.mjs";

const as = (sys, id) => ({ kind: "person", id, clearance: sys.ont.get(id).clearance });
const setup = () => {
  const sys = createSystem({ seed: 7 });
  const hlpb = sys.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const wo = sys.ont.list("WorkOrder", (w) => w.title === "HLP-B: 6-monthly vibration survey")[0];
  const act = (action, params, who = "P-028") => sys.actions.invoke({ action, params, actor: as(sys, who) });
  return { sys, hlpb, wo, act };
};
const permitOn = ({ sys, hlpb, act }) => {
  const p = act("open_permit", { assetId: hlpb.id, kind: "general", holderId: "P-028" }, "P-009");
  act("record_isolation", { permitId: p.decision.objects[0], point: "MCC-2 feeder 4" }, "P-009");
};
const start = (t) => {
  const r = t.act("start_execution", { workOrderId: t.wo.id, personId: "P-028" });
  assert.equal(r.status, "done", r.reason);
  return t.sys.ont.get(r.decision.objects[0]);
};

test("start pins the released version and moves the work order to in_progress", () => {
  const t = setup();
  const ex = start(t);
  assert.equal(ex.type, "Execution");
  assert.equal(ex.procedureId, "PRC-CENTRIFUGAL_PUMP-v3");
  assert.equal(ex.procedureVersion, 3);
  assert.equal(ex.state, "running");
  assert.equal(ex.startedAt, t.sys.tel.now());
  assert.equal(ex.steps.length, 11);
  assert.equal(t.sys.ont.get(t.wo.id).state, "in_progress");
  assert.equal(t.act("start_execution", { workOrderId: t.wo.id, personId: "P-028" }).status, "refused");
});

test("step 1 is locked without a permit; P-009 opens permit and isolation; step 1 completes", () => {
  const t = setup();
  const ex = start(t);
  const locked = t.act("complete_step", { executionId: ex.id, step: 1 });
  assert.equal(locked.status, "refused");
  assert.match(locked.reason, /permit/);
  permitOn(t);
  t.sys.tel.tick(12);
  const ok = t.act("complete_step", { executionId: ex.id, step: 1 });
  assert.equal(ok.status, "done", ok.reason);
  const s1 = t.sys.ont.get(ex.id).steps[0];
  assert.equal(s1.state, "done");
  assert.equal(s1.minutes, 12);
});

test("out-of-order and someone else's steps are refused", () => {
  const t = setup();
  const ex = start(t);
  permitOn(t);
  assert.match(t.act("complete_step", { executionId: ex.id, step: 3 }).reason, /next step is 1/);
  assert.equal(t.act("complete_step", { executionId: ex.id, step: 1 }, "P-029").status, "refused");
  assert.equal(t.act("complete_step", { executionId: ex.id, step: 1 }, "P-009").status, "done");
});

test("a reading step needs its value, writes a Reading, and the band check flags 110.065 mm", () => {
  const t = setup();
  const ex = start(t);
  permitOn(t);
  for (let n = 1; n <= 6; n++) assert.equal(t.act("complete_step", { executionId: ex.id, step: n }).status, "done", `step ${n}`);
  assert.match(t.act("complete_step", { executionId: ex.id, step: 7 }).reason, /reading/);
  const r = t.act("complete_step", { executionId: ex.id, step: 7, value: 110.065 });
  assert.equal(r.status, "done", r.reason);
  const rdg = t.sys.ont.get(t.sys.ont.get(ex.id).steps[6].readingId);
  assert.equal(rdg.type, "Reading");
  assert.equal(rdg.value, 110.065);
  assert.equal(rdg.unit, "mm");
  const part = t.sys.ont.get(rdg.targetId);
  assert.equal(part.name, "Bearing housing");
  assert.deepEqual(bandCheck(part, 110.065), { inBand: false, side: "over", by: 0.03, finding: "DE bore diameter 110.065 mm, 0.03 mm over the band 110–110.035" });
  assert.equal(bandCheck(part, 110.01).inBand, true);
});

test("finishing the last step closes the execution", () => {
  const t = setup();
  const ex = start(t);
  permitOn(t);
  const values = { 7: 110.02, 8: 64.98, 10: 0.5 };
  for (let n = 1; n <= 11; n++) assert.equal(t.act("complete_step", { executionId: ex.id, step: n, value: values[n] }).status, "done", `step ${n}`);
  const done = t.sys.ont.get(ex.id);
  assert.equal(done.state, "done");
  assert.equal(done.finishedAt, t.sys.tel.now());
});

test("a procedure superseded mid-job keeps the pinned version; a new start gets the new one", () => {
  const t = setup();
  const ex = start(t);
  const v3 = t.sys.ont.get("PRC-CENTRIFUGAL_PUMP-v3");
  assert.equal(t.act("propose_procedure_version", { procedureId: v3.id, steps: v3.steps, reason: "r" }, "P-002").status, "done");
  assert.equal(t.act("release_procedure", { procedureId: "PRC-CENTRIFUGAL_PUMP-v4" }, "P-001").status, "done");
  assert.equal(t.sys.ont.get(ex.id).procedureId, "PRC-CENTRIFUGAL_PUMP-v3");
  permitOn(t);
  assert.equal(t.act("complete_step", { executionId: ex.id, step: 1 }).status, "done");
  const hlpa = t.sys.ont.list("Asset", (a) => a.positionTag === "HLP-A")[0];
  const wo2 = t.act("create_work_order", { assetId: hlpa.id, title: "HLP-A check" }, "P-001").decision.objects[0];
  const ex2 = t.sys.ont.get(t.act("start_execution", { workOrderId: wo2, personId: "P-028" }).decision.objects[0]);
  assert.equal(ex2.procedureVersion, 4);
});

test("executions are visible to the person, their supervisor, engineers and the manager only", () => {
  const t = setup();
  const ex = start(t);
  const sees = (id) => !!t.sys.ont.view({ id, clearance: t.sys.ont.get(id).clearance }).get(ex.id);
  assert.ok(sees("P-028") && sees("P-009") && sees("P-002") && sees("P-001"));
  assert.ok(!sees("P-029") && !sees("P-008"));
});

test("issues: raised by the actor; a technician cannot move someone else's; a supervisor can", () => {
  const t = setup();
  const r = t.act("raise_issue", { title: "Sleeve scored, not on the job", assetId: t.hlpb.id, raisedBy: "P-001" });
  assert.equal(r.status, "done", r.reason);
  const iss = t.sys.ont.get(r.decision.objects[0]);
  assert.equal(iss.type, "Issue");
  assert.equal(iss.state, "open");
  assert.equal(iss.raisedBy, "P-028");
  assert.match(t.act("update_issue", { issueId: iss.id, patch: { state: "triaged" } }, "P-029").reason, /raiser or a supervisor/);
  assert.equal(t.act("update_issue", { issueId: iss.id, patch: { state: "triaged" } }, "P-028").status, "done");
  assert.equal(t.act("update_issue", { issueId: iss.id, patch: { state: "in_work", assigneeId: "P-030" } }, "P-009").status, "done");
  assert.match(t.act("update_issue", { issueId: iss.id, patch: { state: "lost" } }, "P-009").reason, /state/);
  assert.match(t.act("update_issue", { issueId: iss.id, patch: { raisedBy: "P-001" } }, "P-009").reason, /patch/);
});

test("an engineer verifies a knowledge note and it becomes a verified Finding the Copilot cites", async () => {
  const t = setup();
  const sleeve = t.sys.ont.list("Part", (p) => p.assetId === t.hlpb.id && p.name === "Shaft sleeve")[0];
  const n = t.act("add_knowledge_note", { text: "Check the sleeve under the seal face; scoring hides there.", partId: sleeve.id, procedureId: "PRC-CENTRIFUGAL_PUMP-v3", step: 8 });
  assert.equal(n.status, "done", n.reason);
  const note = t.sys.ont.get(n.decision.objects[0]);
  assert.equal(note.authorId, "P-028");
  assert.equal(note.assetId, t.hlpb.id);
  assert.equal(t.act("verify_knowledge_note", { noteId: note.id }, "P-009").status, "refused");
  const v = t.act("verify_knowledge_note", { noteId: note.id }, "P-002");
  assert.equal(v.status, "done", v.reason);
  const f = t.sys.ont.get(t.sys.ont.get(note.id).promotedTo);
  assert.equal(f.type, "Finding");
  assert.equal(f.verified, true);
  const s = t.sys.copilot.open({ assetId: t.hlpb.id, user: { id: "P-028", clearance: "technician" } });
  assert.ok(s.insight.notes.some((x) => x.id === note.id));
  const ans = await s.ask("what happened before");
  assert.match(ans.answer, new RegExp(note.id));
});
