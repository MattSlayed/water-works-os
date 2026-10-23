// Technician Copilot (PRD FR-AVZ-005..011): on-scene insight and guided troubleshooting at an asset or part.
// Deterministic answers from the ontology; when Claude is configured, the answer text is written by the model from the
// same insight, and the structured checks, citations and look-here stay deterministic.
import { assetInsight } from "./agents.mjs";
import { askClaude } from "./llm.mjs";
import { bandCheck } from "./functions.mjs";

const SYSTEM = `You are the Technician Copilot at a water treatment works. You talk to an artisan standing at the asset.
Answer in short, plain sentences. Use only the context provided; cite record ids in brackets, for example [FND-001].
Never tell the artisan to do an intrusive step unless the context shows an open permit and an applied isolation.`;

let n = 0;

export function createCopilot({ ont, tel, actions, runtime, llm = askClaude }) {
  const sessions = new Map();
  const listeners = [];
  const emit = (e) => listeners.forEach((fn) => fn(e));

  const ctxFor = (user) => {
    const v = ont.view(user);
    return {
      get: (id) => v.get(id),
      list: (t, p) => v.list(t, p),
      sensorsFor: (id) => tel.sensorsFor(id).filter((s) => v.get(s.id)),
      latest: (id) => (v.get(id) ? tel.latest(id) : null),
      history: (id, k) => (v.get(id) ? tel.history(id, k) : [])
    };
  };
  const agentActor = (user) => ({ kind: "agent", id: "Technician Copilot", clearance: user.clearance, onBehalfOf: user.id });
  const autonomy = (action) => (runtime && runtime.spec("Technician Copilot").autonomy[action]) || "propose";

  function open({ assetId, partId, workOrderId, step, user }) {
    if (!user || !user.id) throw new Error("user required");
    const ctx = ctxFor(user);
    if (partId) { const part = ctx.get(partId); if (!part || part.assetId !== assetId) throw new Error("part not found"); }
    const insight = assetInsight(ctx, assetId, partId);
    if (!insight) throw new Error("asset not found");
    if (runtime) runtime.run("Technician Copilot", { actingUser: user, scope: { assetId, partId }, chain: false, trigger: { kind: "copilot-open" } });
    const id = `COP-${String(++n).padStart(5, "0")}`;
    const s = { id, assetId, partId: partId || null, workOrderId: workOrderId || null, step: step || null, user, insight, transcript: [] };
    sessions.set(id, s);
    return { id, insight, ask: (q) => ask(id, q), tag: (a) => tag({ sessionId: id, ...a }) };
  }

  const partsByName = (insight, names) => ont.list("Part", (p) => p.assetId === insight.asset.id && names.includes(p.name)).map((p) => p.id);

  function nextChecks(s) {
    const ins = assetInsight(ctxFor(s.user), s.assetId, s.partId);
    s.insight = ins;
    const keywords = ins.findings.map((f) => (f.text.match(/soft foot|flush line|check-valve|alignment|belt/i) || [])[0]).filter(Boolean);
    const relevant = (st) => keywords.some((k) => st.text.toLowerCase().includes(k.toLowerCase().replace("check-valve", "check valve")));
    const steps = (s.partId ? ins.procedure : ins.allSteps).slice();
    steps.sort((a, b) => (a.intrusive - b.intrusive) || (relevant(b) - relevant(a)) || a.step - b.step);
    if (s.step) steps.sort((a, b) => (b.step === s.step) - (a.step === s.step));
    const safe = ins.permit && ins.isolated;
    const shown = steps.filter((st) => !st.intrusive || safe);
    const hidden = steps.length - shown.length;
    const checks = shown.map((st) => ({ step: st.step, text: st.text, intrusive: st.intrusive, hazard: st.hazard, stepId: st.id, parts: partsByName(ins, st.partNames) }));
    const withheld = hidden ? `${hidden} intrusive step(s) withheld: open a permit to work and record the isolation on ${ins.asset.positionTag} first.` : null;
    return { ins, checks, withheld };
  }

  async function ask(sessionId, question) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("session not found");
    const q = String(question || "");
    const ql = q.toLowerCase();
    let res;
    const num = q.match(/\d+\.\d+/);
    const part = s.partId ? ont.get(s.partId) : null;
    if (num && part && part.band) {
      const value = Number(num[0]);
      const { lo, hi, measure, unit } = part.band;
      actions.invoke({ action: "record_reading", params: { targetId: part.id, measure, value, unit, workOrderId: s.workOrderId }, actor: agentActor(s.user), autonomy: autonomy("record_reading") });
      const { inBand, side, by, finding } = bandCheck(part, value);
      if (!inBand) {
        const dev = actions.invoke({ action: "raise_deviation", params: { targetId: part.id, finding, disposition: "re-sleeve or replace; engineer to decide", assetId: part.assetId }, actor: agentActor(s.user), autonomy: autonomy("raise_deviation") });
        res = { answer: `${measure} ${value} ${unit} is ${by} ${unit} ${side} the limit (band ${lo}–${hi} ${unit}). Do not reuse it as it is. I have recorded the reading and proposed a deviation for the engineer${dev.proposal ? ` (${dev.proposal.id})` : ""}.`, citations: [{ id: part.id, label: `${part.name} band` }], lookHere: [part.id] };
      } else {
        res = { answer: `${measure} ${value} ${unit} is within the band ${lo}–${hi} ${unit}. I have recorded the reading.`, citations: [{ id: part.id, label: `${part.name} band` }], lookHere: [part.id] };
      }
    } else if (/before|history|happened|last time|previous/.test(ql)) {
      const ins = (s.insight = assetInsight(ctxFor(s.user), s.assetId, s.partId));
      const lines = [...ins.findings.map((f) => `${f.id} (${f.at}, ${f.authorRole}) on ${ont.get(f.assetId) ? ont.get(f.assetId).positionTag : f.assetId}: ${f.text}`), ...ins.notes.map((n) => `${n.id} (${n.at.slice(0, 10)}, field note${n.verified ? ", verified" : ""}): ${n.text}`), ...ins.history.map((w) => `${w.id} ${w.title} (${w.state}${w.closed ? `, closed ${w.closed}` : ""})`)];
      res = { answer: lines.length ? lines.join("\n") : "No earlier work or findings on record for this asset or its siblings.", citations: [...ins.findings.map((f) => ({ id: f.id, label: "Finding" })), ...ins.notes.map((n) => ({ id: n.id, label: "Field note" })), ...ins.history.map((w) => ({ id: w.id, label: "Work order" }))], lookHere: ins.findings.map((f) => f.partId).filter((p) => p && ont.get(p) && ont.get(p).assetId === s.assetId) };
    } else if (/stock|spare|part number|parts/.test(ql)) {
      const parts = ont.list("Part", (p) => p.assetId === s.assetId);
      res = { answer: parts.map((p) => `${p.name}: ${p.erpNo}, ${p.stock ?? 0} in stores${p.reserved ? `, ${p.reserved} reserved` : ""}`).join("\n"), citations: parts.map((p) => ({ id: p.id, label: p.name })), lookHere: [] };
    } else if (/safe|hazard|permit|isolat/.test(ql)) {
      const ins = s.insight;
      res = { answer: `Zone ${ins.zone ? ins.zone.name : "?"}, hazard: ${ins.hazards || "none recorded"}. Permit: ${ins.permit ? `${ins.permit.id} (${ins.permit.state})` : "none open"}. Isolation: ${ins.isolated ? "applied" : "not recorded"}.`, citations: ins.permit ? [{ id: ins.permit.id, label: "Permit" }] : [], lookHere: [] };
    } else {
      const { ins, checks, withheld } = nextChecks(s);
      const why = ins.alerts.map((a) => a.title).join("; ") || "no active alert";
      res = {
        answer: `Why we are here: ${why}. Next checks:${checks.length ? `\n${checks.map((c, i) => `${i + 1}. ${c.text}`).join("\n")}` : " none I can show yet."}${withheld ? `\n${withheld}` : ""}`,
        checks, withheld,
        citations: [...(ins.procedure[0] ? [{ id: ins.procedure[0].documentId, label: "SOP" }] : []), ...(ins.manual ? [{ id: ins.manual.id, label: "OEM manual" }] : []), ...ins.findings.map((f) => ({ id: f.id, label: "Similar finding" })), ...ins.alerts.map((a) => ({ id: a.id, label: "Alert" }))],
        lookHere: [...new Set(checks.flatMap((c) => c.parts))].slice(0, 6)
      };
    }
    res = { checks: undefined, withheld: null, ...res };
    const model = await llm({ system: SYSTEM, context: { asset: s.insight.asset, part: s.insight.part, alerts: s.insight.alerts, sensors: s.insight.sensors, findings: s.insight.findings, permit: s.insight.permit, isolated: s.insight.isolated, draftAnswer: res.answer, checks: res.checks }, question: q });
    if (model) res = { ...res, answer: model, model: true };
    s.transcript.push({ q, a: res.answer, at: new Date().toISOString() });
    return res;
  }

  function tag({ sessionId, partId, note, reading, photo, point }) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error("session not found");
    const pid = partId || s.partId, tagged = pid && ctxFor(s.user).get(pid);
    if (!tagged || tagged.assetId !== s.assetId) throw new Error("part not found");
    const r = actions.invoke({ action: "tag_part", params: { partId: partId || s.partId, note, reading, photo, point, workOrderId: s.workOrderId, authorId: s.user.id }, actor: { kind: "person", ...s.user } });
    if (r.status !== "done") throw new Error(r.reason);
    const f = ont.get(r.decision.objects[0]);
    emit({ kind: "tagged", sessionId, findingId: f.id, partId: f.partId, at: new Date().toISOString() });
    return f;
  }

  return { open, ask, tag, get: (id) => sessions.get(id) || null, on: (fn) => listeners.push(fn) };
}
