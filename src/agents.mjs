// Agent catalogue and runtime (PRD §7.7, FR-AGT-001..011). Agents are data (specs) plus a logic function that may
// only use the context tools: reads through the acting user's view, function tools, and typed actions under the dial.
// shortcut: agent logic is deterministic code over the ontology; with ANTHROPIC_API_KEY the Copilot and Ask answers use
// Claude (src/llm.mjs). Upgrade path: run each spec through the Claude Agent SDK with the same tool wrapper.
import { LEVELS } from "./actions.mjs";
import * as F from "./functions.mjs";

const v = (s) => ({ version: "1.0.0", owner: "reliability_engineer", ...s });
export const AGENT_SPECS = [
  v({ name: "Shift Handover", purpose: "Draft the shift handover: process, alerts, filters, assets out of service, permits, chemicals, incoming crew", trigger: { kind: "schedule", every: "30 min before shift" }, tools: ["draft_document"], autonomy: { draft_document: "act" } }),
  v({ name: "Process Watch", purpose: "Watch filters, dosing and disinfection; alert on breakthrough risk and dose loss; propose backwash", trigger: { kind: "schedule", every: "5 min" }, tools: ["raise_alert", "request_setpoint_change"], autonomy: { raise_alert: "act", request_setpoint_change: "propose" } }),
  v({ name: "Asset Watch", purpose: "Run failure-risk models on rotating assets and raise alerts", trigger: { kind: "schedule", every: "15 min" }, tools: ["raise_alert"], autonomy: { raise_alert: "act" } }),
  v({ name: "Maintenance Triage", purpose: "Price the consequence of an alert (supply, storage, compliance) and rank it", trigger: { kind: "event", on: "Alert raised" }, tools: ["rank_alert"], autonomy: { rank_alert: "act" } }),
  v({ name: "Work Pack", purpose: "Request a corrective work order and draft its work pack from the SOP, history and findings", trigger: { kind: "event", on: "Alert ranked" }, tools: ["create_work_order", "draft_document"], autonomy: { create_work_order: "act", draft_document: "act" } }),
  v({ name: "Parts Readiness", purpose: "Reserve likely parts for a work order; requisition what is out of stock; watch chemical reorder points", trigger: { kind: "event", on: "Work order requested" }, tools: ["reserve_parts", "raise_purchase_requisition"], autonomy: { reserve_parts: "act", raise_purchase_requisition: "propose" } }),
  v({ name: "Scheduler", purpose: "Propose the best competent, available technician and a window", trigger: { kind: "event", on: "Work order requested" }, tools: ["schedule_work"], autonomy: { schedule_work: "propose" } }),
  v({ name: "Technician Copilot", purpose: "On-scene situational insight and guided troubleshooting at an asset or part", trigger: { kind: "event", on: "Part tagged or selected" }, tools: ["record_reading", "tag_part", "raise_deviation", "reserve_parts"], autonomy: { record_reading: "act", tag_part: "act", raise_deviation: "propose", reserve_parts: "propose" } }),
  v({ name: "Debrief", purpose: "Ask targeted close-out questions and capture findings", trigger: { kind: "event", on: "Work order closing" }, tools: ["draft_document"], autonomy: { draft_document: "act" } }),
  v({ name: "Shift Cover", purpose: "Check Reg. 3630 process-controller class and lapsing competence for the next shift", trigger: { kind: "schedule", every: "daily and on roster change" }, tools: ["draft_document", "notify", "raise_alert"], autonomy: { draft_document: "act", notify: "act", raise_alert: "act" } }),
  v({ name: "Permit Guard", purpose: "Check people in hazardous zones against competence and permits", trigger: { kind: "event", on: "Presence or permit change" }, tools: ["raise_alert", "notify"], autonomy: { raise_alert: "act", notify: "act" } }),
  v({ name: "Drop Pack", purpose: "Keep the Blue Drop evidence pack current and list gaps", trigger: { kind: "schedule", every: "daily" }, tools: ["draft_document"], autonomy: { draft_document: "act" } }),
  v({ name: "Ask", purpose: "Answer questions about the works from the ontology", trigger: { kind: "manual" }, tools: [], autonomy: {} }),
  v({ name: "Tag Matcher", purpose: "Match historian tags to positions and report unmatched keys", trigger: { kind: "event", on: "Connector import" }, tools: ["draft_document"], autonomy: { draft_document: "act" } })
];

