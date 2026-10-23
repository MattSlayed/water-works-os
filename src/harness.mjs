// The harness around every agent (agents design §4): the decision statement each agent is held to, its modes,
// evidence freshness, the hard constraints it inherits, and the rules for promoting and demoting it.
import { ACTIONS } from "./actions.mjs";

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
