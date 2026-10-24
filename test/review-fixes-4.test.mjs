// Final review of plan 3a (agent harness and root-cause agent): each test reproduces a confirmed finding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { specFor, shadowRecord } from "../src/harness.mjs";

const SYS = { id: "SYSTEM", kind: "person", clearance: "manager", role: "system" };
const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance });
const act = (s, by, action, params) => s.actions.invoke({ action, params, actor: as(s, by) });
const tag = (s, t) => s.ont.list("Asset", (a) => a.positionTag === t)[0];
const rca = (s, scope, actingUser = SYS) => {
  const run = s.runtime.run("Root Cause", { actingUser, chain: false, scope });
  const out = run.outputs.find((o) => o.action === "draft_document" && o.status === "done");
  assert.ok(out, JSON.stringify(run.refusals));
  return s.ont.get(s.ont.get(out.ref).objects[0]).data;
};
const f07Alert = (s) => { s.runtime.run("Process Watch", { actingUser: SYS, chain: false }); return s.ont.list("Alert", (a) => a.assetId === tag(s, "F07").id && a.state === "active")[0]; };

test("final: shadow actions are matched on the plant tick, so a shadow agent builds a record", () => {
  const s = createSystem(), srv = createServer(s);
  assert.equal(act(s, "P-003", "demote_agent", { agent: "Process Watch", to: "assisted" }).status, "done");
  assert.equal(act(s, "P-003", "demote_agent", { agent: "Process Watch", to: "shadow" }).status, "done");
  srv.tick(15);
  assert.ok(s.ont.list("ShadowAction", (x) => x.agent === "Process Watch").length > 0);
  srv.tick(1440);
  srv.tick(15);
  assert.ok(shadowRecord(s.ont, "Process Watch").cases > 0, JSON.stringify(shadowRecord(s.ont, "Process Watch")));
});

test("final: a permit cap working as designed is not a breach — Chat Intake stays bounded and says the step waits for approval", async () => {
  const s = createSystem(), hlpb = tag(s, "HLP-B");
  const ptw = act(s, "P-009", "open_permit", { assetId: hlpb.id, kind: "general", holderId: "P-030" }).decision.objects[0];
  act(s, "P-009", "record_isolation", { permitId: ptw, point: "MCC-2 feeder 4" });
  await s.channels.inbound("CHN-P-028", "P-028", { text: "start" });
  const spec = specFor(s.ont, "Chat Intake");
  assert.deepEqual([spec.mode, spec.breaches || 0], ["bounded", 0]);
  const reply = s.ont.list("Message", (m) => m.channelId === "CHN-P-028" && m.direction === "out").at(-1);
  assert.ok(!/undefined/.test(reply.text) && /approval/.test(reply.text), reply.text);
});

test("final: Find root cause by a technician on an asset under someone else's permit does not demote Root Cause", () => {
  const s = createSystem(), hlpb = tag(s, "HLP-B");
  act(s, "P-009", "open_permit", { assetId: hlpb.id, kind: "general", holderId: "P-028" });
  s.runtime.run("Asset Watch", { actingUser: SYS, chain: false });
  const alert = s.ont.list("Alert", (a) => a.assetId === hlpb.id)[0];
  rca(s, { targetId: alert.id }, { ...as(s, "P-030"), role: "millwright" });
  assert.equal(specFor(s.ont, "Root Cause").mode, "bounded");
});

test("final: a paused Technician Copilot records nothing and says so", async () => {
  const s = createSystem(), hlpb = tag(s, "HLP-B");
  assert.equal(act(s, "P-003", "set_agent_state", { agent: "Technician Copilot", state: "paused" }).status, "done");
  const before = s.ont.list("Decision", (d) => d.actorId === "Technician Copilot").length;
  const c = s.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: { id: "P-023", clearance: "technician", kind: "person" } });
  const r = await c.ask("Can I reuse the housing? bore reads 110.065");
  assert.equal(s.ont.list("Decision", (d) => d.actorId === "Technician Copilot").length, before);
  assert.equal(s.ont.list("Proposal", (p) => p.actorId === "Technician Copilot" && p.state === "open").length, 0);
  assert.match(r.answer, /paused/);
});

test("final: a shadow-mode agent invoked directly records a shadow action and changes nothing", () => {
  const s = createSystem();
  act(s, "P-003", "demote_agent", { agent: "Technician Copilot", to: "assisted" });
  act(s, "P-003", "demote_agent", { agent: "Technician Copilot", to: "shadow" });
  const r = s.actions.invoke({ action: "record_reading", params: { targetId: tag(s, "HLP-B").id, measure: "vibration", value: 3 }, actor: { kind: "agent", id: "Technician Copilot", clearance: "technician", onBehalfOf: "P-023" }, autonomy: "act" });
  assert.equal(r.status, "shadowed");
  assert.equal(s.ont.list("Reading", (x) => x.measure === "vibration" && x.value === 3).length, 0);
});

