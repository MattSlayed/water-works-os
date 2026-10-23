// Regression tests for the final whole-branch review (C1, C2, I1-I4 and selected minors).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";

const tech = { kind: "person", id: "P-028", clearance: "technician" };
const sup = { kind: "person", id: "P-008", clearance: "supervisor" };
const mgr = { kind: "person", id: "P-001", clearance: "manager" };
const tag = (sys, t) => sys.ont.list("Asset", (a) => a.positionTag === t)[0];

test("C1: a person cannot patch a non-work-order through update_work_order", () => {
  const sys = createSystem({ seed: 7 });
  const r = sys.actions.invoke({ action: "update_work_order", params: { workOrderId: "Z06", patch: { clearance: "technician" } }, actor: tech });
  assert.equal(r.status, "refused");
  assert.equal(sys.ont.get("Z06").clearance, "supervisor");
});

test("C1: update_work_order only patches whitelisted keys with plain values", () => {
  const sys = createSystem({ seed: 7 });
  const wo = sys.ont.list("WorkOrder", (w) => w.state === "open")[0];
  assert.equal(sys.actions.invoke({ action: "update_work_order", params: { workOrderId: wo.id, patch: { assetId: "X" } }, actor: sup }).status, "refused");
  assert.equal(sys.actions.invoke({ action: "update_work_order", params: { workOrderId: wo.id, patch: { title: { x: 1 } } }, actor: sup }).status, "refused");
  assert.equal(sys.actions.invoke({ action: "update_work_order", params: { workOrderId: wo.id, patch: { priority: "P1" } }, actor: sup }).status, "done");
});

test("C1: an actor cannot act on a target it cannot see", () => {
  const sys = createSystem({ seed: 7 });
  const chl = tag(sys, "CHL-A");
  const r = sys.actions.invoke({ action: "change_asset_state", params: { assetId: chl.id, state: "isolated" }, actor: tech });
  assert.equal(r.status, "refused");
  assert.equal(sys.ont.get(chl.id).state, "running");
});

test("C1: wrong target type is refused (rank_alert on a person)", () => {
  const sys = createSystem({ seed: 7 });
  assert.equal(sys.actions.invoke({ action: "rank_alert", params: { alertId: "P-001", consequence: { label: "x" } }, actor: mgr }).status, "refused");
});

test("I3: reserve_parts is all-or-nothing", () => {
  const sys = createSystem({ seed: 7 });
  const a = sys.ont.get("PRT-HLP-B-06"), b = sys.ont.get("PRT-HLP-B-05");
  sys.ont.upsert({ id: b.id, type: "Part", stock: 0 });
  const before = a.stock;
  assert.equal(sys.actions.invoke({ action: "reserve_parts", params: { partIds: [a.id, b.id] }, actor: sup }).status, "refused");
  assert.equal(sys.ont.get(a.id).stock, before);
  assert.equal(sys.ont.list("Reservation").length, 0);
});

test("I3: schedule_work to an unknown person leaves the order untouched", () => {
  const sys = createSystem({ seed: 7 });
  const wo = sys.ont.list("WorkOrder", (w) => w.state === "open")[0];
  assert.equal(sys.actions.invoke({ action: "schedule_work", params: { workOrderId: wo.id, assigneeId: "P-NOPE" }, actor: sup }).status, "refused");
  assert.equal(sys.ont.get(wo.id).state, "open");
});

test("I4: a technician cannot reverse a supervisor's close_permit", () => {
  const sys = createSystem({ seed: 7 });
  const d = sys.actions.invoke({ action: "close_permit", params: { permitId: "PTW-0412" }, actor: sup }).decision;
  assert.equal(sys.actions.reverse(d.id, tech).status, "refused");
  assert.equal(sys.ont.get("PTW-0412").state, "closed");
});

test("I4: reversing an earlier reservation keeps a later one", () => {
  const sys = createSystem({ seed: 7 });
  sys.ont.upsert({ id: "PRT-HLP-C-06", type: "Part", stock: 3 });
  const d1 = sys.actions.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-C-06"] }, actor: sup }).decision;
  sys.actions.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-C-06"] }, actor: sup });
  assert.equal(sys.actions.reverse(d1.id, sup).status, "done");
  assert.equal(sys.ont.get("PRT-HLP-C-06").stock, 2);
  assert.equal(sys.ont.get("PRT-HLP-C-06").reserved, 1);
});

test("I1: objects with minClearance are pruned; agent runs carry the acting clearance", () => {
  const sys = createSystem({ seed: 7 });
  const run = sys.runtime.run("Permit Guard", { actingUser: mgr });
  assert.equal(sys.ont.view(tech).get(run.id), null);
  assert.ok(sys.ont.view(mgr).get(run.id));
  const alert = sys.ont.list("Alert", (a) => a.zoneId === "Z06")[0];
  const dec = sys.ont.list("Decision", (d) => (d.objects || []).includes(alert.id))[0];
  assert.equal(sys.ont.view(tech).get(dec.id), null);
});

test("I1: a handover drafted for a manager is not visible to a technician", () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Shift Handover", { actingUser: mgr });
  assert.equal(sys.ont.view(tech).list("Draft").length, 0);
});

test("I2: the Copilot refuses a part that is hidden or belongs to another asset", async () => {
  const sys = createSystem({ seed: 7 });
  const hlpb = tag(sys, "HLP-B");
  assert.throws(() => sys.copilot.open({ assetId: hlpb.id, partId: "PRT-CHL-A-05", user: tech }), /part not found/);
  assert.throws(() => sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-A-05", user: tech }), /part not found/);
  const s = sys.copilot.open({ assetId: hlpb.id, user: tech });
  assert.throws(() => s.tag({ partId: "PRT-CHL-A-05", note: "x" }), /part not found/);
  assert.equal(sys.ont.list("Finding", (f) => f.partId === "PRT-CHL-A-05").length, 0);
});

test("Minor: Process Watch does not repeat an out-of-band alert", () => {
  const sys = createSystem({ seed: 7 });
  sys.ont.upsert({ id: "SEN-FIN-cl", type: "Sensor", alarmLo: 5 }); // force the residual "low"
  sys.runtime.run("Process Watch", { actingUser: mgr, chain: false });
  sys.runtime.run("Process Watch", { actingUser: mgr, chain: false });
  assert.equal(sys.ont.list("Alert", (a) => a.targetId === "SEN-FIN-cl").length, 1);
});

let srv, base, sys2;
before(async () => { sys2 = createSystem({ seed: 7 }); srv = createServer(sys2); await new Promise((r) => srv.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv.close());

test("C2: a malformed URL gets 400 and the server stays up", async () => {
  assert.equal((await fetch(base + "/%E0%A4%A")).status, 400);
  assert.equal((await fetch(base + "/")).status, 200);
});

test("I1: a technician sees only runs made for their own clearance, and no audit", async () => {
  sys2.runtime.run("Permit Guard", { actingUser: mgr });
  const h = { "x-acting-user": "P-028" };
  const runs = await (await fetch(base + "/api/runs", { headers: h })).json();
  assert.ok(runs.every((r) => r.actingUserId === "P-028"));
  const objs = await (await fetch(base + "/api/objects?type=AgentRun", { headers: h })).json();
  assert.equal(objs.length, 0);
  assert.equal((await fetch(base + "/api/audit", { headers: h })).status, 403);
});
