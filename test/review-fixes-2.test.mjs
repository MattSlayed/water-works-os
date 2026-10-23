// Regression tests for the Phase 2 final review findings (numbers refer to review-findings.json in the plan workspace).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";

const as = (sys, id) => ({ kind: "person", id, clearance: sys.ont.get(id).clearance });
const setup = () => {
  const sys = createSystem({ seed: 7 });
  const hlpb = sys.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const survey = sys.ont.list("WorkOrder", (w) => w.title === "HLP-B: 6-monthly vibration survey")[0];
  const act = (action, params, who = "P-028") => sys.actions.invoke({ action, params, actor: as(sys, who) });
  const permit = () => { const p = act("open_permit", { assetId: hlpb.id, kind: "general", holderId: "P-028" }, "P-009"); act("record_isolation", { permitId: p.decision.objects[0], point: "x" }, "P-009"); };
  const say = (text, ch = "CHN-P-028", from = "P-028") => sys.channels.inbound(ch, from, { text });
  const finishJob = async () => { permit(); await say("start"); for (let n = 1; n <= 11; n++) await say({ 7: "done 110.02", 8: "done 64.98", 10: "done 0.5" }[n] || "done"); };
  return { sys, hlpb, survey, act, permit, say, finishJob };
};
const v3 = (sys) => sys.ont.get("PRC-CENTRIFUGAL_PUMP-v3");

test("#1: a procedure edit derives locks, readings and parts from each step's text, not its position", () => {
  const t = setup();
  const texts = v3(t.sys).steps.map((s) => ({ text: s.text }));
  assert.equal(t.act("propose_procedure_version", { procedureId: "PRC-CENTRIFUGAL_PUMP-v3", steps: [{ text: "Walk down the pump and look for leaks" }, ...texts, { text: "Hand back the permit to work and sign off" }], reason: "r" }, "P-002").status, "done");
  const v4 = t.sys.ont.get("PRC-CENTRIFUGAL_PUMP-v4");
  const by = (txt) => v4.steps.find((s) => s.text.startsWith(txt));
  assert.equal(by("Confirm the permit to work").requires.permit, true);
  assert.equal(by("Record DE and NDE vibration").requires.permit, false);
  assert.equal(by("Measure the DE bearing housing bore").requires.reading.partName, "Bearing housing");
  assert.equal(by("Inspect the shaft sleeve").requires.reading.partName, "Shaft sleeve");
  assert.equal(by("Withdraw the back pull-out unit").requires.reading, null);
  const added = by("Hand back the permit");
  assert.ok(Array.isArray(added.partNames) && added.requires && typeof added.intrusive === "boolean");
  assert.equal(by("Walk down the pump").requires.permit, true, "a new step is locked until a permit exists (safe default)");
  // an edited step with a measurement keeps its reading
  const edited = texts.map((s, i) => (i === 7 ? { text: "Inspect the shaft sleeve under the seal face and measure the OD at three points" } : s));
  const t2 = setup();
  t2.act("propose_procedure_version", { procedureId: "PRC-CENTRIFUGAL_PUMP-v3", steps: edited, reason: "r" }, "P-002");
  assert.equal(t2.sys.ont.get("PRC-CENTRIFUGAL_PUMP-v4").steps[7].requires.reading.partName, "Shaft sleeve");
  // after release, the Copilot still opens on a part
  assert.equal(t.act("release_procedure", { procedureId: "PRC-CENTRIFUGAL_PUMP-v4" }, "P-001").status, "done");
  const sleeve = t.sys.ont.list("Part", (p) => p.assetId === t.hlpb.id && p.name === "Shaft sleeve")[0];
  assert.ok(t.sys.copilot.open({ assetId: t.hlpb.id, partId: sleeve.id, user: { id: "P-028", clearance: "technician" } }).insight);
});

test("#2: 'no' to the note question still brings the job card; 'ok …' is the note; a command is not taken as a note", async () => {
  const a = setup();
  await a.finishJob();
  const no = await a.say("No, nothing to add");
  assert.equal(a.sys.ont.list("KnowledgeNote", (n) => n.authorId === "P-028" && n.executionId).length, 0);
  assert.equal(a.sys.ont.list("Draft", (d) => d.kind === "job-card").length, 1);
  assert.match(no.followUps[0].text, /Submit as is/);
  const b = setup();
  await b.finishJob();
  await b.say("Ok the sleeve was tight");
  assert.equal(b.sys.ont.list("KnowledgeNote", (n) => n.authorId === "P-028" && n.executionId).pop().text, "Ok the sleeve was tight");
  const c = setup();
  await c.finishJob();
  const st = await c.say("start");
  assert.equal(c.sys.ont.list("KnowledgeNote", (n) => n.text === "start").length, 0);
  assert.match(st.replies[0].text, /No open job/);
  assert.equal(c.sys.ont.list("Draft", (d) => d.kind === "job-card").length, 1);
});

test("#2: a hedged 'sure, but …' is not consent to submit", async () => {
  const t = setup();
  await t.finishJob();
  await t.say("Check under the seal face.");
  await t.say("Sure, but let me read it first");
  assert.equal(t.sys.ont.list("Draft", (d) => d.kind === "job-card")[0].state, "draft");
});

test("#3: finishing the job closes the work order, so the next start does not rerun it", async () => {
  const t = setup();
  await t.finishJob();
  const wo = t.sys.ont.get(t.survey.id);
  assert.equal(wo.state, "closed");
  assert.equal(wo.closed, t.sys.tel.now().slice(0, 10));
});

