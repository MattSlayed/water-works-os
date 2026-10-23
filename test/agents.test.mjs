import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { AGENT_SPECS } from "../src/agents.mjs";
import { runEvals } from "../src/evals.mjs";
import { competenceCheck } from "../src/functions.mjs";

const mgr = { id: "P-001", clearance: "manager" };

test("catalogue has the 14 PRD agents with triggers, tools and autonomy", () => {
  const names = AGENT_SPECS.map((s) => s.name);
  for (const n of ["Shift Handover", "Process Watch", "Asset Watch", "Maintenance Triage", "Work Pack", "Parts Readiness", "Scheduler", "Technician Copilot", "Debrief", "Shift Cover", "Permit Guard", "Drop Pack", "Ask", "Tag Matcher"]) {
    assert.ok(names.includes(n), n);
  }
  for (const s of AGENT_SPECS) {
    assert.ok(s.trigger && s.purpose && s.version && Array.isArray(s.tools), s.name);
  }
});

test("Asset Watch alerts on HLP-B and not on HLP-A", () => {
  const sys = createSystem({ seed: 7 });
  const run = sys.runtime.run("Asset Watch", { actingUser: mgr, chain: false });
  assert.equal(run.status, "completed");
  const alerts = sys.ont.list("Alert");
  const tags = alerts.map((a) => sys.ont.get(a.assetId).positionTag);
  assert.ok(tags.includes("HLP-B"), tags.join());
  assert.ok(!tags.includes("HLP-A"));
  assert.ok(run.read.length > 0 && run.calls.length > 0);
});

test("Asset Watch does not raise a duplicate alert on a second run", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Asset Watch", { actingUser: mgr, chain: false });
  const n = sys.ont.list("Alert").length;
  sys.runtime.run("Asset Watch", { actingUser: mgr, chain: false });
  assert.equal(sys.ont.list("Alert").length, n);
});

test("the maintenance chain ends in a Scheduler proposal naming a valid millwright", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Asset Watch", { actingUser: mgr });
  const agents = sys.runtime.runs().map((r) => r.agent);
  for (const a of ["Asset Watch", "Maintenance Triage", "Work Pack", "Parts Readiness", "Scheduler"]) assert.ok(agents.includes(a), `${a} in ${agents}`);
  const prop = sys.ont.list("Proposal", (p) => p.action === "schedule_work")[0];
  assert.ok(prop, "schedule proposal");
  const person = sys.ont.get(prop.params.assigneeId);
  assert.equal(person.trade, "millwright");
  const comps = sys.ont.list("Competency");
  assert.ok(competenceCheck(person, comps, { type: "trade:millwright", level: 2 }, "2026-10-15").ok);
  assert.ok(sys.ont.list("Reservation").length >= 1, "parts reserved");
  assert.ok(sys.ont.list("Draft", (d) => d.kind === "work-pack").length === 1, "work pack drafted");
});

test("every run is stored as an AgentRun with reads and calls", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Asset Watch", { actingUser: mgr });
  for (const r of sys.runtime.runs()) {
    const stored = sys.ont.get(r.id);
    assert.equal(stored.type, "AgentRun");
    assert.ok(r.read.length >= 1, `${r.agent} read`);
    assert.ok(r.calls.length >= 1, `${r.agent} calls`);
  }
});

test("turning the dial down turns a Parts Readiness decision into a proposal (AC-09)", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.setAutonomy("Parts Readiness", "reserve_parts", "propose");
  sys.runtime.run("Asset Watch", { actingUser: mgr });
  assert.equal(sys.ont.list("Reservation").length, 0);
  assert.ok(sys.ont.list("Proposal", (p) => p.action === "reserve_parts").length >= 1);
});

test("setAutonomy rejects unknown levels and agents", () => {
  const sys = createSystem({ seed: 7 });
  assert.throws(() => sys.runtime.setAutonomy("Parts Readiness", "reserve_parts", "yolo"));
  assert.throws(() => sys.runtime.setAutonomy("Nobody", "reserve_parts", "act"));
});

test("an agent calling a human-only action is refused and the run still completes (AC-10)", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.register({ name: "Rogue", purpose: "test", version: "0", trigger: { kind: "manual" }, tools: ["open_permit"], autonomy: { open_permit: "act" } }, (ctx) => {
    ctx.act("open_permit", { assetId: "AST-x", kind: "general", holderId: "P-023" });
  });
  const run = sys.runtime.run("Rogue", { actingUser: mgr });
  assert.equal(run.status, "completed");
  assert.match(run.refusals[0].reason, /human-only/);
  assert.equal(sys.ont.list("Permit", (p) => p.id !== "PTW-0412").length, 0);
});

test("an action outside the agent's manifest is refused", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.register({ name: "Narrow", purpose: "test", version: "0", trigger: { kind: "manual" }, tools: ["notify"], autonomy: {} }, (ctx) => {
    ctx.act("reserve_parts", { partIds: ["PRT-HLP-B-06"] });
  });
  const run = sys.runtime.run("Narrow", { actingUser: mgr });
  assert.match(run.refusals[0].reason, /not in manifest/);
});

test("an agent reads through the acting user's view", () => {
  const sys = createSystem({ seed: 7 });
  let seen;
  sys.runtime.register({ name: "Peek", purpose: "test", version: "0", trigger: { kind: "manual" }, tools: [], autonomy: {} }, (ctx) => {
    seen = ctx.list("Asset", (a) => a.positionTag === "CHL-A").length;
  });
  sys.runtime.run("Peek", { actingUser: { id: "P-023", clearance: "technician" } });
  assert.equal(seen, 0);
});

test("unknown agent throws", () => {
  const sys = createSystem({ seed: 7 });
  assert.throws(() => sys.runtime.run("Nobody", { actingUser: mgr }));
});

test("Shift Handover draft mentions F07", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Shift Handover", { actingUser: mgr });
  const d = sys.ont.list("Draft", (x) => x.kind === "handover")[0];
  assert.ok(d);
  assert.match(d.body, /F07/);
});

test("Permit Guard flags the contractor in the chlorine zone", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Permit Guard", { actingUser: mgr });
  assert.ok(sys.ont.list("Alert", (a) => a.zoneId === "Z06").length >= 1);
});

test("Drop Pack finds the calibration and SANS 241 response gaps", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Drop Pack", { actingUser: mgr });
  const d = sys.ont.list("Draft", (x) => x.kind === "drop-pack")[0];
  const gaps = d.data.items.filter((i) => i.status === "gap").map((i) => i.requirementId);
  assert.ok(gaps.includes("REQ-BD-CAL"));
  assert.ok(gaps.includes("REQ-BD-INC"));
});

test("evals run for every catalogue agent", async () => {
  for (const s of AGENT_SPECS) {
    const r = await runEvals(() => createSystem({ seed: 7 }), s.name);
    assert.ok(r.total >= 3, `${s.name} has ${r.total} cases`);
    assert.equal(r.passed, r.total, `${s.name}: ${JSON.stringify(r.cases.filter((c) => !c.pass))}`);
  }
});

test("an agent that exits early with return ctx.think(...) completes and chains nothing", () => {
  const sys = createSystem({ seed: 7 });
  const run = sys.runtime.run("Work Pack", { actingUser: mgr, scope: {} });
  assert.equal(run.status, "completed");
});
