// Spec triage, the pure part (job brief design §5): tie a source line to an asset, read the value in it, rank the
// candidates for one spec and decide whether they differ from what is confirmed. Nothing here touches the ontology.

export const tokens = (text) => (String(text).toLowerCase().match(/\p{L}+|[0-9]+/gu) || []);
const has = (hay, needle) => needle.length > 0 && hay.some((_, i) => needle.every((t, j) => hay[i + j] === t));

// A tag or KKS code named in the text ties the line to that asset, one row per asset named; otherwise the asset's name
// is scored by token overlap, and names that score within 0.05 of each other are a tie a person must settle.
export function matchAssets(text, assets) {
  const t = tokens(text);
  const exact = [];
  for (const a of assets) {
    if (has(t, tokens(a.positionTag))) exact.push({ assetId: a.id, matchedBy: "tag", tie: false });
    else if (a.kks && has(t, tokens(a.kks))) exact.push({ assetId: a.id, matchedBy: "kks", tie: false });
  }
  if (exact.length) return exact;
  const set = new Set(t);
  const scored = assets.map((a) => { const n = tokens(a.name); return { a, score: n.length ? n.filter((x) => set.has(x)).length / n.length : 0 }; })
    .filter((x) => x.score >= 0.75).sort((x, y) => y.score - x.score);
  if (!scored.length) return [];
  const close = scored.filter((x) => scored[0].score - x.score <= 0.05);
  return (close.length > 1 ? close : [scored[0]]).map((x) => ({ assetId: x.a.id, matchedBy: "name", tie: close.length > 1 }));
}

export const UNITS = { "L/h": ["L/h", 1], "mL/min": ["L/h", 0.06], mm: ["mm", 1], bar: ["bar", 1], NTU: ["NTU", 1], h: ["h", 1], "%": ["%", 1] };
export const MEASURES = { delivery: { exact: ["delivery", "delivering"], synonyms: ["run at", "run", "dose rate", "output"], units: ["L/h", "mL/min"] } };

