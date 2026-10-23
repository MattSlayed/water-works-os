import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { AGENT_SPECS } from "../src/agents.mjs";
import { HARD_CONSTRAINTS, specFor, specId, specFromManifest, statementSentences, matchShadow, shadowRecord, checkWrite } from "../src/harness.mjs";
import { ACTIONS } from "../src/actions.mjs";
import { applyTimeouts } from "../src/harness.mjs";
import { runEvals } from "../src/evals.mjs";
import { createServer } from "../src/server.mjs";

const SYS = { id: "SYSTEM", kind: "person", clearance: "manager", role: "system" };
const setMode = (s, name, mode) => s.ont.upsert({ id: specId(name), type: "AgentSpec", mode });

const sys = createSystem();

test("decision statement: every agent has an AgentSpec, bounded, live, owned by P-002", () => {
  assert.equal((sys.ont.get("P-002") || {}).type, "Person");
  for (const m of AGENT_SPECS) {
    const s = specFor(sys.ont, m.name);
    assert.ok(s, m.name);
    assert.deepEqual([s.type, s.mode, s.state, s.owner], ["AgentSpec", "bounded", "live", "P-002"], m.name);
    assert.deepEqual(Object.fromEntries(s.tools.map((t) => [t.action, t.level])), m.autonomy, m.name);
    assert.ok(s.tools.every((t) => t.enabled === true), m.name);
  }
});

test("decision statement: Process Watch reads back in plain sentences", () => {
  const lines = statementSentences(specFor(sys.ont, "Process Watch"), sys.ont);
  const text = lines.join(" ");
  assert.match(text, /every 5 min/);
  assert.match(text, /without asking/);
  assert.match(text, /never writes to the control system/);
  assert.match(text, /If nobody answers, nothing happens/);
  assert.ok(!/undefined|null/.test(text), text);
});

test("decision statement: hard constraints cannot be removed", () => {
  const s = specFor(sys.ont, "Process Watch");
  sys.ont.upsert({ id: s.id, type: "AgentSpec", constraints: s.constraints.filter((c) => c !== "permit-holder") });
  assert.deepEqual(specFor(sys.ont, "Process Watch").constraints.slice().sort(), HARD_CONSTRAINTS.map((c) => c.id).sort());
});

test("shadow mode: Process Watch records what it would do and invokes nothing", () => {
  const s = createSystem();
  setMode(s, "Process Watch", "shadow");
  const mine = (t) => s.ont.list(t, (o) => o.actorId === "Process Watch").length;
  const alerts = s.ont.list("Alert").length, props = s.ont.list("Proposal").length;
  const run = s.runtime.run("Process Watch", { actingUser: SYS, chain: false });
  assert.equal(run.status, "completed");
  assert.equal(s.ont.list("Alert").length, alerts);
  assert.equal(s.ont.list("Proposal").length, props);
  assert.equal(mine("Decision"), 0);
  const sha = s.ont.list("ShadowAction", (x) => x.agent === "Process Watch");
  assert.ok(sha.some((x) => x.action === "raise_alert") && sha.every((x) => x.status === "pending" && /^SHA-/.test(x.id) && x.runId === run.id), JSON.stringify(sha));

  // a person raises the same alert on F07: agreed; 24 h later with no other decision, the rest are missed
  const f07 = sha.find((x) => x.action === "raise_alert" && s.ont.get(x.params.targetId).positionTag === "F07");
  assert.ok(f07, "a shadow alert on F07");
  const p = s.ont.get("P-004");
  assert.equal(s.actions.invoke({ action: "raise_alert", params: { targetId: f07.params.targetId, title: "F07 turbidity rising" }, actor: { kind: "person", id: p.id, clearance: p.clearance } }).status, "done");
  matchShadow(s.ont, s.tel.now());
  assert.equal(s.ont.get(f07.id).status, "agreed");
  assert.deepEqual(shadowRecord(s.ont, "Process Watch"), { cases: 1, agreed: 1, differed: 0, missed: 0, agreePct: 100 });
  s.tel.tick(24 * 60 + 1);
  matchShadow(s.ont, s.tel.now());
  const rest = s.ont.list("ShadowAction", (x) => x.agent === "Process Watch" && x.id !== f07.id);
  assert.ok(rest.length && rest.every((x) => x.status === "missed"), JSON.stringify(rest.map((x) => x.status)));
});

