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
