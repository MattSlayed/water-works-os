import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";

const as = (sys, id) => ({ kind: "person", id, clearance: sys.ont.get(id).clearance });
const agentFor = (name, id, clearance = "technician") => ({ kind: "agent", id: name, clearance, onBehalfOf: id });
const sees = (sys, who, id) => !!sys.ont.view({ id: who, clearance: sys.ont.get(who).clearance }).get(id);

test("seed: channels, the CL-3 contract, chat history, past jobs, issues and field notes", () => {
  const { ont } = createSystem({ seed: 7 });
  assert.equal(ont.list("Channel").length, 46); // 45 people and the CL-3 group
  assert.equal(ont.list("Participant").length, 3);
  assert.ok(!JSON.stringify(ont.list("Participant")).includes("+27"));
  const grp = ont.get("CHN-GRP-CL3");
  assert.deepEqual(grp.members, ["PAR-001", "PAR-002", "PAR-003", "P-004", "P-009"]);
  const prj = ont.get("PRJ-CL3");
  assert.equal(prj.milestones.length, 6);
  assert.equal(prj.milestones.filter((m) => m.claimedAt).length, 2);
  assert.equal(prj.milestones.filter((m) => m.confirmedAt).length, 1);
  const msgs = ont.list("Message");
  assert.ok(msgs.length >= 7);
  assert.ok(msgs.every((m) => m.prov.source === "CHANNEL-STUB" && Array.isArray(m.audience)));
  const lastContractor = msgs.filter((m) => m.channelId === "CHN-GRP-CL3" && m.from.startsWith("PAR-")).map((m) => m.at).sort().pop();
  assert.equal(lastContractor, "2026-10-10T16:40:00Z");
  assert.equal(ont.list("ProgressClaim").length, 4);
  const ex = ont.list("Execution");
  assert.equal(ex.length, 12);
  assert.ok(ex.every((e) => e.state === "done" && e.steps.every((s) => s.minutes > 0)));
  assert.ok(new Set(ex.map((e) => e.personId)).size >= 4);
  assert.ok(ex.filter((e) => e.personId === "P-028").length >= 2, "the demo artisan has past jobs to show in My work");
  assert.ok(ex.filter((e) => e.procedureId === "PRC-CENTRIFUGAL_PUMP-v3").length >= 5);
  const issues = ont.list("Issue");
  assert.equal(issues.length, 7); // six from Phase 2, and the RES-2 relining issue (Region design §4.4)
  for (const st of ["open", "triaged", "in_work", "done"]) assert.ok(issues.some((i) => i.state === st), st);
  const notes = ont.list("KnowledgeNote");
  assert.equal(notes.length, 9);
  assert.equal(notes.filter((n) => n.procedureId === "PRC-CENTRIFUGAL_PUMP-v3" && n.step === 8).length, 3);
  const hlpb = ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  assert.equal(notes.filter((n) => n.assetId === hlpb.id).length, 0);
});

test("a person's channel and messages are theirs (and the manager's); the group is its members'", () => {
  const sys = createSystem({ seed: 7 });
  assert.ok(sees(sys, "P-028", "CHN-P-028"));
  assert.ok(!sees(sys, "P-029", "CHN-P-028"));
  assert.ok(!sees(sys, "P-002", "CHN-P-028"));
  assert.ok(sees(sys, "P-001", "CHN-P-028"));
  const m = sys.ont.list("Message", (x) => x.channelId === "CHN-P-028")[0];
  assert.ok(sees(sys, "P-028", m.id) && !sees(sys, "P-029", m.id));
  assert.ok(sees(sys, "P-004", "CHN-GRP-CL3") && sees(sys, "P-009", "CHN-GRP-CL3"));
  assert.ok(!sees(sys, "P-008", "CHN-GRP-CL3"));
});

test("a contractor's progress claim is recorded against a milestone, as a claim", () => {
  const sys = createSystem({ seed: 7 });
  const r = sys.actions.invoke({ action: "record_progress_claim", params: { projectId: "PRJ-CL3", milestoneId: "M3", messageId: "MSG-H05", text: "Bearings in", evidence: ["photo:x.jpg"] }, actor: agentFor("Chat Intake", "PAR-001"), autonomy: "act" });
  assert.equal(r.status, "done", r.reason);
  const c = sys.ont.get(r.decision.objects[0]);
  assert.equal(c.type, "ProgressClaim");
  assert.equal(c.by, "PAR-001");
  assert.equal(c.confirmed, false);
  const m3 = sys.ont.get("PRJ-CL3").milestones.find((m) => m.id === "M3");
  assert.equal(m3.claimedAt, sys.tel.now());
  assert.equal(m3.confirmedAt, null);
  assert.match(sys.actions.invoke({ action: "record_progress_claim", params: { projectId: "PRJ-CL3", milestoneId: "M9", messageId: "MSG-H05", text: "x" }, actor: agentFor("Chat Intake", "PAR-001"), autonomy: "act" }).reason, /milestone/);
});

