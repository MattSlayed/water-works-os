// Typed ontology actions, shared by people and agents (PRD §6.3, AD-02), and the action service that applies the
// autonomy dial (BR-04, BR-05, FR-AGT-004) and writes Decisions, Proposals and Feedback (FR-GOV-002).
import { rank } from "./ontology.mjs";
import { currentProcedure, stepLock, bandCheck, partNamesIn, stepRequires } from "./functions.mjs";
import { packageHash, currentPlantModel, writePlant } from "./plant.mjs";
import { specFor, specId, promotionGap, MODES, checkWrite, approvalTerms, expectedEffect, shadowId } from "./harness.mjs";
import { digestDoc } from "./digest.mjs";
import { jobBrief, readingNeed } from "./brief.mjs";
import { validateStatement, replay } from "./studio.mjs";
import { TEMPLATES } from "./templates.mjs";

export const LEVELS = ["read", "draft", "notify", "propose", "act"];
const lv = (l) => LEVELS.indexOf(l);

let seq = 0;
const nextId = (p) => `${p}-${String(++seq).padStart(5, "0")}`;
const wallClock = () => new Date().toISOString();

// needs: the level an actor must hold to apply the action directly. ceiling: the most an agent may ever hold
// for it ("human" = never an agent). minClearance: the least clearance of the actor (or the person an agent acts for).
const def = (needs, ceiling, required, apply, minClearance = "technician") => ({ needs, ceiling, required, apply, minClearance });

// The revert is relative (agents design §4.6): it restores only the fields that still hold what the patch wrote, so a
// later edit by someone else is kept; it returns { kept: [fields] }.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const setProps = (ont, id, patch) => {
  const prev = ont.get(id);
  if (!prev) throw new Error(`not found: ${id}`);
  const old = Object.fromEntries(Object.keys(patch).map((k) => [k, prev[k]]));
  ont.upsert({ id, type: prev.type, ...patch });
  return () => {
    const cur = ont.get(id), kept = Object.keys(patch).filter((k) => !same(cur[k], patch[k]));
    ont.upsert({ id, type: prev.type, ...Object.fromEntries(Object.entries(old).filter(([k]) => !kept.includes(k))) });
    return { kept };
  };
};
const create = (ont, obj, linksTo = []) => {
  const o = ont.upsert(obj);
  for (const [rel, to] of linksTo) if (to && ont.get(to)) ont.link(o.id, rel, to);
  return o;
};

// Parameters that name an object: the type it must be. Every named object must also be visible to the actor.
const TARGET_TYPES = { sceneId: ["Scene"], aoiId: ["Region"], detectionId: ["GeoDetection"], chemicalId: ["Chemical"], modelId: ["PlantModel"], channelId: ["Channel"], messageId: ["Message"], documentId: ["Draft"], onBehalfOf: ["Person", "Project"], procedureId: ["Procedure"], executionId: ["Execution"], issueId: ["Issue"], noteId: ["KnowledgeNote"], personId: ["Person"], projectId: ["Project"], workOrderId: ["WorkOrder"], assetId: ["Asset"], partIds: ["Part"], partId: ["Part"], alertId: ["Alert"], permitId: ["Permit"], assigneeId: ["Person"], holderId: ["Person"], intakeId: ["DocumentIntake"], suggestionId: ["Suggestion"], itemId: ["Part", "Chemical"], targetId: null };
const PATCHABLE = ["title", "priority", "state", "planned", "hours", "closed"];
const ISSUE_STATES = ["open", "triaged", "in_work", "done", "dropped"];
// The person an action is done by or for: an agent acts for the person who launched it.
const actorId = (ctx) => ctx.actor.onBehalfOf || ctx.actor.id;
const atLeast = (ctx, c) => rank(ctx.actor.clearance) >= rank(c);
const isolatedPermit = (ont, assetId) => {
  const permit = ont.list("Permit", (x) => x.assetId === assetId && x.state === "open")[0] || null;
  return { permit, isolated: !!(permit && (permit.isolations || []).some((i) => i.state === "applied")) };
};

const agentSpec = (ont, name) => { const s = specFor(ont, name); if (!s) throw new Error(`unknown agent ${name}`); return s; };
// Withdraw an agent's open proposals (all of them, or one tool's); returns the undos.
const withdrawFor = (ont, agent, action, ctx, reason) => ont.list("Proposal", (p) => p.actorId === agent && p.state === "open" && (!action || p.action === action))
  .map((p) => setProps(ont, p.id, { state: "withdrawn", withdrawnAt: ctx.now(), withdrawnReason: reason }));

// IT's connector catalogue (agents design §7): may this role use this connector operation, at this level?
// locked: the line needs an IT sign-off for the role and does not have one yet.
export const connectorId = (kind) => `CON-${String(kind).replace(".", "-")}`;
export function catalogueAllows(ont, { kind, op, role, level }) {
  const con = ont.get(connectorId(kind)), line = con && con.lines.find((l) => l.op === op);
  if (!line) return { ok: false, reason: `${kind} ${op} is not in the catalogue`, locked: false, maxLevel: null };
  if (!line.roles.includes("*") && !line.roles.includes(role)) return { ok: false, reason: `${kind} ${op} is not allowed for ${role || "this role"}`, locked: false, maxLevel: line.maxLevel };
  if (level && lv(level) > lv(line.maxLevel)) return { ok: false, reason: `${kind} ${op} for ${role}: ${level} is above ${line.maxLevel}`, locked: false, maxLevel: line.maxLevel };
  return { ok: true, reason: null, locked: !!line.itSignOff && !(line.signedOff || {})[role], maxLevel: line.maxLevel };
}
// The catalogue line an action is bound to (file_document is m365.files write), or null.
export const catalogueLine = (ont, action) => {
  for (const con of ont.list("Connector")) { const l = con.lines.find((x) => x.action === action); if (l) return { kind: con.kind, op: l.op }; }
  return null;
};
const itOnly = (ont, ctx) => { if (!(ont.get(actorId(ctx)) || {}).itAdmin) throw new Error("IT administrators only"); };
const lineOf = (ont, kind, op) => {
  const con = ont.get(connectorId(kind));
  if (!con) throw new Error(`no connector ${kind}`);
  const i = con.lines.findIndex((l) => l.op === op);
  return { con, i };
};

// The digester's documents (agents design §8): who built the agent and who approves for it see the intake.
const digestParties = (ont, ctx) => {
  const spec = ctx.actor.kind === "agent" ? specFor(ont, ctx.actor.id) : null, builder = (spec && spec.builderId) || actorId(ctx);
  const approver = spec && typeof spec.approver === "string" ? spec.approver : (ont.get(builder) || {}).supervisorId || null;
  return { builder, approver };
};
const intakeOf = (ont, p) => {
  const d = p.intakeId ? ont.get(p.intakeId) : ont.list("DocumentIntake", (x) => x.attachmentId === p.attachmentId && x.state !== "withdrawn").at(-1);
  if (!d) throw new Error(`${p.attachmentId} has not been digested`);
  if (d.attachmentId !== p.attachmentId) throw new Error(`${d.id} is not ${p.attachmentId}`);
  return d;
};
const seenOf = (ont, d0) => ont.list("DocumentIntake", (d) => d.state !== "withdrawn" && d.attachmentId !== d0.attachmentId && d.receivedAt < d0.receivedAt)
  .map((d) => ({ id: d.id, supplierId: d.fields.supplierId, number: d.fields.invoiceNo, total: d.fields.total, sourceId: d.attachmentId, receivedAt: d.receivedAt }));
// May this person (the builder, for an agent) read the document from the source it names? (agents design §7)
const SOURCE_READ = { "m365.mail": "m365.mail", "m365.files": "m365.files" };
function canReadSource(ont, c, builderId, source, attachmentId) {
  const who = ont.get(builderId) || {}, kind = SOURCE_READ[source && source.kind];
  for (const k of [kind, "erp"].filter(Boolean)) { const ok = catalogueAllows(ont, { kind: k, op: "read", role: who.role }); if (!ok.ok) throw new Error(ok.reason); }
  const there = source.kind === "m365.mail" ? c.m365.mail.list(source.mailbox).some((m) => m.attachments.some((a) => a.id === attachmentId))
    : source.kind === "m365.files" ? c.m365.files.moves().some((m) => m.sourceId === attachmentId)
    : source.kind === "chat" ? ont.view(who).list("Message", (m) => m.channelId === source.channelId && (m.media || []).includes(attachmentId)).length > 0 : false;
  if (!there) throw new Error(`${attachmentId} is not in ${source.kind}${source.mailbox ? ` ${source.mailbox}` : source.channelId ? ` ${source.channelId}` : ""} for ${builderId}`);
}
const notFile = (d) => { if (d.verdict !== "file") throw new Error(d.verdict === "person" ? `${d.id} goes to a person` : `${d.id} needs review`); };

// A job follows the procedure version released when it starts; shared by start_execution and the sampling round.
function openExecution(ont, wo, personId, proc, at) {
  // performance data: the person, their own supervisor and engineers (the manager sees everything)
  const audience = [...new Set([personId, ont.get(personId).supervisorId, ...ont.list("Person", (x) => x.clearance === "engineer").map((x) => x.id)].filter(Boolean))];
  const ex = create(ont, { id: nextId("EXE"), type: "Execution", workOrderId: wo.id, assetId: wo.assetId, personId, procedureId: proc.id, procedureVersion: proc.version, startedAt: at, finishedAt: null, state: "running", audience,
    steps: proc.steps.map((s) => ({ step: s.step, state: "todo", at: null, minutes: null, value: null, readingId: null, note: null })) }, [["FOR", wo.id], ["FOLLOWS", proc.id], ["BY", personId]]);
  const undoWo = setProps(ont, wo.id, { state: "in_progress" });
  return { ex, revert: () => { setProps(ont, ex.id, { state: "cancelled" }); undoWo(); } };
}
// The lab analyst who takes raw-water samples: lab analysts work days, so the first on the roster.
const samplerOf = (ont) => ont.list("Person", (x) => x.role === "lab_analyst").sort((a, b) => a.id.localeCompare(b.id))[0];