test("assisted mode: Maintenance Triage's rank_alert (act) becomes a proposal", () => {
  const s = createSystem();
  s.runtime.run("Asset Watch", { actingUser: SYS, chain: false });
  const alert = s.ont.list("Alert", (a) => a.assetId && s.ont.get(a.assetId).positionTag === "HLP-B")[0];
  setMode(s, "Maintenance Triage", "assisted");
  const run = s.runtime.run("Maintenance Triage", { actingUser: SYS, chain: false, scope: { alertId: alert.id } });
  assert.deepEqual(run.outputs.map((o) => [o.action, o.status]), [["rank_alert", "proposed"]]);
  assert.equal(s.ont.get(alert.id).rankedAt, undefined);
});

test("assisted mode: notify and draft still apply; a turned-off tool is refused", () => {
  const s = createSystem();
  const m = { name: "Test Notifier", version: "1.0.0", owner: "P-002", purpose: "test", trigger: { kind: "manual" }, tools: ["notify", "draft_document", "raise_alert"], autonomy: { notify: "act", draft_document: "act", raise_alert: "act" } };
  s.runtime.register(structuredClone(m), (ctx) => {
    ctx.act("notify", { to: ["P-004"], message: "hello" });
    ctx.act("draft_document", { kind: "note", title: "t", body: "b" });
    ctx.act("raise_alert", { targetId: "P-004", title: "x" });
  });
  s.ont.upsert({ ...specFromManifest(m), mode: "assisted" });
  let run = s.runtime.run("Test Notifier", { actingUser: SYS });
  assert.deepEqual(run.outputs.map((o) => o.status), ["done", "done", "proposed"]);
  const spec = specFor(s.ont, "Test Notifier");
  s.ont.upsert({ id: spec.id, type: "AgentSpec", tools: spec.tools.map((t) => (t.action === "notify" ? { ...t, enabled: false } : t)) });
  run = s.runtime.run("Test Notifier", { actingUser: SYS });
  assert.deepEqual(run.refusals, [{ action: "notify", reason: "tool turned off" }]);
});

test("the autonomy dial and the decision statement agree", () => {
  const s = createSystem();
  s.runtime.setAutonomy("Process Watch", "raise_alert", "propose");
  assert.equal(specFor(s.ont, "Process Watch").tools.find((t) => t.action === "raise_alert").level, "propose");
});

const person = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance });
const act = (s, by, action, params) => s.actions.invoke({ action, params, actor: person(s, by) });
const seedAgreed = (s, agent, n) => { for (let i = 0; i < n; i++) s.ont.upsert({ id: `SHA-T${agent.length}-${i}`, type: "ShadowAction", agent, specVersion: "1.0.0", runId: null, action: "raise_alert", params: {}, at: s.tel.now(), status: "agreed" }); };

test("promotion: four eyes, one step at a time, only on a shadow record that meets the criteria", () => {
  const s = createSystem();
  assert.match(act(s, "P-002", "promote_agent", { agent: "Process Watch", to: "bounded" }).reason, /own agent/);
  setMode(s, "Asset Watch", "shadow");
  assert.match(act(s, "P-003", "promote_agent", { agent: "Asset Watch", to: "assisted" }).reason, /minCases/);
  assert.match(act(s, "P-028", "promote_agent", { agent: "Asset Watch", to: "assisted" }).reason, /engineer/);
  seedAgreed(s, "Asset Watch", 20);
  assert.match(act(s, "P-003", "promote_agent", { agent: "Asset Watch", to: "bounded" }).reason, /one step/);
  assert.equal(act(s, "P-003", "promote_agent", { agent: "Asset Watch", to: "assisted" }).status, "done");
  assert.equal(specFor(s.ont, "Asset Watch").mode, "assisted");
  assert.equal(act(s, "P-003", "promote_agent", { agent: "Asset Watch", to: "live" }).status, "refused");
});

test("off switch: pausing Geo Watch withdraws its open proposals and queued shadow actions; its runs are skipped", () => {
  const s = createSystem();
  const open = s.ont.list("Proposal", (p) => p.actorId === "Geo Watch" && p.state === "open");
  assert.equal(open.length, 2);
  s.ont.upsert({ id: "SHA-GEO-1", type: "ShadowAction", agent: "Geo Watch", specVersion: "1.0.0", runId: null, action: "raise_alert", params: {}, at: s.tel.now(), status: "pending" });
  assert.equal(act(s, "P-003", "set_agent_state", { agent: "Geo Watch", state: "paused" }).status, "done");
  for (const p of open) assert.equal(s.ont.get(p.id).state, "withdrawn");
  assert.equal(s.ont.get("SHA-GEO-1").status, "dropped");
  const spec = specFor(s.ont, "Geo Watch");
  assert.deepEqual([spec.state, spec.killedBy], ["paused", "P-003"]);
  assert.equal(s.runtime.run("Geo Watch", { actingUser: SYS, chain: false }).status, "skipped");
  assert.equal(act(s, "P-028", "set_agent_state", { agent: "Geo Watch", state: "live" }).status, "refused");
});

