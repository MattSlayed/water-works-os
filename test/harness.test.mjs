import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { AGENT_SPECS } from "../src/agents.mjs";
import { HARD_CONSTRAINTS, specFor, specId, specFromManifest, statementSentences, matchShadow, shadowRecord } from "../src/harness.mjs";

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
