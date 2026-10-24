// The job brief (job brief design §6): what a person should know before they calibrate or test an asset, built from
// their own view. Deterministic; Claude, when on, may only shorten its wording.

import { isAnalyser } from "./functions.mjs";
// Corrections that reach a job, most specific first (the asset, its make and model, then an organisation), newest first
// within each. An organisation reaches the asset through any project that touched it or the job's own project; the
// works' owner reaches every job (design §4.5).
export function correctionsFor(view, asset, workOrder = null) {
  const orgs = new Set(["ORG-OWNER"]);
  for (const p of view.list("Project", (x) => (x.assetIds || []).includes(asset.id) || x.assetId === asset.id || (workOrder && workOrder.projectId === x.id))) {
    if (p.clientOrgId) orgs.add(p.clientOrgId);
    if (p.contractorOrgId) orgs.add(p.contractorOrgId);
  }
  const level = (c) => (!c.scope ? -1 : c.scope.assetId ? (c.scope.assetId === asset.id ? 0 : -1) : c.scope.template ? (c.scope.template === asset.template ? 1 : -1) : c.scope.orgId && orgs.has(c.scope.orgId) ? 2 : -1);
  return view.list("Correction").map((c) => [level(c), c]).filter(([l]) => l >= 0)
    .sort((a, b) => a[0] - b[0] || String(b[1].at).localeCompare(String(a[1].at))).map(([, c]) => c);
}

const lowerFirst = (t) => (t ? t[0].toLowerCase() + t.slice(1) : t);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const newestFirst = (k) => (a, b) => String(b[k] || "").localeCompare(String(a[k] || ""));
const item = (text, refs) => ({ text, refs: refs.filter(Boolean) });