test("off switch (J23): turning off Process Watch's setpoint tool withdraws its open request; a run raises none", () => {
  const s = createSystem();
  s.runtime.run("Process Watch", { actingUser: SYS, chain: false });
  const prp = s.ont.list("Proposal", (p) => p.actorId === "Process Watch" && p.action === "request_setpoint_change" && p.state === "open");
  assert.ok(prp.length, "an open setpoint proposal");
  assert.equal(act(s, "P-002", "set_tool_enabled", { agent: "Process Watch", action: "request_setpoint_change", enabled: false }).status, "done");
  for (const p of prp) assert.equal(s.ont.get(p.id).state, "withdrawn");
  for (const a of s.ont.list("Alert", (x) => x.state === "active" && s.ont.get(x.targetId) && s.ont.get(x.targetId).assetClass === "Rapid gravity filter")) act(s, "P-004", "acknowledge_alert", { alertId: a.id });
  const run = s.runtime.run("Process Watch", { actingUser: SYS, chain: false });
  assert.ok(run.refusals.some((r) => r.action === "request_setpoint_change" && r.reason === "tool turned off"), JSON.stringify(run.refusals));
  assert.equal(s.ont.list("Proposal", (p) => p.actorId === "Process Watch" && p.state === "open").length, 0);
});

test("demotion: a bounded agent that hits a hard constraint drops to assisted, with an audit entry", () => {
  const s = createSystem();
  const permit = s.ont.list("Permit", (p) => p.state === "open")[0];
  const m = { name: "Test Recorder", version: "1.0.0", owner: "P-002", purpose: "test", trigger: { kind: "manual" }, tools: ["record_reading"], autonomy: { record_reading: "act" } };
  s.runtime.register(structuredClone(m), (ctx) => { ctx.act("record_reading", { targetId: permit.assetId, measure: "vibration", value: 3.1 }); });
  s.ont.upsert(specFromManifest(m));
  const other = s.ont.list("Person", (p) => p.clearance === "technician" && p.id !== permit.holderId)[0];
  const run = s.runtime.run("Test Recorder", { actingUser: { id: other.id, kind: "person", clearance: "technician" } });
  assert.deepEqual(run.outputs.map((o) => o.status), ["proposed"]);
  assert.equal(specFor(s.ont, "Test Recorder").mode, "assisted");
  assert.ok(s.audit.all().some((e) => e.action === "demote_agent" && e.ref === specId("Test Recorder") && /permit-holder/.test(e.reason)));
});

const PW = { kind: "agent", id: "Process Watch", clearance: "manager", onBehalfOf: "SYSTEM" };
const f07 = (s) => s.ont.list("Asset", (a) => a.positionTag === "F07")[0];

test("freshness: telemetry older than the limit refuses the write, and the refusal is audited", () => {
  const s = createSystem();
  const real = s.tel.latest;
  s.tel.latest = (id) => (id === "SEN-F07-turb" ? { value: 0.6, at: new Date(Date.parse(s.tel.now()) - 45 * 60000).toISOString(), quality: "good" } : real(id));
  const r = s.actions.invoke({ action: "raise_alert", params: { targetId: f07(s).id, title: "F07 breakthrough risk" }, actor: PW, autonomy: "act", evidence: ["SEN-F07-turb"] });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /^evidence stale: SEN-F07-turb 45 min$/);
  const last = s.audit.all().at(-1);
  assert.deepEqual([last.action, last.outcome, last.reason], ["raise_alert", "refused", r.reason]);
  s.tel.latest = real;
  const ok = s.actions.invoke({ action: "raise_alert", params: { targetId: f07(s).id, title: "F07 breakthrough risk" }, actor: PW, autonomy: "act", evidence: ["SEN-F07-turb", "competence ok for P-028"] });
  assert.equal(ok.status, "done");
  assert.ok(ok.decision.evidenceAges.some((e) => e.id === "SEN-F07-turb" && e.ageMin <= 30) && ok.decision.constraintsChecked.includes("permit-holder"));
});