test("final: reversing one isolation removes that isolation and keeps the later one", () => {
  const s = createSystem(), hlpb = tag(s, "HLP-B");
  const ptw = act(s, "P-009", "open_permit", { assetId: hlpb.id, kind: "general", holderId: "P-028" }).decision.objects[0];
  const wrong = act(s, "P-009", "record_isolation", { permitId: ptw, point: "WRONG feeder 9" }).decision;
  act(s, "P-009", "record_isolation", { permitId: ptw, point: "MCC-2 feeder 4" });
  assert.equal(s.actions.reverse(wrong.id, as(s, "P-009")).status, "done");
  assert.deepEqual(s.ont.get(ptw).isolations.map((i) => i.point), ["MCC-2 feeder 4"]);
});

test("final: the Proposals view shows the approval card", () => {
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  for (const x of ["Expected effect", "Constraints checked", "Alternatives", "kept later changes"]) assert.ok(app.includes(x), x);
});

test("final: an onset at the edge of the search window is searched further back, not invented", () => {
  const s = createSystem();
  const alert = f07Alert(s), byAlert = rca(s, { alertId: alert.id });
  s.tel.tick(900);
  const later = rca(s, { targetId: "POS-F07", at: s.tel.now() });
  assert.equal(later.symptom.onsetAt, byAlert.symptom.onsetAt);
});

test("final: the breadth test only counts siblings in the same stage whose onset is near the symptom's", () => {
  const s = createSystem(), real = s.tel.history.bind(s.tel);
  // the operator starts standby HLP-D 10 h ago and RWP-C returns to service 15 h ago: both step up, hours after HLP-B's onset
  const step = { "SEN-HLP-D-vib_de": 10 * 60, "SEN-RWP-C-vib_de": 15 * 60 };
  s.tel.history = (id, n) => {
    const v = real(id, n);
    if (!step[id]) return v;
    const out = Array.from(v);
    for (let i = out.length - 1 - step[id]; i < out.length; i++) out[i] *= 6;
    return out;
  };
  s.runtime.run("Asset Watch", { actingUser: SYS, chain: false });
  const alert = s.ont.list("Alert", (a) => a.assetId === tag(s, "HLP-B").id)[0];
  const r = rca(s, { alertId: alert.id });
  assert.deepEqual(r.causes.map((c) => [c.id, c.kind]), [[tag(s, "HLP-B").id, "local"]], JSON.stringify(r.rejected));
});

test("final: the plume cited is the one seen around the raw-water rise, not an old confirmed one", () => {
  const s = createSystem(), alert = f07Alert(s);
  const old = s.ont.list("Scene").sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt))[0];
  s.ont.upsert({ id: "GEO-OLD", type: "GeoDetection", kind: "plume", status: "confirmed", sceneId: old.id, aoiId: "AOI-INFLOW", confidence: 0.9, at: old.acquiredAt });
  const r = rca(s, { alertId: alert.id });
  const plume = r.causes.find((c) => c.kind === "contributing");
  assert.equal(plume.id, s.ont.list("GeoDetection", (d) => d.id !== "GEO-OLD")[0].id);
});

test("final: telemetry an agent cites in an alert's own evidence is freshness-checked", () => {
  const s = createSystem(), real = s.tel.latest.bind(s.tel);
  s.tel.latest = (id) => (/^SEN-F07-/.test(id) ? { ...real(id), at: new Date(Date.parse(s.tel.now()) - 45 * 60000).toISOString() } : real(id));
  const run = s.runtime.run("Process Watch", { actingUser: SYS, chain: false });
  assert.ok(run.refusals.some((x) => x.action === "raise_alert" && /^evidence stale: SEN-F07-/.test(x.reason)), JSON.stringify(run.refusals));
});

test("final: an assisted agent's answered proposals are its record, so it can earn its way back to bounded", () => {
  const s = createSystem();
  s.runtime.run("Process Watch", { actingUser: SYS, chain: false });
  const p = s.ont.list("Proposal", (x) => x.actorId === "Process Watch" && x.state === "open")[0];
  s.actions.resolve(p.id, { verdict: "approve", by: as(s, "P-004") });
  assert.deepEqual(shadowRecord(s.ont, "Process Watch"), { cases: 1, agreed: 1, differed: 0, missed: 0, agreePct: 100 });
});