const HAZARD_COMPETENCE = { chlorine: "gas-safety:chlorine" };
const TRADE_FOR = { centrifugal_pump: "millwright", blower: "millwright", clarifier_drive: "millwright", dosing_pump: "fitter" };

// Situational insight for an asset or part, shared by the Copilot agent and src/copilot.mjs.
export function assetInsight(ctx, assetId, partId) {
  const asset = ctx.get(assetId);
  if (!asset) return null;
  const part = partId ? ctx.get(partId) : null;
  const sensors = ctx.sensorsFor(assetId).map((s) => {
    const l = ctx.latest(s.id);
    const h = ctx.history(s.id, 4320);
    return { id: s.id, name: s.name, unit: s.unit, value: l && l.value, alarmHi: s.alarmHi, trend: h.length > 1 ? Math.round((h[h.length - 1] - h[0]) * 100) / 100 : 0 };
  });
  const alerts = ctx.list("Alert", (a) => a.assetId === assetId && a.state === "active");
  const siblings = ctx.list("Asset", (a) => a.template && a.template === asset.template && a.id !== assetId).map((a) => a.id);
  const findings = ctx.list("Finding", (f) => f.verified && (f.assetId === assetId || siblings.includes(f.assetId)))
    .map((f) => ({ ...f, partName: f.partId && ctx.get(f.partId) ? ctx.get(f.partId).name : null }));
  const history = ctx.list("WorkOrder", (w) => w.assetId === assetId).sort((a, b) => String(b.planned).localeCompare(String(a.planned))).slice(0, 5);
  const deviations = ctx.list("Deviation", (d) => d.assetId === assetId && d.state !== "withdrawn");
  const permit = ctx.list("Permit", (p) => p.assetId === assetId && p.state === "open")[0] || null;
  const isolated = !!(permit && (permit.isolations || []).some((i) => i.state === "applied"));
  const zone = ctx.get(asset.zoneId);
  const proc = F.currentProcedure(ctx.list("Procedure"), asset.template);
  const steps = proc ? proc.steps : [];
  const procedure = part ? steps.filter((s) => s.partNames.includes(part.name)) : steps;
  const manual = ctx.list("Document", (d) => d.kind === "manual" && d.template === asset.template)[0] || null;
  return { asset, part, sensors, alerts, findings, history, deviations, permit, isolated, hazards: zone ? zone.hazard : null, zone, procedure, allSteps: steps, manual };
}

