// The KG eval's rule grader: no LLM judge. An answer is prose citing [<cite>] with the tools' cite fields, ending in a
// fenced ```json block {status, fields, citations}. Rightness is read from that block only: prose regex never converged.
const CITE = /\[([^[\]]+)\]/g;
const JSON_BLOCK = /```json\s*([\s\S]*?)```/g;
const DATE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g;
const ID = /\b[A-Z][\w-]*\d\w*/g;
// an ISA tag, not the tail of a longer id (the GA-001 in drawing RB-GA-001)
const TAG = /(?<!-)\b[A-Z]{2,4}-\d{3}\b/g;
const ms = (t) => Date.parse(String(t).trim().replace(" ", "T").replace(/(Z|[+-]\d{2}:?\d{2})?$/, (z) => z || "Z")); // no zone reads as UTC

// each unit's common spellings, compared lower-cased with spaces and dots removed
const UNITS = {
  "°C": ["°c", "c", "degc", "degreesc", "degreescelsius", "celsius", "℃", "ºc"],
  NTU: ["ntu"],
  m: ["m", "metre", "metres", "meter", "meters"],
  "m³": ["m³", "m3", "cubicmetres", "cubicmeters"],
  "ML/d": ["ml/d", "mℓ/d", "ml/day", "mℓ/day", "megalitres/day", "megalitresperday", "megalitersperday", "mld"],
  ML: ["ml", "mℓ", "megalitres", "megaliters", "megalitre", "megaliter"],
  mm: ["mm", "millimetres", "millimeters"],
  "m/h": ["m/h", "m/hr", "m/hour", "metresperhour", "m³/m²/h", "m3/m2/h", "m³/m²h"],
  "L/h": ["l/h", "l/hr"]
};
const unitKey = (u) => String(u).toLowerCase().replace(/[\s.]/g, "");

// a quantity as given: a bare number (the declared unit), "5 870 m³", "85 degC", or {value, unit}; NaN when unreadable or
// in another unit
export function quantity(given, unit) {
  let n = given, u = "";
  if (given && typeof given === "object") ({ value: n, unit: u = "" } = given);
  if (typeof n === "string") {
    const m = n.match(/^\s*(-?\d[\d\s,]*(?:\.\d+)?)\s*(.*?)\s*$/);
    if (!m) return NaN;
    n = Number(m[1].replace(/[\s,]/g, ""));
    u = u || m[2];
  }
  if (typeof n !== "number" || Number.isNaN(n)) return NaN;
  if (!u || !unit) return u && !unit ? NaN : n;
  return (UNITS[unit] ?? [unitKey(unit)]).includes(unitKey(u)) ? n : NaN;
}

const words = (s) => String(s).toLowerCase().replace(/[-_\s]+/g, " ").trim();
const idOf = (s) => String(s).trim().toUpperCase().replace(/^(POS-|PM-RB-A:STR-)/, "");
const alts = (expect, norm) => String(expect).split("|").map(norm);

// one field: expect null means the answer must leave it null or out; ids compare as sets, each expected id may list
// alternatives with "|"; strings compare trimmed, case- and hyphen-insensitive, against "|" alternatives
export function fieldMatches(spec, given) {
  if (spec.expect === null) return given === null || given === undefined;
  if (given === null || given === undefined) return false;
  switch (spec.type) {
    case "number": return Math.abs(quantity(given, spec.unit) - spec.expect) <= (spec.tol ?? 0) + 1e-9;
    case "boolean": return given === spec.expect;
    case "string": return typeof given === "string" && alts(spec.expect, words).includes(words(given));
    case "time": return Math.abs(ms(given) - Date.parse(spec.expect)) <= (spec.tol ?? 0) * 60e3;
    case "ids": {
      const got = [...new Set((Array.isArray(given) ? given : String(given).split(",")).map(idOf).filter(Boolean))];
      const want = spec.expect.map((e) => alts(e, idOf));
      return got.length === want.length && want.every((w) => got.some((g) => w.includes(g))) && got.every((g) => want.some((w) => w.includes(g)));
    }
    default: throw new Error(`unknown field type ${spec.type}`);
  }
}

// the last ```json block, or null
export function structured(text) {
  const blocks = [...String(text).matchAll(JSON_BLOCK)];
  try {
    const o = blocks.length ? JSON.parse(blocks.at(-1)[1]) : null;
    return o && typeof o === "object" && !Array.isArray(o) && typeof o.status === "string" ? o : null;
  } catch { return null; }
}

export function grade(text, q, { exists, visible, tags }) {
  text = String(text ?? "");
  const s = structured(text), prose = text.replace(JSON_BLOCK, " ");
  const failed = [];
  if (!s) failed.push("no structured answer");
  else {
    if (s.status !== q.status) failed.push("status");
    const fields = s.fields && typeof s.fields === "object" ? s.fields : {};
    for (const [name, spec] of Object.entries(q.fields)) if (!fieldMatches(spec, fields[name])) failed.push(name);
    for (const name of Object.keys(fields)) if (!(name in q.fields)) failed.push(`unexpected field ${name}`);
  }
  // forbidden guards restricted content (a hidden zone's values), anywhere in the answer
  for (const p of q.forbidden ?? []) if (new RegExp(p, "i").test(text)) failed.push(`forbidden ${p}`);
  const cites = [...[...prose.matchAll(CITE)].flatMap((m) => m[1].split(/;\s*|,\s+/)), ...(Array.isArray(s?.citations) ? s.citations : [])]
    .map((c) => String(c).trim()).filter(Boolean);
  const asked = new Set(q.question.match(TAG) ?? []);
  return {
    right: !failed.length,
    // every cite resolves, and an answer cites at least one of its evidence ids (a cite's base is its id before @ or #)
    citationsValid: cites.every(exists) && (q.status !== "answer" || cites.some((c) => q.evidence.includes(c) || q.evidence.includes(c.split(/[@#]/)[0]))),
    // prose sentences stating a number with no cite; digits inside ids and tags (TT-612, SEN-F07-turb) and dates are not numbers
    uncitedFacts: prose.split(/(?<=[.!?])\s+|\n+/).filter((x) => /\d/.test(x.replace(DATE, " ").replace(ID, " ")) && !x.includes("[")).length,
    leak: cites.some((c) => exists(c) && !visible(c, q.asker)),
    inventedTags: [...new Set(text.match(TAG) ?? [])].filter((t) => !tags.has(t) && !asked.has(t)),
    failed
  };
}

export const viewerOf = (ont, personId) => ({ id: personId, clearance: ont.get(personId)?.clearance });

// a cite resolves when it is an object id (a chunk id included), <sensorId>@<from>..<to>, or <procedureId>#<stepId>
const resolves = (get, c) => {
  if (get(c)) return true;
  if (c.includes("@")) return get(c.split("@")[0])?.type === "Sensor";
  const [pid, sid] = c.split("#");
  return !!sid && !!get(pid)?.steps?.some((x) => x.id === sid);
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
