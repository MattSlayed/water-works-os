// The Agent Studio (agents design §6): a person describes an agent in words; the studio screens it (rule, agent or a
// person's job), plans it from a template, checks it against IT's catalogue, reads it back, replays it, and starts
// it in shadow. Without Claude a keyword planner covers the five templates; with Claude, Claude drafts and the same
// checks decide. Nothing here grants more than the builder already has.
import { ACTIONS, LEVELS, catalogueAllows, catalogueLine } from "./actions.mjs";
import { HARD_CONSTRAINTS, specId } from "./harness.mjs";
import { TEMPLATES } from "./templates.mjs";
import { llmEnabled, askClaude } from "./llm.mjs";

const lv = (l) => LEVELS.indexOf(l);
const PERSON = /\b(compliance|blue drop|green drop|interlocks?|set ?points?|sign[- ]?off)\b/i;
const MESSY = /\b(invoices?|photos?|pdfs?|scans?|scanned|e-?mails?|delivery notes?|documents?|receipts?)\b/i;
const THRESHOLD = /\b(above|below|over|under|more than|less than|exceeds?|older than)\s+\d/i;
const QUESTIONS = [
  { id: "judgement", text: "Does deciding what to do take judgement each time, or is it the same check every time?" },
  { id: "frequency", text: "How often does it come up?" },
  { id: "cost", text: "What does it cost when it goes wrong?" }
];

// Rule, agent or a person's job (agents design §6.1 step 2).
export function screen(text, answers = {}) {
  const t = String(text || ""), p = t.match(PERSON), m = t.match(MESSY);
  if (p) return { verdict: "person", reason: `"${p[0]}" stays with a person: compliance sign-off, interlocks and setpoints are never given to an agent.`, questions: [] };
  if (m) return { verdict: "agent", reason: `"${m[0]}" is messy input: reading it takes judgement, so an agent, held to a statement.`, questions: [] };
  if (answers.judgement === "yes") return { verdict: "agent", reason: "You said it takes judgement each time, so an agent, held to a statement.", questions: [] };
  if (THRESHOLD.test(t) || answers.judgement === "no") return { verdict: "rule", reason: "The same check every time: a rule does this, and a rule never surprises anyone.", questions: [] };
  return { verdict: "rule", reason: "Nothing here needs judgement yet, so a rule; answer the questions if that is wrong.", questions: QUESTIONS };
}

// The template the words point at.
const KEYWORDS = [
  ["digester", /\b(invoices?|delivery notes?|receipts?|pdfs?|scans?|photographed)\b/i],
  ["chaser", /\b(remind|chase|follow up|nudge)\b/i],
  ["data-tidy", /\b(duplicate|tidy|clean up|merge)\b.*\bsuppliers?\b|\bsuppliers?\b.*\b(duplicates?|tidy)\b/i],
  ["weekly-report", /\b(weekly|every week|report|summary)\b/i],
  ["watch", /\b(tell|alert|warn|notify) me\b|\blet me know\b|\b(above|below|over|under|exceeds?)\s+\d/i]
];
const templateFor = (text) => (KEYWORDS.find(([, re]) => re.test(text)) || [null])[0];

const HHMM = (h, m) => `${String(h).padStart(2, "0")}:${m || "00"}`;
function triggerFrom(text) {
  let m;
  if ((m = text.match(/\bevery (\d+) ?min/i))) return { kind: "schedule", every: `every ${m[1]} min` };
  if ((m = text.match(/\bweekdays? at (\d{1,2})(?::(\d{2}))?/i))) return { kind: "schedule", every: `weekdays at ${HHMM(m[1], m[2])}` };
  if ((m = text.match(/\b(?:daily|every day) at (\d{1,2})(?::(\d{2}))?/i))) return { kind: "schedule", every: `daily at ${HHMM(m[1], m[2])}` };
  return null;
}

