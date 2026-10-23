import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { performanceFor, projectStatus } from "../src/functions.mjs";

const SYS = { id: "SYSTEM", clearance: "manager" };
const as = (sys, id) => ({ kind: "person", id, clearance: sys.ont.get(id).clearance });
const perf = (sys, scope) => performanceFor(scope, sys.ont.list("Execution"), sys.ont.list("Procedure"), sys.ont.list("Issue"), sys.ont.list("KnowledgeNote"));

test("performanceFor a procedure: step 6 runs well over its estimate; step 8 carries the notes", () => {
  const sys = createSystem({ seed: 7 });
  const p = perf(sys, { procedureId: "PRC-CENTRIFUGAL_PUMP-v3" });
  assert.ok(p.executions >= 5);
  const s6 = p.steps.find((s) => s.step === 6);
  assert.equal(s6.expected, 45);
  assert.ok(s6.ratio >= 1.5, `ratio ${s6.ratio}`);
  const s8 = p.steps.find((s) => s.step === 8);
  assert.equal(s8.notes, 3);
  assert.equal(s8.issues, 1);
  assert.equal(p.firstTimeRight, 1);
});

test("performanceFor a person: their own jobs, issues and notes; nothing for someone with no jobs", () => {
  const sys = createSystem({ seed: 7 });
  const who = sys.ont.list("Execution")[0].personId;
  const p = perf(sys, { personId: who });
  assert.equal(p.executions, sys.ont.list("Execution", (e) => e.personId === who).length);
  assert.ok(p.steps.every((s) => s.procedureId && s.median > 0));
  assert.equal(p.issuesRaised, sys.ont.list("Issue", (i) => i.raisedBy === who).length);
  assert.equal(p.notesContributed, sys.ont.list("KnowledgeNote", (n) => n.authorId === who).length);
  const none = perf(sys, { personId: "P-001" });
  assert.deepEqual({ executions: none.executions, firstTimeRight: none.firstTimeRight, steps: none.steps }, { executions: 0, firstTimeRight: null, steps: [] });
});

test("an out-of-band reading on a job counts against first-time-right", () => {
  const sys = createSystem({ seed: 7 });
  const hlpb = sys.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const wo = sys.ont.list("WorkOrder", (w) => w.title === "HLP-B: 6-monthly vibration survey")[0];
  const act = (action, params, who = "P-028") => sys.actions.invoke({ action, params, actor: as(sys, who) });
  const pt = act("open_permit", { assetId: hlpb.id, kind: "general", holderId: "P-028" }, "P-009").decision.objects[0];
  act("record_isolation", { permitId: pt, point: "x" }, "P-009");
  const ex = act("start_execution", { workOrderId: wo.id, personId: "P-028" }).decision.objects[0];
  const values = { 7: 110.065, 8: 64.98, 10: 0.5 };
  for (let n = 1; n <= 11; n++) act("complete_step", { executionId: ex, step: n, value: values[n] });
  assert.equal(sys.ont.get(ex).steps[6].inBand, false);
  const p = perf(sys, { personId: "P-028" });
  assert.ok(p.firstTimeRight < 1);
});

test("projectStatus of the seeded contract: quiet, two claimed, one confirmed, one open issue", () => {
  const sys = createSystem({ seed: 7 });
  const st = projectStatus(sys.ont.get("PRJ-CL3"), sys.ont.list("ProgressClaim"), sys.ont.list("Issue"), sys.tel.now());
  assert.equal(st.lastReportAt, "2026-10-10T16:40:00Z");
  assert.equal(st.daysSinceReport, 3);
  assert.equal(st.quiet, true);
  assert.deepEqual(st.milestones, { total: 6, claimed: 2, confirmed: 1 });
  assert.equal(st.openIssues, 1);
  assert.equal(st.end, "2026-11-06");
  assert.deepEqual(st.overdue, ["M2"]);
});

test("Scribe: drafts a job card and asks P-028 (no consent); submits for P-030 (consented)", () => {
  const sys = createSystem({ seed: 7 });
  const card = (who) => {
    const e = sys.ont.list("Execution", (x) => x.state === "done")[0];
    sys.ont.upsert({ id: e.id, type: "Execution", personId: who, audience: [who] });
    sys.runtime.run("Scribe", { actingUser: { id: who, clearance: "technician" }, scope: { executionId: e.id } });
    return sys.ont.list("Draft", (d) => d.kind === "job-card").pop();
  };
  const d28 = card("P-028");
  assert.equal(d28.state, "draft");
  assert.match(d28.body, /Step 1/);
  const ask = sys.ont.list("Message", (m) => m.channelId === "CHN-P-028" && m.direction === "out").pop();
  assert.match(ask.text, /Submit as is\? \(yes\/no\)/);
  assert.deepEqual(ask.awaiting, { kind: "submit", draftId: d28.id });
  const d30 = card("P-030");
  assert.equal(d30.state, "submitted");
  assert.equal(d30.submittedFor, "P-030");
});

