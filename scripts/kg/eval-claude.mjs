// Claude over the KG tools on data/eval-questions.json, graded by the rule grader (src/kg/grade.mjs).
// Usage: node scripts/kg/eval-claude.mjs [--backend memory|atlas] [--out file]
// Each question runs as its asker (a Person's clearance), with only the tools that clearance may call, in a manual
// tool-use loop. Pass bar: 90 % right, 100 % of citations valid, 0 leaks, 0 invented tags. Exit 0 on pass, 1 on a miss.
// Inference is cross-border and disclosed under POPIA s72 (NVT-PROJ-BBR-ARC-001 §4); the questions carry no people data.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createSystem } from "../../src/system.mjs";
import { kgToolsFor } from "../../src/server.mjs";
import { toolsFor } from "../../src/kg/tools.mjs";
import { grade, citeContext, viewerOf } from "../../src/kg/grade.mjs";
import { MODEL } from "../../src/llm.mjs";

const MAX_TURNS = 12; // model calls per question; a question still asking for tools after this is graded on no answer
const { values: { backend, out } } = parseArgs({ options: { backend: { type: "string", default: "memory" }, out: { type: "string" } } });
const stop = (msg) => { console.error(msg); process.exit(2); };
if (!["memory", "atlas"].includes(backend)) stop(`--backend must be memory or atlas, not ${backend}`);
if (!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) stop("eval-claude: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN to run Claude; nothing was run.");
let Anthropic;
try { ({ default: Anthropic } = await import("@anthropic-ai/sdk")); } catch { stop("eval-claude: the optional @anthropic-ai/sdk is not installed (npm install); nothing was run."); }

const sys = createSystem({ seed: 7 });
const crosswalk = JSON.parse(readFileSync(new URL("../../data/crosswalk.json", import.meta.url), "utf8"));
const bank = JSON.parse(readFileSync(new URL("../../data/eval-questions.json", import.meta.url), "utf8"));
// the same wiring as the MCP endpoint (src/server.mjs), but an atlas run that cannot connect stops: never graded as memory
let tools;
try { tools = await kgToolsFor(sys, { ...process.env, WWOS_KG_BACKEND: backend, WWOS_KG_CYPHER: "0" }, { fallback: false }); } catch (e) { stop(`eval-claude: ${e.message}; nothing was run.`); }
const ctx = citeContext(sys.ont, crosswalk);
const client = new Anthropic();

const system = `You answer questions about the Riverbend water treatment works using only the tools provided.
The plant clock is ${sys.tel.now()}: "now" means that time. Telemetry starts at ${sys.tel.start}.
Answer in plain text first. Cite every fact in square brackets with the cite field of the tool item it came from, for example [SEN-RAW-turb] or [DOC-DESIGN-BASIS#c02]. Cite only what the tools returned.
If the tools do not find what was asked about, say "not found" in words and do not guess. If the data cannot answer the question, say "insufficient evidence" in words.
Be brief.
Then end with one fenced \`\`\`json block: {"status": "answer" | "not_found" | "insufficient", "fields": {...}, "citations": ["<cite>", ...]}.
- status: "not_found" when the thing asked about is not found; "insufficient" when it exists but the data cannot answer; else "answer".
- fields: exactly the fields the question lists, no others. Use null for a field the tools cannot answer.
- number: a JSON number in the listed unit (or a string with the number and its unit). boolean: true or false. string: a short value, such as a tag or one word.
- ids: an array of plant tags where one exists (such as SLP-A or BWR-1), else object ids. time: ISO 8601 UTC, such as 2026-10-02T14:05Z.
- citations: the cites the answer rests on.`;

// the question, then its fields: names, types and units, never the expected values
const userTurn = (q) => `${q.question}\n\nFields for the json block:\n${Object.entries(q.fields)
  .map(([name, f]) => `- ${name}: ${f.type}${f.unit ? ` (${f.unit})` : ""}`).join("\n")}`;

async function ask(q) {
  const viewer = viewerOf(sys.ont, q.asker), mine = toolsFor(tools, viewer).filter((t) => t.name !== "people"); // no question needs people data; none goes to the provider
  const defs = mine.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }));
  const messages = [{ role: "user", content: userTurn(q) }];
  let calls = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const r = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system,
      tools: defs,
      messages
    });
    messages.push({ role: "assistant", content: r.content }); // whole content, thinking blocks included
    if (r.stop_reason !== "tool_use") return { answer: r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(), stop: r.stop_reason, calls };
    const results = await Promise.all(r.content.filter((b) => b.type === "tool_use").map(async (b) => {
      calls++;
      const t = mine.find((x) => x.name === b.name);
      if (!t) return { type: "tool_result", tool_use_id: b.id, content: `Unknown tool: ${b.name}`, is_error: true };
      try { return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(await t.run(b.input, viewer)) }; }
      catch (e) { return { type: "tool_result", tool_use_id: b.id, content: `${b.name} failed: ${String(e?.message).slice(0, 200)}`, is_error: true }; }
    }));
    messages.push({ role: "user", content: results }); // every result of a turn in one message
  }
  return { answer: "", stop: "turn cap", calls };
}

const rows = [];
for (const q of bank) {
  let run;
  try { run = await ask(q); } catch (e) {
    // a credential or connection failure is a run that could not happen, not a question missed
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError || e instanceof Anthropic.APIConnectionError)
      stop(`eval-claude: the Anthropic API refused or could not be reached (${e.constructor.name}); nothing was graded.`);
    const why = e instanceof Anthropic.APIError ? `API error ${e.status ?? e.constructor.name}` : String(e?.message).slice(0, 200);
    run = { answer: "", stop: why, calls: 0 };
  }
  const g = grade(run.answer, q, ctx);
  rows.push({ id: q.id, kind: q.kind, asker: q.asker, status: q.status, ...run, ...g });
  console.log(`${q.id} ${g.right ? "right" : `WRONG (${g.failed.join(", ")})`}${g.citationsValid ? "" : " bad-cite"}${g.leak ? " LEAK" : ""}${g.inventedTags.length ? ` invented ${g.inventedTags}` : ""} (${run.calls} calls, ${run.stop})`);
}

const n = rows.length, count = (f) => rows.filter(f).length;
const totals = {
  n,
  right: count((r) => r.right) / n,
  citationsValid: count((r) => r.citationsValid) / n,
  leaks: count((r) => r.leak),
  inventedTags: rows.reduce((s, r) => s + r.inventedTags.length, 0),
  uncitedFacts: rows.reduce((s, r) => s + r.uncitedFacts, 0)
};
totals.pass = totals.right >= 0.9 && totals.citationsValid === 1 && totals.leaks === 0 && totals.inventedTags === 0;
const report = { model: MODEL, backend, plantClock: sys.tel.now(), ranAt: new Date().toISOString(), totals, questions: rows };
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(totals));
process.exit(totals.pass ? 0 : 1);
