// The harness around every agent (agents design §4): the decision statement each agent is held to, its modes,
// evidence freshness, the hard constraints it inherits, and the rules for promoting and demoting it.
import { ACTIONS } from "./actions.mjs";
import { rank } from "./ontology.mjs";

export const HARD_CONSTRAINTS = [
  { id: "no-control-write", text: "It never writes to the control system." },
  { id: "chlorine-propose", text: "It only proposes chlorine dosing changes." },
  { id: "permit-holder", text: "It only proposes changes to an asset under an open permit, unless the person behind it holds the permit or is a supervisor or above." },
  { id: "reg3630-cover", text: "It keeps to the Reg. 3630 shift-cover rules." },
  { id: "money-propose", text: "It only proposes anything that moves money." },
  { id: "human-only-releases", text: "It never confirms a geo detection, releases a plant model or releases a procedure." }
];
const HARD_IDS = HARD_CONSTRAINTS.map((c) => c.id);

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const specId = (name) => `AGS-${slug(name)}`;

export function specFromManifest(m) {
  return {
    id: specId(m.name), type: "AgentSpec", name: m.name, version: m.version, owner: m.owner, purpose: m.purpose, trigger: m.trigger,
    reads: [{ source: "telemetry", freshnessMin: 30 }, { source: "objects", freshnessMin: null }],
    tools: m.tools.map((action) => ({ action, level: m.autonomy[action], enabled: true })),
    constraints: [...HARD_IDS], approver: { clearanceOf: "action" }, backup: null, escalateAfterMin: null, onTimeout: "hold",
    exclusions: [], mode: "bounded", promotion: { minCases: 20, minAgreePct: 90, maxBreaches: 0, maxStalePct: 5 },
    state: "live", killedAt: null, killedBy: null
  };
}

// The spec as the harness reads it: the inherited constraints are merged back in on every read, so they cannot be removed.
export function specFor(ont, name) {
  const s = ont.get(specId(name));
  return s ? { ...s, constraints: [...new Set([...HARD_IDS, ...(s.constraints || [])])] } : null;
}

const words = (action) => action.replace(/_/g, " ");
const whoAnswers = (spec, action, ont) => {
  const a = spec.approver || {};
  if (a.clearanceOf) return `any ${(ACTIONS[action] || {}).minClearance || "technician"} or above`;
  const p = ont.get(a.id || a);
  return p ? `${p.name} (${p.id})` : String(a.id || a);
};

// The decision statement read back in plain sentences (agents design §4.1).
export function statementSentences(spec, ont) {
  const t = spec.trigger || {};
  const every = String(t.every || "");
  const out = [
    `It exists to: ${spec.purpose}.`,
    t.kind === "schedule" ? `It runs ${/^\d+\s*(min|h)$/.test(every) ? `every ${every}` : every}.` : t.kind === "event" ? `It runs when this happens: ${t.on}.` : "It runs only when a person starts it."
  ];
  if (!spec.tools.length) out.push("It takes no actions.");
  for (const { action, level, enabled } of spec.tools) {
    const w = words(action);
    if (!enabled) out.push(`Its ${w} tool is turned off.`);
    else if (level === "act") out.push(`It may ${w} without asking.`);
    else if (level === "propose") out.push(`It asks before it will ${w}; ${whoAnswers(spec, action, ont)} may answer.`);
    else out.push(`It may only ${level} for ${w}.`);
  }
  out.push(spec.onTimeout === "drop" ? "If nobody answers, the proposal is dropped." : "If nobody answers, nothing happens.");
  out.push(...HARD_CONSTRAINTS.filter((c) => spec.constraints.includes(c.id)).map((c) => c.text));
  return out;
}

// Shadow mode (agents design §4.2): what the agent would have done, matched later against what people did.
let shaSeq = 0;
export const shadowId = () => `SHA-${String(++shaSeq).padStart(5, "0")}`;
const KEYS = ["assetId", "targetId", "workOrderId", "alertId"];
const DAY_MS = 24 * 3600000;
// The matching rule: the key target is the first of assetId, targetId, workOrderId, alertId in the shadow action's
// params. A person's Decision within 24 h after it, naming the same key with the same value, is "agreed" when it is
// the same action and "differed" when it is another. Nothing within 24 h, once 24 h have passed, is "missed".
export function matchShadow(ont, nowIso) {
  const now = Date.parse(nowIso);
  const decisions = ont.list("Decision", (d) => d.actorKind === "person");
  for (const sha of ont.list("ShadowAction", (x) => x.status === "pending")) {
    const key = KEYS.find((k) => sha.params[k] != null);
    const from = Date.parse(sha.at), to = from + DAY_MS;
    const near = key ? decisions.filter((d) => d.params && d.params[key] === sha.params[key] && Date.parse(d.at) >= from && Date.parse(d.at) <= to) : [];
    const status = near.some((d) => d.action === sha.action) ? "agreed" : near.length ? "differed" : now >= to ? "missed" : null;
    if (status) ont.upsert({ id: sha.id, type: "ShadowAction", status, matchedTo: (near.find((d) => d.action === sha.action) || near[0] || {}).id || null, matchedAt: nowIso });
  }
}