// The brief for one work order, from the viewer's own view: { lines, full, specVersions, correctionIds }, or null when
// the viewer cannot see the job. lines is the chat version (at most 8 lines); full holds every section with its refs.
// Source text never enters it: only titles, dates and names.
export function jobBrief(view, workOrderId, { execution = null } = {}) {
  const wo = view.get(workOrderId);
  if (!wo || wo.type !== "WorkOrder") return null;
  const asset = view.get(wo.assetId);
  if (!asset) return null;
  const nameOf = (id) => (view.get(id) || {}).name || id;
  const sisters = new Set(asset.template ? view.list("Asset", (a) => a.template === asset.template).map((a) => a.id) : [asset.id]);

  // 1. target: the confirmed band for each measure the procedure records, and any change waiting for the site manager
  const specs = view.list("Spec", (x) => x.assetId === asset.id && x.step != null).sort((a, b) => a.step - b.step);
  const target = [];
  for (const sp of specs) {
    const src = (sp.sourceRefs || [])[0] || {};
    const p = view.list("Proposal", (x) => x.action === "update_spec" && x.state === "open" && x.params.specId === sp.id)[0];
    // during a job, the band it is held to (design §6: a change confirmed mid-job does not move the job)
    const pin = execution && (execution.specPins || []).find((x) => x.specId === sp.id);
    if (pin && pin.version !== sp.version) { target.push(item(`Target: ${lowerFirst(sp.measure)} ${pin.lo}–${pin.hi} ${sp.unit} (this job is held to v${pin.version}; v${sp.version} was confirmed after it started).`, [sp.id])); continue; }
    let text = `Target: ${lowerFirst(sp.measure)} ${sp.lo}–${sp.hi} ${sp.unit} (${src.title || "no source"}, confirmed by ${nameOf(sp.confirmedBy)}).`;
    if (sp.condition) text += ` Until ${sp.condition}.`;
    if (p) text += ` A newer value, ${p.params.target ?? `${p.params.lo}–${p.params.hi}`} ${sp.unit}, waits for the site manager.`;
    target.push(item(text, [sp.id, p && p.id]));
    if (p && p.params.why) target.push(item(`Waiting: ${p.params.why}`, [p.id]));
  }

  // 2. corrections: the asset, its make and model, its organisations; three, then a count
  const cors = correctionsFor(view, asset, wo);
  const corrections = cors.slice(0, 3).map((c) => item(c.line, [c.id]));
  if (cors.length > 3) corrections.push(item(`and ${cors.length - 3} more`, []));

  // 3. last time: the newest finished job, else the newest closed work order; and the newest finding on a sister asset
  const ex = view.list("Execution", (e) => e.assetId === asset.id && e.state === "done").sort(newestFirst("finishedAt"))[0];
  const prevWo = view.list("WorkOrder", (w) => w.assetId === asset.id && w.state === "closed" && w.id !== wo.id).sort((a, b) => String(b.closed || b.planned).localeCompare(String(a.closed || a.planned)))[0];
  let lastText = null, lastAt = null, lastRef = null;
  if (ex) {
    const n = ex.steps.filter((x) => x.value != null).length, right = !ex.steps.some((x) => x.inBand === false);
    lastText = `Last time: ${ex.finishedAt.slice(0, 10)} by ${nameOf(ex.personId)}, ${n} reading${n === 1 ? "" : "s"}, ${right ? "first time right" : "not first time right"}.`;
    lastAt = ex.finishedAt; lastRef = ex.id;
  } else if (prevWo) {
    const when = prevWo.closed || prevWo.planned;
    lastText = `Last time: ${prevWo.id} ${lowerFirst(prevWo.title.split(":")[0])} in ${MONTHS[Number(when.slice(5, 7)) - 1]}, no readings.`;
    lastAt = when; lastRef = prevWo.id;
  }
  const finding = view.list("Finding", (f) => f.verified && sisters.has(f.assetId)).sort(newestFirst("at"))[0];
  const fromFinding = finding && view.list("Correction", (c) => c.fromId === finding.id)[0];
  const findingText = finding ? `On ${(view.get(finding.assetId) || {}).positionTag || finding.assetId}, ${lowerFirst(fromFinding ? fromFinding.line : finding.text)}` : null;
  const lastTime = lastText || findingText ? [item([lastText, findingText].filter(Boolean).join(" "), [lastRef, finding && finding.id, fromFinding && fromFinding.id])] : [];

  // 4. open now: issues on the asset, and analysers on it without a current certificate
  const open = view.list("Issue", (i) => i.assetId === asset.id && !["done", "dropped"].includes(i.state)).sort(newestFirst("at")).map((i) => item(`Open: ${i.id}, ${i.title}.`, [i.id]));
  const certs = view.list("Document", (d) => d.kind === "certificate");
  for (const s of view.list("Sensor", (x) => x.assetId === asset.id && isAnalyser(x))) {
    const c = certs.find((d) => d.sensorId === s.id);
    if (!c || (wo.planned && c.validTo < wo.planned)) open.push(item(`Open: no current calibration certificate for ${s.name}.`, [s.id, c && c.id]));
  }

  // 5. watch-outs: notes on this make and model's procedure steps, this asset first; a note the finding already says is dropped
  const sameProc = (n) => n.procedureId && (view.get(n.procedureId) || {}).template === asset.template;
  const notes = asset.template ? view.list("KnowledgeNote", (n) => sameProc(n) && sisters.has(n.assetId))
    .filter((n) => !(finding && n.assetId !== asset.id && n.assetId === finding.assetId && n.partId === finding.partId))
    .sort((a, b) => (a.assetId === asset.id ? 0 : 1) - (b.assetId === asset.id ? 0 : 1) || String(b.at).localeCompare(String(a.at))) : [];
  const watchOuts = notes.map((n) => item(`Step ${n.step}: ${lowerFirst(n.text.replace(/\.$/, ""))} (${n.id}).`, [n.id]));

  // 6. changed since the last job here (full brief only)
  const changed = !lastAt ? [] : [
    ...view.list("Spec", (x) => x.assetId === asset.id && String(x.confirmedAt) > lastAt).map((x) => item(`Spec: ${lowerFirst(x.measure)} is now v${x.version}, ${x.lo}–${x.hi} ${x.unit} (${String(x.confirmedAt).slice(0, 10)}).`, [x.id])),
    ...view.list("Issue", (i) => i.assetId === asset.id && String(i.at) > lastAt).map((i) => item(`New issue: ${i.title} (${String(i.at).slice(0, 10)}).`, [i.id])),
    ...view.list("KnowledgeNote", (n) => n.assetId === asset.id && String(n.at) > lastAt).map((n) => item(`New note on step ${n.step} (${String(n.at).slice(0, 10)}).`, [n.id]))
  ];

  const full = { target, corrections, lastTime, open, watchOuts, changed };
  const any = Object.values(full).some((s) => s.length);
  const lines = !any ? [] : [`${wo.id} ${wo.title}. Before you start:`, target[0] && target[0].text, ...cors.slice(0, 2).map((c) => c.line),
    lastTime[0] && lastTime[0].text, open[0] && open[0].text, watchOuts[0] && watchOuts[0].text, 'Reply "brief" for the full brief, "start step 1" to begin.'].filter(Boolean);
  return { lines, full, specVersions: specs.map((x) => ({ specId: x.id, version: x.version })), correctionIds: cors.slice(0, 3).map((c) => c.id) };
}

// What a step asks the person to measure, and the band it is held to: the spec pinned when the job started, else the
// Part's own band (jobs started before specs existed). view may be the ontology, a view or an agent's context.
export function readingNeed(view, ex, procStep) {
  const pin = (ex.specPins || []).find((p) => p.step === procStep.step);
  if (pin) return { partName: pin.partName, measure: pin.measure, unit: pin.unit, lo: pin.lo, hi: pin.hi, specId: pin.specId, specVersion: pin.version };
  const r = procStep.requires && procStep.requires.reading;
  if (!r) return null;
  const part = view.list("Part", (p) => p.assetId === ex.assetId && p.name === r.partName)[0];
  const b = part && part.band;
  return { partName: r.partName, measure: r.measure, unit: r.unit, lo: b ? b.lo : null, hi: b ? b.hi : null, specId: null, specVersion: null };
}