test("freshness: a cited object that does not exist refuses the write", () => {
  const s = createSystem();
  const r = s.actions.invoke({ action: "raise_alert", params: { targetId: f07(s).id, title: "x" }, actor: PW, autonomy: "act", evidence: ["SEN-NOPE"] });
  assert.equal(r.reason, "evidence missing: SEN-NOPE");
});

test("permit-holder: an agent acting for someone other than the holder only proposes on a permitted asset", () => {
  const s = createSystem();
  const hlpb = s.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  assert.equal(act(s, "P-009", "open_permit", { assetId: hlpb.id, kind: "general", holderId: "P-028" }).status, "done");
  const copilot = (who) => s.actions.invoke({ action: "record_reading", params: { targetId: hlpb.id, measure: "vibration", value: 3.2 }, actor: { kind: "agent", id: "Technician Copilot", clearance: "technician", onBehalfOf: who }, autonomy: "act" });
  const r = copilot("P-030");
  assert.equal(r.status, "proposed");
  assert.deepEqual(r.hits, ["permit-holder"]);
  assert.equal(copilot("P-028").status, "done");
  const spec = specFor(s.ont, "Technician Copilot");
  s.ont.upsert({ id: spec.id, type: "AgentSpec", constraints: [] });
  assert.equal(copilot("P-030").status, "proposed", "the inherited constraint cannot be removed");
});

test("hard constraints: chlorine and money cap at propose; a control-system write is refused", () => {
  const s = createSystem();
  const base = { ont: s.ont, tel: s.tel, actor: PW, evidence: [], spec: specFor(s.ont, "Process Watch"), now: s.tel.now() };
  const cl = checkWrite({ ...base, action: "propose_dose_change", params: { chemicalId: "CHEM-CL2", change: "up" } });
  assert.deepEqual([cl.level, cl.refuse], ["propose", null]);
  assert.ok(cl.caps.includes("chlorine-propose") && cl.checked.includes("chlorine-propose"));
  assert.equal(checkWrite({ ...base, action: "propose_dose_change", params: { chemicalId: "CHEM-COAG", change: "up" } }).level, null);
  ACTIONS.raise_alert.money = true;
  try { assert.ok(checkWrite({ ...base, action: "raise_alert", params: { targetId: "Z01", title: "x" } }).caps.includes("money-propose")); } finally { delete ACTIONS.raise_alert.money; }
  ACTIONS.raise_alert.control = true;
  try { assert.match(checkWrite({ ...base, action: "raise_alert", params: { targetId: "Z01", title: "x" } }).refuse, /control system/); } finally { delete ACTIONS.raise_alert.control; }
});

test("every read records its source time", () => {
  const s = createSystem();
  const run = s.runtime.run("Process Watch", { actingUser: SYS, chain: false });
  const cl = run.sources.find((x) => x.id === "SEN-FIN-cl");
  assert.ok(cl && typeof cl.sourceAt === "string" && cl.sourceAt <= s.tel.now(), JSON.stringify(cl));
});

const setpointProposal = (s) => {
  s.runtime.run("Process Watch", { actingUser: SYS, chain: false });
  return s.ont.list("Proposal", (p) => p.actorId === "Process Watch" && p.action === "request_setpoint_change" && p.state === "open")[0];
};
const named = (s, extra) => s.ont.upsert({ id: specId("Process Watch"), type: "AgentSpec", approver: "P-004", backup: "P-001", escalateAfterMin: 60, onTimeout: "hold", ...extra });
const resolveAs = (s, id, by, verdict = "approve", reason) => s.actions.resolve(id, { verdict, reason, by: person(s, by) });

test("approvers: a named approver answers; the backup only after the escalation window", () => {
  const s = createSystem();
  named(s);
  const p = setpointProposal(s);
  assert.deepEqual([p.approver, p.backup, p.onTimeout], ["P-004", "P-001", "hold"]);
  assert.equal(Date.parse(p.escalateAt) - Date.parse(p.created), 60 * 60000);
  const early = resolveAs(s, p.id, "P-001");
  assert.equal(early.status, "refused");
  assert.match(early.reason, /waiting for P-004/);
  s.tel.tick(61);
  assert.equal(resolveAs(s, p.id, "P-001").status, "done");
});