export const ACTIONS = {
  // The harness's switches (agents design §4.2, §4.6): people only, engineers and above.
  // Promotion is the second pair of eyes: an engineer, or the agent's named approver (a supervisor or above), never its builder.
  promote_agent: def("act", "human", ["agent", "to"], (ont, p, ctx) => {
    const spec = agentSpec(ont, p.agent);
    if (actorId(ctx) === spec.owner || actorId(ctx) === spec.builderId) throw new Error("the builder cannot promote their own agent");
    if (!atLeast(ctx, "engineer") && !(spec.approver === actorId(ctx) && atLeast(ctx, "supervisor"))) throw new Error("promoting needs engineer clearance or the agent's approver");
    const next = MODES[MODES.indexOf(spec.mode) + 1];
    if (!next) throw new Error(`${spec.name} is already ${spec.mode}`);
    if (p.to !== next) throw new Error(`promotion is one step at a time: ${spec.name} is ${spec.mode}, so the next step is ${next}`);
    const gap = promotionGap(ont, spec);
    if (gap) throw new Error(`not yet: ${gap}`);
    return { objects: [spec.id], revert: setProps(ont, spec.id, { mode: p.to }) };
  }),
  // A person starts an agent for their own work (agents design §6.1 step 5): checked, and always in shadow.
  create_studio_agent: def("act", "human", ["spec"], (ont, p, ctx) => {
    const s = p.spec && typeof p.spec === "object" ? p.spec : {};
    if (s.builderId !== actorId(ctx)) throw new Error("a studio agent is built for your own work: its builder must be you");
    if (!s.name || s.id !== specId(s.name)) throw new Error("the statement needs a name and its id");
    const v = validateStatement(s, { ont });
    if (!v.ok) throw new Error(v.problems.join("; "));
    if (ont.get(s.id) && ont.get(s.id).state !== "retired") throw new Error(`${s.name} already exists`);
    if (!s.trigger || !["schedule", "manual"].includes(s.trigger.kind)) throw new Error("a studio agent runs on a schedule or when its builder starts it");
    const keep = ["id", "name", "version", "purpose", "template", "params", "trigger", "reads", "tools", "approver", "backup", "escalateAfterMin", "onTimeout", "exclusions", "builderId", "constraints"];
    const stored = ont.upsert({ ...Object.fromEntries(keep.filter((k) => k in s).map((k) => [k, structuredClone(s[k])])), type: "AgentSpec", owner: s.builderId, mode: "shadow", state: "live",
      promotion: { ...(TEMPLATES[s.template].promotion || { minCases: 20, minAgreePct: 90, maxBreaches: 0, maxStalePct: 5 }) }, breaches: 0, killedAt: null, killedBy: null, createdAt: ctx.now() });
    // its record starts as the replay of exactly the statement it starts with (agents design §6.1 step 4)
    if (s.template === "digester") replay({ ont, connectors: ctx.connectors, now: ctx.now() }, stored, { record: true });
    return { objects: [s.id], revert: () => setProps(ont, s.id, { state: "retired", killedAt: ctx.now(), killedBy: actorId(ctx) }) };
  }),
  // stepping down needs no second pair of eyes: it only narrows what the agent may do
  demote_agent: def("act", "human", ["agent", "to"], (ont, p, ctx) => {
    const spec = agentSpec(ont, p.agent);
    const down = MODES[MODES.indexOf(spec.mode) - 1];
    if (!down) throw new Error(`${spec.name} is already ${spec.mode}`);
    if (p.to !== down) throw new Error(`demotion is one step down: ${spec.name} is ${spec.mode}, so the next step down is ${down}`);
    return { objects: [spec.id], revert: setProps(ont, spec.id, { mode: p.to }) };
  }, "engineer"),
  set_agent_state: def("act", "human", ["agent", "state"], (ont, p, ctx) => {
    const spec = agentSpec(ont, p.agent);
    if (!["live", "paused", "retired"].includes(p.state)) throw new Error("state must be live, paused or retired");
    const off = p.state !== "live";
    const undo = [setProps(ont, spec.id, { state: p.state, killedAt: off ? ctx.now() : null, killedBy: off ? actorId(ctx) : null })];
    if (off) undo.push(...withdrawFor(ont, spec.name, null, ctx, `${spec.name} ${p.state}`), ...ont.list("ShadowAction", (x) => x.agent === spec.name && x.status === "pending").map((x) => setProps(ont, x.id, { status: "dropped" })));
    return { objects: [spec.id], revert: () => undo.reverse().forEach((f) => f()) };
  }, "engineer"),
  set_tool_enabled: def("act", "human", ["agent", "action", "enabled"], (ont, p, ctx) => {
    const spec = agentSpec(ont, p.agent);
    if (!spec.tools.some((t) => t.action === p.action)) throw new Error(`${p.action} is not one of ${spec.name}'s tools`);
    const on = p.enabled === true || p.enabled === "true";
    const undo = [setProps(ont, spec.id, { tools: spec.tools.map((t) => (t.action === p.action ? { ...t, enabled: on } : t)) })];
    if (!on) undo.push(...withdrawFor(ont, spec.name, p.action, ctx, `${p.action} turned off`));
    return { objects: [spec.id], revert: () => undo.reverse().forEach((f) => f()) };
  }, "engineer"),
  // IT's catalogue: one IT administrator edits a line or signs it off for a role (agents design §7, §14 call 7)
  set_catalogue_line: def("act", "human", ["kind", "op", "patch"], (ont, p, ctx) => {
    itOnly(ont, ctx);
    const keys = Object.keys(p.patch || {});
    if (!keys.length || keys.some((k) => !["action", "roles", "maxLevel", "itSignOff"].includes(k))) throw new Error("patch may only change: action, roles, maxLevel, itSignOff");
    if (p.patch.roles !== undefined && (!Array.isArray(p.patch.roles) || p.patch.roles.some((r) => typeof r !== "string"))) throw new Error("roles must be a list of roles");
    if (p.patch.maxLevel !== undefined && !LEVELS.includes(p.patch.maxLevel)) throw new Error(`maxLevel must be one of ${LEVELS.join(", ")}`);
    const { con, i } = lineOf(ont, p.kind, p.op);
    const base = i >= 0 ? con.lines[i] : { op: p.op, action: null, roles: [], maxLevel: "read", itSignOff: false, signedOff: {} };
    const lines = i >= 0 ? con.lines.map((l, j) => (j === i ? { ...base, ...p.patch } : l)) : [...con.lines, { ...base, ...p.patch }];
    return { objects: [con.id], revert: setProps(ont, con.id, { lines }) };
  }),
  sign_off_catalogue_line: def("act", "human", ["kind", "op", "role"], (ont, p, ctx) => {
    itOnly(ont, ctx);
    const { con, i } = lineOf(ont, p.kind, p.op);
    if (i < 0) throw new Error(`${p.kind} ${p.op} is not in the catalogue`);
    const l = con.lines[i];
    if (!l.itSignOff) throw new Error(`${p.kind} ${p.op} needs no sign-off`);
    if (!l.roles.includes(p.role)) throw new Error(`${p.kind} ${p.op} is not allowed for ${p.role}`);
    if ((l.signedOff || {})[p.role]) throw new Error(`${p.kind} ${p.op} is already signed off for ${p.role}`);
    const mark = { by: actorId(ctx), at: ctx.now() };
    ont.upsert({ id: con.id, type: "Connector", lines: con.lines.map((x, j) => (j === i ? { ...x, signedOff: { ...x.signedOff, [p.role]: mark } } : x)) });
    // the revert removes only this role's sign-off, so a later edit to the line is kept
    const revert = () => {
      const cur = ont.get(con.id);
      ont.upsert({ id: con.id, type: "Connector", lines: cur.lines.map((x) => (x.op !== p.op ? x : { ...x, signedOff: Object.fromEntries(Object.entries(x.signedOff || {}).filter(([r, m]) => !(r === p.role && same(m, mark)))) })) });
    };
    return { objects: [con.id], revert };
  }),
  // The document digester (agents design §8): digest into graded cells, file, post the match (money: propose at most), review
  digest_document: def("draft", "act", ["attachmentId", "source"], (ont, p, ctx) => {
    const c = ctx.connectors, att = c && c.attachment(p.attachmentId);
    if (!att) throw new Error(`attachment not found: ${p.attachmentId}`);
    const who = digestParties(ont, ctx), at = p.receivedAt || ctx.now(), tol = Number(p.tolerancePct) || 2;
    canReadSource(ont, c, who.builder, p.source, att.id);
    if (ont.list("DocumentIntake", (d) => d.attachmentId === att.id && d.builderId === who.builder && d.state !== "withdrawn").length) throw new Error(`${att.id} is already digested`);
    const r = digestDoc(att, { erp: c.erp, moves: c.m365.files.moves(), seen: seenOf(ont, { attachmentId: att.id, receivedAt: at }), at, asOf: ctx.now(), tolerancePct: tol, cells: Array.isArray(p.cells) ? p.cells : null });
    const d = create(ont, { id: nextId("DIN"), type: "DocumentIntake", attachmentId: att.id, name: att.name, messageId: p.fromMessage || null, source: p.source, receivedAt: at, tolerancePct: tol, ...r,
      builderId: who.builder, approverId: who.approver, audience: [...new Set([who.builder, who.approver].filter(Boolean))], reviews: [], state: "digested", at: ctx.now() }, [["FROM", p.fromMessage]]);
    return { objects: [d.id], revert: () => setProps(ont, d.id, { state: "withdrawn" }) };
  }),
  file_document: def("act", "act", ["attachmentId", "path"], (ont, p, ctx) => {
    const d = intakeOf(ont, p);
    notFile(d);
    if (d.state === "filed") throw new Error(`${d.id} is already filed`);
    const item = ctx.connectors.m365.files.copy(d.attachmentId, String(p.path), { by: actorId(ctx), at: ctx.now() });
    const undo = setProps(ont, d.id, { state: "filed", filedItemId: item.id, filedPath: String(p.path) });
    return { objects: [d.id], revert: () => { ctx.connectors.m365.files.remove(item.id); return undo(); } };
  }),
  post_invoice_match: { ...def("act", "propose", ["attachmentId", "poId"], (ont, p, ctx) => {
    const d = intakeOf(ont, p);
    notFile(d);
    if (d.postedInvoiceId) throw new Error(`${d.id} is already posted as ${d.postedInvoiceId}`);
    const inv = ctx.connectors.erp.postMatch({ invoice: { ...d.fields, sourceId: d.attachmentId, receivedAt: d.receivedAt }, poId: String(p.poId), by: actorId(ctx), at: ctx.now() });
    const undo = setProps(ont, d.id, { postedInvoiceId: inv.id });
    return { objects: [d.id], revert: () => { ctx.connectors.erp.unpost(inv.id); return undo(); } };
  }), money: true },
  review_intake_cells: def("act", "human", ["intakeId", "marks"], (ont, p, ctx) => {
    const d = ont.get(p.intakeId);
    if (d.state !== "digested") throw new Error(`${d.id} is ${d.state}`);
    if (!Array.isArray(p.marks) || !p.marks.length) throw new Error("marks must be a non-empty list of {key, verdict, value?}");
    for (const m of p.marks) {
      const c = d.cells.find((x) => x.key === (m && m.key));
      if (!c) throw new Error(`no cell ${m && m.key} in ${d.id}`);
      if (!["accept", "correct"].includes(m.verdict)) throw new Error("verdict must be accept or correct");
      if (m.verdict === "correct" && m.value === undefined) throw new Error(`correcting ${c.key} needs a value`);
      if (m.verdict === "correct" && ["total", "vat"].includes(c.key) && !(m.value !== null && m.value !== "" && Number.isFinite(Number(m.value)))) throw new Error(`${c.key} needs an amount, such as 1234.50`);
      if (m.verdict === "accept" && c.grade === "AMBIGUOUS" && (c.value == null || /\?/.test(String(c.value)))) throw new Error(`${c.key} cannot be read: correct it with a value`);
    }
    const mark = { by: actorId(ctx), at: ctx.now() }, hit = new Map(p.marks.map((m) => [m.key, m]));
    const cells = d.cells.map((c) => { const m = hit.get(c.key); return !m ? c : { ...c, ...(m.verdict === "correct" ? { value: m.value, reasoning: `${c.reasoning} — corrected by ${mark.by} from ${JSON.stringify(c.value)}` } : {}), reviewed: mark }; });
    const k = ctx.connectors, r = digestDoc(k.attachment(d.attachmentId), { erp: k.erp, moves: k.m365.files.moves(), seen: seenOf(ont, d), at: d.receivedAt, asOf: ctx.now(), tolerancePct: d.tolerancePct, cells });
    return { objects: [d.id], revert: setProps(ont, d.id, { cells: r.cells, fields: r.fields, match: r.match, verdict: r.verdict, destination: r.destination, reviews: [...(d.reviews || []), { ...mark, cells: hit.size }] }) };
  }),
  // Suggestions (agents design §9): made only for the person whose work they read; only that person answers them.
  // ---- Spec triage and corrections (job brief design §4–§5): only the site manager confirms a spec or records a correction ----
  record_spec_candidates: def("draft", "act", ["candidates"], (ont, p) => {
    if (!Array.isArray(p.candidates)) throw new Error("candidates must be a list");
    const made = [];
    for (const c of p.candidates) {
      const prev = ont.get(c.id);
      // a re-read keeps what a person decided about the candidate
      ont.upsert({ ...c, type: "SpecCandidate", minClearance: "engineer", status: prev && prev.status !== "suggested" ? prev.status : "suggested" });
      if (!prev) made.push(c.id);
    }
    return { objects: p.candidates.map((c) => c.id), revert: () => made.forEach((id) => ont.remove(id)) };
  }),
  update_spec: def("act", "propose", ["specId", "lo", "hi"], (ont, p, ctx) => {
    const who = ctx.approvedBy || actorId(ctx), person = ont.get(who);
    if (!person || person.role !== "works_manager") throw new Error("only the site manager confirms a spec");
    const sp = ont.get(p.specId);
    if (!sp || sp.type !== "Spec") throw new Error(`no spec ${p.specId}`);
    const lo = Number(p.lo), hi = Number(p.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) throw new Error("the band needs a low and a high, low first");
    const cand = p.candidateId ? ont.get(p.candidateId) : null;
    const prev = { version: sp.version, lo: sp.lo, hi: sp.hi, target: sp.target, condition: sp.condition, sourceRefs: sp.sourceRefs, confirmedBy: sp.confirmedBy, confirmedAt: sp.confirmedAt, reason: sp.reason };
    const ref = cand ? { kind: cand.source.kind, id: cand.source.id, title: cand.source.title, at: cand.source.at, authorId: cand.source.authorId || null } : { kind: "Person", id: who, title: "the site manager's own value", at: ctx.now(), authorId: who };
    ont.upsert({ id: sp.id, type: "Spec", version: sp.version + 1, lo, hi, target: p.target == null ? null : Number(p.target), condition: p.condition || null, sourceRefs: [ref],
      confirmedBy: who, confirmedAt: ctx.now(), reason: p.why ? String(p.why) : "Confirmed by the site manager", history: [...(sp.history || []), prev] });
    const undoCand = cand ? setProps(ont, cand.id, { status: "approved" }) : null;
    return { objects: [sp.id], revert: () => { ont.upsert({ id: sp.id, type: "Spec", ...prev, history: sp.history || [] }); if (undoCand) undoCand(); } };
  }, "manager"),
  record_correction: def("act", "human", ["line", "scope"], (ont, p, ctx) => {
    const person = ont.get(actorId(ctx));
    if (!person || person.role !== "works_manager") throw new Error("only the site manager records a correction");
    const sc = p.scope || {}, keys = ["assetId", "template", "orgId"].filter((k) => sc[k]);
    if (keys.length !== 1) throw new Error("a correction needs one scope: an asset, a make and model, or an organisation");
    const line = String(p.line).trim();
    if (!line || line.length > 100) throw new Error("the line must be 1 to 100 characters");
    const c = create(ont, { id: nextId("COR"), type: "Correction", line, text: p.text ? String(p.text) : line, wrongSourceRef: p.wrongSourceRef || null,
      wrongValue: p.wrongValue == null ? null : Number(p.wrongValue), rightValue: p.rightValue == null ? null : p.rightValue, scope: { [keys[0]]: sc[keys[0]] }, fromId: p.fromId || null, by: person.id, at: ctx.now() },
      [["FROM", p.fromId]]);
    return { objects: [c.id], revert: () => ont.remove(c.id) };
  }),
  record_suggestion: def("draft", "act", ["personId", "signal", "key", "title"], (ont, p, ctx) => {
    if (actorId(ctx) !== p.personId) throw new Error("a suggestion is only made for the person whose work it reads");
    const audience = Array.isArray(p.audience) && p.audience.includes(p.personId) ? p.audience.map(String) : [p.personId];
    const s = create(ont, { id: nextId("SUG"), type: "Suggestion", personId: p.personId, signal: p.signal, key: p.key, title: String(p.title), evidence: Array.isArray(p.evidence) ? p.evidence.map(String) : [],
      statement: p.statement || null, savedMinPerWeek: Number(p.savedMinPerWeek) || 0, basis: p.basis || null, state: "open", audience, at: ctx.now() });
    return { objects: [s.id], revert: () => setProps(ont, s.id, { state: "withdrawn" }) };
  }),
  accept_suggestion: def("act", "human", ["suggestionId"], (ont, p, ctx) => {
    const s = ont.get(p.suggestionId);
    if (s.personId !== actorId(ctx)) throw new Error("only the person it was made for answers a suggestion");
    if (s.state !== "open") throw new Error(`${s.id} is ${s.state}`);
    return { objects: [s.id], revert: setProps(ont, s.id, { state: "accepted", acceptedAt: ctx.now() }) };
  }),
  dismiss_suggestion: def("act", "human", ["suggestionId"], (ont, p, ctx) => {
    const s = ont.get(p.suggestionId);
    if (s.personId !== actorId(ctx)) throw new Error("only the person it was made for answers a suggestion");
    if (s.state !== "open") throw new Error(`${s.id} is ${s.state}`);
    return { objects: [s.id], revert: setProps(ont, s.id, { state: "dismissed", dismissedAt: ctx.now(), dismissReason: p.reason ? String(p.reason) : null }) };
  }),
  create_work_order: def("act", "act", ["assetId", "title"], (ont, p, ctx) => {
    const wo = create(ont, { id: nextId("WO-N"), type: "WorkOrder", assetId: p.assetId, title: p.title, kind: p.kind || "CM", priority: p.priority || "P3", state: "requested", requested: ctx.now(), source: p.source || null }, [["TARGETS", p.assetId]]);
    return { objects: [wo.id], revert: () => setProps(ont, wo.id, { state: "cancelled" }) };
  }),
  update_work_order: def("act", "propose", ["workOrderId", "patch"], (ont, p, ctx) => {
    const keys = Object.keys(p.patch || {});
    if (!keys.length || keys.some((k) => !PATCHABLE.includes(k))) throw new Error(`patch may only change: ${PATCHABLE.join(", ")}`);
    if (keys.some((k) => p.patch[k] !== null && !["string", "number"].includes(typeof p.patch[k]))) throw new Error("patch values must be text or numbers");
    return { objects: [p.workOrderId], revert: setProps(ont, p.workOrderId, p.patch) };
  }),
  draft_document: def("draft", "act", ["kind", "title", "body"], (ont, p, ctx) => {
    const d = create(ont, { id: nextId("DRF"), type: "Draft", minClearance: ctx.actor.kind === "agent" ? ctx.actor.clearance : null, audience: Array.isArray(p.audience) ? p.audience.map(String) : null, kind: p.kind, title: p.title, body: p.body, data: p.data || null, aboutId: p.aboutId || null, assetId: p.assetId || null, created: ctx.now(), state: "draft" }, [["ABOUT", p.aboutId]]);
    return { objects: [d.id], revert: () => setProps(ont, d.id, { state: "withdrawn" }) };
  }),
  reserve_parts: def("act", "act", ["partIds"], (ont, p, ctx) => {
    // check every part before changing any, so a refusal leaves stock untouched; reverts are relative
    for (const id of p.partIds) if ((ont.get(id).stock || 0) < 1) throw new Error(`no stock for ${id}`);
    for (const id of p.partIds) { const part = ont.get(id); ont.upsert({ id, type: "Part", stock: part.stock - 1, reserved: (part.reserved || 0) + 1 }); }
    const reverts = p.partIds.map((id) => () => { const part = ont.get(id); ont.upsert({ id, type: "Part", stock: (part.stock || 0) + 1, reserved: Math.max(0, (part.reserved || 0) - 1) }); });
    const r = create(ont, { id: nextId("RSV"), type: "Reservation", partIds: p.partIds, workOrderId: p.workOrderId || null, assetId: ont.get(p.partIds[0]).assetId, at: ctx.now() }, [["FOR", p.workOrderId]]);
    return { objects: [r.id, ...p.partIds], revert: () => { reverts.forEach((f) => f()); setProps(ont, r.id, { state: "released" }); } };
  }),
  raise_purchase_requisition: def("act", "propose", ["itemId", "qty"], (ont, p, ctx) => {
    const pr = create(ont, { id: nextId("PR"), type: "PurchaseRequisition", itemId: p.itemId, qty: p.qty, reason: p.reason || null, state: "raised", at: ctx.now() });
    return { objects: [pr.id], revert: () => setProps(ont, pr.id, { state: "cancelled" }) };
  }),
  schedule_work: def("act", "propose", ["workOrderId", "assigneeId"], (ont, p, ctx) => {
    const revert = setProps(ont, p.workOrderId, { assigneeId: p.assigneeId, planned: p.window || null, state: "scheduled" });
    ont.link(p.workOrderId, "ASSIGNED_TO", p.assigneeId);
    return { objects: [p.workOrderId], revert };
  }),
  open_permit: def("act", "human", ["assetId", "kind", "holderId"], (ont, p, ctx) => {
    const a = ont.get(p.assetId);
    const pt = create(ont, { id: nextId("PTW"), type: "Permit", kind: p.kind, state: "open", assetId: p.assetId, zoneId: a && a.zoneId, holderId: p.holderId, opened: ctx.now(), isolations: [] }, [["COVERS", p.assetId]]);
    return { objects: [pt.id], revert: () => setProps(ont, pt.id, { state: "cancelled" }) };
  }, "supervisor"),
  close_permit: def("act", "human", ["permitId"], (ont, p, ctx) => ({ objects: [p.permitId], revert: setProps(ont, p.permitId, { state: "closed", closed: ctx.now() }) }), "supervisor"),
  record_isolation: def("act", "human", ["permitId", "point"], (ont, p, ctx) => {
    const pt = ont.get(p.permitId);
    if (!pt) throw new Error(`permit not found: ${p.permitId}`);
    const isoId = nextId("ISO");
    ont.upsert({ id: pt.id, type: "Permit", isolations: [...(pt.isolations || []), { isoId, point: p.point, state: "applied", appliedBy: p.by || null, verifiedBy: p.verifiedBy || null }] });
    // relative: the revert removes this isolation only, whatever was recorded after it
    return { objects: [p.permitId], revert: () => ont.upsert({ id: pt.id, type: "Permit", isolations: (ont.get(pt.id).isolations || []).filter((i) => i.isoId !== isoId) }) };
  }, "supervisor"),
  raise_alert: def("act", "act", ["targetId", "title"], (ont, p, ctx) => {
    const t = ont.get(p.targetId);
    const al = create(ont, { id: nextId("ALT"), type: "Alert", targetId: p.targetId, assetId: t && t.type === "Asset" ? t.id : t && t.assetId, zoneId: t && t.zoneId, title: p.title, severity: p.severity || "medium", evidence: p.evidence || [], score: p.score ?? null, state: "active", at: ctx.now() }, [["ON", p.targetId]]);
    return { objects: [al.id], revert: () => setProps(ont, al.id, { state: "withdrawn" }) };
  }),
  rank_alert: def("act", "act", ["alertId", "consequence"], (ont, p, ctx) => ({ objects: [p.alertId], revert: setProps(ont, p.alertId, { consequence: p.consequence, priority: p.priority || null, rankedAt: ctx.now() }) })),
  acknowledge_alert: def("act", "act", ["alertId"], (ont, p, ctx) => ({ objects: [p.alertId], revert: setProps(ont, p.alertId, { state: "acknowledged" }) })),
  notify: def("notify", "act", ["to", "message"], (ont, p, ctx) => {
    const to = [].concat(p.to).map(String);
    const n = create(ont, { id: nextId("NTF"), type: "Notification", audience: to.length ? to : null, minClearance: !to.length && ctx.actor.kind === "agent" ? ctx.actor.clearance : null, to, message: p.message, aboutId: p.aboutId || null, at: ctx.now() });
    return { objects: [n.id] };
  }),
  record_reading: def("act", "act", ["targetId", "measure", "value"], (ont, p, ctx) => {
    const t = ont.get(p.targetId);
    const r = create(ont, { id: nextId("RDG"), type: "Reading", targetId: p.targetId, assetId: t && (t.assetId || t.id), measure: p.measure, value: p.value, unit: p.unit || null, workOrderId: p.workOrderId || null, at: ctx.now(), source: "field", by: actorId(ctx) }, [["OF", p.targetId]]);
    return { objects: [r.id] };
  }),
  tag_part: def("act", "act", ["partId", "note"], (ont, p, ctx) => {
    const part = ont.get(p.partId);
    if (!part) throw new Error(`part not found: ${p.partId}`);
    const f = create(ont, { id: nextId("FND"), type: "Finding", partId: p.partId, assetId: part.assetId, workOrderId: p.workOrderId || null, text: p.note, reading: p.reading ?? null, photo: p.photo || null, point: p.point || null, authorId: p.authorId || null, verified: false, at: ctx.now() }, [["ABOUT", p.partId], ["ON", p.workOrderId]]);
    return { objects: [f.id] };
  }),
  raise_deviation: def("act", "propose", ["targetId", "finding"], (ont, p, ctx) => {
    const t = ont.get(p.targetId);
    const dv = create(ont, { id: nextId("DEV"), type: "Deviation", targetId: p.targetId, assetId: t && (t.assetId || t.id), finding: p.finding, disposition: p.disposition || "engineer to decide", state: "raised", at: ctx.now() }, [["AGAINST", p.targetId]]);
    return { objects: [dv.id], revert: () => setProps(ont, dv.id, { state: "withdrawn" }) };
  }),
  change_asset_state: def("act", "propose", ["assetId", "state"], (ont, p, ctx) => ({ objects: [p.assetId], revert: setProps(ont, p.assetId, { state: p.state }) })),
  // A recorded request for the process controller. Nothing is written to a control system (BR-06).
  request_setpoint_change: def("act", "propose", ["targetId", "setpoint", "value"], (ont, p, ctx) => {
    const r = create(ont, { id: nextId("SPR"), type: "SetpointRequest", targetId: p.targetId, setpoint: p.setpoint, value: p.value, unit: p.unit || null, state: "requested", at: ctx.now() });
    return { objects: [r.id], revert: () => setProps(ont, r.id, { state: "withdrawn" }) };
  }),
  submit_compliance_pack: def("act", "human", ["framework"], (ont, p, ctx) => {
    const s = create(ont, { id: nextId("SUB"), type: "Submission", framework: p.framework, state: "submitted", at: ctx.now() });
    return { objects: [s.id] };
  }, "manager"),
  // Living SOPs: an author with the c-author competence drafts the next version; the manager releases it.
  propose_procedure_version: def("act", "human", ["procedureId", "steps", "reason"], (ont, p, ctx) => {
    const today = ctx.now().slice(0, 10);
    if (!ont.list("Competency", (c) => c.personId === ctx.actor.id && c.competency === "c-author" && c.validTo >= today).length) throw new Error("needs the c-author competence");
    const cur = ont.get(p.procedureId);
    if (!Array.isArray(p.steps) || !p.steps.length || p.steps.some((s) => !s || typeof s.text !== "string" || !s.text.trim())) throw new Error("steps must be a non-empty list with text");
    const version = Math.max(...ont.list("Procedure", (x) => x.template === cur.template).map((x) => x.version)) + 1;
    const id = `PRC-${cur.template.toUpperCase()}-v${version}`;
    const assets = new Set(ont.list("Asset", (a) => a.template === cur.template).map((a) => a.id));
    const bands = new Map(ont.list("Part", (x) => assets.has(x.assetId)).map((x) => [x.name, x.band]));
    const bandOf = (n) => bands.get(n) || null;
    const steps = p.steps.map((s, i) => {
      const text = String(s.text).trim();
      const same = cur.steps.find((x) => x.text === text);
      // shortcut: a new or reworded step is treated as intrusive (locked until permit and isolation); let authors set it when they ask
      const partNames = same ? same.partNames : partNamesIn(text, [...bands.keys()]);
      const base = same || { intrusive: true, hazard: null, expectedMinutes: 25 };
      return { ...base, text, partNames, documentId: cur.documentId, requires: stepRequires(text, base.intrusive, partNames, bandOf), id: `${id}-S${String(i + 1).padStart(2, "0")}`, step: i + 1 };
    });
    const pr = create(ont, { id, type: "Procedure", template: cur.template, documentId: cur.documentId, title: cur.title, version, state: "draft", steps, basedOn: cur.id, proposedBy: ctx.actor.id, reason: p.reason, created: ctx.now() }, [["PART_OF", cur.documentId], ["REVISES", cur.id]]);
    return { objects: [pr.id], revert: () => setProps(ont, pr.id, { state: "withdrawn" }) };
  }, "engineer"),
  release_procedure: def("act", "human", ["procedureId"], (ont, p, ctx) => {
    const next = ont.get(p.procedureId);
    if (next.state !== "draft") throw new Error(`${next.id} is ${next.state}, not a draft`);
    const prev = ont.list("Procedure", (x) => x.template === next.template && x.state === "released")[0];
    const undo = [setProps(ont, next.id, { state: "released", releasedBy: ctx.actor.id, releasedAt: ctx.now() })];
    if (prev) undo.push(setProps(ont, prev.id, { state: "superseded" }));
    if (ont.get(next.documentId)) undo.push(setProps(ont, next.documentId, { sourceBehind: true }));
    return { objects: [next.id, ...(prev ? [prev.id] : [])], revert: () => undo.forEach((f) => f()) };
  }, "manager"),
  // Digitised work: a job follows the procedure version released when it starts.
  start_execution: def("act", "act", ["workOrderId", "personId"], (ont, p, ctx) => {
    if (actorId(ctx) !== p.personId && !atLeast(ctx, "supervisor")) throw new Error("only the person or a supervisor starts their job");
    const wo = ont.get(p.workOrderId), asset = ont.get(wo.assetId);
    if (["closed", "cancelled"].includes(wo.state)) throw new Error(`${wo.id} is ${wo.state}`);
    if (wo.assigneeId && wo.assigneeId !== p.personId && !atLeast(ctx, "supervisor")) throw new Error(`${wo.id} is assigned to ${wo.assigneeId}`);
    if (ont.list("Execution", (e) => e.workOrderId === wo.id && e.state === "running").length) throw new Error(`${wo.id} already has a running job`);
    const proc = currentProcedure(ont.list("Procedure"), asset && asset.template);
    if (!proc) throw new Error(`no released procedure for ${wo.id}`);
    const { ex, revert } = openExecution(ont, wo, p.personId, proc, ctx.now());
    // the job is held to the specs confirmed when it starts; a later change never moves it (job brief design §6)
    const specPins = ont.list("Spec", (x) => x.assetId === wo.assetId && x.step != null && proc.steps.some((st) => st.step === x.step))
      .map((x) => ({ specId: x.id, version: x.version, step: x.step, partName: x.partName, measure: x.measure, unit: x.unit, lo: x.lo, hi: x.hi }));
    ont.upsert({ id: ex.id, type: "Execution", specPins });
    // what the person was told before step 1, so root cause can later ask (design §4.6)
    const person = ont.get(p.personId), sm = ont.list("Person", (x) => x.role === "works_manager")[0];
    const b = jobBrief(ont.view({ id: person.id, clearance: person.clearance }), wo.id);
    const br = b && create(ont, { id: nextId("BRF"), type: "Brief", executionId: ex.id, workOrderId: wo.id, assetId: wo.assetId, personId: person.id, at: ctx.now(),
      specVersions: b.specVersions, correctionIds: b.correctionIds, lines: b.lines, audience: [...new Set([person.id, person.supervisorId, sm && sm.id].filter(Boolean))] }, [["FOR", ex.id]]);
    return { objects: [ex.id, wo.id, ...(br ? [br.id] : [])], revert: () => { if (br) ont.remove(br.id); revert(); } };
  }),
  complete_step: def("act", "act", ["executionId", "step"], (ont, p, ctx) => {
    const ex = ont.get(p.executionId);
    if (actorId(ctx) !== ex.personId && !atLeast(ctx, "supervisor")) throw new Error("only the person on the job or a supervisor completes its steps");
    if (ex.state !== "running") throw new Error(`${ex.id} is ${ex.state}`);
    const next = ex.steps.find((s) => s.state === "todo");
    if (Number(p.step) !== next.step) throw new Error(`the next step is ${next.step}`);
    const spec = ont.get(ex.procedureId).steps.find((s) => s.step === next.step);
    const lock = stepLock(spec, isolatedPermit(ont, ex.assetId));
    if (lock.locked) throw new Error(lock.reason);
    const need = readingNeed(ont, ex, spec);
    const value = p.value === undefined || p.value === null || p.value === "" ? null : Number(p.value);
    if (value !== null && !Number.isFinite(value)) throw new Error("the reading must be a number");
    if (need && value === null) throw new Error(`Step ${next.step} needs a reading: ${need.measure} in ${need.unit}`);
    let readingId = null, inBand = null;
    if (need) {
      const part = ont.list("Part", (x) => x.assetId === ex.assetId && x.name === need.partName)[0];
      if (need.lo != null) inBand = bandCheck({ band: { lo: need.lo, hi: need.hi, measure: need.measure, unit: need.unit } }, value).inBand;
      readingId = create(ont, { id: nextId("RDG"), type: "Reading", targetId: part.id, assetId: ex.assetId, measure: need.measure, value, unit: need.unit, workOrderId: ex.workOrderId, executionId: ex.id, at: ctx.now(), source: "field" }, [["OF", part.id]]).id;
    }
    // a reading on a sampling round for a satellite detection is also the Sample that confirms or rejects it (Region design §5.4)
    const wo = ont.get(ex.workOrderId), det = need && wo && String(wo.source || "").startsWith("GEO-") ? ont.get(wo.source) : null;
    const sampleId = det ? create(ont, { id: nextId("SMP-G"), type: "Sample", point: "Raw water", processUnitId: "PU-intake", zoneId: "Z01", analyte: need.measure, value, limit: null, unit: need.unit, takenAt: ctx.now(), compliant: null, response: null, detectionId: det.id, executionId: ex.id }, [["FOR", det.id]]).id : null;
    const undoDet = sampleId ? setProps(ont, det.id, { sampleIds: [...(det.sampleIds || []), sampleId] }) : null;
    const prevAt = [...ex.steps].reverse().find((s) => s.at)?.at || ex.startedAt;
    const minutes = Math.round((Date.parse(ctx.now()) - Date.parse(prevAt)) / 60000);
    const steps = ex.steps.map((s) => (s.step === next.step ? { ...s, state: "done", at: ctx.now(), minutes, value, inBand, readingId, specId: need ? need.specId : null, specVersion: need ? need.specVersion : null, note: p.note ? String(p.note) : null } : s));
    const last = steps.every((s) => s.state === "done");
    // say once that a pinned spec changed after the job started
    const moved = !ex.specNotice && (ex.specPins || []).map((pin) => ({ pin, cur: ont.get(pin.specId) })).find((x) => x.cur && x.cur.version > x.pin.version);
    const specNotice = moved ? { specId: moved.pin.specId, measure: moved.pin.measure, from: moved.pin.version, to: moved.cur.version, atStep: next.step } : ex.specNotice || null;
    ont.upsert({ id: ex.id, type: "Execution", steps, specNotice, ...(last ? { state: "done", finishedAt: ctx.now() } : {}) });
    const undoWo = last ? setProps(ont, ex.workOrderId, { state: "closed", closed: ctx.now().slice(0, 10) }) : null;
    const revert = () => {
      const now = ont.get(ex.id), doneSteps = now.steps.filter((s) => s.state === "done");
      if (doneSteps[doneSteps.length - 1].step !== next.step) throw new Error(`reverse the later steps of ${ex.id} first`);
      ont.upsert({ id: ex.id, type: "Execution", state: "running", finishedAt: null, steps: now.steps.map((s) => (s.step === next.step ? { ...s, state: "todo", at: null, minutes: null, value: null, inBand: null, readingId: null, specId: null, specVersion: null, note: null } : s)), specNotice: moved ? null : now.specNotice || null });
      if (readingId) setProps(ont, readingId, { state: "withdrawn" });
      if (sampleId) {
        if (ont.get(det.id).status !== "suggested") throw new Error(`${det.id} has been reviewed with this sample; reverse the review first`);
        setProps(ont, sampleId, { state: "withdrawn" });
        undoDet();
      }
      if (undoWo) undoWo();
    };
    return { objects: [ex.id, ...(readingId ? [readingId] : []), ...(sampleId ? [sampleId] : []), ...(last ? [ex.workOrderId] : [])], revert };
  }),
  raise_issue: def("act", "act", ["title"], (ont, p, ctx) => {
    const assetId = p.assetId || (p.partId && ont.get(p.partId).assetId) || null;
    const iss = create(ont, { id: nextId("ISS"), type: "Issue", title: String(p.title), state: "open", raisedBy: actorId(ctx), assetId, partId: p.partId || null, workOrderId: p.workOrderId || null, projectId: p.projectId || null, procedureId: p.procedureId || null, step: p.step ?? null, evidence: Array.isArray(p.evidence) ? p.evidence.map(String) : [], assigneeId: p.assigneeId || null, audience: Array.isArray(p.audience) && p.audience.length ? p.audience.map(String) : null, at: ctx.now() }, [["ON", assetId], ["ABOUT", p.partId], ["FOR", p.workOrderId], ["IN", p.projectId]]);
    return { objects: [iss.id], revert: () => setProps(ont, iss.id, { state: "dropped" }) };
  }),
  update_issue: def("act", "act", ["issueId", "patch"], (ont, p, ctx) => {
    const iss = ont.get(p.issueId);
    const patch = p.patch || {};
    const keys = Object.keys(patch);
    if (!keys.length || keys.some((k) => !["state", "assigneeId", "title"].includes(k))) throw new Error("patch may only change: state, assigneeId, title");
    if (patch.state !== undefined && !ISSUE_STATES.includes(patch.state)) throw new Error(`state must be one of ${ISSUE_STATES.join(", ")}`);
    if (patch.assigneeId != null && (ont.get(patch.assigneeId) || {}).type !== "Person") throw new Error("assigneeId must be a person");
    if (patch.title !== undefined && (typeof patch.title !== "string" || !patch.title.trim())) throw new Error("title must be text");
    if (iss.raisedBy !== actorId(ctx) && !atLeast(ctx, "supervisor")) throw new Error("only the raiser or a supervisor moves an issue");
    return { objects: [iss.id], revert: setProps(ont, iss.id, { ...patch, updatedAt: ctx.now() }) };
  }),
  add_knowledge_note: def("act", "act", ["text"], (ont, p, ctx) => {
    const part = p.partId ? ont.get(p.partId) : null;
    const kn = create(ont, { id: nextId("KN"), type: "KnowledgeNote", text: String(p.text), authorId: actorId(ctx), partId: p.partId || null, assetId: p.assetId || (part && part.assetId) || null, procedureId: p.procedureId || null, step: p.step ?? null, executionId: p.executionId || null, messageId: p.messageId || null, verified: false, at: ctx.now() }, [["ABOUT", p.partId || p.assetId], ["ON", p.procedureId]]);
    return { objects: [kn.id], revert: () => setProps(ont, kn.id, { state: "withdrawn" }) };
  }),
  verify_knowledge_note: def("act", "human", ["noteId"], (ont, p, ctx) => {
    const n = ont.get(p.noteId);
    if (n.verified) throw new Error(`${n.id} is already verified`);
    const author = ont.get(n.authorId);
    const f = create(ont, { id: nextId("FND"), type: "Finding", partId: n.partId, assetId: n.assetId, text: n.text, authorId: n.authorId, authorRole: author ? author.role : null, verified: true, verifiedBy: ctx.actor.id, fromNoteId: n.id, at: ctx.now().slice(0, 10) }, [["ABOUT", n.partId || n.assetId]]);
    const undo = setProps(ont, n.id, { verified: true, verifiedBy: ctx.actor.id, promotedTo: f.id });
    return { objects: [n.id, f.id], revert: () => { undo(); setProps(ont, f.id, { verified: false }); } };
  }, "engineer"),
  // Projects: what a chat says is a claim until a supervisor confirms the milestone.
  record_progress_claim: def("act", "act", ["projectId", "messageId", "text"], (ont, p, ctx) => {
    const prj = ont.get(p.projectId);
    if (p.milestoneId != null && !prj.milestones.some((m) => m.id === p.milestoneId)) throw new Error(`no milestone ${p.milestoneId} on ${prj.id}`);
    const c = create(ont, { id: nextId("PCL"), type: "ProgressClaim", projectId: prj.id, milestoneId: p.milestoneId || null, messageId: p.messageId, by: actorId(ctx), at: ctx.now(), text: String(p.text), evidence: Array.isArray(p.evidence) ? p.evidence.map(String) : [], confirmed: false }, [["CLAIMS", prj.id], ["FROM", p.messageId]]);
    if (p.milestoneId && !prj.milestones.find((m) => m.id === p.milestoneId).claimedAt) ont.upsert({ id: prj.id, type: "Project", milestones: prj.milestones.map((m) => (m.id === p.milestoneId ? { ...m, claimedAt: ctx.now() } : m)) });
    // relative revert: withdraw this claim; the milestone's claimedAt becomes the earliest claim left
    const revert = () => {
      setProps(ont, c.id, { state: "withdrawn" });
      if (!p.milestoneId) return;
      const left = ont.list("ProgressClaim", (x) => x.projectId === prj.id && x.milestoneId === p.milestoneId && x.state !== "withdrawn").map((x) => x.at).sort();
      ont.upsert({ id: prj.id, type: "Project", milestones: ont.get(prj.id).milestones.map((m) => (m.id === p.milestoneId ? { ...m, claimedAt: left[0] || null } : m)) });
    };
    return { objects: [c.id, prj.id], revert };
  }),
  confirm_milestone: def("act", "human", ["projectId", "milestoneId"], (ont, p, ctx) => {
    const prj = ont.get(p.projectId);
    const m = prj.milestones.find((x) => x.id === p.milestoneId);
    if (!m) throw new Error(`no milestone ${p.milestoneId} on ${prj.id}`);
    if (m.confirmedAt) throw new Error(`${m.id} is already confirmed`);
    const setMs = (fields) => ont.upsert({ id: prj.id, type: "Project", milestones: ont.get(prj.id).milestones.map((x) => (x.id === m.id ? { ...x, ...fields } : x)) });
    setMs({ confirmedAt: ctx.now(), confirmedBy: ctx.actor.id });
    const claims = ont.list("ProgressClaim", (x) => x.projectId === prj.id && x.milestoneId === m.id && !x.confirmed).map((x) => x.id);
    for (const id of claims) ont.upsert({ id, type: "ProgressClaim", confirmed: true });
    return { objects: [prj.id], revert: () => { setMs({ confirmedAt: null, confirmedBy: null }); for (const id of claims) ont.upsert({ id, type: "ProgressClaim", confirmed: false }); } };
  }, "supervisor"),
  // The works number's outbound side. One reply per inbound message; only Project Watch posts to a group.
  // ---------- Geo Watch (Region design §5.4): detections stay suggested until a person confirms them with a sample ----------
  record_detection: def("act", "act", ["sceneId", "aoiId", "kind", "z"], (ont, p, ctx) => {
    if (!["plume", "bloom", "extent_change"].includes(p.kind)) throw new Error("kind must be plume, bloom or extent_change");
    if (!Number.isFinite(p.z)) throw new Error("z must be a number");
    if (ont.get(p.aoiId).kind !== "aoi") throw new Error(`${p.aoiId} is not an area of interest`);
    const d = create(ont, { id: nextId("GEO"), type: "GeoDetection", sceneId: p.sceneId, aoiId: p.aoiId, kind: p.kind, index: p.index || null, z: p.z, confidence: p.confidence ?? null, cloudPct: p.cloudPct ?? null,
      status: "suggested", reviewedBy: null, reviewedAt: null, sampleIds: [], zoneId: null, at: ctx.now(), note: "index, not calibrated" }, [["SEEN_IN", p.sceneId], ["IN", p.aoiId]]);
    return { objects: [d.id], revert: () => setProps(ont, d.id, { status: "withdrawn" }) };
  }),
  propose_dose_change: def("act", "propose", ["chemicalId", "change"], (ont, p, ctx) => {
    const r = create(ont, { id: nextId("DCH"), type: "DoseChange", chemicalId: p.chemicalId, change: String(p.change), reason: p.reason ? String(p.reason) : null, detectionId: p.detectionId || null, state: "requested", at: ctx.now() }, [["FOR", p.chemicalId]]);
    return { objects: [r.id], revert: () => setProps(ont, r.id, { state: "withdrawn" }) };
  }),
  start_sampling_round: def("act", "propose", ["detectionId"], (ont, p, ctx) => {
    const det = ont.get(p.detectionId), who = samplerOf(ont), point = ont.get("AST-SMP-RAW");
    if (det.status !== "suggested") throw new Error(`${det.id} is already ${det.status}; no sampling round needed`);
    const proc = currentProcedure(ont.list("Procedure"), point && point.template);
    if (!who || !proc) throw new Error("no lab analyst or no released sampling procedure");
    const wo = create(ont, { id: nextId("WO-N"), type: "WorkOrder", assetId: point.id, title: `Raw-water grab sample for ${det.id}`, kind: "sampling", priority: "P2", state: "scheduled", requested: ctx.now(), assigneeId: who.id, source: det.id }, [["TARGETS", point.id], ["ASSIGNED_TO", who.id]]);
    const { ex, revert } = openExecution(ont, wo, who.id, proc, ctx.now());
    const st = proc.steps[0], area = ont.get(det.aoiId);
    const msg = ACTIONS.send_message.apply(ont, { channelId: `CHN-${who.id}`, text: `Sampling round ${wo.id}: satellite ${det.kind} suggested in the ${area ? area.name.toLowerCase() : det.aoiId} (${det.sceneId}, index not calibrated). Step 1/${proc.steps.length}: ${st.text}. Reply with the turbidity in NTU.` }, ctx);
    return { objects: [wo.id, ex.id, ...msg.objects], revert: () => { revert(); setProps(ont, wo.id, { state: "cancelled" }); } };
  }, "supervisor"),
  review_detection: def("act", "human", ["detectionId", "verdict"], (ont, p, ctx) => {
    const d = ont.get(p.detectionId);
    if (!["confirmed", "rejected"].includes(p.verdict)) throw new Error("verdict must be confirmed or rejected");
    if (d.status !== "suggested") throw new Error(`${d.id} is already ${d.status}`);
    if (!(d.sampleIds || []).length) throw new Error(`${p.verdict === "confirmed" ? "confirm" : "reject"} a detection with a raw-water sample attached`);
    return { objects: [d.id], revert: setProps(ont, d.id, { status: p.verdict, reviewedBy: actorId(ctx), reviewedAt: ctx.now() }) };
  }, "operator"),
  send_message: def("notify", "act", ["channelId", "text"], (ont, p, ctx) => {
    const ch = ont.get(p.channelId);
    if (ch.groupName && ctx.actor.kind === "agent" && ctx.actor.id !== "Project Watch") throw new Error("only Project Watch posts to a group");
    if (p.inReplyTo && ont.list("Message", (m) => m.channelId === ch.id && m.direction === "out" && m.inReplyTo === p.inReplyTo).length) throw new Error(`one reply per message: ${p.inReplyTo} already has one`);
    const m = create(ont, { id: nextId("MSG"), type: "Message", channelId: ch.id, direction: "out", from: "WORKS", sentBy: ctx.actor.id, at: ctx.now(), text: String(p.text), media: [], awaiting: p.awaiting || null, inReplyTo: p.inReplyTo || null, audience: ch.audience || null }, [["IN", ch.id]]);
    return { objects: [m.id] };
  }),
  // Paperwork: an agent submits on someone's behalf only when that person (or the project) has consented.
  submit_document: def("act", "act", ["documentId", "onBehalfOf"], (ont, p, ctx) => {
    const d = ont.get(p.documentId), who = ont.get(p.onBehalfOf);
    if (d.state !== "draft") throw new Error(`${d.id} is ${d.state}`);
    if (ctx.actor.kind === "agent" && !who.autoSubmit) throw new Error(`no consent to submit on their behalf: ${who.id} has not turned on agent submission`);
    const owner = d.data && d.data.onBehalfOf;
    if (owner && owner !== who.id) throw new Error(`${d.id} belongs to ${owner}`);
    if (ctx.actor.kind !== "agent" && actorId(ctx) !== who.id && who.ownerId !== actorId(ctx)) throw new Error("a person submits their own paperwork");
    return { objects: [d.id], revert: setProps(ont, d.id, { state: "submitted", submittedBy: ctx.actor.id, submittedFor: who.id, submittedAt: ctx.now() }) };
  }),
  release_asset_model: def("act", "human", ["assetId", "revision"], (ont, p, ctx) => ({ objects: [p.assetId], revert: setProps(ont, p.assetId, { modelRevision: p.revision }) }), "engineer"),
  // Drawing review (design §4.3 step 4): bulk-accept one sheet's EXTRACTED cells, or mark cells by key, optionally correcting the value.
  review_cells: def("act", "human", ["modelId"], (ont, p, ctx) => {
    const m = ont.get(p.modelId);
    if (!["draft", "in_review"].includes(m.status)) throw new Error(`${m.id} is ${m.status}, not a draft`);
    let hit;
    if (p.accept !== undefined) {
      if (p.accept !== "EXTRACTED" || !p.sheet) throw new Error('bulk accept takes accept: "EXTRACTED" and a sheet');
      hit = new Map(m.cells.filter((c) => c.grade === "EXTRACTED" && c.sheet === p.sheet).map((c) => [c.key, {}]));
    } else {
      if (!Array.isArray(p.marks) || !p.marks.length || p.marks.some((k) => !k || typeof k.key !== "string")) throw new Error("marks must be a non-empty list of {key, value?}");
      const unknown = p.marks.find((k) => !m.cells.some((c) => c.key === k.key));
      if (unknown) throw new Error(`no cell ${unknown.key} in ${m.id}`);
      hit = new Map(p.marks.map((k) => [k.key, k]));
    }
    if (!hit.size) throw new Error(`nothing to review: no cells match on ${p.sheet || "the marks"}`);
    const mark = { by: actorId(ctx), at: ctx.now() }, fix = (c) => "value" in hit.get(c.key);
    const cells = m.cells.map((c) => (!hit.has(c.key) ? c : { ...c, ...(fix(c) ? { value: hit.get(c.key).value, reasoning: `${c.reasoning} — corrected by ${mark.by} from ${JSON.stringify(c.value)}` } : {}), reviewed: mark }));
    const items = m.items.map((it) => { const fixed = cells.filter((c) => c.key.startsWith(`${it.tag}|`) && hit.has(c.key) && fix(c)); return fixed.length ? { ...it, fields: { ...it.fields, ...Object.fromEntries(fixed.map((c) => [c.field, c.value])) } } : it; });
    const rid = `RV-${m.reviews.length + 1}-${mark.by}-${mark.at}`, reviews = [...m.reviews, { ...mark, id: rid, cells: hit.size }];
    ont.upsert({ id: m.id, type: "PlantModel", cells, items, reviews, status: "in_review", packageHash: packageHash({ ...m, cells, items }) });
    // Undo only this review: cells still as it left them go back; later reviews by others stay. A released model is final.
    const before = new Map(m.cells.filter((c) => hit.has(c.key)).map((c) => [c.key, c])), wrote = new Map(cells.filter((c) => hit.has(c.key)).map((c) => [c.key, JSON.stringify(c)]));
    const revert = () => {
      const cur = ont.get(m.id);
      if (!["draft", "in_review"].includes(cur.status)) throw new Error(`${m.id} is ${cur.status}; its reviews can no longer be undone`);
      const back = new Set([...wrote].filter(([k, json]) => JSON.stringify(cur.cells.find((c) => c.key === k)) === json).map(([k]) => k));
      const cells2 = cur.cells.map((c) => (back.has(c.key) ? before.get(c.key) : c));
      const items2 = cur.items.map((it) => { const f = cells2.filter((c) => back.has(c.key) && c.key.startsWith(`${it.tag}|`)); return f.length ? { ...it, fields: { ...it.fields, ...Object.fromEntries(f.map((c) => [c.field, c.value])) } } : it; });
      const reviews2 = cur.reviews.filter((r) => r.id !== rid);
      ont.upsert({ id: m.id, type: "PlantModel", cells: cells2, items: items2, reviews: reviews2, status: reviews2.length ? cur.status : "draft", packageHash: packageHash({ ...cur, cells: cells2, items: items2 }) });
    };
    return { objects: [m.id], revert };
  }, "engineer"),
  // Four-eyes release of a plant model (design §4.3 step 5). Writes revision-scoped objects; never rewrites existing records.
  release_plant_model: def("act", "human", ["modelId", "hash"], (ont, p, ctx) => {
    const m = ont.get(p.modelId), by = actorId(ctx), at = ctx.now();
    if (!["draft", "in_review"].includes(m.status)) throw new Error(`${m.id} is ${m.status}, not a draft`);
    const last = m.reviews[m.reviews.length - 1];
    if (!last) throw new Error(`${m.id} has no review; someone other than the releaser must review it first`);
    if (last.by === by) throw new Error(`${by} is the last reviewer; release needs a second person (four eyes)`);
    const open = m.cells.filter((c) => c.grade !== "EXTRACTED" && !c.reviewed);
    if (open.length) throw new Error(`${open.length} INFERRED or AMBIGUOUS cells unreviewed: ${open.slice(0, 3).map((c) => c.key).join(", ")}`);
    if (p.hash !== packageHash(m)) throw new Error("stale hash: the model changed since the releaser read it");
    if (!ont.list("Competency", (c) => c.personId === by && c.competency === "c-model" && c.validTo >= at.slice(0, 10)).length) throw new Error("needs the c-model competence");
    const prev = currentPlantModel(ont);
    if (prev) ont.upsert({ id: prev.id, type: "PlantModel", status: "superseded", governs: { ...prev.governs, to: at } });
    ont.upsert({ id: m.id, type: "PlantModel", status: "released", governs: { from: at, to: null }, release: { by, at, hash: p.hash } });
    writePlant(ont, ont.get(m.id));
    // An accepted disagreement with an existing record goes to that record's owner as an Issue (spec §4.3 step 3), once.
    const issues = [];
    for (const c of m.cells.filter((x) => x.grade === "AMBIGUOUS" && x.reviewed)) {
      const cites = [...new Set(c.reasoning.match(/\b[A-Z]{2,4}-[\w-]+/g) || [])].map((id) => ont.get(id)).filter((o) => o && !o.modelId && !["Drawing", "PlantModel"].includes(o.type));
      const title = `Drawing disagrees with record: ${c.key}`;
      // a disagreement the reviewer corrected is resolved; only an accepted one goes to the record's owner
      if (!cites.length || c.reasoning.includes(" — corrected by ") || ont.list("Issue", (i) => i.title === title).length) continue;
      const rec = cites[0];
      const iss = create(ont, { id: nextId("ISS"), type: "Issue", title, state: "open", raisedBy: by, assetId: rec.assetId || null, partId: null, workOrderId: null, projectId: null, procedureId: null, step: null, recordIds: cites.map((o) => o.id), evidence: [m.id, c.key, c.reasoning], assigneeId: rec.ownerId || null, at }, [["ON", rec.assetId], ["ABOUT", rec.id]]);
      issues.push(iss.id);
    }
    return { objects: [m.id, ...issues] };
  }, "engineer")
};

