// Function tools: models and logic exposed to people and agents alike (PRD §6.4).
// shortcut: transparent heuristics over the synthetic data; upgrade to trained models with a registry and backtests (FR-ANL-006).

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const tail = (a, f = 0.1) => a.slice(-Math.max(1, Math.floor(a.length * f)));
const head = (a, f = 0.1) => a.slice(0, Math.max(1, Math.floor(a.length * f)));
const slope = (a) => {
  const n = a.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2, my = mean(a);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (a[i] - my); den += (i - mx) ** 2; }
  return num / den;
};

export const VIB_ZONE_D = 7.1; // mm/s, ISO 10816-3 group 1 boundary used as the failure line

export function failureRisk({ vib = [], temp = [] }, samplesPerDay = 1440) {
  if (!vib.length) return { score: 0, horizonDays: null, drivers: [] };
  const vLast = mean(tail(vib)), dv = vLast - mean(head(vib));
  const tLast = temp.length ? mean(tail(temp)) : 0, dt = temp.length ? tLast - mean(head(temp)) : 0;
  const sv = clamp01((vLast - 2.5) / 4), tv = clamp01(dv / 3), st = clamp01((tLast - 62) / 20 + dt / 40);
  const score = Math.round(clamp01(0.45 * sv + 0.35 * tv + 0.2 * st) * 100) / 100;
  const drivers = [];
  if (sv > 0.2) drivers.push(`DE vibration ${vLast.toFixed(1)} mm/s`);
  if (tv > 0.2) drivers.push(`vibration rising ${dv.toFixed(1)} mm/s over the window`);
  if (st > 0.2) drivers.push(`bearing temperature ${tLast.toFixed(0)} °C`);
  const s = slope(vib) * samplesPerDay;
  const horizonDays = s > 0.01 ? Math.max(0.5, Math.round(((VIB_ZONE_D - vLast) / s) * 10) / 10) : null;
  return { score, horizonDays, drivers };
}

export function anomaly(values = [], threshold = 4) {
  if (values.length < 10) return { z: 0, flagged: false };
  const base = values.slice(0, Math.floor(values.length * 0.8));
  const m = mean(base), sd = Math.max(std(base), Math.abs(m) * 1e-3, 1e-9);
  const z = Math.round(((mean(tail(values)) - m) / sd) * 100) / 100;
  return { z, flagged: Math.abs(z) > threshold };
}

export function breakthroughRisk({ turbidity = [], headloss = [] }, limitNtu = 1.0, samplesPerHour = 60) {
  if (!turbidity.length) return { score: 0, hoursToLimit: null };
  const tLast = mean(tail(turbidity)), hLast = headloss.length ? mean(tail(headloss)) : 0;
  const score = Math.round(clamp01(0.6 * clamp01((tLast - 0.2) / 0.4) + 0.4 * clamp01((hLast - 1.8) / 0.8)) * 100) / 100;
  const s = slope(turbidity) * samplesPerHour;
  const hoursToLimit = s > 1e-4 ? Math.max(0, Math.round(((limitNtu - tLast) / s) * 10) / 10) : null;
  return { score, hoursToLimit };
}

export function storageHours({ levelPct, capacityMl, demandMlPerH }) {
  if (!demandMlPerH) return Infinity;
  return Math.round(((levelPct / 100) * capacityMl / demandMlPerH) * 10) / 10;
}

export function consequence({ redundancy = 0, storageHours: h = 24, compliance = false }) {
  const r = redundancy <= 0 ? 1 : redundancy === 1 ? 0.5 : 0.1;
  const s = clamp01((12 - h) / 12);
  const score = Math.round(clamp01(0.5 * r + 0.3 * s + (compliance ? 0.2 : 0)) * 100) / 100;
  const label = score >= 0.6 ? "high" : score >= 0.3 ? "medium" : "low";
  const supply = r >= 1 ? "no standby unit" : r >= 0.5 ? "one standby unit" : "two or more standby units";
  return { score, supply, label };
}

