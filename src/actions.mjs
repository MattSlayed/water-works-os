// Typed ontology actions, shared by people and agents (PRD §6.3, AD-02), and the action service that applies the
// autonomy dial (BR-04, BR-05, FR-AGT-004) and writes Decisions, Proposals and Feedback (FR-GOV-002).
import { rank } from "./ontology.mjs";

export const LEVELS = ["read", "draft", "notify", "propose", "act"];
const lv = (l) => LEVELS.indexOf(l);

let seq = 0;
const nextId = (p) => `${p}-${String(++seq).padStart(5, "0")}`;
const wallClock = () => new Date().toISOString();

// needs: the level an actor must hold to apply the action directly. ceiling: the most an agent may ever hold
// for it ("human" = never an agent). minClearance: the least clearance of the actor (or the person an agent acts for).
const def = (needs, ceiling, required, apply, minClearance = "technician") => ({ needs, ceiling, required, apply, minClearance });

const setProps = (ont, id, patch) => {
  const prev = ont.get(id);
  if (!prev) throw new Error(`not found: ${id}`);
  const old = Object.fromEntries(Object.keys(patch).map((k) => [k, prev[k]]));
  ont.upsert({ id, type: prev.type, ...patch });
  return () => ont.upsert({ id, type: prev.type, ...old });
};
const create = (ont, obj, linksTo = []) => {
  const o = ont.upsert(obj);
  for (const [rel, to] of linksTo) if (to && ont.get(to)) ont.link(o.id, rel, to);
  return o;
};

// Parameters that name an object: the type it must be. Every named object must also be visible to the actor.
const TARGET_TYPES = { procedureId: ["Procedure"], workOrderId: ["WorkOrder"], assetId: ["Asset"], partIds: ["Part"], partId: ["Part"], alertId: ["Alert"], permitId: ["Permit"], assigneeId: ["Person"], holderId: ["Person"], itemId: ["Part", "Chemical"], targetId: null };
const PATCHABLE = ["title", "priority", "state", "planned", "hours", "closed"];