const LOGIC = {
  "Shift Handover"(ctx) {
    const lines = [];
    const shifts = ctx.list("Shift").sort((a, b) => a.start.localeCompare(b.start));
    const next = shifts.find((s) => s.start >= ctx.now) || shifts[shifts.length - 1];
    lines.push(`Handover for shift ${next.id} (crew ${next.crew}), prepared ${ctx.now}.`);
    for (const id of ["SEN-RAW-flow", "SEN-FW-turb", "SEN-FIN-cl", "SEN-CWR1-level", "SEN-CWR2-level"]) {
      const s = ctx.get(id), l = ctx.latest(id);
      if (s && l) lines.push(`Process: ${s.name} ${l.value} ${s.unit}.`);
    }
    for (const f of ctx.list("Asset", (a) => a.assetClass === "Rapid gravity filter")) {
      const t = ctx.latest(`SEN-${f.positionTag}-turb`), h = ctx.latest(`SEN-${f.positionTag}-headloss`);
      if (t && h && (t.value > 0.3 || h.value > 2.1)) lines.push(`Filter ${f.positionTag}: turbidity ${t.value} NTU, head loss ${h.value} m. Consider an early backwash.`);
    }
    for (const a of ctx.list("Alert", (x) => x.state === "active")) lines.push(`Alert: ${a.title} (${a.severity}).`);
    for (const a of ctx.list("Asset", (x) => x.state && !["running", "in service"].includes(x.state))) lines.push(`Asset ${a.positionTag || a.name} is ${a.state}.`);
    for (const p of ctx.list("Permit", (x) => x.state === "open")) lines.push(`Permit ${p.id} open on ${ctx.get(p.assetId) ? ctx.get(p.assetId).positionTag : p.assetId}.`);
    for (const c of ctx.list("Chemical", (x) => x.levelPct < x.reorderPct)) lines.push(`Chemical below reorder: ${c.name} at ${c.levelPct}%.`);
    const open = ctx.list("WorkOrder", (w) => !["closed", "cancelled"].includes(w.state));
    lines.push(`Open work orders: ${open.length}.`);
    ctx.think(`Collected ${lines.length} handover lines.`);
    ctx.act("draft_document", { kind: "handover", title: `Shift handover ${next.id}`, body: lines.join("\n"), aboutId: next.id });
  },

  "Process Watch"(ctx) {
    for (const f of ctx.list("Asset", (a) => a.assetClass === "Rapid gravity filter")) {
      const turb = ctx.history(`SEN-${f.positionTag}-turb`, 240), hl = ctx.history(`SEN-${f.positionTag}-headloss`, 240);
      const r = ctx.fn("breakthroughRisk", { turbidity: turb, headloss: hl });
      if (r.score < 0.35 || ctx.list("Alert", (a) => a.assetId === f.id && a.state === "active").length) continue;
      ctx.think(`${f.positionTag} breakthrough risk ${r.score}; hours to 1 NTU ${r.hoursToLimit}.`);
      ctx.act("raise_alert", { targetId: f.id, title: `${f.positionTag} filter breakthrough risk`, severity: r.score > 0.6 ? "high" : "medium", score: r.score, evidence: [`SEN-${f.positionTag}-turb`, `SEN-${f.positionTag}-headloss`] });
      ctx.act("request_setpoint_change", { targetId: f.positionId, setpoint: "initiate backwash", value: "now", assetId: f.id }, { evidence: [`SEN-${f.positionTag}-turb`], risk: r });
    }
    for (const p of ctx.list("Asset", (a) => a.template === "dosing_pump" && a.state === "running")) {
      const flow = ctx.history(`SEN-${p.positionTag}-flow`, 240);
      if (!flow.length) continue;
      const sorted = [...flow].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
      if (Math.min(...flow) < 0.5 * median && !ctx.list("Alert", (a) => a.assetId === p.id && a.state === "active").length) {
        ctx.think(`${p.positionTag} dose flow dipped to ${Math.min(...flow).toFixed(0)} L/h against a median of ${median.toFixed(0)}.`);
        ctx.act("raise_alert", { targetId: p.id, title: `${p.positionTag} dose flow dropping intermittently`, severity: "medium", evidence: [`SEN-${p.positionTag}-flow`] });
      }
    }
    for (const id of ["SEN-FIN-cl", "SEN-FIN-ph"]) {
      const s = ctx.get(id), l = ctx.latest(id);
      if (s && l && ((s.alarmLo != null && l.value < s.alarmLo) || (s.alarmHi != null && l.value > s.alarmHi)) && !ctx.list("Alert", (a) => a.targetId === id && a.state === "active").length) {
        ctx.act("raise_alert", { targetId: id, title: `${s.name} out of band: ${l.value} ${s.unit}`, severity: "high", evidence: [id] });
      }
    }
  },

  "Asset Watch"(ctx) {
    const next = [];
    for (const a of ctx.list("Asset", (x) => x.hero && x.state === "running")) {
      const vibS = ctx.sensorsFor(a.id).find((s) => s.key.startsWith("vib"));
      if (!vibS) continue;
      const tempS = ctx.sensorsFor(a.id).find((s) => s.key.startsWith("temp"));
      const r = ctx.fn("failureRisk", { vib: ctx.history(vibS.id, 4320), temp: tempS ? ctx.history(tempS.id, 4320) : [] });
      if (r.score < 0.5) continue;
      if (ctx.list("Alert", (x) => x.assetId === a.id && x.state === "active").length) continue;
      ctx.think(`${a.positionTag} failure risk ${r.score}, horizon ${r.horizonDays} days: ${r.drivers.join("; ")}.`);
      const res = ctx.act("raise_alert", { targetId: a.id, title: `${a.positionTag} failure risk ${Math.round(r.score * 100)}% within ${r.horizonDays ?? "?"} days`, severity: r.score > 0.75 ? "high" : "medium", score: r.score, evidence: [vibS.id, tempS && tempS.id].filter(Boolean) });
      if (res.status === "done") next.push({ agent: "Maintenance Triage", scope: { alertId: res.objects[0] } });
    }
    return next;
  },

  "Maintenance Triage"(ctx) {
    const alert = ctx.get(ctx.scope.alertId);
    if (!alert) return ctx.think("No alert in scope.");
    const asset = ctx.get(alert.assetId);
    const peers = ctx.list("Asset", (a) => a.template === asset.template && a.positionId && ctx.get(a.positionId) && ctx.get(a.positionId).stage === ctx.get(asset.positionId).stage && a.id !== asset.id);
    const redundancy = peers.filter((a) => a.state === "standby").length;
    const res = ctx.list("Asset", (a) => a.assetClass === "Reservoir");
    const stored = res.reduce((s, r) => s + ((ctx.latest(r.levelSensor) || { value: 0 }).value / 100) * r.capacityMl, 0);
    const out = (ctx.latest("SEN-OUT-flow") || { value: 100 }).value / 24;
    const hours = ctx.fn("storageHours", { levelPct: 100, capacityMl: stored, demandMlPerH: out });
    const c = ctx.fn("consequence", { redundancy, storageHours: hours, compliance: asset.criticality === "A" });
    const priority = c.label === "high" || (alert.score || 0) > 0.75 ? "P1" : c.label === "medium" ? "P2" : "P3";
    ctx.think(`${asset.positionTag}: ${c.supply}; ${hours} h of treated storage; consequence ${c.label}; priority ${priority}.`);
    ctx.act("rank_alert", { alertId: alert.id, consequence: { ...c, storageHours: hours, redundancy }, priority });
    return priority !== "P3" ? [{ agent: "Work Pack", scope: { alertId: alert.id } }] : [];
  },

  "Work Pack"(ctx) {
    const alert = ctx.get(ctx.scope.alertId);
    if (!alert) return ctx.think("No alert in scope.");
    const asset = ctx.get(alert.assetId);
    const ins = assetInsight(ctx, asset.id);
    let wo = ctx.list("WorkOrder", (w) => w.assetId === asset.id && w.kind === "CM" && !["closed", "cancelled"].includes(w.state))[0];
    if (!wo) {
      const r = ctx.act("create_work_order", { assetId: asset.id, title: `${asset.positionTag}: ${alert.title}`, kind: "CM", priority: alert.priority || "P2", source: alert.id });
      if (r.status !== "done") return;
      wo = ctx.get(r.objects[0]);
    }
    const faults = ins.manual && ins.manual.faultTree ? Object.entries(ins.manual.faultTree).map(([k, causes]) => `${k}: ${causes.join("; ")}`) : [];
    const body = [
      `Work order ${wo.id} for ${asset.name} (${asset.positionTag}, serial ${asset.serial}).`,
      `Why: ${alert.title}.`,
      `Likely causes (OEM manual ${ins.manual ? ins.manual.id : "n/a"}): ${faults.join(" | ")}`,
      ...ins.findings.map((f) => `Similar finding ${f.id} on ${ctx.get(f.assetId) ? ctx.get(f.assetId).positionTag : f.assetId}: ${f.text}`),
      "Steps:",
      ...ins.allSteps.map((s) => `${s.step}. ${s.text}${s.intrusive ? " [needs permit and isolation]" : ""}`)
    ].join("\n");
    ctx.act("draft_document", { kind: "work-pack", title: `Work pack ${wo.id}`, body, aboutId: wo.id, assetId: asset.id });
    return [{ agent: "Parts Readiness", scope: { workOrderId: wo.id } }, { agent: "Scheduler", scope: { workOrderId: wo.id } }];
  },

  "Parts Readiness"(ctx) {
    if (ctx.scope.workOrderId) {
      const wo = ctx.get(ctx.scope.workOrderId);
      if (!wo) return ctx.think("Work order not found.");
      const parts = ctx.list("Part", (p) => p.assetId === wo.assetId && /bearing/i.test(p.name) && !/housing/i.test(p.name));
      for (const p of parts) {
        if ((p.stock || 0) > 0) ctx.act("reserve_parts", { partIds: [p.id], workOrderId: wo.id, assetId: wo.assetId });
        else ctx.act("raise_purchase_requisition", { itemId: p.id, qty: 1, reason: `No stock for ${wo.id}`, assetId: wo.assetId });
      }
      return;
    }
    for (const c of ctx.list("Chemical", (x) => x.levelPct < x.reorderPct)) {
      ctx.act("raise_purchase_requisition", { itemId: c.id, qty: 1, reason: `${c.name} at ${c.levelPct}% (reorder at ${c.reorderPct}%)` });
    }
  },

  Scheduler(ctx) {
    const wo = ctx.get(ctx.scope.workOrderId);
    if (!wo) return ctx.think("Work order not found.");
    const asset = ctx.get(wo.assetId);
    const trade = TRADE_FOR[asset.template] || "fitter";
    const comps = ctx.list("Competency");
    const load = (pid) => ctx.list("WorkOrder", (w) => w.assigneeId === pid && !["closed", "cancelled"].includes(w.state)).length;
    const candidates = ctx.list("Person", (p) => p.trade === trade && p.role !== "contractor")
      .map((p) => ({ p, chk: ctx.fn("competenceCheck", p, comps, { type: `trade:${trade}`, level: wo.priority === "P1" ? 3 : 2 }, ctx.today), load: load(p.id) }));
    for (const c of candidates) if (!c.chk.ok) ctx.think(`${c.p.id} excluded: ${c.chk.reasons.join("; ")}.`);
    const ok = candidates.filter((c) => c.chk.ok).sort((a, b) => a.load - b.load);
    if (!ok.length) return ctx.think(`No competent ${trade} available.`);
    const best = ok[0];
    const window = `${ctx.today} day shift (standby unit carries the load)`;
    ctx.think(`Chose ${best.p.id} (${trade}, ${best.load} open jobs).`);
    ctx.act("schedule_work", { workOrderId: wo.id, assigneeId: best.p.id, window, assetId: wo.assetId }, { evidence: [`competence ok for ${best.p.id}`] });
  },

  "Technician Copilot"(ctx) {
    const ins = assetInsight(ctx, ctx.scope.assetId, ctx.scope.partId);
    if (!ins) return ctx.think("Asset not visible or not found.");
    ctx.think(`${ins.alerts.length} active alerts, ${ins.findings.length} verified findings, permit ${ins.permit ? ins.permit.id : "none"}.`);
    ctx.output({ kind: "insight", assetId: ins.asset.id, partId: ins.part && ins.part.id, alerts: ins.alerts.map((a) => a.id), findings: ins.findings.map((f) => f.id), permit: ins.permit && ins.permit.id });
  },

  Debrief(ctx) {
    const wo = ctx.get(ctx.scope.workOrderId);
    if (!wo) return ctx.think("Work order not found.");
    const asset = ctx.get(wo.assetId);
    const manual = ctx.list("Document", (d) => d.kind === "manual" && d.template === asset.template)[0];
    const qs = ["What did you find, and on which part?", "What was the root cause, in your judgement?"];
    if (manual && manual.faultTree) qs.push(`Which of these did you rule out: ${Object.values(manual.faultTree)[0].join("; ")}?`);
    qs.push("Should the procedure change? If so, which step?");
    ctx.act("draft_document", { kind: "debrief", title: `Debrief ${wo.id}`, body: qs.join("\n"), aboutId: wo.id, assetId: asset.id });
  },

  "Shift Cover"(ctx) {
    const shifts = ctx.list("Shift").sort((a, b) => a.start.localeCompare(b.start));
    const next = shifts.find((s) => s.start >= ctx.now) || shifts[shifts.length - 1];
    const crew = ctx.list("Person", (p) => p.shift === next.crew && ["process_controller", "shift_supervisor"].includes(p.role));
    const comps = ctx.list("Competency", (c) => c.competency === "reg3630:process-controller");
    const valid = (p) => comps.filter((c) => c.personId === p.id && c.validTo >= ctx.today).map((c) => c.regClass || 0);
    const best = Math.max(0, ...crew.flatMap(valid));
    const lapsing = ctx.list("Competency", (c) => c.validTo >= ctx.today && c.validTo <= addDays(ctx.today, 30));
    const lines = [`Shift ${next.id} crew ${next.crew}: highest valid process-controller class ${best}; works minimum ${next.minClass}.`];
    for (const c of lapsing) lines.push(`${c.competency} for ${c.personId} lapses on ${c.validTo}.`);
    const gap = best < next.minClass;
    if (gap) {
      lines.push("GAP: minimum class not covered.");
      const sups = ctx.list("Person", (p) => p.role === "shift_supervisor").map((p) => p.id);
      ctx.act("raise_alert", { targetId: next.id, title: `Shift ${next.id} below minimum process-controller class`, severity: "high" });
      ctx.act("notify", { to: sups, message: lines[0], aboutId: next.id });
    }
    ctx.act("draft_document", { kind: "cover", title: `Cover check ${next.id}`, body: lines.join("\n"), aboutId: next.id, data: { shiftId: next.id, best, min: next.minClass, gap } });
  },

  "Permit Guard"(ctx) {
    const comps = ctx.list("Competency");
    for (const pr of ctx.list("Presence")) {
      const zone = ctx.get(pr.zoneId);
      const needed = zone && HAZARD_COMPETENCE[zone.hazard];
      if (!needed) continue;
      const chk = ctx.fn("competenceCheck", { id: pr.personId }, comps, { type: needed, level: 1 }, ctx.today);
      if (chk.ok) continue;
      if (ctx.list("Alert", (a) => a.targetId === pr.id && a.state === "active").length) continue;
      ctx.think(`${pr.personId} in ${zone.id} (${zone.hazard}) without ${needed}: ${chk.reasons.join("; ")}.`);
      ctx.act("raise_alert", { targetId: pr.id, title: `${pr.personId} in ${zone.name} without ${needed}`, severity: "high", evidence: [pr.id] });
      const hosts = ctx.list("Person", (p) => p.role === "shift_supervisor" || p.role === "safety_officer").map((p) => p.id);
      ctx.act("notify", { to: hosts, message: `Escort or remove ${pr.personId} from ${zone.name}.`, aboutId: pr.id });
    }
  },

  "Drop Pack"(ctx) {
    const items = dropPackEvidence(ctx);
    const body = items.map((i) => `${i.status.toUpperCase()} ${i.requirementId}: ${i.detail}`).join("\n");
    ctx.act("draft_document", { kind: "drop-pack", title: "Blue Drop evidence pack", body, data: { items } });
  },

  Ask(ctx) {
    const q = String(ctx.mission || "");
    const tokens = q.match(/[A-Z]{1,4}-?[A-Z0-9]{1,3}\b|F\d\d/g) || [];
    const objs = [...new Set(tokens)].flatMap((t) => ctx.search(t, 3)).filter((o) => o.type === "Asset" || o.type === "Position");
    const lines = objs.map((o) => {
      const a = o.type === "Position" ? ctx.list("Asset", (x) => x.positionId === o.id)[0] : o;
      if (!a) return `${o.tag}: no unit installed.`;
      const vals = ctx.sensorsFor(a.id).map((s) => `${s.name} ${(ctx.latest(s.id) || {}).value} ${s.unit}`).join(", ");
      const alerts = ctx.list("Alert", (x) => x.assetId === a.id && x.state === "active").map((x) => x.title);
      return `${a.positionTag} ${a.name} is ${a.state}. ${vals}.${alerts.length ? ` Active alerts: ${alerts.join("; ")}.` : ""}`;
    });
    ctx.output({ kind: "answer", text: lines.length ? lines.join("\n") : "I could not find an asset or tag in the question.", cites: objs.map((o) => o.id) });
  },

  "Tag Matcher"(ctx) {
    const unmatched = [];
    for (const s of ctx.list("Sensor", (x) => x.assetId)) {
      const a = ctx.get(s.assetId), pos = a && ctx.get(a.positionId);
      if (!pos || !s.historianTag.startsWith(pos.kks)) unmatched.push(s.id);
    }
    ctx.act("draft_document", { kind: "tag-match", title: "Historian tag match report", body: `${unmatched.length} unmatched historian tags.${unmatched.length ? " " + unmatched.join(", ") : ""}`, data: { unmatched } });
  }
};

