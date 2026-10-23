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
  const lastReportAt = claims.filter((c) => c.projectId === project.id).map((c) => c.at).sort().pop() || null;
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
