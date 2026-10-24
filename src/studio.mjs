// The Agent Studio (agents design §6): a person describes an agent in words; the studio screens it (rule, agent or a
// person's job), plans it from a template, checks it against IT's catalogue, reads it back, replays it, and starts
// it in shadow. Without Claude a keyword planner covers the five templates; with Claude, Claude drafts and the same
// checks decide. Nothing here grants more than the builder already has.
import { ACTIONS, LEVELS, catalogueAllows, catalogueLine } from "./actions.mjs";
import { HARD_CONSTRAINTS, specId, statementSentences, shadowId } from "./harness.mjs";
import { digestDoc, isInvoiceDoc } from "./digest.mjs";
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

// Read-back the other way (agents design §6.1 step 3): the editable sentences parsed back into the statement. An edit
// that does not read, or that the checks refuse, leaves the statement as it was and says why.
const EVERY_BACK = { weekday: "weekdays", day: "daily", Friday: "fridays" };
export function statementFromSentences(sentences, spec, ont) {
  const original = statementSentences(spec, ont), next = structuredClone(spec), problems = [];
  const byWords = new Map(spec.tools.map((t) => [t.action.replace(/_/g, " "), t.action]));
  const who = (name) => {
    const ps = ont.list("Person", (p) => p.name === name.trim());
    if (ps.length === 1) return ps[0].id;
    problems.push(ps.length ? `two people are called ${name}` : `nobody here is called ${name}`);
    return null;
  };
  const tool = (w, patch) => {
    const action = byWords.get(w.trim());
    if (!action) return problems.push(`it has no "${w}" tool`);
    next.tools = next.tools.map((t) => (t.action === action ? { ...t, ...patch } : t));
  };
  // every sentence is parsed, the unchanged ones first, so an edit wins over a sentence that still says the old value
  const all = (sentences || []).map((x) => String(x).trim());
  for (const s of [...all.filter((x) => original.includes(x)), ...all.filter((x) => !original.includes(x))]) {
    let m;
    if ((m = s.match(/^Every (weekday|day|Friday) at (\d{1,2}):(\d{2}) (it .+)\.$/)) || (m = s.match(/^Every (\d+) min (it .+)\.$/))) {
      next.trigger = { kind: "schedule", every: m.length === 5 ? `${EVERY_BACK[m[1]]} at ${m[2].padStart(2, "0")}:${m[3]}` : `every ${m[1]} min` };
      const src = original[1].replace(/^Every .+? (?=it )/, "").replace(/\.$/, "");
      if (m[m.length - 1] !== src) problems.push("what it reads cannot be changed in a sentence: describe the agent again");
    } else if ((m = s.match(/^It runs every (\d+\s*(?:min|h))\.$/))) next.trigger = { kind: "schedule", every: m[1] };
    else if ((m = s.match(/^It runs when this happens: (.+)\.$/))) next.trigger = { kind: "event", on: m[1] };
    else if (s === "It runs only when a person starts it.") next.trigger = { kind: "manual" };
    else if ((m = s.match(/^It runs (.+)\.$/))) next.trigger = { kind: "schedule", every: m[1] };
    else if ((m = s.match(/^It may only (read|draft|notify) for (.+)\.$/))) tool(m[2], { level: m[1], enabled: true });
    else if ((m = s.match(/^It may (.+?) (?:without asking|on its own once promoted)(?:, once IT signs it off)?\.$/))) tool(m[1], { level: "act", enabled: true });
    else if ((m = s.match(/^It asks before it will (.+?); .+ may answer\.$/))) tool(m[1], { level: "propose", enabled: true });
    else if ((m = s.match(/^It asks (.+?) before it will (.+)\.$/))) { const id = who(m[1]); if (id) next.approver = id; tool(m[2], { level: "propose", enabled: true }); }
    else if ((m = s.match(/^Its (.+) tool is turned off\.$/))) tool(m[1], { enabled: false });
    else if ((m = s.match(/^If (.+?) does not answer in (\d+(?:\.\d+)?) (hours?|minutes?) it asks (.+?); if nobody answers (it does nothing|the proposal is dropped)\.$/))) {
      const a = who(m[1]), b = who(m[4]);
      if (a) next.approver = a;
      if (b) next.backup = b;
      next.escalateAfterMin = Math.round(Number(m[2]) * (/^hour/.test(m[3]) ? 60 : 1));
      next.onTimeout = m[5] === "the proposal is dropped" ? "drop" : "hold";
    } else if ((m = s.match(/^If nobody answers, (nothing happens|the proposal is dropped)\.$/))) next.onTimeout = m[1] === "nothing happens" ? "hold" : "drop";
    else if (!original.includes(s)) problems.push(`this sentence cannot be changed here: "${s}"`);
  }
  if (!problems.length) {
    if (next.template) problems.push(...validateStatement(next, { ont }).problems);
    else for (const t of next.tools) if (ACTIONS[t.action] && lv(t.level) > lv(ACTIONS[t.action].ceiling)) problems.push(`${t.action} ${t.level} is above ${ACTIONS[t.action].ceiling}, the most an agent may do`);
  }
  return problems.length ? { spec, problems: [...new Set(problems)] } : { spec: next, problems: [] };
}

// The runtime's view of a studio statement: the inverse of the harness's specFromManifest.
export function manifestFromSpec(spec) {
  return { name: spec.name, version: spec.version, owner: spec.builderId || spec.owner, purpose: spec.purpose, trigger: spec.trigger,
    tools: spec.tools.map((t) => t.action), autonomy: Object.fromEntries(spec.tools.map((t) => [t.action, t.level])) };
}