export function shadowRecord(ont, agent) {
  const done = ont.list("ShadowAction", (x) => x.agent === agent && ["agreed", "differed", "missed"].includes(x.status));
  const n = (s) => done.filter((x) => x.status === s).length;
  const cases = done.length, agreed = n("agreed");
  return { cases, agreed, differed: n("differed"), missed: n("missed"), agreePct: cases ? Math.round((agreed / cases) * 100) : 0 };
}

// Promotion and demotion (agents design §4.2). Rates are over a fixed window of the last 20 runs or proposals, so a
// young agent is not demoted for one stale reading or one rejection.
export const MODES = ["shadow", "assisted", "bounded"];
const WINDOW = 20;
const staleRuns = (ont, name) => ont.list("AgentRun", (r) => r.agent === name).slice(-WINDOW).filter((r) => (r.refusals || []).some((x) => /^evidence stale/.test(x.reason))).length;

// The first promotion criterion the agent's shadow record misses, or null.
export function promotionGap(ont, spec) {
  const c = spec.promotion, r = shadowRecord(ont, spec.name), stale = staleRuns(ont, spec.name);
  if (r.cases < c.minCases) return `minCases: ${r.cases} of ${c.minCases} cases seen`;
  if (r.agreePct < c.minAgreePct) return `minAgreePct: ${r.agreePct}% agreement, needs ${c.minAgreePct}%`;
  if ((spec.breaches || 0) > c.maxBreaches) return `maxBreaches: ${spec.breaches} hard-constraint breaches`;
  if ((stale / WINDOW) * 100 > c.maxStalePct) return `maxStalePct: stale evidence in ${stale} of its last ${WINDOW} runs`;
  return null;
}

export function demoteIfNeeded(ont, spec, run) {
  if (!spec || spec.mode !== "bounded") return null;
  if ((run.constraintHits || []).length) return `hit a hard constraint: ${[...new Set(run.constraintHits)].join(", ")}`;
  const stale = staleRuns(ont, spec.name);
  if ((stale / WINDOW) * 100 > spec.promotion.maxStalePct) return `stale evidence in ${stale} of its last ${WINDOW} runs`;
  const props = new Set(ont.list("Proposal", (p) => p.actorId === spec.name).slice(-WINDOW).map((p) => p.id));
  const overrides = ont.list("Feedback", (f) => props.has(f.targetId) && ["reject", "edit"].includes(f.verdict)).length;
  if ((overrides / WINDOW) * 100 > 20) return `people overrode ${overrides} of its last ${WINDOW} proposals`;
  return null;
}

// Evidence freshness and the inherited hard constraints, checked before any agent write (agents design §4.3, §4.4).
// Only id-like evidence is a citation; free text such as "competence ok for P-028" is a note, not a source.
const ID_LIKE = /^[A-Z][A-Z0-9]*(-[A-Za-z0-9_.]+)+$/;
const minutesBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);
export const objectTime = (o) => o.at || o.updatedAt || (o.prov && o.prov.extracted_at) || null;
// The asset an action is about: named directly, or through what it targets.
const assetOf = (ont, p) => {
  if (p.assetId) return p.assetId;
  for (const k of ["targetId", "partId", "workOrderId", "executionId", "alertId"]) {
    const o = p[k] && ont.get(p[k]);
    if (o) return o.type === "Asset" ? o.id : o.assetId || null;
  }
  return Array.isArray(p.partIds) && p.partIds.length ? (ont.get(p.partIds[0]) || {}).assetId || null : null;
};
const inDisinfection = (ont, p) => [p.chemicalId, p.targetId, p.assetId].some((id) => id && (ont.get(id) || {}).zoneId === "Z06");

export function checkWrite({ ont, tel, actor, action, params, evidence, spec, now }) {
  const out = { level: null, refuse: null, checked: [], caps: [], hits: [], ages: [] };
  const limit = ((spec && spec.reads) || []).find((r) => r.source === "telemetry")?.freshnessMin ?? 30;
  for (const id of [].concat(evidence || []).filter((x) => typeof x === "string" && ID_LIKE.test(x))) {
    const l = tel && tel.latest(id), o = l ? null : ont.get(id);
    if (!l && !o) return { ...out, refuse: `evidence missing: ${id}` };
    const at = l ? l.at : objectTime(o), ageMin = at ? minutesBetween(at, now) : null;
    out.ages.push({ id, ageMin });
    if (l && limit != null && ageMin > limit) return { ...out, refuse: `evidence stale: ${id} ${ageMin} min` };
  }
  const a = ACTIONS[action];
  const cap = (id) => { out.level = "propose"; out.caps.push(id); };
  out.checked.push("no-control-write", "human-only-releases");
  if (a.control) return { ...out, refuse: `${action} writes to the control system`, hits: ["no-control-write"] };
  out.checked.push("chlorine-propose");
  if (["request_setpoint_change", "propose_dose_change"].includes(action) && inDisinfection(ont, params)) cap("chlorine-propose");
  out.checked.push("money-propose");
  if (a.money) cap("money-propose");
  out.checked.push("permit-holder");
  const assetId = assetOf(ont, params);
  const permit = assetId && ont.list("Permit", (p) => p.assetId === assetId && p.state === "open")[0];
  if (permit && permit.holderId !== (actor.onBehalfOf || actor.id) && rank(actor.clearance) < rank("supervisor")) cap("permit-holder");
  return out;
}
