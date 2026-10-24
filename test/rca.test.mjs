import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { AGENT_SPECS } from "../src/agents.mjs";
import { runEvals } from "../src/evals.mjs";
import { outcomeOf } from "../src/rca.mjs";

const SYS = { id: "SYSTEM", kind: "person", clearance: "manager", role: "system" };
const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance });
const first = (s, role) => s.ont.list("Person", (p) => p.role === role).sort((a, b) => a.id.localeCompare(b.id))[0];
const tag = (s, t) => s.ont.list("Asset", (a) => a.positionTag === t)[0];
// F07 at the clock, after Process Watch has run; the report is the Root Cause agent's draft
const f07Alert = (s) => {
  s.runtime.run("Process Watch", { actingUser: SYS, chain: false });
  return s.ont.list("Alert", (a) => a.assetId === tag(s, "F07").id && a.state === "active")[0];
};
const rca = (s, scope) => {
  const run = s.runtime.run("Root Cause", { actingUser: SYS, chain: false, scope });
  const out = run.outputs.find((o) => o.action === "draft_document");
  assert.ok(out && out.status === "done", JSON.stringify(run.refusals.concat(run.reasoning)));
  const d = s.ont.get(s.ont.get(out.ref).objects[0]);
  assert.equal(d.kind, "rca");
  return d.data;
};

test("root cause: F07 media is the local cause; DP-2 is rejected as too late", () => {
  const s = createSystem();
  const r = rca(s, { alertId: f07Alert(s).id });
  assert.equal(r.verdict, "explained");
  assert.deepEqual([r.causes[0].id, r.causes[0].kind, r.causes[0].weight], [tag(s, "F07").id, "local", 1]);
  assert.equal(r.symptom.sensorId, "SEN-F07-headloss");
  const dp2 = r.rejected.find((x) => x.id === tag(s, "DP-2").id);
  assert.ok(dp2, JSON.stringify(r.rejected));
  assert.match(dp2.reason, /too late/);
  assert.match(dp2.reason, /\d+ min/);
  assert.ok(r.window.onsetH > 0 && r.window.tailH > r.window.meanH);
  for (const c of r.causes) assert.ok(c.evidence.length && c.showMe.startsWith("#/"), c.id);
});

test("root cause: the plume contributes — 0.5 while suggested, 0.7 once confirmed; raw water leads F07 by about 2 h", async () => {
  const s = createSystem();
  const alert = f07Alert(s), det = s.ont.list("GeoDetection", (d) => d.kind === "plume")[0];
  let r = rca(s, { alertId: alert.id });
  let plume = r.causes.find((c) => c.id === det.id);
  assert.deepEqual([plume.kind, plume.weight, plume.status], ["contributing", 0.5, "suggested"]);
  assert.equal(plume.showMe, `#/region/focus=detection:${det.id}`);
  const lead = (Date.parse(r.symptom.onsetAt) - Date.parse(plume.onsetAt)) / 60000;
  assert.ok(lead >= 100 && lead <= 300, `raw water leads F07 by ${lead} min`);

  const sup = first(s, "shift_supervisor"), analyst = first(s, "lab_analyst");
  const prp = s.ont.list("Proposal", (p) => p.action === "start_sampling_round" && p.state === "open")[0];
  assert.equal(s.actions.resolve(prp.id, { verdict: "approve", by: as(s, sup.id) }).status, "done");
  await s.channels.inbound(`CHN-${analyst.id}`, analyst.id, { text: "raw 88 NTU at intake jetty" });
  assert.equal(s.actions.invoke({ action: "review_detection", params: { detectionId: det.id, verdict: "confirmed" }, actor: as(s, analyst.id) }).status, "done");
  r = rca(s, { alertId: alert.id });
  plume = r.causes.find((c) => c.id === det.id);
  assert.deepEqual([plume.weight, plume.status], [0.7, "confirmed"]);
  assert.equal(r.causes[0].kind, "local", "F07 stays first");
});

test("root cause: a pump's vibration is local, with no upstream water cause", () => {
  const s = createSystem();
  s.runtime.run("Asset Watch", { actingUser: SYS, chain: false });
  const alert = s.ont.list("Alert", (a) => a.assetId === tag(s, "HLP-B").id)[0];
  const r = rca(s, { alertId: alert.id });
  assert.deepEqual(r.causes.map((c) => [c.id, c.kind]), [[tag(s, "HLP-B").id, "local"]]);
});

test("root cause: no onset, or no released plant model, is Insufficient evidence — never a guess", () => {
  const s = createSystem();
  const none = rca(s, { targetId: "RES-CWR1" });
  assert.deepEqual([none.verdict, none.causes], ["Insufficient evidence", []]);
  const alert = f07Alert(s);
  for (const m of s.ont.list("PlantModel", (x) => x.status === "released")) s.ont.upsert({ id: m.id, type: "PlantModel", status: "superseded" });
  const nomodel = rca(s, { alertId: alert.id });
  assert.deepEqual([nomodel.verdict, nomodel.causes], ["Insufficient evidence", []]);
});

test("outcome check: back within tolerance, halfway, unchanged, or no data", () => {
  const t0 = Date.parse("2026-10-10T00:00:00Z"), iso = (i) => new Date(t0 + i * 60000).toISOString();
  const grade = (after, actionAt = iso(900)) => {
    const series = [...Array(600).fill(1.0), ...Array(300).fill(2.0), ...Array(300).fill(after)];
    const report = { id: "DRF-T", type: "Draft", data: { symptom: { id: "X", sensorId: "SEN-X", onsetAt: iso(600) } } };
    const ctx = { get: (id) => (id === "DRF-T" ? report : null), history: (id, n) => series.slice(-n), latest: () => ({ at: iso(series.length - 1) }) };
    return outcomeOf(ctx, { reportId: "DRF-T", actionAt, windowH: 4 });
  };
  assert.equal(grade(1.05), "Effective");
  assert.equal(grade(1.4), "Partially effective");
  assert.equal(grade(2.0), "Ineffective");
  assert.equal(grade(1.05, iso(1199)), "Insufficient evidence");
});

test("root cause: agent 20 is in the catalogue (21 with the Recommender) and passes its evals", async () => {
  assert.equal(AGENT_SPECS.length, 21);
  const r = await runEvals(() => createSystem(), "Root Cause");
  assert.equal(r.total, 3);
  assert.equal(r.passed, 3, JSON.stringify(r.cases));
});

test("root cause from the plant selection: a structure's position resolves to its asset", () => {
  const s = createSystem();
  const r = rca(s, { targetId: "POS-F07" });
  assert.deepEqual([r.verdict, r.causes[0].id, r.causes[0].kind], ["explained", tag(s, "F07").id, "local"]);
});

test("root cause from the plant selection hours later still reads the alert's moment, not the clock", () => {
  const s = createSystem();
  const alert = f07Alert(s);
  s.tel.tick(300);
  const r = rca(s, { targetId: "POS-F07" }), byAlert = rca(s, { alertId: alert.id });
  assert.equal(r.symptom.onsetAt, byAlert.symptom.onsetAt);
  assert.ok(r.causes.some((c) => c.kind === "contributing"), JSON.stringify(r.rejected));
});