test("#4: only the latest step can be reversed, and reversing a claim leaves later confirmations alone", () => {
  const t = setup();
  t.permit();
  const ex = t.act("start_execution", { workOrderId: t.survey.id, personId: "P-028" }).decision.objects[0];
  const d1 = t.act("complete_step", { executionId: ex, step: 1 }).decision.id;
  const d2 = t.act("complete_step", { executionId: ex, step: 2 }).decision.id;
  assert.equal(t.sys.actions.reverse(d1, as(t.sys, "P-009")).status, "refused");
  assert.equal(t.sys.ont.get(ex).steps[1].state, "done");
  assert.equal(t.sys.actions.reverse(d2, as(t.sys, "P-009")).status, "done");
  assert.equal(t.sys.ont.get(ex).steps[1].state, "todo");
  assert.equal(t.sys.ont.get(ex).steps[0].state, "done");
  const claim = t.sys.actions.invoke({ action: "record_progress_claim", params: { projectId: "PRJ-CL3", milestoneId: "M3", messageId: "MSG-H05", text: "x" }, actor: { kind: "agent", id: "Chat Intake", clearance: "technician", onBehalfOf: "PAR-001" }, autonomy: "act" }).decision.id;
  t.act("confirm_milestone", { projectId: "PRJ-CL3", milestoneId: "M2" }, "P-009");
  assert.equal(t.sys.actions.reverse(claim, as(t.sys, "P-001")).status, "done");
  const ms = t.sys.ont.get("PRJ-CL3").milestones;
  assert.equal(ms.find((m) => m.id === "M2").confirmedBy, "P-009");
  assert.equal(ms.find((m) => m.id === "M3").claimedAt, null);
});

test("#5: a decimal comma reading is read whole", async () => {
  const t = setup();
  t.permit();
  await t.say("start");
  for (let n = 1; n <= 6; n++) await t.say("done");
  const r = await t.say("done 110,065 mm");
  assert.match(r.replies[0].text, /0\.03 mm over/);
});

test("#6: Ask still answers an asset question that shares a word with a project title", () => {
  const sys = createSystem({ seed: 7 });
  const r = sys.runtime.run("Ask", { actingUser: { id: "SYSTEM", clearance: "manager" }, mission: "How is the clarifier drive CL-1 doing?" });
  assert.match(r.outputs[0].text, /CL-1/);
  assert.doesNotMatch(r.outputs[0].text, /refurbishment/);
});

test("#11: asking the works number where a project stands gets the project status", async () => {
  const t = setup();
  const r = await t.say("Where is the CL-3 refurb?", "CHN-P-001", "P-001");
  assert.match(r.replies[0].text, /Clarifier 3 scraper drive refurbishment/);
  assert.match(r.replies[0].text, /milestones claimed/);
});

test("#20: a job card's text is not readable through its Decision", () => {
  const t = setup();
  t.sys.runtime.run("Scribe", { actingUser: { id: "P-028", clearance: "technician" }, scope: { executionId: t.sys.ont.list("Execution", (e) => e.personId === "P-028")[0].id } });
  const dec = t.sys.ont.list("Decision", (d) => d.action === "draft_document" && d.params.kind === "job-card").pop();
  assert.equal(t.sys.ont.view({ id: "P-029", clearance: "technician" }).get(dec.id), null);
});

test("#21: a run that read someone's private records is visible only to that audience", () => {
  const t = setup();
  const run = t.sys.runtime.run("Scribe", { actingUser: { id: "P-028", clearance: "technician" }, scope: { executionId: t.sys.ont.list("Execution", (e) => e.personId === "P-028")[0].id } });
  assert.equal(t.sys.ont.view({ id: "P-029", clearance: "technician" }).get(run.id), null);
  assert.ok(t.sys.ont.view({ id: "P-028", clearance: "technician" }).get(run.id));
});

test("#22: only the person who acted, or a supervisor, reverses a decision", () => {
  const t = setup();
  const d = t.act("start_execution", { workOrderId: t.survey.id, personId: "P-028" }).decision.id;
  assert.match(t.sys.actions.reverse(d, as(t.sys, "P-029")).reason, /person who did it or a supervisor/);
  assert.equal(t.sys.actions.reverse(d, as(t.sys, "P-009")).status, "done");
});

test("#23: a technician cannot start a job assigned to someone else", () => {
  const t = setup();
  assert.match(t.act("start_execution", { workOrderId: t.survey.id, personId: "P-029" }, "P-029").reason, /assigned to P-028/);
});

test("#24: submission is checked against the draft's owner, not a claimed one; nobody submits another person's card", () => {
  const t = setup();
  const d = t.sys.actions.invoke({ action: "draft_document", params: { kind: "job-card", title: "x", body: "b", data: { onBehalfOf: "P-028" } }, actor: { kind: "agent", id: "Scribe", clearance: "technician", onBehalfOf: "P-028" }, autonomy: "act" }).decision.objects[0];
  assert.match(t.act("submit_document", { documentId: d, onBehalfOf: "P-029" }, "P-029").reason, /P-028/);
  assert.match(t.act("submit_document", { documentId: d, onBehalfOf: "P-028" }, "P-009").reason, /their own/);
  assert.equal(t.act("submit_document", { documentId: d, onBehalfOf: "P-028" }).status, "done");
});

test("#25: group messages that are not progress or an issue are not stored", async () => {
  const t = setup();
  const n = t.sys.ont.list("Message").length;
  const r = await t.say("Is anyone coming to the braai, or is the gearbox still broken?", "CHN-GRP-CL3", "PAR-002");
  assert.equal(r.outcome, "dropped");
  assert.equal(r.message, null);
  assert.equal(t.sys.ont.list("Message").length, n);
});
