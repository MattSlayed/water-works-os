// Typed ontology actions, shared by people and agents (PRD §6.3, AD-02), and the action service that applies the
// autonomy dial (BR-04, BR-05, FR-AGT-004) and writes Decisions, Proposals and Feedback (FR-GOV-002).
import { rank } from "./ontology.mjs";

export const LEVELS = ["read", "draft", "notify", "propose", "act"];
const lv = (l) => LEVELS.indexOf(l);

let seq = 0;
const nextId = (p) => `${p}-${String(++seq).padStart(5, "0")}`;
const now = () => new Date().toISOString();

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

export const ACTIONS = {
  create_work_order: def("act", "act", ["assetId", "title"], (ont, p) => {
    const wo = create(ont, { id: nextId("WO-N"), type: "WorkOrder", assetId: p.assetId, title: p.title, kind: p.kind || "CM", priority: p.priority || "P3", state: "requested", requested: now(), source: p.source || null }, [["TARGETS", p.assetId]]);
    return { objects: [wo.id], revert: () => setProps(ont, wo.id, { state: "cancelled" }) };
  }),
  update_work_order: def("act", "propose", ["workOrderId", "patch"], (ont, p) => ({ objects: [p.workOrderId], revert: setProps(ont, p.workOrderId, p.patch) })),
  draft_document: def("draft", "act", ["kind", "title", "body"], (ont, p) => {
    const d = create(ont, { id: nextId("DRF"), type: "Draft", kind: p.kind, title: p.title, body: p.body, data: p.data || null, aboutId: p.aboutId || null, assetId: p.assetId || null, created: now(), state: "draft" }, [["ABOUT", p.aboutId]]);
    return { objects: [d.id], revert: () => setProps(ont, d.id, { state: "withdrawn" }) };
  }),
  reserve_parts: def("act", "act", ["partIds"], (ont, p) => {
    const reverts = [];
    for (const id of p.partIds) {
      const part = ont.get(id);
      if (!part) throw new Error(`part not found: ${id}`);
      if ((part.stock || 0) < 1) throw new Error(`no stock for ${id}`);
      reverts.push(setProps(ont, id, { stock: part.stock - 1, reserved: (part.reserved || 0) + 1 }));
    }
    const r = create(ont, { id: nextId("RSV"), type: "Reservation", partIds: p.partIds, workOrderId: p.workOrderId || null, assetId: ont.get(p.partIds[0]).assetId, at: now() }, [["FOR", p.workOrderId]]);
    return { objects: [r.id, ...p.partIds], revert: () => { reverts.forEach((f) => f()); setProps(ont, r.id, { state: "released" }); } };
  }),
  raise_purchase_requisition: def("act", "propose", ["itemId", "qty"], (ont, p) => {
    const pr = create(ont, { id: nextId("PR"), type: "PurchaseRequisition", itemId: p.itemId, qty: p.qty, reason: p.reason || null, state: "raised", at: now() });
    return { objects: [pr.id], revert: () => setProps(ont, pr.id, { state: "cancelled" }) };
  }),
  schedule_work: def("act", "propose", ["workOrderId", "assigneeId"], (ont, p) => {
    const revert = setProps(ont, p.workOrderId, { assigneeId: p.assigneeId, planned: p.window || null, state: "scheduled" });
    ont.link(p.workOrderId, "ASSIGNED_TO", p.assigneeId);
    return { objects: [p.workOrderId], revert };
  }),
  open_permit: def("act", "human", ["assetId", "kind", "holderId"], (ont, p) => {
    const a = ont.get(p.assetId);
    const pt = create(ont, { id: nextId("PTW"), type: "Permit", kind: p.kind, state: "open", assetId: p.assetId, zoneId: a && a.zoneId, holderId: p.holderId, opened: now(), isolations: [] }, [["COVERS", p.assetId]]);
    return { objects: [pt.id], revert: () => setProps(ont, pt.id, { state: "cancelled" }) };
  }, "supervisor"),
  close_permit: def("act", "human", ["permitId"], (ont, p) => ({ objects: [p.permitId], revert: setProps(ont, p.permitId, { state: "closed", closed: now() }) }), "supervisor"),
  record_isolation: def("act", "human", ["permitId", "point"], (ont, p) => {
    const pt = ont.get(p.permitId);
    if (!pt) throw new Error(`permit not found: ${p.permitId}`);
    const isolations = [...(pt.isolations || []), { point: p.point, state: "applied", appliedBy: p.by || null, verifiedBy: p.verifiedBy || null }];
    return { objects: [p.permitId], revert: setProps(ont, p.permitId, { isolations }) };
  }, "supervisor"),
  raise_alert: def("act", "act", ["targetId", "title"], (ont, p) => {
    const t = ont.get(p.targetId);
    const al = create(ont, { id: nextId("ALT"), type: "Alert", targetId: p.targetId, assetId: t && t.type === "Asset" ? t.id : t && t.assetId, zoneId: t && t.zoneId, title: p.title, severity: p.severity || "medium", evidence: p.evidence || [], score: p.score ?? null, state: "active", at: now() }, [["ON", p.targetId]]);
    return { objects: [al.id], revert: () => setProps(ont, al.id, { state: "withdrawn" }) };
  }),
  rank_alert: def("act", "act", ["alertId", "consequence"], (ont, p) => ({ objects: [p.alertId], revert: setProps(ont, p.alertId, { consequence: p.consequence, priority: p.priority || null, rankedAt: now() }) })),
  acknowledge_alert: def("act", "act", ["alertId"], (ont, p) => ({ objects: [p.alertId], revert: setProps(ont, p.alertId, { state: "acknowledged" }) })),
  notify: def("notify", "act", ["to", "message"], (ont, p) => {
    const n = create(ont, { id: nextId("NTF"), type: "Notification", to: p.to, message: p.message, aboutId: p.aboutId || null, at: now() });
    return { objects: [n.id] };
  }),
  record_reading: def("act", "act", ["targetId", "measure", "value"], (ont, p) => {
    const t = ont.get(p.targetId);
    const r = create(ont, { id: nextId("RDG"), type: "Reading", targetId: p.targetId, assetId: t && (t.assetId || t.id), measure: p.measure, value: p.value, unit: p.unit || null, workOrderId: p.workOrderId || null, at: now(), source: "field" }, [["OF", p.targetId]]);
    return { objects: [r.id] };
  }),
  tag_part: def("act", "act", ["partId", "note"], (ont, p) => {
    const part = ont.get(p.partId);
    if (!part) throw new Error(`part not found: ${p.partId}`);
    const f = create(ont, { id: nextId("FND"), type: "Finding", partId: p.partId, assetId: part.assetId, workOrderId: p.workOrderId || null, text: p.note, reading: p.reading ?? null, photo: p.photo || null, point: p.point || null, authorId: p.authorId || null, verified: false, at: now() }, [["ABOUT", p.partId], ["ON", p.workOrderId]]);
    return { objects: [f.id] };
  }),
  raise_deviation: def("act", "propose", ["targetId", "finding"], (ont, p) => {
    const t = ont.get(p.targetId);
    const dv = create(ont, { id: nextId("DEV"), type: "Deviation", targetId: p.targetId, assetId: t && (t.assetId || t.id), finding: p.finding, disposition: p.disposition || "engineer to decide", state: "raised", at: now() }, [["AGAINST", p.targetId]]);
    return { objects: [dv.id], revert: () => setProps(ont, dv.id, { state: "withdrawn" }) };
  }),
  change_asset_state: def("act", "propose", ["assetId", "state"], (ont, p) => ({ objects: [p.assetId], revert: setProps(ont, p.assetId, { state: p.state }) })),
  // A recorded request for the process controller. Nothing is written to a control system (BR-06).
  request_setpoint_change: def("act", "propose", ["targetId", "setpoint", "value"], (ont, p) => {
    const r = create(ont, { id: nextId("SPR"), type: "SetpointRequest", targetId: p.targetId, setpoint: p.setpoint, value: p.value, unit: p.unit || null, state: "requested", at: now() });
    return { objects: [r.id], revert: () => setProps(ont, r.id, { state: "withdrawn" }) };
  }),
  submit_compliance_pack: def("act", "human", ["framework"], (ont, p) => {
    const s = create(ont, { id: nextId("SUB"), type: "Submission", framework: p.framework, state: "submitted", at: now() });
    return { objects: [s.id] };
  }, "manager"),
  release_asset_model: def("act", "human", ["assetId", "revision"], (ont, p) => ({ objects: [p.assetId], revert: setProps(ont, p.assetId, { modelRevision: p.revision }) }), "engineer")
};

export function createActionService({ ont, audit }) {
  const reverts = new Map();
  const log = (entry) => audit && audit.append(entry);
  const refuse = (action, actor, reason) => {
    log({ actor: actor && actor.id, actorKind: actor && actor.kind, action, outcome: "refused", reason });
    return { status: "refused", reason };
  };

  function apply(action, params, actor, extra = {}) {
    const res = ACTIONS[action].apply(ont, params, { actor });
    const dec = ont.upsert({
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
    try {
      if (actor.kind === "person") return apply(action, params, actor);
      if (a.ceiling === "human") return refuse(action, actor, `${action} is human-only`);
      const eff = LEVELS[Math.min(lv(autonomy || "propose"), lv(a.ceiling))];
      if (lv(eff) >= lv(a.needs)) return apply(action, params, actor, { autonomy: eff, runId });
      if (lv(eff) >= lv("propose")) {
        const prp = ont.upsert({
          id: nextId("PRP"), type: "Proposal", action, params, actorId: actor.id, actorKind: actor.kind, runId: runId || null,
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