export function competenceCheck(person, competencies, required, onDate) {
  const mine = competencies.filter((c) => c.personId === person.id && c.competency === required.type);
  if (!mine.length) return { ok: false, reasons: [`no ${required.type} competence on record`] };
  const valid = mine.filter((c) => c.validTo >= onDate);
  if (!valid.length) {
    const last = mine.map((c) => c.validTo).sort().pop();
    return { ok: false, reasons: [`${required.type} lapsed on ${last}`] };
  }
  const best = valid.reduce((a, b) => (b.level > a.level ? b : a));
  if (best.level < (required.level || 0)) return { ok: false, reasons: [`level ${best.level} below required ${required.level}`] };
  if (required.regClass && (best.regClass || 0) < required.regClass) return { ok: false, reasons: [`process-controller class ${best.regClass} below ${required.regClass}`] };
  return { ok: true, reasons: [] };
}

// The released procedure for an asset template.
export const currentProcedure = (procedures, template) => procedures.find((p) => p.template === template && p.state === "released") || null;

// A step that needs a permit or an isolation stays locked until both are on record.
export function stepLock(step, { permit, isolated }) {
  const r = step.requires || {};
  if (r.permit && !permit) return { locked: true, reason: `Step ${step.step} needs an open permit to work and an applied isolation first.` };
  if (r.isolation && !isolated) return { locked: true, reason: `Step ${step.step} needs the isolation recorded on the permit first.` };
  return { locked: false, reason: null };
}