const SENSOR_WORDS = [[/temp/i, /temp/i], [/vibrat/i, /vib/i], [/current/i, /current/i], [/flow/i, /flow/i], [/pressure/i, /press/i], [/level/i, /level/i]];
function paramsFor(template, text, { builder, view }) {
  if (template === "digester") {
    const tol = text.match(/within (\d+(?:\.\d+)?)\s?%/i);
    const folder = text.match(/\b(?:dropped|saved|put) (?:in|into) (?:the )?(.+?) folder/i);
    const source = /\b(chat|whatsapp)\b/i.test(text) ? { kind: "chat", channelId: `CHN-${builder.id}` }
      : folder ? { kind: "m365.files", path: folder[1] } : { kind: "m365.mail", mailbox: "accounts@riverbend.example" };
    return { source, tolerancePct: tol ? Number(tol[1]) : 2 };
  }
  if (template === "watch") {
    const tag = (text.match(/\b([A-Z]{2,4}-[A-Z0-9]{1,3})\b/) || [])[1];
    const asset = tag && view.list("Asset", (a) => a.positionTag === tag)[0];
    const kind = SENSOR_WORDS.find(([say]) => say.test(text));
    const sensor = asset && kind && view.list("Sensor", (s) => s.assetId === asset.id && kind[1].test(`${s.key} ${s.name}`))[0];
    if (!sensor) return { error: "Which reading? Name the asset tag and what to watch: temperature, vibration, current, flow, pressure or level." };
    const above = text.match(/\b(?:above|over|more than|exceeds?)\s+(\d+(?:\.\d+)?)/i), below = text.match(/\b(?:below|under|less than)\s+(\d+(?:\.\d+)?)/i);
    if (!above && !below) return { error: "Watch for what? Say above or below a number." };
    return { sensorId: sensor.id, label: `${tag} ${sensor.name.toLowerCase()}`, ...(above ? { above: Number(above[1]) } : {}), ...(below ? { below: Number(below[1]) } : {}) };
  }
  if (template === "weekly-report") {
    const types = [[/issues?/i, "Issue"], [/work orders?/i, "WorkOrder"], [/alerts?/i, "Alert"]].filter(([re]) => re.test(text)).map(([, t]) => t);
    return { types: types.length ? types : ["Issue", "WorkOrder"] };
  }
  if (template === "chaser") {
    const days = text.match(/older than (\d+) ?days?/i);
    return { olderThanDays: days ? Number(days[1]) : 5, match: /supplier quer/i.test(text) ? "supplier quer" : null };
  }
  return {};
}

// Who answers for a studio agent: for money, the finance officer; otherwise the builder's supervisor. The backup is the works manager.
function approversFor(template, builder, ont) {
  const fin = ont.list("Person", (p) => p.role === "finance_officer" && p.id !== builder.id)[0];
  const approver = (template === "digester" && fin ? fin.id : builder.supervisorId) || null;
  const mgr = ont.list("Person", (p) => p.role === "works_manager")[0];
  return { approver, backup: mgr && ![approver, builder.id].includes(mgr.id) ? mgr.id : null };
}

// The draft decision statement for a template (agents design §4.1): shadow, the builder's own reach, levels capped by the catalogue.
export function draftSpec(template, { params, trigger, builder, ont }) {
  const t = TEMPLATES[template];
  const tools = Object.entries(t.tools).map(([action, level0]) => {
    const line = catalogueLine(ont, action), cat = line && catalogueAllows(ont, { kind: line.kind, op: line.op, role: builder.role });
    const level = cat && cat.maxLevel && lv(level0) > lv(cat.maxLevel) ? cat.maxLevel : level0;
    return { action, level, enabled: true, ...(cat && cat.ok && cat.locked ? { locked: true } : {}) };
  });
  const reads = t.reads.filter((r) => !(template === "digester" && r === "connector:m365.mail" && params.source.kind !== "m365.mail"))
    .map((source) => (source === "telemetry" ? { source, freshnessMin: 30 } : { source, freshnessMin: null }));
  let name = `${t.label} (${builder.name})`;
  for (let n = 2; ont.get(specId(name)); n++) name = `${t.label} (${builder.name}) ${n}`;
  const { approver, backup } = approversFor(template, builder, ont);
  return {
    id: specId(name), type: "AgentSpec", name, version: "1.0.0", owner: builder.id, builderId: builder.id, purpose: t.purpose, template, params, trigger: trigger || t.trigger,
    reads, tools, constraints: HARD_CONSTRAINTS.map((c) => c.id), approver, backup, escalateAfterMin: approver ? 240 : null, onTimeout: "hold", exclusions: [],
    mode: "shadow", promotion: { minCases: 20, minAgreePct: 90, maxBreaches: 0, maxStalePct: 5 }, state: "live", killedAt: null, killedBy: null, createdAt: null
  };
}

