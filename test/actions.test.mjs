import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorks } from "../src/generate.mjs";
import { createOntology } from "../src/ontology.mjs";
import { createAudit } from "../src/audit.mjs";
import { createActionService, ACTIONS, LEVELS } from "../src/actions.mjs";

const setup = () => {
  const ont = createOntology(generateWorks(7));
  const audit = createAudit();
  return { ont, audit, svc: createActionService({ ont, audit }) };
};
const agent = { kind: "agent", id: "Parts Readiness", clearance: "manager" };
const planner = { kind: "person", id: "P-008", clearance: "supervisor" };

test("registry covers the PRD action list and levels are ordered", () => {
  for (const a of ["create_work_order", "draft_document", "reserve_parts", "raise_purchase_requisition", "schedule_work", "open_permit", "close_permit", "record_isolation", "raise_alert", "notify", "record_reading", "tag_part", "raise_deviation", "change_asset_state", "request_setpoint_change", "submit_compliance_pack", "release_asset_model"]) {
    assert.ok(ACTIONS[a], a);
  }
  assert.deepEqual(LEVELS, ["read", "draft", "notify", "propose", "act"]);
});

test("missing required params are refused", () => {
  const { svc } = setup();
  const r = svc.invoke({ action: "reserve_parts", params: {}, actor: agent, autonomy: "act" });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /partIds/);
});

test("unknown action is refused", () => {
  const { svc } = setup();
  assert.equal(svc.invoke({ action: "open_valve", params: {}, actor: agent, autonomy: "act" }).status, "refused");
});

test("agents can never call human-only actions", () => {
  const { svc, ont } = setup();
  const a = ont.list("Asset", (x) => x.positionTag === "HLP-B")[0];
  const r = svc.invoke({ action: "open_permit", params: { assetId: a.id, kind: "general", holderId: "P-023" }, actor: agent, autonomy: "act" });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /human-only/);
});

test("a person below the action's clearance is refused", () => {
  const { svc, ont } = setup();
  const a = ont.list("Asset", (x) => x.positionTag === "HLP-B")[0];
  const r = svc.invoke({ action: "open_permit", params: { assetId: a.id, kind: "general", holderId: "P-023" }, actor: { kind: "person", id: "P-023", clearance: "technician" } });
  assert.equal(r.status, "refused");
});

test("autonomy propose yields a proposal; act yields a decision that changed the record", () => {
  const { svc, ont } = setup();
  const before = ont.get("PRT-HLP-B-06").stock;
  const p = svc.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"], workOrderId: "WO-26043" }, actor: agent, autonomy: "propose" });
  assert.equal(p.status, "proposed");
  assert.equal(ont.get(p.proposal.id).state, "open");
  assert.equal(ont.get("PRT-HLP-B-06").stock, before);
  const d = svc.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"], workOrderId: "WO-26043" }, actor: agent, autonomy: "act" });
  assert.equal(d.status, "done");
  assert.equal(ont.get(d.decision.id).type, "Decision");
  assert.equal(ont.get("PRT-HLP-B-06").stock, before - 1);
});

test("effective autonomy is capped by the action ceiling", () => {
  const { svc, ont } = setup();
  const a = ont.list("Asset", (x) => x.positionTag === "HLP-B")[0];
  const r = svc.invoke({ action: "change_asset_state", params: { assetId: a.id, state: "out_of_service" }, actor: agent, autonomy: "act" });
  assert.equal(r.status, "proposed");
});

test("autonomy below propose refuses a write action", () => {
  const { svc } = setup();
  const r = svc.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"] }, actor: agent, autonomy: "notify" });
  assert.equal(r.status, "refused");
});

test("approve executes once; resolving twice is refused", () => {
  const { svc, ont } = setup();
  const p = svc.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"] }, actor: agent, autonomy: "propose" }).proposal;
  const r1 = svc.resolve(p.id, { verdict: "approve", by: planner, reason: "ok" });
  assert.equal(r1.status, "done");
  assert.equal(ont.get(p.id).state, "approved");
  assert.ok(ont.links(p.id, { rel: "RESOLVED_BY" }).length === 1);
  assert.equal(svc.resolve(p.id, { verdict: "approve", by: planner }).status, "refused");
});

test("edit applies edited params; reject stores feedback with the reason", () => {
  const { svc, ont } = setup();
  const p1 = svc.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"] }, actor: agent, autonomy: "propose" }).proposal;
  const e = svc.resolve(p1.id, { verdict: "edit", params: { partIds: ["PRT-HLP-B-07"] }, by: planner, reason: "NDE bearing instead" });
  assert.equal(e.status, "done");
  assert.deepEqual(ont.get(e.decision.id).params.partIds, ["PRT-HLP-B-07"]);
  const p2 = svc.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"] }, actor: agent, autonomy: "propose" }).proposal;
  svc.resolve(p2.id, { verdict: "reject", by: planner, reason: "already in stores bin" });
  const fb = ont.list("Feedback", (f) => f.targetId === p2.id);
  assert.equal(fb.length, 1);
  assert.equal(fb[0].comment, "already in stores bin");
  assert.equal(ont.get(p2.id).state, "rejected");
});

test("reject without a reason is refused", () => {
  const { svc } = setup();
  const p = svc.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"] }, actor: agent, autonomy: "propose" }).proposal;
  assert.equal(svc.resolve(p.id, { verdict: "reject", by: planner }).status, "refused");
});

test("reverse restores the prior state once", () => {
  const { svc, ont } = setup();
  const before = ont.get("PRT-HLP-B-06").stock;
  const d = svc.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"] }, actor: agent, autonomy: "act" }).decision;
  assert.equal(svc.reverse(d.id, planner).status, "done");
  assert.equal(ont.get("PRT-HLP-B-06").stock, before);
  assert.equal(svc.reverse(d.id, planner).status, "refused");
});

test("setpoint change is only ever a recorded request", () => {
  const { svc, ont } = setup();
  const r = svc.invoke({ action: "request_setpoint_change", params: { targetId: "PU-coag", setpoint: "coagulant dose", value: 32, unit: "mg/L" }, actor: { kind: "person", id: "P-010", clearance: "operator" } });
  assert.equal(r.status, "done");
  const req = ont.list("SetpointRequest");
  assert.equal(req.length, 1);
  assert.equal(req[0].state, "requested");
});

test("audit chain verifies and detects tampering", () => {
  const { svc, audit } = setup();
  svc.invoke({ action: "notify", params: { to: ["P-001"], message: "hello" }, actor: agent, autonomy: "act" });
  svc.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"] }, actor: agent, autonomy: "propose" });
  assert.ok(audit.all().length >= 2);
  assert.equal(audit.verify(), true);
  audit.all()[0].action = "tampered";
  assert.equal(audit.verify(), false);
});

test("actions stamp objects with the injected clock", () => {
  const ont = createOntology(generateWorks(7));
  const svc = createActionService({ ont, audit: createAudit(), clock: () => "2026-10-14T07:05:00.000Z" });
  const r = svc.invoke({ action: "raise_alert", params: { targetId: "SEN-FW-turb", title: "t" }, actor: planner });
  assert.equal(ont.get(r.decision.objects[0]).at, "2026-10-14T07:05:00.000Z");
  assert.equal(r.decision.at, "2026-10-14T07:05:00.000Z");
});
