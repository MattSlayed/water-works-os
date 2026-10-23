import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { AGENT_SPECS } from "../src/agents.mjs";
import { HARD_CONSTRAINTS, specFor, statementSentences } from "../src/harness.mjs";

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