test("only a person at supervisor clearance confirms a milestone; its claims are confirmed with it", () => {
  const sys = createSystem({ seed: 7 });
  const params = { projectId: "PRJ-CL3", milestoneId: "M2" };
  assert.match(sys.actions.invoke({ action: "confirm_milestone", params, actor: agentFor("Project Watch", "SYSTEM", "manager") }).reason, /human-only/);
  assert.equal(sys.actions.invoke({ action: "confirm_milestone", params, actor: as(sys, "P-028") }).status, "refused");
  const r = sys.actions.invoke({ action: "confirm_milestone", params, actor: as(sys, "P-009") });
  assert.equal(r.status, "done", r.reason);
  const m2 = sys.ont.get("PRJ-CL3").milestones.find((m) => m.id === "M2");
  assert.equal(m2.confirmedBy, "P-009");
  assert.ok(sys.ont.list("ProgressClaim", (c) => c.milestoneId === "M2").every((c) => c.confirmed));
});

test("an agent submits paperwork only for someone who consented; a person submits their own", () => {
  const sys = createSystem({ seed: 7 });
  const draft = (forId) => sys.actions.invoke({ action: "draft_document", params: { kind: "job-card", title: "Job card", body: "b", data: { onBehalfOf: forId } }, actor: agentFor("Scribe", "SYSTEM", "manager"), autonomy: "act" }).decision.objects[0];
  const d28 = draft("P-028"), d30 = draft("P-030"), d28b = draft("P-028");
  assert.match(sys.actions.invoke({ action: "submit_document", params: { documentId: d28, onBehalfOf: "P-028" }, actor: agentFor("Scribe", "SYSTEM", "manager"), autonomy: "act" }).reason, /no consent/);
  const ok = sys.actions.invoke({ action: "submit_document", params: { documentId: d30, onBehalfOf: "P-030" }, actor: agentFor("Scribe", "SYSTEM", "manager"), autonomy: "act" });
  assert.equal(ok.status, "done", ok.reason);
  assert.equal(sys.ont.get(d30).state, "submitted");
  assert.equal(sys.ont.get(d30).submittedFor, "P-030");
  assert.match(sys.actions.invoke({ action: "submit_document", params: { documentId: d28b, onBehalfOf: "P-028" }, actor: as(sys, "P-029") }).reason, /their own|not found/);
  assert.equal(sys.actions.invoke({ action: "submit_document", params: { documentId: d28b, onBehalfOf: "P-028" }, actor: { ...as(sys, "P-028"), clearance: "manager" } }).status, "done");
  assert.match(sys.actions.invoke({ action: "submit_document", params: { documentId: d28b, onBehalfOf: "P-028" }, actor: { ...as(sys, "P-028"), clearance: "manager" } }).reason, /submitted/);
});

test("send_message: one reply per inbound, private channels stay private, only Project Watch posts to a group", () => {
  const sys = createSystem({ seed: 7 });
  const send = (params, actor) => sys.actions.invoke({ action: "send_message", params, actor, autonomy: "act" });
  const first = send({ channelId: "CHN-P-028", text: "Step 1: confirm the permit.", inReplyTo: "MSG-X1" }, agentFor("Chat Intake", "P-028"));
  assert.equal(first.status, "done", first.reason);
  const m = sys.ont.get(first.decision.objects[0]);
  assert.equal(m.direction, "out");
  assert.deepEqual(m.audience, ["P-028"]);
  assert.equal(m.at, sys.tel.now());
  assert.match(send({ channelId: "CHN-P-028", text: "again", inReplyTo: "MSG-X1" }, agentFor("Chat Intake", "P-028")).reason, /one reply/);
  assert.equal(send({ channelId: "CHN-P-028", text: "x" }, agentFor("Chat Intake", "P-029")).status, "refused");
  assert.match(send({ channelId: "CHN-GRP-CL3", text: "hello group" }, agentFor("Chat Intake", "P-004")).reason, /Project Watch/);
  assert.equal(send({ channelId: "CHN-GRP-CL3", text: "Weekly status" }, agentFor("Project Watch", "SYSTEM", "manager")).status, "done");
});
