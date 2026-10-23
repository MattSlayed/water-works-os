// Typed ontology actions, shared by people and agents (PRD §6.3, AD-02), and the action service that applies the
// autonomy dial (BR-04, BR-05, FR-AGT-004) and writes Decisions, Proposals and Feedback (FR-GOV-002).
import { rank } from "./ontology.mjs";
import { currentProcedure, stepLock, bandCheck, partNamesIn, stepRequires } from "./functions.mjs";
import { packageHash, currentPlantModel, writePlant } from "./plant.mjs";

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
const TARGET_TYPES = { modelId: ["PlantModel"], channelId: ["Channel"], messageId: ["Message"], documentId: ["Draft"], onBehalfOf: ["Person", "Project"], procedureId: ["Procedure"], executionId: ["Execution"], issueId: ["Issue"], noteId: ["KnowledgeNote"], personId: ["Person"], projectId: ["Project"], workOrderId: ["WorkOrder"], assetId: ["Asset"], partIds: ["Part"], partId: ["Part"], alertId: ["Alert"], permitId: ["Permit"], assigneeId: ["Person"], holderId: ["Person"], itemId: ["Part", "Chemical"], targetId: null };
const PATCHABLE = ["title", "priority", "state", "planned", "hours", "closed"];
const ISSUE_STATES = ["open", "triaged", "in_work", "done", "dropped"];
// The person an action is done by or for: an agent acts for the person who launched it.
const actorId = (ctx) => ctx.actor.onBehalfOf || ctx.actor.id;
const atLeast = (ctx, c) => rank(ctx.actor.clearance) >= rank(c);
const isolatedPermit = (ont, assetId) => {
  const permit = ont.list("Permit", (x) => x.assetId === assetId && x.state === "open")[0] || null;
  return { permit, isolated: !!(permit && (permit.isolations || []).some((i) => i.state === "applied")) };
};

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
    const d = create(ont, { id: nextId("DRF"), type: "Draft", minClearance: ctx.actor.kind === "agent" ? ctx.actor.clearance : null, audience: Array.isArray(p.audience) ? p.audience.map(String) : null, kind: p.kind, title: p.title, body: p.body, data: p.data || null, aboutId: p.aboutId || null, assetId: p.assetId || null, created: ctx.now(), state: "draft" }, [["ABOUT", p.aboutId]]);
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
    const to = [].concat(p.to).map(String);
    const n = create(ont, { id: nextId("NTF"), type: "Notification", audience: to.length ? to : null, minClearance: !to.length && ctx.actor.kind === "agent" ? ctx.actor.clearance : null, to, message: p.message, aboutId: p.aboutId || null, at: ctx.now() });
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
    const assets = new Set(ont.list("Asset", (a) => a.template === cur.template).map((a) => a.id));
    const bands = new Map(ont.list("Part", (x) => assets.has(x.assetId)).map((x) => [x.name, x.band]));
    const bandOf = (n) => bands.get(n) || null;
    const steps = p.steps.map((s, i) => {
      const text = String(s.text).trim();
      const same = cur.steps.find((x) => x.text === text);
      // shortcut: a new or reworded step is treated as intrusive (locked until permit and isolation); let authors set it when they ask
      const partNames = same ? same.partNames : partNamesIn(text, [...bands.keys()]);
      const base = same || { intrusive: true, hazard: null, expectedMinutes: 25 };
      return { ...base, text, partNames, documentId: cur.documentId, requires: stepRequires(text, base.intrusive, partNames, bandOf), id: `${id}-S${String(i + 1).padStart(2, "0")}`, step: i + 1 };
    });
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
  // Digitised work: a job follows the procedure version released when it starts.
  start_execution: def("act", "act", ["workOrderId", "personId"], (ont, p, ctx) => {
    if (actorId(ctx) !== p.personId && !atLeast(ctx, "supervisor")) throw new Error("only the person or a supervisor starts their job");
    const wo = ont.get(p.workOrderId), asset = ont.get(wo.assetId);
    if (["closed", "cancelled"].includes(wo.state)) throw new Error(`${wo.id} is ${wo.state}`);
    if (wo.assigneeId && wo.assigneeId !== p.personId && !atLeast(ctx, "supervisor")) throw new Error(`${wo.id} is assigned to ${wo.assigneeId}`);
    if (ont.list("Execution", (e) => e.workOrderId === wo.id && e.state === "running").length) throw new Error(`${wo.id} already has a running job`);
    const proc = currentProcedure(ont.list("Procedure"), asset && asset.template);
    if (!proc) throw new Error(`no released procedure for ${wo.id}`);
    // performance data: the person, their own supervisor and engineers (the manager sees everything)
    const audience = [...new Set([p.personId, ont.get(p.personId).supervisorId, ...ont.list("Person", (x) => x.clearance === "engineer").map((x) => x.id)].filter(Boolean))];
    const ex = create(ont, { id: nextId("EXE"), type: "Execution", workOrderId: wo.id, assetId: wo.assetId, personId: p.personId, procedureId: proc.id, procedureVersion: proc.version, startedAt: ctx.now(), finishedAt: null, state: "running", audience,
      steps: proc.steps.map((s) => ({ step: s.step, state: "todo", at: null, minutes: null, value: null, readingId: null, note: null })) }, [["FOR", wo.id], ["FOLLOWS", proc.id], ["BY", p.personId]]);
    const undoWo = setProps(ont, wo.id, { state: "in_progress" });
    return { objects: [ex.id, wo.id], revert: () => { setProps(ont, ex.id, { state: "cancelled" }); undoWo(); } };
  }),
  complete_step: def("act", "act", ["executionId", "step"], (ont, p, ctx) => {
    const ex = ont.get(p.executionId);
    if (actorId(ctx) !== ex.personId && !atLeast(ctx, "supervisor")) throw new Error("only the person on the job or a supervisor completes its steps");
    if (ex.state !== "running") throw new Error(`${ex.id} is ${ex.state}`);
    const next = ex.steps.find((s) => s.state === "todo");
    if (Number(p.step) !== next.step) throw new Error(`the next step is ${next.step}`);
    const spec = ont.get(ex.procedureId).steps.find((s) => s.step === next.step);
    const lock = stepLock(spec, isolatedPermit(ont, ex.assetId));
    if (lock.locked) throw new Error(lock.reason);
    const need = spec.requires && spec.requires.reading;
    const value = p.value === undefined || p.value === null || p.value === "" ? null : Number(p.value);
    if (value !== null && !Number.isFinite(value)) throw new Error("the reading must be a number");
    if (need && value === null) throw new Error(`Step ${next.step} needs a reading: ${need.measure} in ${need.unit}`);
    let readingId = null, inBand = null;
    if (need) {
      const part = ont.list("Part", (x) => x.assetId === ex.assetId && x.name === need.partName)[0];
      if (part.band) inBand = bandCheck(part, value).inBand;
      readingId = create(ont, { id: nextId("RDG"), type: "Reading", targetId: part.id, assetId: ex.assetId, measure: need.measure, value, unit: need.unit, workOrderId: ex.workOrderId, executionId: ex.id, at: ctx.now(), source: "field" }, [["OF", part.id]]).id;
    }
    const prevAt = [...ex.steps].reverse().find((s) => s.at)?.at || ex.startedAt;
    const minutes = Math.round((Date.parse(ctx.now()) - Date.parse(prevAt)) / 60000);
    const steps = ex.steps.map((s) => (s.step === next.step ? { ...s, state: "done", at: ctx.now(), minutes, value, inBand, readingId, note: p.note ? String(p.note) : null } : s));
    const last = steps.every((s) => s.state === "done");
    ont.upsert({ id: ex.id, type: "Execution", steps, ...(last ? { state: "done", finishedAt: ctx.now() } : {}) });
    const undoWo = last ? setProps(ont, ex.workOrderId, { state: "closed", closed: ctx.now().slice(0, 10) }) : null;
    const revert = () => {
      const now = ont.get(ex.id), doneSteps = now.steps.filter((s) => s.state === "done");
      if (doneSteps[doneSteps.length - 1].step !== next.step) throw new Error(`reverse the later steps of ${ex.id} first`);
      ont.upsert({ id: ex.id, type: "Execution", state: "running", finishedAt: null, steps: now.steps.map((s) => (s.step === next.step ? { ...s, state: "todo", at: null, minutes: null, value: null, inBand: null, readingId: null, note: null } : s)) });
      if (readingId) setProps(ont, readingId, { state: "withdrawn" });
      if (undoWo) undoWo();
    };
    return { objects: [ex.id, ...(readingId ? [readingId] : []), ...(last ? [ex.workOrderId] : [])], revert };
  }),
  raise_issue: def("act", "act", ["title"], (ont, p, ctx) => {
    const assetId = p.assetId || (p.partId && ont.get(p.partId).assetId) || null;
    const iss = create(ont, { id: nextId("ISS"), type: "Issue", title: String(p.title), state: "open", raisedBy: actorId(ctx), assetId, partId: p.partId || null, workOrderId: p.workOrderId || null, projectId: p.projectId || null, procedureId: p.procedureId || null, step: p.step ?? null, evidence: Array.isArray(p.evidence) ? p.evidence.map(String) : [], assigneeId: null, at: ctx.now() }, [["ON", assetId], ["ABOUT", p.partId], ["FOR", p.workOrderId], ["IN", p.projectId]]);
    return { objects: [iss.id], revert: () => setProps(ont, iss.id, { state: "dropped" }) };
  }),
  update_issue: def("act", "act", ["issueId", "patch"], (ont, p, ctx) => {
    const iss = ont.get(p.issueId);
    const patch = p.patch || {};
    const keys = Object.keys(patch);
    if (!keys.length || keys.some((k) => !["state", "assigneeId", "title"].includes(k))) throw new Error("patch may only change: state, assigneeId, title");
    if (patch.state !== undefined && !ISSUE_STATES.includes(patch.state)) throw new Error(`state must be one of ${ISSUE_STATES.join(", ")}`);
    if (patch.assigneeId != null && (ont.get(patch.assigneeId) || {}).type !== "Person") throw new Error("assigneeId must be a person");
    if (patch.title !== undefined && (typeof patch.title !== "string" || !patch.title.trim())) throw new Error("title must be text");
    if (iss.raisedBy !== actorId(ctx) && !atLeast(ctx, "supervisor")) throw new Error("only the raiser or a supervisor moves an issue");
    return { objects: [iss.id], revert: setProps(ont, iss.id, { ...patch, updatedAt: ctx.now() }) };
  }),
  add_knowledge_note: def("act", "act", ["text"], (ont, p, ctx) => {
    const part = p.partId ? ont.get(p.partId) : null;
    const kn = create(ont, { id: nextId("KN"), type: "KnowledgeNote", text: String(p.text), authorId: actorId(ctx), partId: p.partId || null, assetId: p.assetId || (part && part.assetId) || null, procedureId: p.procedureId || null, step: p.step ?? null, executionId: p.executionId || null, messageId: p.messageId || null, verified: false, at: ctx.now() }, [["ABOUT", p.partId || p.assetId], ["ON", p.procedureId]]);
    return { objects: [kn.id], revert: () => setProps(ont, kn.id, { state: "withdrawn" }) };
  }),
  verify_knowledge_note: def("act", "human", ["noteId"], (ont, p, ctx) => {
    const n = ont.get(p.noteId);
    if (n.verified) throw new Error(`${n.id} is already verified`);
    const author = ont.get(n.authorId);
    const f = create(ont, { id: nextId("FND"), type: "Finding", partId: n.partId, assetId: n.assetId, text: n.text, authorId: n.authorId, authorRole: author ? author.role : null, verified: true, verifiedBy: ctx.actor.id, fromNoteId: n.id, at: ctx.now().slice(0, 10) }, [["ABOUT", n.partId || n.assetId]]);
    const undo = setProps(ont, n.id, { verified: true, verifiedBy: ctx.actor.id, promotedTo: f.id });
    return { objects: [n.id, f.id], revert: () => { undo(); setProps(ont, f.id, { verified: false }); } };
  }, "engineer"),
  // Projects: what a chat says is a claim until a supervisor confirms the milestone.
  record_progress_claim: def("act", "act", ["projectId", "messageId", "text"], (ont, p, ctx) => {
    const prj = ont.get(p.projectId);
    if (p.milestoneId != null && !prj.milestones.some((m) => m.id === p.milestoneId)) throw new Error(`no milestone ${p.milestoneId} on ${prj.id}`);
    const c = create(ont, { id: nextId("PCL"), type: "ProgressClaim", projectId: prj.id, milestoneId: p.milestoneId || null, messageId: p.messageId, by: actorId(ctx), at: ctx.now(), text: String(p.text), evidence: Array.isArray(p.evidence) ? p.evidence.map(String) : [], confirmed: false }, [["CLAIMS", prj.id], ["FROM", p.messageId]]);
    if (p.milestoneId && !prj.milestones.find((m) => m.id === p.milestoneId).claimedAt) ont.upsert({ id: prj.id, type: "Project", milestones: prj.milestones.map((m) => (m.id === p.milestoneId ? { ...m, claimedAt: ctx.now() } : m)) });
    // relative revert: withdraw this claim; the milestone's claimedAt becomes the earliest claim left
    const revert = () => {
      setProps(ont, c.id, { state: "withdrawn" });
      if (!p.milestoneId) return;
      const left = ont.list("ProgressClaim", (x) => x.projectId === prj.id && x.milestoneId === p.milestoneId && x.state !== "withdrawn").map((x) => x.at).sort();
      ont.upsert({ id: prj.id, type: "Project", milestones: ont.get(prj.id).milestones.map((m) => (m.id === p.milestoneId ? { ...m, claimedAt: left[0] || null } : m)) });
    };
    return { objects: [c.id, prj.id], revert };
  }),
  confirm_milestone: def("act", "human", ["projectId", "milestoneId"], (ont, p, ctx) => {
    const prj = ont.get(p.projectId);
    const m = prj.milestones.find((x) => x.id === p.milestoneId);
    if (!m) throw new Error(`no milestone ${p.milestoneId} on ${prj.id}`);
    if (m.confirmedAt) throw new Error(`${m.id} is already confirmed`);
    const setMs = (fields) => ont.upsert({ id: prj.id, type: "Project", milestones: ont.get(prj.id).milestones.map((x) => (x.id === m.id ? { ...x, ...fields } : x)) });
    setMs({ confirmedAt: ctx.now(), confirmedBy: ctx.actor.id });
    const claims = ont.list("ProgressClaim", (x) => x.projectId === prj.id && x.milestoneId === m.id && !x.confirmed).map((x) => x.id);
    for (const id of claims) ont.upsert({ id, type: "ProgressClaim", confirmed: true });
    return { objects: [prj.id], revert: () => { setMs({ confirmedAt: null, confirmedBy: null }); for (const id of claims) ont.upsert({ id, type: "ProgressClaim", confirmed: false }); } };
  }, "supervisor"),
  // The works number's outbound side. One reply per inbound message; only Project Watch posts to a group.
  send_message: def("notify", "act", ["channelId", "text"], (ont, p, ctx) => {
    const ch = ont.get(p.channelId);
    if (ch.groupName && ctx.actor.kind === "agent" && ctx.actor.id !== "Project Watch") throw new Error("only Project Watch posts to a group");
    if (p.inReplyTo && ont.list("Message", (m) => m.channelId === ch.id && m.direction === "out" && m.inReplyTo === p.inReplyTo).length) throw new Error(`one reply per message: ${p.inReplyTo} already has one`);
    const m = create(ont, { id: nextId("MSG"), type: "Message", channelId: ch.id, direction: "out", from: "WORKS", sentBy: ctx.actor.id, at: ctx.now(), text: String(p.text), media: [], awaiting: p.awaiting || null, inReplyTo: p.inReplyTo || null, audience: ch.audience || null }, [["IN", ch.id]]);
    return { objects: [m.id] };
  }),
  // Paperwork: an agent submits on someone's behalf only when that person (or the project) has consented.
  submit_document: def("act", "act", ["documentId", "onBehalfOf"], (ont, p, ctx) => {
    const d = ont.get(p.documentId), who = ont.get(p.onBehalfOf);
    if (d.state !== "draft") throw new Error(`${d.id} is ${d.state}`);
    if (ctx.actor.kind === "agent" && !who.autoSubmit) throw new Error(`no consent to submit on their behalf: ${who.id} has not turned on agent submission`);
    const owner = d.data && d.data.onBehalfOf;
    if (owner && owner !== who.id) throw new Error(`${d.id} belongs to ${owner}`);
    if (ctx.actor.kind !== "agent" && actorId(ctx) !== who.id && who.ownerId !== actorId(ctx)) throw new Error("a person submits their own paperwork");
    return { objects: [d.id], revert: setProps(ont, d.id, { state: "submitted", submittedBy: ctx.actor.id, submittedFor: who.id, submittedAt: ctx.now() }) };
  }),
  release_asset_model: def("act", "human", ["assetId", "revision"], (ont, p, ctx) => ({ objects: [p.assetId], revert: setProps(ont, p.assetId, { modelRevision: p.revision }) }), "engineer"),
  // Drawing review (design §4.3 step 4): bulk-accept one sheet's EXTRACTED cells, or mark cells by key, optionally correcting the value.
  review_cells: def("act", "human", ["modelId"], (ont, p, ctx) => {
    const m = ont.get(p.modelId);
    if (!["draft", "in_review"].includes(m.status)) throw new Error(`${m.id} is ${m.status}, not a draft`);
    let hit;
    if (p.accept !== undefined) {
      if (p.accept !== "EXTRACTED" || !p.sheet) throw new Error('bulk accept takes accept: "EXTRACTED" and a sheet');
      hit = new Map(m.cells.filter((c) => c.grade === "EXTRACTED" && c.sheet === p.sheet).map((c) => [c.key, {}]));
    } else {
      if (!Array.isArray(p.marks) || !p.marks.length || p.marks.some((k) => !k || typeof k.key !== "string")) throw new Error("marks must be a non-empty list of {key, value?}");
      const unknown = p.marks.find((k) => !m.cells.some((c) => c.key === k.key));
      if (unknown) throw new Error(`no cell ${unknown.key} in ${m.id}`);
      hit = new Map(p.marks.map((k) => [k.key, k]));
    }
    const mark = { by: actorId(ctx), at: ctx.now() }, fix = (c) => "value" in hit.get(c.key);
    const cells = m.cells.map((c) => (!hit.has(c.key) ? c : { ...c, ...(fix(c) ? { value: hit.get(c.key).value, reasoning: `${c.reasoning} — corrected by ${mark.by} from ${JSON.stringify(c.value)}` } : {}), reviewed: mark }));
    const items = m.items.map((it) => { const fixed = cells.filter((c) => c.key.startsWith(`${it.tag}|`) && hit.has(c.key) && fix(c)); return fixed.length ? { ...it, fields: { ...it.fields, ...Object.fromEntries(fixed.map((c) => [c.field, c.value])) } } : it; });
    const reviews = [...m.reviews, { ...mark, cells: hit.size }];
    ont.upsert({ id: m.id, type: "PlantModel", cells, items, reviews, status: "in_review", packageHash: packageHash({ ...m, cells, items }) });
    return { objects: [m.id], revert: () => ont.upsert({ id: m.id, type: "PlantModel", cells: m.cells, items: m.items, reviews: m.reviews, status: m.status, packageHash: m.packageHash }) };
  }, "engineer"),
  // Four-eyes release of a plant model (design §4.3 step 5). Writes revision-scoped objects; never rewrites existing records.
  release_plant_model: def("act", "human", ["modelId", "hash"], (ont, p, ctx) => {
    const m = ont.get(p.modelId), by = actorId(ctx), at = ctx.now();
    if (!["draft", "in_review"].includes(m.status)) throw new Error(`${m.id} is ${m.status}, not a draft`);
    const last = m.reviews[m.reviews.length - 1];
    if (!last) throw new Error(`${m.id} has no review; someone other than the releaser must review it first`);
    if (last.by === by) throw new Error(`${by} is the last reviewer; release needs a second person (four eyes)`);
    const open = m.cells.filter((c) => c.grade !== "EXTRACTED" && !c.reviewed);
    if (open.length) throw new Error(`${open.length} INFERRED or AMBIGUOUS cells unreviewed: ${open.slice(0, 3).map((c) => c.key).join(", ")}`);
    if (p.hash !== packageHash(m)) throw new Error("stale hash: the model changed since the releaser read it");
    if (!ont.list("Competency", (c) => c.personId === by && c.competency === "c-model" && c.validTo >= at.slice(0, 10)).length) throw new Error("needs the c-model competence");
    const prev = currentPlantModel(ont);
    if (prev) ont.upsert({ id: prev.id, type: "PlantModel", status: "superseded", governs: { ...prev.governs, to: at } });
    ont.upsert({ id: m.id, type: "PlantModel", status: "released", governs: { from: at, to: null }, release: { by, at, hash: p.hash } });
    writePlant(ont, ont.get(m.id));
    // An accepted disagreement with an existing record goes to that record's owner as an Issue (spec §4.3 step 3), once.
    const issues = [];
    for (const c of m.cells.filter((x) => x.grade === "AMBIGUOUS" && x.reviewed)) {
      const cites = [...new Set(c.reasoning.match(/\b[A-Z]{2,4}-[\w-]+/g) || [])].map((id) => ont.get(id)).filter((o) => o && !o.modelId && !["Drawing", "PlantModel"].includes(o.type));
      const title = `Drawing disagrees with record: ${c.key}`;
      if (!cites.length || ont.list("Issue", (i) => i.title === title).length) continue;
      const rec = cites[0];
      const iss = create(ont, { id: nextId("ISS"), type: "Issue", title, state: "open", raisedBy: by, assetId: rec.assetId || null, partId: null, workOrderId: null, projectId: null, procedureId: null, step: null, recordIds: cites.map((o) => o.id), evidence: [m.id, c.key, c.reasoning], assigneeId: rec.ownerId || null, at }, [["ON", rec.assetId], ["ABOUT", rec.id]]);
      issues.push(iss.id);
    }
    return { objects: [m.id, ...issues] };
  }, "engineer")
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

  // A decision or proposal about an audience-limited object (a private chat, a person's job) is limited the same way.
  function audienceFor(params) {
    if (Array.isArray(params.audience) && params.audience.length) return params.audience.map(String);
    for (const id of Object.keys(TARGET_TYPES).flatMap((k) => (params[k] == null ? [] : [].concat(params[k])))) {
      const o = typeof id === "string" ? ont.get(id) : null;
      if (o && o.audience) return o.audience;
    }
    return null;
  }

  function apply(action, params, actor, extra = {}) {
    const res = ACTIONS[action].apply(ont, params, { actor, now });
    const dec = ont.upsert({ zoneId: zoneFor(params), audience: audienceFor(params),
      id: nextId("DEC"), type: "Decision", action, params, actorId: actor.id, actorKind: actor.kind, onBehalfOf: actor.onBehalfOf || null, autonomy: extra.autonomy || null,
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
          zoneId: zoneFor(params), audience: audienceFor(params), id: nextId("PRP"), type: "Proposal", action, params, actorId: actor.id, actorKind: actor.kind, runId: runId || null,
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
    if ((d.onBehalfOf || d.actorId) !== by.id && rank(by.clearance) < rank("supervisor")) return refuse("reverse", by, "only the person who did it or a supervisor reverses it");
    const f = reverts.get(decisionId);
    if (!f) return refuse("reverse", by, "not reversible");
    try { f(); } catch (e) { return refuse("reverse", by, e.message); }
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