export function createActionService({ ont, audit, clock = wallClock, tel = null, connectors = null }) {
  const now = clock;
  const reverts = new Map();
  const log = (entry) => audit && audit.append(entry);
  const refuse = (action, actor, reason) => {
    log({ actor: actor && actor.id, actorKind: actor && actor.kind, action, outcome: "refused", reason });
    return { status: "refused", reason };
  };

  // Every object a parameter names must exist, be of the right type, and be visible to the actor.
  function validate(action, params, actor) {
    const view = ont.view({ id: actor.onBehalfOf || actor.id, clearance: actor.clearance });
    for (const [key, types] of Object.entries(TARGET_TYPES)) {
      if (params[key] === undefined || params[key] === null) continue;
      if (key === "partIds" && (!Array.isArray(params[key]) || !params[key].length)) return `${key} must be a non-empty list`;
      for (const id of [].concat(params[key])) {
        const o = typeof id === "string" ? view.get(id) : null;
        if (!o) return `${key} ${id} not found`;
        if (types && !types.includes(o.type)) return `${key} ${id} is a ${o.type}, not a ${types.join(" or ")}`;
      }
    }
    return null;
  }
  // The strictest zone among the objects a decision or proposal is about, so it is pruned like its targets.
  function zoneFor(params) {
    let best = null;
    for (const id of Object.keys(TARGET_TYPES).flatMap((k) => (params[k] == null ? [] : [].concat(params[k])))) {
      const z = typeof id === "string" ? ont.zoneOf(id) : null;
      if (z && ont.get(z) && (!best || rank(ont.get(z).clearance) > rank(ont.get(best).clearance))) best = z;
    }
    return best;
  }

  // A decision or proposal about an audience-limited object (a private chat, a person's job) is limited the same way.
  function audienceFor(params) {
    if (Array.isArray(params.audience) && params.audience.length) return params.audience.map(String);
    for (const id of Object.keys(TARGET_TYPES).flatMap((k) => (params[k] == null ? [] : [].concat(params[k])))) {
      const o = typeof id === "string" ? ont.get(id) : null;
      if (o && o.audience) return o.audience;
    }
    return null;
  }

  function apply(action, params, actor, extra = {}) {
    const res = ACTIONS[action].apply(ont, params, { actor, now, connectors, approvedBy: extra.approvedBy || null });
    const dec = ont.upsert({ zoneId: zoneFor(params), audience: audienceFor(params),
      id: nextId("DEC"), type: "Decision", action, params, actorId: actor.id, actorKind: actor.kind, onBehalfOf: actor.onBehalfOf || null, autonomy: extra.autonomy || null,
      approvedBy: extra.approvedBy || null, proposalId: extra.proposalId || null, runId: extra.runId || null,
      constraintsChecked: extra.constraintsChecked || null, evidenceAges: extra.evidenceAges || null,
      assetId: params.assetId || null, objects: res.objects, reversible: !!res.revert, reversed: false, at: now()
    });
    if (res.revert) reverts.set(dec.id, res.revert);
    for (const id of res.objects) if (ont.get(id)) ont.link(dec.id, "PRODUCED", id);
    log({ actor: actor.id, actorKind: actor.kind, action, outcome: "done", ref: dec.id, objects: res.objects, approvedBy: extra.approvedBy || null });
    return { status: "done", decision: dec };
  }

  function invoke({ action, params = {}, actor, autonomy, runId, evidence, risk, alternatives }) {
    const a = ACTIONS[action];
    if (!a) return refuse(action, actor, `unknown action ${action}`);
    if (!actor || !actor.id) return refuse(action, actor, "no actor");
    const missing = a.required.filter((k) => params[k] === undefined || params[k] === null || params[k] === "");
    if (missing.length) return refuse(action, actor, `missing params: ${missing.join(", ")}`);
    if (rank(actor.clearance) < rank(a.minClearance)) return refuse(action, actor, `${action} needs ${a.minClearance} clearance`);
    if (actor.kind !== "person" && a.ceiling === "human") return refuse(action, actor, `${action} is human-only`);
    const bad = validate(action, params, actor);
    if (bad) return refuse(action, actor, bad);
    try {
      if (actor.kind === "person") {
        // IT's catalogue binds people too: filing and posting through a connector need a role it allows (agents design §7)
        const pl = catalogueLine(ont, action), pc = pl && catalogueAllows(ont, { kind: pl.kind, op: pl.op, role: (ont.get(actor.id) || {}).role });
        if (pc && !pc.ok) return refuse(action, actor, pc.reason);
        return apply(action, params, actor);
      }
      if (a.ceiling === "human") return refuse(action, actor, `${action} is human-only`);
      // the harness: evidence freshness and the inherited hard constraints (agents design §4.3, §4.4)
      // the decision statement's switches and mode bind every agent call, from a run or not (agents design §4.2, §4.6)
      const spec = specFor(ont, actor.id), tool = spec && spec.tools.find((t) => t.action === action);
      if (spec && ["paused", "retired"].includes(spec.state)) return refuse(action, actor, `${actor.id} is ${spec.state}`);
      if (tool && !tool.enabled) return refuse(action, actor, "tool turned off");
      // IT's catalogue binds what a studio agent does through a connector, by its builder's role (agents design §7)
      const line = spec && spec.builderId ? catalogueLine(ont, action) : null;
      const cat = line && catalogueAllows(ont, { kind: line.kind, op: line.op, role: (ont.get(spec.builderId) || {}).role });
      if (cat && !cat.ok) return refuse(action, actor, cat.reason);
      if (spec && spec.mode === "shadow") {
        // a studio agent's shadow actions are its builder's and approver's to see, like its documents
        const shAud = spec.builderId ? [spec.builderId, spec.approver].filter((x) => typeof x === "string") : audienceFor(params);
        const sha = ont.upsert({ id: shadowId(), type: "ShadowAction", agent: actor.id, specVersion: spec.version, runId: runId || null, action, params, at: now(), status: "pending", minClearance: actor.clearance, audience: shAud });
        log({ actor: actor.id, actorKind: actor.kind, action, outcome: "shadowed", ref: sha.id });
        return { status: "shadowed", shadow: sha };
      }
      if (cat && cat.locked) return refuse(action, actor, `needs IT sign-off: ${line.kind} ${line.op}`);
      // the telemetry an alert names in its own evidence is cited too
      const cited = [...[].concat(evidence || []), ...[].concat(params.evidence || []).filter((x) => typeof x === "string" && x.startsWith("SEN-"))];
      const chk = checkWrite({ ont, tel, actor, action, params, evidence: cited, spec, now: now() });
      let eff = LEVELS[Math.min(lv(autonomy || "propose"), lv(a.ceiling), spec && spec.mode === "assisted" ? lv("propose") : Infinity)];
      // a breach is a write a constraint refused; a cap doing its job (a proposal instead of an act) is not one
      const hits = chk.hits;
      if (chk.refuse) return { ...refuse(action, actor, chk.refuse), hits };
      if (chk.level && lv(eff) > lv(chk.level)) eff = chk.level;
      if (cat && lv(eff) > lv(cat.maxLevel)) eff = cat.maxLevel;
      const stamp = { constraintsChecked: chk.checked, evidenceAges: chk.ages };
      if (lv(eff) >= lv(a.needs)) return { ...apply(action, params, actor, { autonomy: eff, runId, ...stamp }), hits };
      if (lv(eff) >= lv("propose")) {
        const prp = ont.upsert({
          zoneId: zoneFor(params), audience: audienceFor(params), id: nextId("PRP"), type: "Proposal", action, params, actorId: actor.id, actorKind: actor.kind, runId: runId || null,
          assetId: params.assetId || (params.partIds && ont.get(params.partIds[0]) && ont.get(params.partIds[0]).assetId) || null,
          evidence: evidence || [], risk: risk || null, state: "open", created: now(), ...stamp, ...approvalTerms(spec, now()),
          card: { evidence: chk.ages, constraintsChecked: chk.checked, expectedEffect: expectedEffect(action), alternatives: Array.isArray(alternatives) ? alternatives : [] }
        });
        log({ actor: actor.id, actorKind: actor.kind, action, outcome: "proposed", ref: prp.id, ...(hits.length ? { constraints: hits } : {}) });
        return { status: "proposed", proposal: prp, hits };
      }
      return refuse(action, actor, `autonomy ${eff} is below what ${action} needs`);
    } catch (e) {
      return refuse(action, actor, e.message);
    }
  }

  function resolve(proposalId, { verdict, params, reason, by }) {
    const p = ont.get(proposalId);
    if (!p || p.type !== "Proposal") return refuse("resolve", by, "proposal not found");
    if (p.state !== "open") return refuse("resolve", by, `proposal already ${p.state}`);
    if (!by || by.kind !== "person") return refuse("resolve", by, "only a person resolves a proposal");
    if (!["approve", "edit", "reject"].includes(verdict)) return refuse("resolve", by, "verdict must be approve, edit or reject");
    if (verdict !== "approve" && !reason) return refuse("resolve", by, "a reason is required to edit or reject");
    if (rank(by.clearance) < rank(ACTIONS[p.action].minClearance)) return refuse("resolve", by, "insufficient clearance");
    // a named approver answers; the backup only once the escalation time has passed (agents design §4.5)
    const backupNow = p.backup && by.id === p.backup && p.escalateAt && Date.parse(now()) >= Date.parse(p.escalateAt);
    if (typeof p.approver === "string" && by.id !== p.approver && !backupNow) return refuse("resolve", by, `waiting for ${p.approver}${p.backup ? ` (${p.backup} may answer from ${p.escalateAt})` : ""}`);
    const fb = (v) => {
      const f = ont.upsert({ id: nextId("FBK"), type: "Feedback", targetId: proposalId, runId: p.runId, verdict: v, comment: reason || null, authorId: by.id, at: now() });
      ont.link(f.id, "ON", proposalId);
      // an override with a reason becomes an eval case for the agent
      if (reason && v !== "approve" && p.actorKind === "agent") ont.upsert({ id: nextId("LEV"), type: "LearnedEval", agent: p.actorId, case: { action: p.action, params: p.params }, expect: `not ${p.action}`, reason, from: proposalId, at: now() });
    };
    if (verdict === "reject") {
      ont.upsert({ id: proposalId, type: "Proposal", state: "rejected", resolvedBy: by.id, resolvedAt: now() });
      fb("reject");
      log({ actor: by.id, actorKind: "person", action: "resolve", outcome: "rejected", ref: proposalId, reason });
      return { status: "rejected" };
    }
    const finalParams = verdict === "edit" ? { ...p.params, ...params } : p.params;
    const bad = validate(p.action, finalParams, by);
    if (bad) return refuse("resolve", by, bad);
    let res;
    try {
      res = apply(p.action, finalParams, { kind: p.actorKind, id: p.actorId }, { approvedBy: by.id, proposalId, runId: p.runId });
    } catch (e) {
      return refuse("resolve", by, e.message);
    }
    ont.upsert({ id: proposalId, type: "Proposal", state: verdict === "edit" ? "edited" : "approved", resolvedBy: by.id, resolvedAt: now() });
    ont.link(proposalId, "RESOLVED_BY", res.decision.id);
    if (reason || verdict === "edit") fb(verdict);
    return res;
  }

  function reverse(decisionId, by) {
    const d = ont.get(decisionId);
    if (!d || d.type !== "Decision") return refuse("reverse", by, "decision not found");
    if (d.reversed) return refuse("reverse", by, "already reversed");
    if (!by || by.kind !== "person" || !ont.view(by).get(decisionId)) return refuse("reverse", by, "decision not found");
    if (rank(by.clearance) < rank(ACTIONS[d.action].minClearance)) return refuse("reverse", by, `reversing ${d.action} needs ${ACTIONS[d.action].minClearance} clearance`);
    if ((d.onBehalfOf || d.actorId) !== by.id && rank(by.clearance) < rank("supervisor")) return refuse("reverse", by, "only the person who did it or a supervisor reverses it");
    const f = reverts.get(decisionId);
    if (!f) return refuse("reverse", by, "not reversible");
    let kept = [];
    try { kept = (f() || {}).kept || []; } catch (e) { return refuse("reverse", by, e.message); }
    reverts.delete(decisionId);
    ont.upsert({ id: decisionId, type: "Decision", reversed: true, reversedBy: by && by.id, reversedAt: now(), ...(kept.length ? { kept } : {}) });
    log({ actor: by && by.id, actorKind: by && by.kind, action: "reverse", outcome: "done", ref: decisionId, ...(kept.length ? { kept } : {}) });
    return { status: "done", kept };
  }

  return {
    invoke, resolve, reverse,
    proposals: (state) => ont.list("Proposal", (p) => !state || p.state === state),
    decisions: () => ont.list("Decision")
  };
}