const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

export function dropPackEvidence(ctx) {
  const items = [];
  const samples = ctx.list("Sample");
  const bad = samples.filter((s) => !s.compliant);
  const pct = samples.length ? Math.round(((samples.length - bad.length) / samples.length) * 1000) / 10 : 0;
  items.push({ requirementId: "REQ-BD-QUAL", status: pct >= 97 ? "met" : "gap", detail: `${pct}% of ${samples.length} final-water results within SANS 241 limits.`, refs: bad.map((s) => s.id) });
  const noResponse = bad.filter((s) => !s.response);
  items.push({ requirementId: "REQ-BD-INC", status: noResponse.length ? "gap" : "met", detail: noResponse.length ? `${noResponse.length} non-compliance(s) without a documented response.` : "Every non-compliance has a response.", refs: noResponse.map((s) => s.id) });
  const analysers = ctx.list("Sensor", (s) => s.processUnitId && /turb|cl|ph/.test(s.key) && !s.id.startsWith("SEN-RAW"));
  const certs = ctx.list("Document", (d) => d.kind === "certificate");
  const missing = analysers.filter((s) => !certs.some((c) => c.sensorId === s.id && c.validTo >= ctx.today));
  items.push({ requirementId: "REQ-BD-CAL", status: missing.length ? "gap" : "met", detail: missing.length ? `No current calibration certificate for: ${missing.map((s) => s.name).join(", ")}.` : "All analysers calibrated.", refs: missing.map((s) => s.id) });
  const shifts = ctx.list("Shift");
  const comps = ctx.list("Competency", (c) => c.competency === "reg3630:process-controller" && c.validTo >= ctx.today);
  const uncovered = shifts.filter((sh) => {
    const crew = ctx.list("Person", (p) => p.shift === sh.crew);
    return Math.max(0, ...comps.filter((c) => crew.some((p) => p.id === c.personId)).map((c) => c.regClass)) < sh.minClass;
  });
  items.push({ requirementId: "REQ-BD-PROC", status: uncovered.length ? "gap" : "met", detail: uncovered.length ? `Shifts below minimum class: ${uncovered.map((s) => s.id).join(", ")}.` : `All ${shifts.length} shifts covered at the minimum class.`, refs: uncovered.map((s) => s.id) });
  const pms = ctx.list("WorkOrder", (w) => w.kind === "PM");
  const done = pms.filter((w) => w.state === "closed");
  items.push({ requirementId: "REQ-BD-AM", status: pms.length && done.length / pms.length >= 0.9 ? "met" : "gap", detail: `${done.length} of ${pms.length} planned maintenance orders closed.`, refs: [] });
  return items;
}

