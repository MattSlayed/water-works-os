import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { runEvals } from "../src/evals.mjs";

const as = (sys, id) => ({ kind: "person", id, clearance: sys.ont.get(id).clearance });
const SYS = { id: "SYSTEM", kind: "person", clearance: "manager" };
const first = (sys, role) => sys.ont.list("Person", (p) => p.role === role).sort((a, b) => a.id.localeCompare(b.id))[0];

test("geo watch: one suggested plume detection on the day-11 scene, with an alert, at system start", () => {
  const sys = createSystem();
  const dets = sys.ont.list("GeoDetection");
  assert.equal(dets.length, 1);
  assert.deepEqual([dets[0].status, dets[0].sceneId, dets[0].aoiId, dets[0].kind], ["suggested", "S2-20261012", "AOI-INFLOW", "plume"]);
  assert.ok(dets[0].z >= 2.4 && dets[0].confidence > 0.5 && dets[0].confidence <= 0.95);
  assert.ok(sys.ont.list("Alert", (a) => a.targetId === dets[0].id).length === 1);
  assert.equal(sys.ont.list("GeoDetection", (d) => d.sceneId === "S2-20261007").length, 0, "no detection on the cloudy scene");
  const open = sys.ont.list("Proposal", (p) => p.state === "open" && ["start_sampling_round", "propose_dose_change"].includes(p.action));
  assert.deepEqual(open.map((p) => p.action).sort(), ["propose_dose_change", "start_sampling_round"]);
});

test("geo watch: running again adds nothing", () => {
  const sys = createSystem();
  sys.runtime.run("Geo Watch", { actingUser: SYS, chain: false });
  assert.equal(sys.ont.list("GeoDetection").length, 1);
  assert.equal(sys.ont.list("Proposal", (p) => p.action === "start_sampling_round" && p.state === "open").length, 1);
});

test("geo watch: approve the round, the analyst replies by chat, a Sample is recorded, the analyst confirms", async () => {
  const sys = createSystem();
  const det = sys.ont.list("GeoDetection")[0], sup = first(sys, "shift_supervisor"), analyst = first(sys, "lab_analyst");
  const prp = sys.ont.list("Proposal", (p) => p.action === "start_sampling_round" && p.state === "open")[0];
  assert.equal(sys.actions.resolve(prp.id, { verdict: "approve", by: as(sys, sup.id) }).status, "done");
  const ex = sys.ont.list("Execution", (e) => e.personId === analyst.id && e.state === "running")[0];
  assert.ok(ex, "the round is running for the analyst");
  const out = sys.ont.list("Message", (m) => m.channelId === `CHN-${analyst.id}` && m.direction === "out");
  assert.equal(out.length, 1);
  assert.match(out[0].text, /NTU/);
  await sys.channels.inbound(`CHN-${analyst.id}`, analyst.id, { text: "raw 88 NTU at intake jetty" });
  const smp = sys.ont.list("Sample", (s) => s.detectionId === det.id);
  assert.equal(smp.length, 1);
  assert.deepEqual([smp[0].value, smp[0].unit, smp[0].point], [88, "NTU", "Raw water"]);
  assert.deepEqual(sys.ont.get(det.id).sampleIds, [smp[0].id]);
  const r = sys.actions.invoke({ action: "review_detection", params: { detectionId: det.id, verdict: "confirmed" }, actor: as(sys, analyst.id) });
  assert.equal(r.status, "done", r.reason);
  assert.deepEqual([sys.ont.get(det.id).status, sys.ont.get(det.id).reviewedBy], ["confirmed", analyst.id]);
});

test("geo watch: an agent cannot review a detection; nobody confirms or rejects one without a sample", () => {
  const sys = createSystem();
  const det = sys.ont.list("GeoDetection")[0];
  assert.equal(sys.actions.invoke({ action: "review_detection", params: { detectionId: det.id, verdict: "confirmed" }, actor: { kind: "agent", id: "Geo Watch", clearance: "manager", onBehalfOf: "SYSTEM" } }).status, "refused");
  const r = sys.actions.invoke({ action: "review_detection", params: { detectionId: det.id, verdict: "confirmed" }, actor: as(sys, "P-001") });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /sample/);
  assert.equal(sys.actions.invoke({ action: "review_detection", params: { detectionId: det.id, verdict: "rejected" }, actor: as(sys, "P-001") }).status, "refused");
});

test("geo watch: the raw-water sample does not count as a final-water compliance result", () => {
  const sys = createSystem();
  const before = sys.ont.list("Sample").length;
  sys.ont.upsert({ id: "SMP-RAW-T", type: "Sample", point: "Raw water", analyte: "turbidity", value: 88, unit: "NTU", compliant: null, zoneId: "Z01" });
  const pack = sys.runtime.run("Drop Pack", { actingUser: SYS, chain: false });
  assert.equal(pack.status, "completed");
  const d = sys.ont.list("Draft", (x) => x.kind === "drop-pack").pop();
  assert.match(d.body, new RegExp(`of ${before} final-water results`));
});

test("geo watch: its evals pass", async () => {
  const r = await runEvals(() => createSystem(), "Geo Watch");
  assert.equal(r.total, 4);
  assert.equal(r.passed, 4, JSON.stringify(r.cases));
});