export function planFromText(text, { builder, ont }) {
  const t = String(text || ""), sc = screen(t);
  if (sc.verdict === "person") return { template: null, reason: sc.reason, screen: sc };
  const template = templateFor(t);
  if (!template) return { template: null, reason: "No studio template fits this yet. The studio builds a document digester, a watch, a weekly report, a chaser or a supplier tidy-up.", screen: sc };
  const params = paramsFor(template, t, { builder, view: ont.view(builder) });
  if (params.error) return { template: null, reason: params.error, screen: sc };
  return { template, spec: draftSpec(template, { params, trigger: triggerFrom(t), builder, ont }), screen: sc };
}

// The checks a statement must pass before it is shown, replayed or started (agents design §6.1, §7).
export function validateStatement(spec, { ont }) {
  const problems = [], t = TEMPLATES[spec.template], builder = ont.get(spec.builderId);
  if (!builder || builder.type !== "Person") problems.push(`the builder ${spec.builderId} is not a person`);
  if (!t) problems.push(`there is no ${spec.template} template`);
  for (const tool of spec.tools || []) {
    const a = ACTIONS[tool.action];
    if (!a) { problems.push(`${tool.action} is not an action`); continue; }
    if (t && !(tool.action in t.tools)) problems.push(`${tool.action} is not one of the ${t.label.toLowerCase()}'s tools`);
    if (!LEVELS.includes(tool.level)) problems.push(`${tool.action}: there is no level ${tool.level}`);
    else if (a.ceiling === "human") problems.push(`${tool.action} is for people only`);
    else if (lv(tool.level) > lv(a.ceiling)) problems.push(`${tool.action} ${tool.level} is above ${a.ceiling}, the most an agent may do`);
    const line = catalogueLine(ont, tool.action);
    if (line && builder && LEVELS.includes(tool.level)) { const c = catalogueAllows(ont, { kind: line.kind, op: line.op, role: builder.role, level: tool.level }); if (!c.ok) problems.push(c.reason); }
  }
  for (const r of spec.reads || []) {
    if (!String(r.source).startsWith("connector:") || !builder) continue;
    const c = catalogueAllows(ont, { kind: r.source.slice("connector:".length), op: "read", role: builder.role });
    if (!c.ok) problems.push(c.reason);
  }
  for (const k of ["approver", "backup"]) if (spec[k] != null && (ont.get(spec[k]) || {}).type !== "Person") problems.push(`the ${k} ${spec[k]} is not a person`);
  if (!["hold", "drop"].includes(spec.onTimeout)) problems.push(`if nobody answers it must hold or drop, never ${spec.onTimeout}`);
  if (spec.escalateAfterMin != null && !(Number(spec.escalateAfterMin) > 0)) problems.push("escalation must be after a number of minutes");
  return { ok: !problems.length, problems: [...new Set(problems)] };
}

// With Claude on, Claude picks the template, parameters and schedule; the same draft and checks decide, and any
// problem falls back to the keyword planner. Returns null when Claude is off. Not tested against the network.
export async function composeWithClaude(text, { builder, ont }) {
  if (!llmEnabled()) return null;
  const fallback = planFromText(text, { builder, ont });
  const answer = await askClaude({
    system: `You turn a works person's description into one studio agent. Answer only JSON {"template": one of ${JSON.stringify(Object.keys(TEMPLATES))} or null, "params": object, "trigger": {"kind":"schedule","every":string} or null}. Use the parameter names the keyword plan uses. Never add tools.`,
    context: { builderRole: builder.role, keywordPlan: fallback.spec ? { template: fallback.template, params: fallback.spec.params, trigger: fallback.spec.trigger } : null },
    question: String(text)
  });
  let out;
  try { out = JSON.parse(String(answer || "").replace(/^```(json)?|```$/g, "")); } catch { return fallback.spec || null; }
  if (!out || !TEMPLATES[out.template] || typeof out.params !== "object") return fallback.spec || null;
  const spec = draftSpec(out.template, { params: out.params, trigger: out.trigger && typeof out.trigger.every === "string" ? out.trigger : null, builder, ont });
  return validateStatement(spec, { ont }).ok ? spec : fallback.spec || null;
}