export function createRuntime({ ont, tel, actions }) {
  const specs = new Map(AGENT_SPECS.map((s) => [s.name, structuredClone(s)]));
  const logic = new Map(Object.entries(LOGIC));
  const runs = [];
  let n = 0;

  function makeCtx(spec, run, opts) {
    const view = ont.view(opts.actingUser);
    const seen = new Set();
    const read = (o) => { if (o && !seen.has(o.id)) { seen.add(o.id); if (run.read.length < 500) run.read.push(o.id); } return o; };
    const call = (tool, args, result) => { run.calls.push({ tool, args, result }); return result; };
    const now = tel.now();
    return {
      spec, now, today: now.slice(0, 10), mission: opts.mission || null, scope: opts.scope || {},
      get: (id) => read(view.get(id)),
      list: (type, pred) => view.list(type, pred).map(read),
      search: (q, k) => view.search(q, k).map(read),
      links: (id, o) => view.links(id, o),
      neighbors: (id, rel) => view.neighbors(id, rel).filter(Boolean).map(read),
      sensorsFor: (id) => tel.sensorsFor(id).filter((s) => view.get(s.id)).map(read),
      latest: (id) => (view.get(id) ? tel.latest(id) : null),
      history: (id, k) => (view.get(id) ? tel.history(id, k) : []),
      fn: (name, ...args) => {
        if (!F[name]) throw new Error(`unknown function ${name}`);
        return call(`fn:${name}`, args.length === 1 ? args[0] : args.map((a) => (a && a.id ? a.id : Array.isArray(a) ? `[${a.length}]` : a)), F[name](...args));
      },
      act: (action, params, meta = {}) => {
        if (!spec.tools.includes(action)) {
          const r = { status: "refused", reason: `${action} not in manifest` };
          run.refusals.push({ action, reason: r.reason });
          return call(action, params, r);
        }
        const r = actions.invoke({ action, params, actor: { kind: "agent", id: spec.name, clearance: opts.actingUser.clearance, onBehalfOf: opts.actingUser.id }, autonomy: spec.autonomy[action] || "propose", runId: run.id, ...meta });
        if (r.status === "refused") run.refusals.push({ action, reason: r.reason });
        else run.outputs.push({ action, status: r.status, ref: (r.decision || r.proposal).id });
        return call(action, params, { status: r.status, ref: r.decision ? r.decision.id : r.proposal ? r.proposal.id : null, objects: r.decision ? r.decision.objects : [], reason: r.reason });
      },
      think: (t) => run.reasoning.push(t),
      output: (o) => run.outputs.push(o)
    };
  }

  function run(name, opts = {}, depth = 0) {
    const spec = specs.get(name);
    if (!spec) throw new Error(`unknown agent ${name}`);
    if (!opts.actingUser) throw new Error("actingUser required");
    const r = {
      id: `RUN-${String(++n).padStart(5, "0")}`, type: "AgentRun", agent: name, version: spec.version, trigger: opts.trigger || { kind: "manual" },
      mission: opts.mission || null, scope: opts.scope || {}, actingUserId: opts.actingUser.id, startedAt: new Date().toISOString(), plantTime: tel.now(),
      read: [], calls: [], reasoning: [], outputs: [], refusals: [], status: "running"
    };
    let next = [];
    try {
      next = logic.get(name)(makeCtx(spec, r, opts)) || [];
      r.status = "completed";
    } catch (e) {
      r.status = "failed";
      r.error = e.message;
    }
    r.endedAt = new Date().toISOString();
    ont.upsert({ ...r, minClearance: opts.actingUser.clearance });
    runs.push(r);
    if (opts.chain !== false && depth < 6) for (const x of next) run(x.agent, { ...opts, scope: x.scope, mission: null, trigger: { kind: "chain", from: r.id } }, depth + 1);
    return r;
  }

  return {
    specs: () => [...specs.values()],
    spec: (name) => specs.get(name) || null,
    register(spec, fn) { specs.set(spec.name, spec); logic.set(spec.name, fn); },
    setAutonomy(name, action, level) {
      const s = specs.get(name);
      if (!s) throw new Error(`unknown agent ${name}`);
      if (!LEVELS.includes(level)) throw new Error(`unknown level ${level}`);
      if (!s.tools.includes(action)) throw new Error(`${action} not in ${name}'s manifest`);
      s.autonomy[action] = level;
      return s;
    },
    run,
    runs: () => runs,
    getRun: (id) => runs.find((r) => r.id === id) || null
  };
}