const r4 = (n) => (n == null ? null : Math.round(n * 1e4) / 1e4);
const wordIn = (text, w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`, "i").test(text);
// a number (digits, or digits with "?" where the photo could not be read), an optional range end, a unit, and ± tolerance
const NUM = /(?<![\w.\-–/±])([\d?]*\d[\d?]*|\d*\?[\d?]*)(?:\.([\d?]+))?(?![A-Za-z\d])(?:\s*[–-]\s*(\d+(?:\.\d+)?))?\s*([A-Za-z%][A-Za-z/%]*)?(?:\s*±\s*(\d+(?:\.\d+)?)\s*(%)?)?/g;

// The value a line states for a measure. opts.measure and opts.unit come from a sheet's header; a bare cell then reads
// as that measure. Grades follow the digester: EXTRACTED, INFERRED (found through a synonym), AMBIGUOUS (unsure).
export function readValue(text, { measureKeys = Object.keys(MEASURES), measure = null, unit = null } = {}) {
  const s = String(text);
  let key = measure, grade = measure ? "EXTRACTED" : null;
  if (!key) for (const k of measureKeys) {
    const m = MEASURES[k];
    if (m.exact.some((w) => wordIn(s, w))) { key = k; grade = "EXTRACTED"; break; }
    if (m.synonyms.some((w) => wordIn(s, w))) { key = k; grade = "INFERRED"; break; }
  }
  const nums = [...s.matchAll(NUM)].map((m) => ({ raw: m[1] + (m[2] ? `.${m[2]}` : ""), to: m[3], unit: m[4] || unit, tol: m[5], pct: !!m[6] }));
  const wanted = (u) => (key ? MEASURES[key].units.includes(u) : Object.values(MEASURES).some((m) => m.units.includes(u)));
  let n = nums.find((x) => x.unit && wanted(x.unit));
  if (n && !key) { key = Object.keys(MEASURES).find((k) => MEASURES[k].units.includes(n.unit)); grade = "INFERRED"; }
  if (!key) return null;
  const condition = (s.match(/\buntil ([^.]+)/i) || [null, null])[1];
  if (!n) {
    // a number with no unit, or one not in the table: unsure
    const odd = nums.find((x) => !x.unit || !UNITS[x.unit]);
    if (!odd) return null;
    return { key, lo: null, hi: null, target: null, unit: odd.unit || null, grade: "AMBIGUOUS", condition: condition && condition.trim(), line: s };
  }
  if (/\?/.test(n.raw)) return { key, lo: null, hi: null, target: null, unit: n.unit, grade: "AMBIGUOUS", condition: condition && condition.trim(), line: s };
  const [canon, f] = UNITS[n.unit];
  let target = Number(n.raw), lo = null, hi = null;
  if (n.to) { lo = target; hi = Number(n.to); target = null; }
  else if (n.tol) { const d = n.pct ? (target * Number(n.tol)) / 100 : Number(n.tol); lo = target - d; hi = target + d; }
  const k = (x) => (x == null ? null : r4(x * f));
  return { key, lo: k(lo), hi: k(hi), target: k(target), unit: canon, grade, condition: condition ? condition.trim() : null, line: s };
}

export const AUTHORITY = ["client-spec", "oem", "drawing", "spreadsheet", "report"];
// Where a source sits on the ladder; the site manager's own word is "manager", ranked by rule 1 of rank().
export function authorityOf(source, people = []) {
  const sm = people.find((p) => p.role === "works_manager");
  const mailOf = (p) => `${p.name.toLowerCase().split(/\s+/).join(".")}@riverbend.example`;
  if (sm && source.kind === "m365.mail" && String(source.from).toLowerCase() === mailOf(sm)) return "manager";
  if (sm && source.kind === "chat" && source.from === sm.id) return "manager";
  if (source.kind === "m365.files" && /^Engineering\/Specs/.test(source.path || "") && /^Signed:/m.test(source.text || "")) return "client-spec";
  if (source.kind === "Document" && source.docKind === "manual") return "oem";
  if (source.kind === "m365.files" && /^Engineering\/Drawings/.test(source.path || "")) return "drawing";
  if (source.kind === "google.sheets") return "spreadsheet";
  return "report";
}

const valueOf = (c) => (c.target ?? c.lo);
const atOf = (c) => String(c.at ?? (c.source || {}).at ?? "");
const newest = (a, b) => atOf(b).localeCompare(atOf(a));
const covers = (cor, c) => !cor.scope || !cor.scope.assetId || cor.scope.assetId === c.subject;

// Rule 1: the site manager's newest instruction wins when it is newer than the best other candidate. Rule 2: otherwise
// authority first, then the newest. Unsure, blocked and rejected candidates never rank. Each loser gets one reason.
export function rank(candidates, { corrections = [], rejected = [] } = {}) {
  const passedOver = [], live = [];
  for (const c of candidates) {
    const block = corrections.find((cor) => cor.wrongValue != null && covers(cor, c) && cor.wrongSourceRef && cor.wrongSourceRef.id === c.source.id && cor.wrongValue === valueOf(c));
    if (c.grade === "AMBIGUOUS") passedOver.push({ candidateId: c.id, reason: "unsure" });
    else if (block) passedOver.push({ candidateId: c.id, reason: `blocked by ${block.id}` });
    else if (rejected.some((x) => x.sourceId === c.source.id && x.lo === c.lo && x.hi === c.hi)) passedOver.push({ candidateId: c.id, reason: "rejected before" });
    else live.push(c);
  }
  const M = live.filter((c) => c.authority === "manager").sort(newest)[0];
  const T = live.filter((c) => c.authority !== "manager").sort((a, b) => AUTHORITY.indexOf(a.authority) - AUTHORITY.indexOf(b.authority) || newest(a, b))[0];
  const winner = M && (!T || atOf(M) > atOf(T)) ? M : T || null;
  for (const c of live) {
    if (c === winner) continue;
    const reason = c === T && winner === M ? "older than the site manager's instruction"
      : c.authority === "manager" ? "older"
      : AUTHORITY.indexOf(c.authority) > AUTHORITY.indexOf(T.authority) ? "lower authority" : "older";
    passedOver.push({ candidateId: c.id, reason });
  }
  return { winner, passedOver };
}

const r2 = (n) => Math.round(n * 100) / 100;
// Does the winner differ from the confirmed spec? A single value takes the confirmed spec's relative tolerance.
export function decide(winner, confirmed, { ratedRange = null } = {}) {
  let { lo, hi } = winner;
  const target = winner.target ?? null;
  const single = lo == null || hi == null;
  if (single) {
    const mid = (confirmed.lo + confirmed.hi) / 2, half = mid ? (confirmed.hi - confirmed.lo) / 2 / mid : 0;
    lo = r4(target * (1 - half)); hi = r4(target * (1 + half));
  }
  const centre = target ?? (lo + hi) / 2;
  const same = single || (r2(lo) === r2(confirmed.lo) && r2(hi) === r2(confirmed.hi));
  if (centre >= confirmed.lo && centre <= confirmed.hi && same) return { kind: "agrees", lo, hi, target, flag: null };
  const flag = ratedRange && (lo < ratedRange[0] || hi > ratedRange[1]) ? `outside the maker's rated range (${ratedRange[0]}–${ratedRange[1]} ${confirmed.unit})` : null;
  return { kind: "propose", lo, hi, target, flag };
}