// Where a field reading sits against a part's band; the finding text is what a deviation records.
export function bandCheck(part, value) {
  const { lo, hi, measure, unit } = part.band;
  const v = Number(value);
  const inBand = v >= lo && v <= hi;
  const side = inBand ? null : v > hi ? "over" : "under";
  const by = inBand ? 0 : Math.round(Math.abs(v - (v > hi ? hi : lo)) * 1000) / 1000;
  return { inBand, side, by, finding: inBand ? `${measure} ${v} ${unit}, within the band ${lo}–${hi}` : `${measure} ${v} ${unit}, ${by} ${unit} ${side} the band ${lo}–${hi}` };
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// How work goes per step, for one person or one procedure (design §6.1 Performance). Never ranks people.
export function performanceFor(scope, executions, procedures, issues, notes) {
  const byPerson = !!scope.personId;
  const mine = (e) => (byPerson ? e.personId === scope.personId : e.procedureId === scope.procedureId);
  const done = executions.filter((e) => e.state === "done" && mine(e));
  const procIds = byPerson ? [...new Set(done.map((e) => e.procedureId))] : [scope.procedureId];
  const steps = [];
  for (const pid of procIds) {
    const proc = procedures.find((p) => p.id === pid);
    if (!proc) continue;
    const runs = done.filter((e) => e.procedureId === pid);
    for (const st of proc.steps) {
      const med = median(runs.map((e) => (e.steps.find((x) => x.step === st.step) || {}).minutes).filter(Number.isFinite));
      steps.push({
        procedureId: pid, step: st.step, text: st.text, expected: st.expectedMinutes, median: med, ratio: med == null ? null : Math.round((med / st.expectedMinutes) * 100) / 100,
        notes: notes.filter((n) => n.procedureId === pid && n.step === st.step && (!byPerson || n.authorId === scope.personId)).length,
        issues: issues.filter((i) => i.procedureId === pid && i.step === st.step && (!byPerson || i.raisedBy === scope.personId)).length
      });
    }
  }
  // first time right: no reading out of band and no issue raised against the job's work order
  const right = done.filter((e) => !e.steps.some((s) => s.inBand === false) && !issues.some((i) => i.workOrderId && i.workOrderId === e.workOrderId));
  return {
    executions: done.length, steps, firstTimeRight: done.length ? Math.round((right.length / done.length) * 100) / 100 : null,
    issuesRaised: issues.filter((i) => (byPerson ? i.raisedBy === scope.personId : i.procedureId === scope.procedureId)).length,
    notesContributed: notes.filter((n) => (byPerson ? n.authorId === scope.personId : n.procedureId === scope.procedureId)).length
  };
}

// Where a project stands, from its claims (a claim is the contractor's word, not a confirmation).
export function projectStatus(project, claims, issues, now) {
  const lastReportAt = claims.filter((c) => c.projectId === project.id && c.state !== "withdrawn").map((c) => c.at).sort().pop() || null;
  const days = lastReportAt ? Math.floor((Date.parse(now) - Date.parse(lastReportAt)) / 86400000) : null;
  const ms = project.milestones || [];
  const today = String(now).slice(0, 10);
  return {
    lastReportAt, daysSinceReport: days, quiet: days != null && days >= 3, end: project.end,
    milestones: { total: ms.length, claimed: ms.filter((m) => m.claimedAt).length, confirmed: ms.filter((m) => m.confirmedAt).length },
    overdue: ms.filter((m) => m.due < today && !m.confirmedAt).map((m) => m.id),
    openIssues: issues.filter((i) => i.projectId === project.id && !["done", "dropped"].includes(i.state)).length
  };
}

// The parts a step's text names: by full name, or by the last word of the name ("sleeve" -> Shaft sleeve).
export function partNamesIn(text, names) {
  const t = String(text).toLowerCase();
  return names.filter((n) => { const w = n.toLowerCase().split(/[\s-]+/).pop(); return t.includes(n.toLowerCase()) || (w.length >= 4 && new RegExp(`\\b${w}`).test(t)); });
}
// What a step needs before it can be signed off, from its text: a permit and isolation, and a reading for a measured part.
export function stepRequires(text, intrusive, partNames, bandOf) {
  const gated = !!intrusive || /permit to work/i.test(text);
  const banded = /measure/i.test(text) && partNames.find((n) => bandOf(n));
  const b = banded && bandOf(banded);
  return { permit: gated, isolation: gated, reading: b ? { partName: banded, measure: b.measure, unit: b.unit } : null };
}

// ---------- Process graph over the current released plant model (design §4.6) ----------
// Nodes: plant Structures, and machines keyed by their Position id. Edges: causal Lines (flow), dosing lines
// (injection, acting on all the water at the injection point) and machine-in-structure (contains).
// Intermittent lines (backwash, filter-to-waste) are walked only in mode "backwash"; recycle edges are marked, never crossed.
export function graphFrom(objects) {
  const nodes = new Map(), out = new Map(), inc = new Map(), alias = new Map();
  const add = (e) => { (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e); (inc.get(e.to) || inc.set(e.to, []).get(e.to)).push(e); };
  for (const o of objects) if (o.type === "Structure") { nodes.set(o.id, o); if (o.positionId) alias.set(o.positionId, o.id); }
  for (const o of objects) if (o.type === "MachinePlacement") {
    const id = o.positionId || o.id;
    nodes.set(id, o);
    if (nodes.has(o.structureId)) add({ from: id, to: o.structureId, kind: "contains", split: null, mode: "continuous", recycle: false });
  }
  for (const l of objects) if (l.type === "Line" && l.causal && nodes.has(l.fromId)) {
    const to = l.injectionAt ? l.fromId.replace(/STR-.*$/, `STR-${l.injectionAt}`) : l.toId;
    if (!nodes.has(to)) continue;
    add({ from: l.fromId, to, kind: l.injectionAt ? "injection" : "flow", lineId: l.id, split: l.splitFraction ?? null, mode: l.mode, recycle: !!l.recycle, length: l.length || 0, pumped: !!l.pumped });
  }
  return { nodes, out, in: inc, alias };
}

const live = (edges, mode) => (edges || []).filter((e) => mode === "backwash" || e.mode !== "intermittent");
const flowTotal = (edges) => edges.filter((e) => e.kind === "flow").reduce((s, e) => s + (e.split || 0), 0);

// Sets with shares: the fraction of the node's water that passed through each item (flow), or 1 for a dose or a
// machine acting on all of it. Every path keeps its own visited set, and recycle edges stop the walk.
function walk(start, g, up, { depth = 20, mode = "normal" } = {}) {
  const id0 = g.alias.get(start) || start, res = new Map();
  const step = (id, share, d, seen) => {
    if (d >= depth) return;
    const edges = live((up ? g.in : g.out).get(id), mode), total = flowTotal(edges);
    for (const e of edges) {
      const next = up ? e.from : e.to;
      if (seen.has(next)) continue;
      const s = share * (e.kind === "flow" ? (total ? (e.split || 0) / total : 0) : 1);
      const r = res.get(next) || res.set(next, { id: next, share: 0 }).get(next);
      r.share += s;
      if (e.recycle) { r.recycle = true; continue; }
      step(next, s, d + 1, new Set(seen).add(next));
    }
  };
  step(id0, 1, 0, new Set([id0]));
  return [...res.values()].map((r) => ({ ...r, share: Math.round(r.share * 1e4) / 1e4 }));
}
export const upstreamOf = (id, g, opts) => walk(id, g, true, opts);
export const downstreamOf = (id, g, opts) => walk(id, g, false, opts);

export function processPaths(from, to, g, { limit = 10, depth = 20, mode = "normal" } = {}) {
  const a = g.alias.get(from) || from, b = g.alias.get(to) || to, paths = [];
  const dfs = (id, path) => {
    if (paths.length >= limit) return;
    if (id === b) return void paths.push(path);
    if (path.length > depth) return;
    for (const e of live(g.out.get(id), mode)) if (!e.recycle && !path.includes(e.to)) dfs(e.to, [...path, e.to]);
  };
  dfs(a, [a]);
  return paths;
}

// Residence-time classes [onset, tail] as multiples of t = V/(Q·share): T10 baffling factors after the EPA classes
// (clarifier 0.4, contact tank 0.5), a mixed flash-mix tank, staged flocculation, a filter's supernatant over a plug-flow
// bed, and the reservoir's exponential response (onset 0.1·t, tail 3·t). Unlisted structures are treated as plug flow.
const RTD = { flash_mix: [0.1, 2.3], flocculator: [0.3, 1.7], clarifier_circular: [0.4, 1.8], filter_bed: [0.2, 1.6], contact_tank: [0.5, 1.5], reservoir_covered: [0.1, 3] };
export function travelWindow(path, g, { flowMlD = 120, lagMin = 0 } = {}) {
  const Q = (flowMlD * 1000) / 24, speed = flowMlD / 120; // line velocity 1.0 m/s gravity, 2.0 m/s pumped, at 120 ML/d
  let on = 0, mean = 0, tl = 0;
  path.forEach((id, i) => {
    const e = i > 0 && (g.out.get(path[i - 1]) || []).find((x) => x.to === id);
    if (e && e.length) { const t = e.length / ((e.pumped ? 2 : 1) * speed) / 3600; on += t; mean += t; tl += t; }
    const n = g.nodes.get(id);
    if (n && n.type === "Structure" && n.volumeM3) {
      const thru = flowTotal(live(g.in.get(id), "normal")) || 1, t = n.volumeM3 / (Q * thru), [fo, ft] = RTD[n.kind] || [1, 1];
      on += fo * t; mean += t; tl += ft * t;
    }
  });
  const r = (h) => Math.round((h + lagMin / 60) * 100) / 100;
  return { onsetH: r(on), meanH: r(mean), tailH: r(tl), basis: `design volumes at Q=${flowMlD} ML/d (${Math.round(Q)} m³/h); onset and tail from residence-time classes; lines at 1.0 m/s gravity, 2.0 m/s pumped scaled to flow; sample lag ${lagMin} min` };
}

// The first sample that leaves the baseline by more than rel × the baseline median. With a period (a known duty
// cycle such as a filter run), each sample is compared with the one a period earlier, so the cycle itself is not an onset.
export function onsetMinute(values = [], { baseline = 120, rel = 0.25, period } = {}) {
  if (values.length <= baseline) return null;
  const med = median(values.slice(0, baseline)), tol = rel * (Math.abs(med) || 1);
  for (let i = Math.max(baseline, period || 0); i < values.length; i++) if (Math.abs(values[i] - (period ? values[i - period] : med)) > tol) return i;
  return null;
}
