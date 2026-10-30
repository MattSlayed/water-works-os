// The KG eval's rule grader: no LLM judge. An answer is plain text citing [<cite>] with the tools' cite fields.
// Facts are matched in the prose with the cites cut out, so a cite's own text (a readings window) never counts as a fact.
const CITE = /\[([^[\]]+)\]/g;
const WHEN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g;
const DATE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g;
const ID = /\b[A-Z][\w-]*\d\w*/g;
// an ISA tag, not the tail of a longer id (the GA-001 in drawing RB-GA-001)
const TAG = /(?<!-)\b[A-Z]{2,4}-\d{3}\b/g;
const ms = (t) => Date.parse(t.replace(" ", "T").replace(/Z?$/, "Z")); // a time without a zone is read as UTC

// The numbers the text states in a unit (85 °C, 85°C, 5,870 m³), ids and dates removed first so TT-612 or 2026-10-13
// never count. The unit must not run on into a longer one: "m" is not read from "mm" or "m³".
export function unitValues(text, unit) {
  const u = unit.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const re = new RegExp(`(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*${u}(?![A-Za-z²³])`, "g");
  return [...text.replace(DATE, " ").replace(ID, " ").matchAll(re)].map((m) => Number(m[1].replace(/,/g, "")));
}

// one required item: a number in a unit within tol ({value, tol, unit}), an ISO time within tol minutes ({value, tol}),
// or a case-insensitive pattern for a fact that is not a number
function holds(prose, { pattern, value, tol = 0, unit }) {
  if (unit) return unitValues(prose, unit).some((n) => Math.abs(n - value) <= tol + 1e-9);
  if (typeof value === "string") return (prose.match(WHEN) ?? []).some((t) => Math.abs(ms(t) - Date.parse(value)) <= tol * 60e3);
  return new RegExp(pattern, "i").test(prose);
}

export function grade(text, q, { exists, visible, tags }) {
  const cites = [...text.matchAll(CITE)].flatMap((m) => m[1].split(/;\s*|,\s+/)).map((c) => c.trim()).filter(Boolean);
  const prose = text.replace(CITE, " ");
  const missing = q.required.filter((r) => !holds(prose, r)).map((r) => r.label);
  const asked = new Set(q.question.match(TAG) ?? []);
  return {
    right: !missing.length && !(q.forbidden ?? []).some((p) => new RegExp(p, "i").test(prose)),
    // every cite resolves, and an answer cites at least one of its evidence ids (a cite's base is its id before @ or #)
    citationsValid: cites.every(exists) && (q.expect !== "answer" || cites.some((c) => q.evidence.includes(c) || q.evidence.includes(c.split(/[@#]/)[0]))),
    // sentences stating a number with no cite; digits inside ids and tags (TT-612, SEN-F07-turb) and dates are not numbers
    uncitedFacts: text.split(/(?<=[.!?])\s+|\n+/).filter((s) => /\d/.test(s.replace(DATE, " ").replace(ID, " ")) && !s.includes("[")).length,
    leak: cites.some((c) => exists(c) && !visible(c, q.asker)),
    inventedTags: [...new Set(text.match(TAG) ?? [])].filter((t) => !tags.has(t) && !asked.has(t)),
    missing
  };
}

export const viewerOf = (ont, personId) => ({ id: personId, clearance: ont.get(personId)?.clearance });

// a cite resolves when it is an object id (a chunk id included), <sensorId>@<from>..<to>, or <procedureId>#<stepId>
const resolves = (get, c) => {
  if (get(c)) return true;
  if (c.includes("@")) return get(c.split("@")[0])?.type === "Sensor";
  const [pid, sid] = c.split("#");
  return !!sid && !!get(pid)?.steps?.some((s) => s.id === sid);
};
export function citeContext(ont, crosswalk) {
  const views = new Map();
  const view = (asker) => views.get(asker) ?? views.set(asker, ont.view(viewerOf(ont, asker))).get(asker);
  return {
    exists: (c) => resolves((id) => ont.get(id), c),
    visible: (c, asker) => resolves((id) => view(asker).get(id), c),
    tags: new Set(Object.values(crosswalk.sensors || {}))
  };
}
