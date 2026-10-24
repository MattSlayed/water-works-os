// Recommendations (plan 3b Task 8): suggestions from how each person works, private, with evidence, 30-day dismissals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { AGENT_SPECS } from "../src/agents.mjs";
import { runEvals } from "../src/evals.mjs";

const SYS = { id: "SYSTEM", kind: "person", clearance: "manager", role: "system" };
const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance, role: s.ont.get(id).role });
const recommend = (s, id) => s.runtime.run("Recommender", { actingUser: as(s, id), chain: false, audience: [id] });
const mine = (s, id, signal) => s.ont.list("Suggestion", (x) => x.personId === id && (!signal || x.signal === signal));
const cSuper = (s) => s.ont.list("Person", (p) => p.role === "shift_supervisor" && p.shift === "C")[0].id;
const hlpb = (s) => s.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];

test("each of the six signals makes its suggestion for the right person", () => {
  const s = createSystem();
  s.runtime.run("Procedure Steward", { actingUser: SYS, chain: false });
  for (const id of ["P-043", "P-028", "P-004", cSuper(s), "P-002"]) assert.equal(recommend(s, id).status, "completed");
  assert.match(mine(s, "P-043", "repeated-action")[0].title, /37 invoices/);
  const watch = mine(s, "P-028", "repeated-check")[0];
  assert.match(watch.title, /HLP-B/);
  assert.deepEqual([watch.statement.template, watch.statement.mode, watch.statement.params.sensorId], ["watch", "shadow", "SEN-HLP-B-temp_de"]);
  assert.match(mine(s, "P-004", "repeated-override")[0].title, /artisan on leave/);
  assert.ok(mine(s, cSuper(s), "slow-decision").length);
  assert.ok(mine(s, "P-002", "long-step").length);
  const chase = mine(s, "P-043", "exceptions-to-one")[0];
  assert.equal(chase.statement.template, "chaser");
  for (const x of s.ont.list("Suggestion")) {
    assert.ok(x.evidence.length && x.basis && x.savedMinPerWeek > 0, x.key);
    const view = s.ont.view(as(s, x.personId)), files = new Set(s.connectors.m365.files.list().map((f) => f.id));
    for (const id of x.evidence) assert.ok(view.get(id) || files.has(id), `${x.key}: ${id}`);
  }
});

test("nobody sees another person's suggestions; a supervisor sees only the slow-decision ones", () => {
  const s = createSystem();
  for (const id of ["P-043", "P-028", cSuper(s)]) recommend(s, id);
  const v = (id) => s.ont.view(as(s, id)).list("Suggestion");
  assert.ok(v("P-028").length && v("P-028").every((x) => x.personId === "P-028"));
  assert.ok(!v("P-044").some((x) => x.personId === "P-043"));
  const slow = mine(s, cSuper(s), "slow-decision")[0];
  assert.deepEqual(slow.audience, [cSuper(s), ...(s.ont.get(cSuper(s)).supervisorId ? [s.ont.get(cSuper(s)).supervisorId] : [])]);
  assert.ok(s.ont.list("AgentRun", (r) => r.agent === "Recommender").every((r) => r.audience && r.audience.length === 1));
});

test("J27 and Review Focus 4: a dismissed suggestion stays away for 30 days, however much its signal grows", () => {
  const s = createSystem(), act = (by, action, params) => s.actions.invoke({ action, params, actor: as(s, by) });
  recommend(s, "P-028");
  const sug = mine(s, "P-028", "repeated-check")[0];
  assert.equal(act("P-028", "dismiss_suggestion", { suggestionId: sug.id, reason: "I like to look myself" }).status, "done");
  assert.equal(s.ont.get(sug.id).state, "dismissed");
  const read = () => act("P-028", "record_reading", { targetId: hlpb(s).id, measure: "bearing temp", value: 70 });
  for (let day = 1; day <= 31; day++) {
    s.tel.tick(1440);
    read();
    read();
    recommend(s, "P-028");
    const open = mine(s, "P-028", "repeated-check").filter((x) => x.state === "open");
    if (day < 30) assert.equal(open.length, 0, `day ${day}`);
    if (day === 31) assert.equal(open.length, 1, "back after 30 days");
  }
});

test("accepting returns the draft for the studio; only its person may accept or dismiss", () => {
  const s = createSystem(), act = (by, action, params) => s.actions.invoke({ action, params, actor: as(s, by) });
  recommend(s, "P-028");
  const sug = mine(s, "P-028", "repeated-check")[0];
  assert.equal(act("P-029", "accept_suggestion", { suggestionId: sug.id }).status, "refused");
  assert.equal(act("P-001", "dismiss_suggestion", { suggestionId: sug.id }).status, "refused");
  const r = act("P-028", "accept_suggestion", { suggestionId: sug.id });
  assert.equal(r.status, "done");
  assert.equal(s.ont.get(sug.id).state, "accepted");
  assert.equal(s.ont.get(sug.id).statement.template, "watch");
  recommend(s, "P-028");
  assert.equal(mine(s, "P-028", "repeated-check").length, 1); // not suggested again once accepted
});

test("the Recommender is agent 21 and its evals pass", async () => {
  assert.equal(AGENT_SPECS.length, 22);
  assert.equal(AGENT_SPECS[20].name, "Recommender");
  const r = await runEvals(() => createSystem(), "Recommender");
  assert.ok(r.total >= 3);
  assert.equal(r.passed, r.total, JSON.stringify(r.cases));
});
