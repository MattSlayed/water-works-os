import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { readFileSync } from "node:fs";
import { createSiteAgent, plantFocus } from "../src/site-agent.mjs";
import { MODEL } from "../src/llm.mjs";
import { createKgTools } from "../src/kg/tools.mjs";
import { createMemoryBackend } from "../src/kg/backend-memory.mjs";

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

// project questions: the real KG tools over their own system, so snapshot counts stay out of the other tests
const crosswalk = JSON.parse(readFileSync(new URL("../data/crosswalk.json", import.meta.url), "utf8"));
const projectAgent = (client = null) => {
  const s = createSystem({ seed: 7 });
  const tools = createKgTools({ backend: createMemoryBackend(s), ont: s.ont, tel: s.tel, crosswalk });
  return { s, agent: createSiteAgent({ ont: s.ont, tel: s.tel, tools, client }), mgr: { id: "P-004", clearance: s.ont.get("P-004").clearance } };
};
const CL4 = "how is the clarifier 4 refurbishment project going?";

test("site agent: fallback project brief for 'how is the clarifier 4 refurbishment project going?' has the header line, project, and a linked snapshot", async () => {
  const { s, agent, mgr } = projectAgent();
  const r = await agent.ask({ question: CL4, viewer: mgr });
  assert.equal(r.model, false);
  assert.equal(r.project.id, "PRJ-CL4");
  assert.match(r.answer, /^Clarifier 4 scraper drive refurbishment: \d+ confirmed of 6 milestones, \d+ overdue; R \d+ of R 1200000; last report (\d+ days ago|none) \[PRJ-CL4\]/);
  const [snap] = s.ont.list("ProjectSnapshot");
  assert.ok(s.ont.links(snap.id, { rel: "ABOUT" }).some((l) => l.to === "PRJ-CL4"));
  assert.ok(r.focus.includes("PM-RB-A:MCH-CL-4"));
  assert.deepEqual(r.changed, []);
});

test("site agent: asking the same project twice gives changed: []", async () => {
  const { s, agent, mgr } = projectAgent();
  await agent.ask({ question: CL4, viewer: mgr });
  assert.deepEqual((await agent.ask({ question: CL4, viewer: mgr })).changed, []);
  assert.equal(s.ont.list("ProjectSnapshot").length, 2);
});

test("site agent: a changed area is reported against the newest earlier snapshot", async () => {
  const { s, agent, mgr } = projectAgent();
  await agent.ask({ question: CL4, viewer: mgr });
  const [first] = s.ont.list("ProjectSnapshot");
  s.ont.upsert({ ...first, areas: { ...first.areas, plant: { ...first.areas.plant, status: first.areas.plant.status === "red" ? "green" : "red" } } });
  const r = await agent.ask({ question: CL4, viewer: mgr });
  assert.deepEqual(r.changed.map((c) => c.area), ["plant"]);
});

test("site agent: a technician never diffs against a manager's snapshot", async () => {
  const { s, agent, mgr } = projectAgent();
  const tech = { id: s.ont.list("Person", (p) => p.clearance === "technician")[0].id, clearance: "technician" };
  await agent.ask({ question: CL4, viewer: mgr });
  const first = s.ont.list("ProjectSnapshot")[0];
  s.ont.upsert({ ...first, areas: Object.fromEntries(Object.entries(first.areas).map(([k, a]) => [k, { ...a, status: "red" }])) }); // would differ everywhere
  const r = await agent.ask({ question: CL4, viewer: tech });
  assert.deepEqual(r.changed, []);
  assert.deepEqual(s.ont.view(tech).list("ProjectSnapshot").map((x) => x.minClearance), ["technician"]);
});

test("site agent: with Claude, project_status is offered, its result fills project, and a snapshot is written", async () => {
  const calls = [];
  const replies = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "project_status", input: { projectId: "PRJ-RES2" } }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "show_on_map", input: { ids: ["AST-RES-2"] } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Compliance is red on the reservoir project [PRJ-RES2]." }] }
  ];
  const client = { beta: { messages: { create: async (req) => { calls.push(req); return replies[calls.length - 1]; } } } };
  const { s, agent, mgr } = projectAgent(client);
  const r = await agent.ask({ question: "reservoir 2 status?", viewer: mgr });
  assert.equal(r.model, true);
  assert.ok(calls[0].tools.some((t) => t.name === "project_status") && !calls[0].tools.some((t) => t.name === "people"));
  assert.match(calls[0].system, /call project_status and read its latest progress report with documents/);
  assert.equal(r.project.id, "PRJ-RES2");
  assert.equal(r.project.areas.compliance.status, "red");
  const snaps = s.ont.list("ProjectSnapshot");
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].model, MODEL);
  assert.ok(s.ont.links(snaps[0].id, { rel: "ABOUT" }).some((l) => l.to === "PRJ-RES2"));
});

test("site agent: a question naming no project returns no project and writes no snapshot", async () => {
  const { s, agent, mgr } = projectAgent();
  const r = await agent.ask({ question: "What is going on with the turbidity alert?", viewer: mgr });
  assert.equal(r.project, undefined);
  assert.equal(r.changed, undefined);
  assert.equal(s.ont.list("ProjectSnapshot").length, 0);
});

test("site agent: a manager asking after a technician on PRJ-PS2 is diffed only against manager snapshots (R12)", async () => {
  const { s, agent, mgr } = projectAgent();
  const tech = { id: "P-028", clearance: "technician" };
  const q = "how is project PRJ-PS2 going?";
  assert.equal((await agent.ask({ question: q, viewer: tech })).project.id, "PRJ-PS2");
  assert.deepEqual((await agent.ask({ question: q, viewer: mgr })).changed, []);
  assert.deepEqual((await agent.ask({ question: q, viewer: mgr })).changed, []);
  assert.deepEqual(s.ont.list("ProjectSnapshot").map((x) => x.minClearance), ["technician", mgr.clearance, mgr.clearance]);
});

test("site agent: the fallback brief skips closed projects and ranks by words matched", async () => {
  const { agent, mgr } = projectAgent();
  const r = await agent.ask({ question: "how is the intake screen upgrade project going?", viewer: mgr });
  assert.equal(r.project.id, "PRJ-INT");
  assert.match(r.answer, /^Intake screen upgrade: /);
  assert.ok(!r.answer.includes("Coagulant"), "the closed project is never briefed or listed");
  assert.match(r.answer.split("\n").at(-1), /^Also matching: PS-2 MCC upgrade\.$/);
});

test("site agent: two equal matches brief the earlier start and list the other last", async () => {
  const { agent, mgr } = projectAgent();
  const r = await agent.ask({ question: "how is the water project going?", viewer: mgr });
  assert.equal(r.project.id, "PRJ-RES2");
  assert.equal(r.answer.split("\n").at(-1), "Also matching: Raw-water main section replacement.");
});

test("site agent: a Claude snapshot stores the model name and no person cite", async () => {
  const replies = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "project_status", input: { projectId: "PRJ-RES2" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Red [PRJ-RES2], crew [P-030]." }] }
  ];
  let n = 0;
  const client = { beta: { messages: { create: async () => replies[n++] } } };
  const { s, agent, mgr } = projectAgent(client);
  await agent.ask({ question: "reservoir 2 status?", viewer: mgr });
  const [snap] = s.ont.list("ProjectSnapshot");
  assert.equal(snap.model, MODEL);
  assert.deepEqual(snap.citations.map((c) => c.id), ["PRJ-RES2"]);
});
