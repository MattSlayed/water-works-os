// Read models for the Region view (Region design §6, §9): capacity and supply, since-you-left, risks, focus, project panels.
import { STAGE_CAPACITY, DESIGN_ML_D } from "./region.mjs";

const activeOn = (p, day) => p.start <= day && day <= p.end;

// Committed spend at a time: the last commitment on or before it.
export const spendAt = (p, iso) => (p.spend || []).filter((s) => s.at <= String(iso).slice(0, 10)).reduce((z, s) => s.zar, 0);

// Treatment capacity is the smallest stage capacity (the stages run in series), not a sum of losses.
export function treatmentCapacity(ont, isoDay) {
  const day = String(isoDay).slice(0, 10), byStage = { ...STAGE_CAPACITY };
  for (const p of ont.list("Project", (x) => activeOn(x, day))) {
    const c = p.capacityImpact;
    if (c && c.stage in byStage && Number.isFinite(c.capacityMlD)) byStage[c.stage] = Math.min(byStage[c.stage], c.capacityMlD);
  }
  const limiting = Object.keys(byStage).reduce((a, b) => (byStage[b] < byStage[a] ? b : a));
  const capacityMlD = Math.min(DESIGN_ML_D, byStage[limiting]);
  return { capacityMlD, byStage, limiting, outOfServiceMlD: DESIGN_ML_D - capacityMlD };
}

// Outbound effects (pumping, storage) count against supply, not treatment.
export function supplyImpacts(ont, isoDay) {
  const day = String(isoDay).slice(0, 10);
  return ont.list("Project", (p) => activeOn(p, day) && p.capacityImpact && ["storage", "supply"].includes(p.capacityImpact.stage))
    .map((p) => ({ projectId: p.id, text: p.capacityImpact.text, ...(p.capacityImpact.storagePct ? { storagePct: p.capacityImpact.storagePct } : {}) }));
}