export const ACTIONS = {
  create_work_order: def("act", "act", ["assetId", "title"], (ont, p, ctx) => {
    const wo = create(ont, { id: nextId("WO-N"), type: "WorkOrder", assetId: p.assetId, title: p.title, kind: p.kind || "CM", priority: p.priority || "P3", state: "requested", requested: ctx.now(), source: p.source || null }, [["TARGETS", p.assetId]]);
    return { objects: [wo.id], revert: () => setProps(ont, wo.id, { state: "cancelled" }) };
  }),
  update_work_order: def("act", "propose", ["workOrderId", "patch"], (ont, p, ctx) => {
    const keys = Object.keys(p.patch || {});
    if (!keys.length || keys.some((k) => !PATCHABLE.includes(k))) throw new Error(`patch may only change: ${PATCHABLE.join(", ")}`);
    if (keys.some((k) => p.patch[k] !== null && !["string", "number"].includes(typeof p.patch[k]))) throw new Error("patch values must be text or numbers");
    return { objects: [p.workOrderId], revert: setProps(ont, p.workOrderId, p.patch) };
  }),
  draft_document: def("draft", "act", ["kind", "title", "body"], (ont, p, ctx) => {
    const d = create(ont, { id: nextId("DRF"), type: "Draft", minClearance: ctx.actor.kind === "agent" ? ctx.actor.clearance : null, kind: p.kind, title: p.title, body: p.body, data: p.data || null, aboutId: p.aboutId || null, assetId: p.assetId || null, created: ctx.now(), state: "draft" }, [["ABOUT", p.aboutId]]);
    return { objects: [d.id], revert: () => setProps(ont, d.id, { state: "withdrawn" }) };
  }),
  reserve_parts: def("act", "act", ["partIds"], (ont, p, ctx) => {
    // check every part before changing any, so a refusal leaves stock untouched; reverts are relative
    for (const id of p.partIds) if ((ont.get(id).stock || 0) < 1) throw new Error(`no stock for ${id}`);
    for (const id of p.partIds) { const part = ont.get(id); ont.upsert({ id, type: "Part", stock: part.stock - 1, reserved: (part.reserved || 0) + 1 }); }
    const reverts = p.partIds.map((id) => () => { const part = ont.get(id); ont.upsert({ id, type: "Part", stock: (part.stock || 0) + 1, reserved: Math.max(0, (part.reserved || 0) - 1) }); });
    const r = create(ont, { id: nextId("RSV"), type: "Reservation", partIds: p.partIds, workOrderId: p.workOrderId || null, assetId: ont.get(p.partIds[0]).assetId, at: ctx.now() }, [["FOR", p.workOrderId]]);
    return { objects: [r.id, ...p.partIds], revert: () => { reverts.forEach((f) => f()); setProps(ont, r.id, { state: "released" }); } };
  }),
  raise_purchase_requisition: def("act", "propose", ["itemId", "qty"], (ont, p, ctx) => {
    const pr = create(ont, { id: nextId("PR"), type: "PurchaseRequisition", itemId: p.itemId, qty: p.qty, reason: p.reason || null, state: "raised", at: ctx.now() });
    return { objects: [pr.id], revert: () => setProps(ont, pr.id, { state: "cancelled" }) };
  }),
  schedule_work: def("act", "propose", ["workOrderId", "assigneeId"], (ont, p, ctx) => {
    const revert = setProps(ont, p.workOrderId, { assigneeId: p.assigneeId, planned: p.window || null, state: "scheduled" });
    ont.link(p.workOrderId, "ASSIGNED_TO", p.assigneeId);
    return { objects: [p.workOrderId], revert };
  }),
  open_permit: def("act", "human", ["assetId", "kind", "holderId"], (ont, p, ctx) => {
    const a = ont.get(p.assetId);
    const pt = create(ont, { id: nextId("PTW"), type: "Permit", kind: p.kind, state: "open", assetId: p.assetId, zoneId: a && a.zoneId, holderId: p.holderId, opened: ctx.now(), isolations: [] }, [["COVERS", p.assetId]]);
    return { objects: [pt.id], revert: () => setProps(ont, pt.id, { state: "cancelled" }) };
  }, "supervisor"),
  close_permit: def("act", "human", ["permitId"], (ont, p, ctx) => ({ objects: [p.permitId], revert: setProps(ont, p.permitId, { state: "closed", closed: ctx.now() }) }), "supervisor"),
  record_isolation: def("act", "human", ["permitId", "point"], (ont, p, ctx) => {
    const pt = ont.get(p.permitId);
    if (!pt) throw new Error(`permit not found: ${p.permitId}`);
    const isolations = [...(pt.isolations || []), { point: p.point, state: "applied", appliedBy: p.by || null, verifiedBy: p.verifiedBy || null }];
    return { objects: [p.permitId], revert: setProps(ont, p.permitId, { isolations }) };
  }, "supervisor"),
  raise_alert: def("act", "act", ["targetId", "title"], (ont, p, ctx) => {
    const t = ont.get(p.targetId);
    const al = create(ont, { id: nextId("ALT"), type: "Alert", targetId: p.targetId, assetId: t && t.type === "Asset" ? t.id : t && t.assetId, zoneId: t && t.zoneId, title: p.title, severity: p.severity || "medium", evidence: p.evidence || [], score: p.score ?? null, state: "active", at: ctx.now() }, [["ON", p.targetId]]);
    return { objects: [al.id], revert: () => setProps(ont, al.id, { state: "withdrawn" }) };
  }),
  rank_alert: def("act", "act", ["alertId", "consequence"], (ont, p, ctx) => ({ objects: [p.alertId], revert: setProps(ont, p.alertId, { consequence: p.consequence, priority: p.priority || null, rankedAt: ctx.now() }) })),
  acknowledge_alert: def("act", "act", ["alertId"], (ont, p, ctx) => ({ objects: [p.alertId], revert: setProps(ont, p.alertId, { state: "acknowledged" }) })),
  notify: def("notify", "act", ["to", "message"], (ont, p, ctx) => {
    const n = create(ont, { id: nextId("NTF"), type: "Notification", minClearance: ctx.actor.kind === "agent" ? ctx.actor.clearance : null, to: p.to, message: p.message, aboutId: p.aboutId || null, at: ctx.now() });
    return { objects: [n.id] };
  }),
  record_reading: def("act", "act", ["targetId", "measure", "value"], (ont, p, ctx) => {
    const t = ont.get(p.targetId);
    const r = create(ont, { id: nextId("RDG"), type: "Reading", targetId: p.targetId, assetId: t && (t.assetId || t.id), measure: p.measure, value: p.value, unit: p.unit || null, workOrderId: p.workOrderId || null, at: ctx.now(), source: "field" }, [["OF", p.targetId]]);
    return { objects: [r.id] };
  }),
  tag_part: def("act", "act", ["partId", "note"], (ont, p, ctx) => {
    const part = ont.get(p.partId);
    if (!part) throw new Error(`part not found: ${p.partId}`);
    const f = create(ont, { id: nextId("FND"), type: "Finding", partId: p.partId, assetId: part.assetId, workOrderId: p.workOrderId || null, text: p.note, reading: p.reading ?? null, photo: p.photo || null, point: p.point || null, authorId: p.authorId || null, verified: false, at: ctx.now() }, [["ABOUT", p.partId], ["ON", p.workOrderId]]);
    return { objects: [f.id] };
  }),
  raise_deviation: def("act", "propose", ["targetId", "finding"], (ont, p, ctx) => {
    const t = ont.get(p.targetId);
    const dv = create(ont, { id: nextId("DEV"), type: "Deviation", targetId: p.targetId, assetId: t && (t.assetId || t.id), finding: p.finding, disposition: p.disposition || "engineer to decide", state: "raised", at: ctx.now() }, [["AGAINST", p.targetId]]);
    return { objects: [dv.id], revert: () => setProps(ont, dv.id, { state: "withdrawn" }) };
  }),
  change_asset_state: def("act", "propose", ["assetId", "state"], (ont, p, ctx) => ({ objects: [p.assetId], revert: setProps(ont, p.assetId, { state: p.state }) })),
  // A recorded request for the process controller. Nothing is written to a control system (BR-06).
  request_setpoint_change: def("act", "propose", ["targetId", "setpoint", "value"], (ont, p, ctx) => {
    const r = create(ont, { id: nextId("SPR"), type: "SetpointRequest", targetId: p.targetId, setpoint: p.setpoint, value: p.value, unit: p.unit || null, state: "requested", at: ctx.now() });
    return { objects: [r.id], revert: () => setProps(ont, r.id, { state: "withdrawn" }) };
  }),
  submit_compliance_pack: def("act", "human", ["framework"], (ont, p, ctx) => {
    const s = create(ont, { id: nextId("SUB"), type: "Submission", framework: p.framework, state: "submitted", at: ctx.now() });
    return { objects: [s.id] };
  }, "manager"),
  // Living SOPs: an author with the c-author competence drafts the next version; the manager releases it.
  propose_procedure_version: def("act", "human", ["procedureId", "steps", "reason"], (ont, p, ctx) => {
    const today = ctx.now().slice(0, 10);
    if (!ont.list("Competency", (c) => c.personId === ctx.actor.id && c.competency === "c-author" && c.validTo >= today).length) throw new Error("needs the c-author competence");
    const cur = ont.get(p.procedureId);
    if (!Array.isArray(p.steps) || !p.steps.length || p.steps.some((s) => !s || typeof s.text !== "string" || !s.text.trim())) throw new Error("steps must be a non-empty list with text");
    const version = Math.max(...ont.list("Procedure", (x) => x.template === cur.template).map((x) => x.version)) + 1;
    const id = `PRC-${cur.template.toUpperCase()}-v${version}`;
    const steps = p.steps.map((s, i) => ({ ...(cur.steps[i] || {}), text: String(s.text), id: `${id}-S${String(i + 1).padStart(2, "0")}`, step: i + 1 }));
    const pr = create(ont, { id, type: "Procedure", template: cur.template, documentId: cur.documentId, title: cur.title, version, state: "draft", steps, basedOn: cur.id, proposedBy: ctx.actor.id, reason: p.reason, created: ctx.now() }, [["PART_OF", cur.documentId], ["REVISES", cur.id]]);
    return { objects: [pr.id], revert: () => setProps(ont, pr.id, { state: "withdrawn" }) };
  }, "engineer"),
  release_procedure: def("act", "human", ["procedureId"], (ont, p, ctx) => {
    const next = ont.get(p.procedureId);
    if (next.state !== "draft") throw new Error(`${next.id} is ${next.state}, not a draft`);
    const prev = ont.list("Procedure", (x) => x.template === next.template && x.state === "released")[0];
    const undo = [setProps(ont, next.id, { state: "released", releasedBy: ctx.actor.id, releasedAt: ctx.now() })];
    if (prev) undo.push(setProps(ont, prev.id, { state: "superseded" }));
    if (ont.get(next.documentId)) undo.push(setProps(ont, next.documentId, { sourceBehind: true }));
    return { objects: [next.id, ...(prev ? [prev.id] : [])], revert: () => undo.forEach((f) => f()) };
  }, "manager"),
  release_asset_model: def("act", "human", ["assetId", "revision"], (ont, p, ctx) => ({ objects: [p.assetId], revert: setProps(ont, p.assetId, { modelRevision: p.revision }) }), "engineer")
};

