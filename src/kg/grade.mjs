// The KG eval's rule grader: no LLM judge. An answer is plain text citing [<cite>] with the tools' cite fields.
// Facts are matched in the prose with the cites cut out, so a cite's own text (a readings window) never counts as a fact.
const CITE = /\[([^[\]]+)\]/g;
const WHEN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g;
const NUM = /\d+(?:\.\d+)?/g;
const DATE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g;
const ID = /\b[A-Z][\w-]*\d\w*/g;
// an ISA tag, not the tail of a longer id (the GA-001 in drawing RB-GA-001)
const TAG = /(?<!-)\b[A-Z]{2,4}-\d{3}\b/g;
const ms = (t) => Date.parse(t.replace(" ", "T").replace(/Z?$/, "Z")); // a time without a zone is read as UTC

// one required item: pattern alone must match; value (a number within tol, or an ISO time within tol minutes) is looked
// for inside the pattern's matches, or anywhere in the prose when there is no pattern
function holds(prose, { pattern, value, tol = 0 }) {
  const spans = pattern ? prose.match(new RegExp(pattern, "gi")) ?? [] : [prose];
  if (value === undefined) return spans.length > 0;
  if (typeof value === "string") return spans.some((s) => (s.match(WHEN) ?? []).some((t) => Math.abs(ms(t) - Date.parse(value)) <= tol * 60e3));
  const nums = (s) => s.replace(WHEN, " ").replace(/(\d),(?=\d{3}\b)/g, "$1").match(NUM) ?? [];
  return spans.some((s) => nums(s).some((n) => Math.abs(Number(n) - value) <= tol));
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
