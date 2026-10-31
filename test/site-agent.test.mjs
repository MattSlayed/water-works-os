import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { createSiteAgent, plantFocus } from "../src/site-agent.mjs";

for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "WWOS_LLM"]) delete process.env[k]; // the alert brief, never a live call

const sys = createSystem({ seed: 7 });
const as = (id) => ({ id, clearance: sys.ont.get(id).clearance });
const sup = as("P-004"), tech = as(sys.ont.list("Person", (p) => p.clearance === "technician")[0].id);

test("site agent: the alert brief cites the turbidity alert and its intake reading, and focuses the intake", async () => {
  const r = await createSiteAgent({ ont: sys.ont, tel: sys.tel, tools: [] }).ask({ question: "What is going on with the turbidity alert?", viewer: sup });
  assert.equal(r.model, false);
  assert.deepEqual(r.citations.map((c) => c.id), ["ALT-00005", "SEN-RAW-turb"]);
  assert.match(r.answer, /81\.\d+ NTU/);
  assert.deepEqual(r.focus, ["PM-RB-A:STR-10UPA01"]);
});

test("site agent: plant focus resolves tags, sensors and zones, and keeps only what the viewer may see", () => {
  assert.deepEqual(plantFocus(sys.ont, sup, ["CHL-A"]), ["PM-RB-A:MCH-CHL-A"]);
  assert.ok(plantFocus(sys.ont, sup, ["SEN-FIN-cl@2026-10-14T05:00Z..2026-10-14T06:00Z"]).includes("PM-RB-A:STR-16UHC01"));
  assert.deepEqual(plantFocus(sys.ont, sup, ["NOPE"]), []);
  assert.deepEqual(plantFocus(sys.ont, tech, ["CHL-A", "Z06", "SEN-FIN-cl"]), []);
});

test("site agent: with Claude, show_on_map sets the focus, the people tool is never offered, and cites are kept", async () => {
  const calls = [];
  const replies = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "show_on_map", input: { ids: ["SEN-RAW-turb"] } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Raw water is turbid at the intake [SEN-RAW-turb] [NOT-A-THING]." }] }
  ];
  const client = { beta: { messages: { create: async (req) => { calls.push(req); return replies[calls.length - 1]; } } } };
  const tools = [{ name: "people", description: "", inputSchema: {}, run: async () => ({}) }, { name: "search", description: "", inputSchema: {}, run: async () => ({}) }];
  const r = await createSiteAgent({ ont: sys.ont, tel: sys.tel, tools, client }).ask({ question: "Where is the turbidity coming in?", viewer: sup });
  assert.equal(r.model, true);
  assert.deepEqual(r.focus, ["PM-RB-A:STR-10UPA01"]);
  assert.deepEqual(r.citations.map((c) => c.id), ["SEN-RAW-turb"]);
  assert.deepEqual(calls[0].tools.map((t) => t.name), ["search", "show_on_map"]);
  assert.equal(calls[1].messages[2].content[0].content, "Showing: 10UPA01 · pump house (rev A)."); // the tool result turn: question, assistant, results
});

let srv, base;
before(async () => { srv = createServer(createSystem({ seed: 7 })); await new Promise((r) => srv.listen(0, r)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv.close());
const ask = (question) => fetch(`${base}/api/plant/ask`, { method: "POST", headers: { "content-type": "application/json", "x-acting-user": "P-004" }, body: JSON.stringify({ question }) });

test("site agent: POST /api/plant/ask briefs, and refuses an empty or oversized question", async () => {
  const ok = await ask("turbidity alert?");
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).focus, ["PM-RB-A:STR-10UPA01"]);
  assert.equal((await ask("  ")).status, 400);
  assert.equal((await ask("x".repeat(501))).status, 400);
  assert.equal((await ask(42)).status, 400);
});

test("site agent: an alert brief that matches nothing in the question says so before naming the most severe alert", async () => {
  const r = await createSiteAgent({ ont: sys.ont, tel: sys.tel, tools: [] }).ask({ question: "Anything wrong with chlorination?", viewer: tech });
  assert.match(r.answer, /^No active alert you can see matches that\. The most severe one is: /);
});

test("site agent: the last allowed turn forbids tools, so a long search still ends in a brief", async () => {
  const calls = [];
  const client = { beta: { messages: { create: async (req) => {
    calls.push(req);
    return req.tool_choice?.type === "none" ? { stop_reason: "end_turn", content: [{ type: "text", text: "I cannot find it among what you can see." }] }
      : { stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${calls.length}`, name: "search", input: { q: "x" } }] };
  } } } };
  const tools = [{ name: "search", description: "", inputSchema: {}, run: async () => ({ items: [] }) }];
  const r = await createSiteAgent({ ont: sys.ont, tel: sys.tel, tools, client }).ask({ question: "chlorination?", viewer: tech });
  assert.equal(r.model, true);
  assert.equal(r.answer, "I cannot find it among what you can see.");
  assert.equal(calls.length, 8);
  assert.ok(calls.slice(0, 7).every((c) => !c.tool_choice));
  assert.equal(calls[7].messages[calls[7].messages.length - 2].content.at(-1).text, "No more tool calls are allowed. Write the brief now from what you have.");
});