export function createActionService({ ont, audit, clock = wallClock }) {
  const now = clock;
  const reverts = new Map();
  const log = (entry) => audit && audit.append(entry);
  const refuse = (action, actor, reason) => {
    log({ actor: actor && actor.id, actorKind: actor && actor.kind, action, outcome: "refused", reason });
    return { status: "refused", reason };
  };

  // Every object a parameter names must exist, be of the right type, and be visible to the actor.
  function validate(action, params, actor) {
    const view = ont.view({ id: actor.onBehalfOf || actor.id, clearance: actor.clearance });
    for (const [key, types] of Object.entries(TARGET_TYPES)) {
      if (params[key] === undefined || params[key] === null) continue;
      if (key === "partIds" && (!Array.isArray(params[key]) || !params[key].length)) return `${key} must be a non-empty list`;
      for (const id of [].concat(params[key])) {
        const o = typeof id === "string" ? view.get(id) : null;
        if (!o) return `${key} ${id} not found`;
        if (types && !types.includes(o.type)) return `${key} ${id} is a ${o.type}, not a ${types.join(" or ")}`;
      }
    }
    return null;
  }
  // The strictest zone among the objects a decision or proposal is about, so it is pruned like its targets.
  function zoneFor(params) {
    let best = null;
    for (const id of Object.keys(TARGET_TYPES).flatMap((k) => (params[k] == null ? [] : [].concat(params[k])))) {
      const z = typeof id === "string" ? ont.zoneOf(id) : null;
      if (z && ont.get(z) && (!best || rank(ont.get(z).clearance) > rank(ont.get(best).clearance))) best = z;
    }
    return best;
  }

  function apply(action, params, actor, extra = {}) {
    const res = ACTIONS[action].apply(ont, params, { actor, now });
    const dec = ont.upsert({ zoneId: zoneFor(params),
      id: nextId("DEC"), type: "Decision", action, params, actorId: actor.id, actorKind: actor.kind, autonomy: extra.autonomy || null,
      approvedBy: extra.approvedBy || null, proposalId: extra.proposalId || null, runId: extra.runId || null,
      assetId: params.assetId || null, objects: res.objects, reversible: !!res.revert, reversed: false, at: now()
    });
    if (res.revert) reverts.set(dec.id, res.revert);
    for (const id of res.objects) if (ont.get(id)) ont.link(dec.id, "PRODUCED", id);
    log({ actor: actor.id, actorKind: actor.kind, action, outcome: "done", ref: dec.id, objects: res.objects, approvedBy: extra.approvedBy || null });
    return { status: "done", decision: dec };
  }

  function invoke({ action, params = {}, actor, autonomy, runId, evidence, risk }) {
    const a = ACTIONS[action];
    if (!a) return refuse(action, actor, `unknown action ${action}`);
    if (!actor || !actor.id) return refuse(action, actor, "no actor");
    const missing = a.required.filter((k) => params[k] === undefined || params[k] === null || params[k] === "");
    if (missing.length) return refuse(action, actor, `missing params: ${missing.join(", ")}`);
    if (rank(actor.clearance) < rank(a.minClearance)) return refuse(action, actor, `${action} needs ${a.minClearance} clearance`);
    if (actor.kind !== "person" && a.ceiling === "human") return refuse(action, actor, `${action} is human-only`);
    const bad = validate(action, params, actor);
    if (bad) return refuse(action, actor, bad);
    try {
      if (actor.kind === "person") return apply(action, params, actor);
      if (a.ceiling === "human") return refuse(action, actor, `${action} is human-only`);
      const eff = LEVELS[Math.min(lv(autonomy || "propose"), lv(a.ceiling))];
      if (lv(eff) >= lv(a.needs)) return apply(action, params, actor, { autonomy: eff, runId });
      if (lv(eff) >= lv("propose")) {
        const prp = ont.upsert({
          zoneId: zoneFor(params), id: nextId("PRP"), type: "Proposal", action, params, actorId: actor.id, actorKind: actor.kind, runId: runId || null,
          assetId: params.assetId || (params.partIds && ont.get(params.partIds[0]) && ont.get(params.partIds[0]).assetId) || null,
          evidence: evidence || [], risk: risk || null, state: "open", created: now()
        });
        log({ actor: actor.id, actorKind: actor.kind, action, outcome: "proposed", ref: prp.id });
        return { status: "proposed", proposal: prp };
      }
      return refuse(action, actor, `autonomy ${eff} is below what ${action} needs`);
    } catch (e) {
      return refuse(action, actor, e.message);
    }
  }

  function resolve(proposalId, { verdict, params, reason, by }) {
    const p = ont.get(proposalId);
    if (!p || p.type !== "Proposal") return refuse("resolve", by, "proposal not found");
    if (p.state !== "open") return refuse("resolve", by, `proposal already ${p.state}`);
    if (!by || by.kind !== "person") return refuse("resolve", by, "only a person resolves a proposal");
    if (!["approve", "edit", "reject"].includes(verdict)) return refuse("resolve", by, "verdict must be approve, edit or reject");
    if (verdict !== "approve" && !reason) return refuse("resolve", by, "a reason is required to edit or reject");
    if (rank(by.clearance) < rank(ACTIONS[p.action].minClearance)) return refuse("resolve", by, "insufficient clearance");
    const fb = (v) => {
      const f = ont.upsert({ id: nextId("FBK"), type: "Feedback", targetId: proposalId, runId: p.runId, verdict: v, comment: reason || null, authorId: by.id, at: now() });
      ont.link(f.id, "ON", proposalId);
    };
    if (verdict === "reject") {
      ont.upsert({ id: proposalId, type: "Proposal", state: "rejected", resolvedBy: by.id, resolvedAt: now() });
      fb("reject");
      log({ actor: by.id, actorKind: "person", action: "resolve", outcome: "rejected", ref: proposalId, reason });
      return { status: "rejected" };
    }
    const finalParams = verdict === "edit" ? { ...p.params, ...params } : p.params;
    const bad = validate(p.action, finalParams, by);
    if (bad) return refuse("resolve", by, bad);
    let res;
    try {
      res = apply(p.action, finalParams, { kind: p.actorKind, id: p.actorId }, { approvedBy: by.id, proposalId, runId: p.runId });
    } catch (e) {
      return refuse("resolve", by, e.message);
    }
    ont.upsert({ id: proposalId, type: "Proposal", state: verdict === "edit" ? "edited" : "approved", resolvedBy: by.id, resolvedAt: now() });
    ont.link(proposalId, "RESOLVED_BY", res.decision.id);
    if (reason || verdict === "edit") fb(verdict);
    return res;
  }

  function reverse(decisionId, by) {
    const d = ont.get(decisionId);
    if (!d || d.type !== "Decision") return refuse("reverse", by, "decision not found");
    if (d.reversed) return refuse("reverse", by, "already reversed");
    if (!by || by.kind !== "person" || !ont.view(by).get(decisionId)) return refuse("reverse", by, "decision not found");
    if (rank(by.clearance) < rank(ACTIONS[d.action].minClearance)) return refuse("reverse", by, `reversing ${d.action} needs ${ACTIONS[d.action].minClearance} clearance`);
    const f = reverts.get(decisionId);
    if (!f) return refuse("reverse", by, "not reversible");
    f();
    reverts.delete(decisionId);
    ont.upsert({ id: decisionId, type: "Decision", reversed: true, reversedBy: by && by.id, reversedAt: now() });
    log({ actor: by && by.id, actorKind: by && by.kind, action: "reverse", outcome: "done", ref: decisionId });
    return { status: "done" };
  }

  return {
    invoke, resolve, reverse,
    proposals: (state) => ont.list("Proposal", (p) => !state || p.state === state),
    decisions: () => ont.list("Decision")
  };
}