test("J8 end to end: the note brings the job card, and yes submits it under the artisan's name", async () => {
  const sys = createSystem({ seed: 7 });
  const hlpb = sys.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const pt = sys.actions.invoke({ action: "open_permit", params: { assetId: hlpb.id, kind: "general", holderId: "P-028" }, actor: as(sys, "P-009") }).decision.objects[0];
  sys.actions.invoke({ action: "record_isolation", params: { permitId: pt, point: "x" }, actor: as(sys, "P-009") });
  const say = (text) => sys.channels.inbound("CHN-P-028", "P-028", { text });
  await say("start");
  for (let n = 1; n <= 11; n++) await say({ 7: "done 110.02", 8: "done 64.98", 10: "done 0.5" }[n] || "done");
  const note = await say("Check under the seal face.");
  assert.equal(note.replies.length, 1);
  assert.equal(note.followUps.length, 1);
  assert.match(note.followUps[0].text, /Submit as is/);
  const yes = await say("yes");
  const card = sys.ont.list("Draft", (d) => d.kind === "job-card").pop();
  assert.equal(card.state, "submitted");
  assert.equal(card.submittedBy, "P-028");
  assert.match(yes.replies[0].text, /Submitted/);
});

test("Scribe: an issue close-out is drafted and never submitted; a project report waits for the owner", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Scribe", { actingUser: SYS, scope: { issueId: "ISS-H06" } });
  const c = sys.ont.list("Draft", (d) => d.kind === "issue-closeout").pop();
  assert.equal(c.state, "draft");
  assert.match(c.body, /gasket/);
  sys.runtime.run("Scribe", { actingUser: SYS, scope: { projectId: "PRJ-CL3" } });
  const w = sys.ont.list("Draft", (d) => d.kind === "weekly-report").pop();
  assert.equal(w.state, "draft");
  assert.match(w.body, /2 of 6 milestones claimed, 1 confirmed/);
  assert.ok(sys.ont.list("Notification", (n) => n.aboutId === w.id && n.to.includes("P-004")).length);
});

test("Project Watch: one quiet-project notice per plant day; the weekly status posts on Friday afternoon only", () => {
  const sys = createSystem({ seed: 7 });
  const run = () => sys.runtime.run("Project Watch", { actingUser: SYS });
  run(); run();
  const quiet = sys.ont.list("Notification", (n) => n.aboutId === "PRJ-CL3" && /quiet/i.test(n.message));
  assert.equal(quiet.length, 1);
  assert.deepEqual([...quiet[0].to].sort(), ["P-001", "P-004"]);
  assert.ok(sys.ont.view({ id: "P-004", clearance: "supervisor" }).get(quiet[0].id), "the planner sees a notice addressed to them");
  assert.equal(sys.ont.view({ id: "P-028", clearance: "technician" }).get(quiet[0].id), null);
  const posts = () => sys.ont.list("Message", (m) => m.channelId === "CHN-GRP-CL3" && m.direction === "out");
  assert.equal(posts().length, 0);
  sys.tel.tick(57 * 60); // Friday 2026-10-16 15:00
  run(); run();
  assert.equal(posts().length, 1);
  assert.match(posts()[0].text, /CL-3|Clarifier 3/);
  assert.match(posts()[0].text, /2 of 6 milestones claimed/);
  assert.equal(sys.ont.list("Notification", (n) => n.aboutId === "PRJ-CL3" && /quiet/i.test(n.message)).length, 2);
});

test("Procedure Steward flags steps, not people, once a week", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Procedure Steward", { actingUser: SYS });
  sys.runtime.run("Procedure Steward", { actingUser: SYS });
  const n = sys.ont.list("Notification", (x) => x.aboutId === "PRC-CENTRIFUGAL_PUMP-v3");
  assert.equal(n.length, 1);
  assert.match(n[0].message, /step 6/);
  assert.match(n[0].message, /step 8/);
  assert.doesNotMatch(n[0].message, /P-0\d\d/);
  assert.deepEqual([...n[0].to].sort(), ["P-002", "P-003"]);
});

test("Ask answers where a project stands", () => {
  const sys = createSystem({ seed: 7 });
  const r = sys.runtime.run("Ask", { actingUser: SYS, mission: "Where is the CL-3 refurb?" });
  const a = r.outputs[0];
  assert.match(a.text, /Clarifier 3 scraper drive refurbishment/);
  assert.match(a.text, /2026-11-06/);
  assert.match(a.text, /3 days/);
  assert.ok(a.cites.includes("PRJ-CL3"));
});