// Live studio agents whose schedule came round between the last plant tick and now (plant-clock times).
const DAYS = { weekdays: [1, 2, 3, 4, 5], daily: [0, 1, 2, 3, 4, 5, 6], fridays: [5] };
export function dueStudioAgents(ont, nowIso, lastIso) {
  const now = Date.parse(nowIso), last = Date.parse(lastIso);
  const due = (every) => {
    let m;
    if ((m = every.match(/^every (\d+) min$/))) { const n = Number(m[1]) * 60000; return Math.floor(now / n) > Math.floor(last / n); }
    if (!(m = every.match(/^(weekdays|daily|fridays) at (\d\d):(\d\d)$/))) return false;
    const at = (Number(m[2]) * 60 + Number(m[3])) * 60000;
    for (let d = last - (last % 86400000); d <= now; d += 86400000) if (d + at > last && d + at <= now && DAYS[m[1]].includes(new Date(d).getUTCDay())) return true;
    return false;
  };
  return ont.list("AgentSpec", (s) => s.builderId && s.template && s.state === "live" && s.trigger && s.trigger.kind === "schedule" && due(String(s.trigger.every))).map((s) => s.name);
}

// Replay (agents design §6.1 step 4): the digester run over the last days of its source as its builder, in shadow,
// each case matched to what the person did. A replay replaces the agent's earlier replay; it writes ShadowActions only.
export function replay(sys, spec, { days = 14 } = {}) {
  const { ont, connectors: c, tel } = sys, now = tel.now(), since = new Date(Date.parse(now) - days * 86400000).toISOString();
  const out = { cases: 0, agreed: 0, differed: 0, missed: 0, unsure: 0, caught: 0, stale: 0, constraintHits: 0, examples: [] };
  if (spec.template !== "digester") return { ...out, note: "Replay covers the document digester; the other templates build their record in shadow." };
  const builder = ont.get(spec.builderId), tol = Number(spec.params.tolerancePct) || 2, src = spec.params.source;
  for (const r of spec.reads || []) {
    if (!String(r.source).startsWith("connector:")) continue;
    const ok = catalogueAllows(ont, { kind: r.source.slice("connector:".length), op: "read", role: builder.role });
    if (!ok.ok) throw new Error(ok.reason);
  }
  for (const x of ont.list("ShadowAction", (x) => x.agent === spec.name && x.replay)) ont.remove(x.id);
  const view = ont.view(builder), moves = c.m365.files.moves();
  const docs = src.kind === "m365.mail" ? c.m365.mail.list(src.mailbox, { since }).flatMap((m) => m.attachments.map((att) => ({ att, at: m.receivedDateTime })))
    : src.kind === "chat" ? view.list("Message", (m) => m.channelId === src.channelId && m.at >= since).flatMap((m) => (m.media || []).map((id) => ({ att: c.attachment(id), at: m.at })))
    : moves.filter((x) => x.path.startsWith(src.path) && x.at >= since).map((x) => ({ att: c.attachment(x.sourceId), at: x.at }));
  const seen = [], examples = [];
  for (const doc of docs.filter((d) => d.att && isInvoiceDoc(d.att))) {
    const r = digestDoc(doc.att, { erp: c.erp, moves, seen, at: doc.at, tolerancePct: tol });
    seen.push({ supplierId: r.fields.supplierId, number: r.fields.invoiceNo, total: r.fields.total, sourceId: doc.att.id, receivedAt: doc.at });
    const filed = moves.find((m) => m.sourceId === doc.att.id && ont.get(m.by) && ont.get(m.by).type === "Person");
    const unsure = r.cells.some((x) => x.grade === "AMBIGUOUS" && !x.reviewed);
    const caught = !unsure && r.match.issues.some((i) => ["duplicate", "bank-change"].includes(i.kind));
    const agreed = !unsure && !caught && r.verdict === "file" && !!filed && filed.path === r.destination.path;
    const outcome = unsure ? "unsure" : caught ? "caught" : agreed ? "agreed" : "differed";
    out.cases++;
    out[outcome]++;
    ont.upsert({ id: shadowId(), type: "ShadowAction", agent: spec.name, specVersion: spec.version, runId: null, action: r.verdict === "file" ? "file_document" : "digest_document",
      params: { attachmentId: doc.att.id, ...(r.verdict === "file" ? { path: r.destination.path } : {}) }, at: doc.at, status: agreed ? "agreed" : "differed", reason: agreed ? null : outcome,
      matchedTo: filed ? filed.itemId : null, matchedAt: now, replay: true, minClearance: builder.clearance, audience: [builder.id, spec.approver].filter((x) => typeof x === "string") });
    examples.push({ attachmentId: doc.att.id, name: doc.att.name, at: doc.at, verdict: r.verdict, outcome, path: r.verdict === "file" ? r.destination.path : null, personPath: filed ? filed.path : null,
      reason: r.match.issues.map((i) => i.detail).concat(r.cells.filter((x) => x.grade === "AMBIGUOUS").map((x) => `${x.key}: ${x.reasoning}`)).join("; ") || null });
  }
  out.examples = [...examples.filter((e) => e.outcome !== "agreed"), ...examples.filter((e) => e.outcome === "agreed")].slice(0, 10);
  return out;
}