test("timeouts: an unanswered proposal is dropped or held, never applied", () => {
  const s = createSystem();
  named(s, { onTimeout: "drop" });
  const p = setpointProposal(s);
  const srv = createServer(s);
  srv.tick(121);
  assert.deepEqual([s.ont.get(p.id).state, s.ont.get(p.id).withdrawnReason], ["withdrawn", "timed out"]);
  assert.equal(s.ont.list("Decision", (d) => d.proposalId === p.id).length, 0);

  const h = createSystem();
  named(h, { onTimeout: "hold" });
  const q = setpointProposal(h);
  h.tel.tick(121);
  applyTimeouts(h.ont, h.tel.now());
  assert.deepEqual([h.ont.get(q.id).state, h.ont.get(q.id).timedOut], ["open", true]);
  assert.equal(h.ont.list("Decision", (d) => d.proposalId === q.id).length, 0);
});

test("approvers: a default agent's proposal is answered by anyone with the action's clearance, as today", () => {
  const s = createSystem();
  const p = s.ont.list("Proposal", (x) => x.actorId === "Geo Watch" && x.action === "start_sampling_round" && x.state === "open")[0];
  const sup = s.ont.list("Person", (x) => x.role === "shift_supervisor")[0];
  assert.equal(resolveAs(s, p.id, sup.id).status, "done");
});

test("approval cards: evidence with its age, the constraints checked, the expected effect", () => {
  const s = createSystem();
  const { card } = setpointProposal(s);
  assert.ok(card.evidence.length && card.evidence.every((e) => /^SEN-/.test(e.id) && Number.isFinite(e.ageMin)), JSON.stringify(card));
  assert.ok(card.constraintsChecked.includes("permit-holder"));
  assert.ok(card.expectedEffect.length > 10);
  assert.deepEqual(card.alternatives, []);
});

test("overrides are learnt: a rejection with a reason becomes an eval case", async () => {
  const s = createSystem();
  const p = setpointProposal(s);
  assert.equal(resolveAs(s, p.id, "P-004", "reject", "artisan on leave").status, "rejected");
  const learned = s.ont.list("LearnedEval");
  assert.equal(learned.length, 1);
  assert.deepEqual([learned[0].agent, learned[0].expect, learned[0].reason], ["Process Watch", "not request_setpoint_change", "artisan on leave"]);
  assert.equal((await runEvals(() => createSystem(), "Process Watch", s.ont)).learned, 1);
});

test("relative revert: reversing an agent's change keeps a person's later edit of the same field", () => {
  const s = createSystem();
  const wo = s.ont.list("WorkOrder", (w) => !["closed", "cancelled"].includes(w.state))[0];
  const prp = s.actions.invoke({ action: "update_work_order", params: { workOrderId: wo.id, patch: { priority: "P1" } }, actor: PW, autonomy: "act" });
  assert.equal(prp.status, "proposed");
  const agentDec = resolveAs(s, prp.proposal.id, "P-004").decision;
  assert.equal(s.ont.get(wo.id).priority, "P1");
  assert.equal(act(s, "P-004", "update_work_order", { workOrderId: wo.id, patch: { planned: "2026-10-20", priority: "P2" } }).status, "done");
  assert.equal(s.actions.reverse(agentDec.id, person(s, "P-004")).status, "done");
  assert.deepEqual([s.ont.get(wo.id).priority, s.ont.get(wo.id).planned], ["P2", "2026-10-20"]);
  const entry = s.audit.all().filter((e) => e.action === "reverse").at(-1);
  assert.deepEqual(entry.kept, ["priority"]);
});

test("relative revert: closing a permit and recording an isolation can both be reversed", () => {
  const s = createSystem();
  const hlpb = s.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const ptw = act(s, "P-009", "open_permit", { assetId: hlpb.id, kind: "general", holderId: "P-028" }).decision.objects[0];
  const iso = act(s, "P-009", "record_isolation", { permitId: ptw, point: "MCC-2 feeder 4" }).decision;
  assert.equal(s.ont.get(ptw).isolations.length, 1);
  assert.equal(s.actions.reverse(iso.id, person(s, "P-009")).status, "done");
  assert.equal(s.ont.get(ptw).isolations.length, 0);
  const close = act(s, "P-009", "close_permit", { permitId: ptw }).decision;
  assert.equal(s.ont.get(ptw).state, "closed");
  assert.equal(s.actions.reverse(close.id, person(s, "P-009")).status, "done");
  assert.equal(s.ont.get(ptw).state, "open");
});
