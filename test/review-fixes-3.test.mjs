// Final review of the Region branch: each test reproduces a confirmed finding before its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { parseMessage } from "../src/parse.mjs";
import { extractPlant } from "../src/ingest/extract.mjs";
import { drawingSet } from "../src/drawings/make.mjs";
import { generateWorks } from "../src/generate.mjs";
import { createOntology } from "../src/ontology.mjs";
import { projectPanel, supplyRisks, regionPayload } from "../src/regionview.mjs";

const as = (sys, id) => ({ kind: "person", id, clearance: sys.ont.get(id).clearance });
const SYS = { id: "SYSTEM", kind: "person", clearance: "manager" };
const first = (sys, role) => sys.ont.list("Person", (p) => p.role === role).sort((a, b) => a.id.localeCompare(b.id))[0];
const round = (sys) => sys.ont.list("Proposal", (p) => p.action === "start_sampling_round" && p.state === "open")[0];
const sampleTaken = async (sys) => {
  const lab = first(sys, "lab_analyst");
  sys.actions.resolve(round(sys).id, { verdict: "approve", by: as(sys, first(sys, "shift_supervisor").id) });
  await sys.channels.inbound(`CHN-${lab.id}`, lab.id, { text: "raw 88 NTU at intake jetty" });
  return lab;
};

test("fix: a reviewed detection keeps its sample — the sampling step cannot be reversed after the review", async () => {
  const sys = createSystem(), det = sys.ont.list("GeoDetection")[0], lab = await sampleTaken(sys);
  assert.equal(sys.actions.invoke({ action: "review_detection", params: { detectionId: det.id, verdict: "confirmed" }, actor: as(sys, lab.id) }).status, "done");
  const step = sys.ont.list("Decision", (d) => d.action === "complete_step" && d.objects.some((o) => String(o).startsWith("SMP-G")))[0];
  const r = sys.actions.reverse(step.id, as(sys, lab.id)); // the analyst who took the sample
  assert.equal(r.status, "refused");
  assert.match(r.reason, /review/);
  assert.equal(sys.ont.get(det.id).sampleIds.length, 1);
});

test("fix: an NTU figure in an issue or a question is not a step reading", () => {
  const ex = { id: "EXE-1" };
  assert.equal(parseMessage({ text: "issue: raw water at 90 NTU, dosing cannot keep up" }, { execution: ex }).kind, "issue");
  assert.equal(parseMessage({ text: "is 90 NTU too high for the clarifiers?" }, { execution: ex }).kind, "question");
  assert.equal(parseMessage({ text: "raw 88 NTU at intake jetty" }, { execution: ex }).kind, "done");
});

test("fix: with record_detection turned down to propose, Geo Watch proposes each detection once and raises nothing on a proposal", () => {
  const sys = createSystem();
  for (const d of sys.ont.list("GeoDetection")) sys.ont.remove(d.id);
  sys.runtime.setAutonomy("Geo Watch", "record_detection", "propose");
  sys.runtime.run("Geo Watch", { actingUser: SYS, chain: false });
  sys.runtime.run("Geo Watch", { actingUser: SYS, chain: false });
  assert.equal(sys.ont.list("Proposal", (p) => p.action === "record_detection" && p.state === "open").length, 1);
  assert.equal(sys.ont.list("Proposal", (p) => p.action === "start_sampling_round" && p.state === "open").length, 1, "only the one from system start");
});

test("fix: geofence events are written to the audit log, so the panel links them", () => {
  const sys = createSystem(), ev = sys.ont.list("GeofenceEvent", (e) => e.trackerId === "TRK-PP2")[0];
  assert.ok(sys.audit.all().some((e) => (e.objects || []).includes(ev.id)));
  const p = projectPanel(sys, as(sys, "P-004"), "PRJ-RWM");
  assert.ok(p.issues.some((i) => i.kind === "geofence" && Number.isInteger(i.auditId)));
});

test("fix: rejecting a detection needs a sample too, like confirming", async () => {
  const sys = createSystem(), det = sys.ont.list("GeoDetection")[0];
  const r = sys.actions.invoke({ action: "review_detection", params: { detectionId: det.id, verdict: "rejected" }, actor: as(sys, first(sys, "process_controller").id) });
  assert.equal(r.status, "refused");
  assert.match(r.reason, /sample/);
  const lab = await sampleTaken(sys);
  assert.equal(sys.actions.invoke({ action: "review_detection", params: { detectionId: det.id, verdict: "rejected" }, actor: as(sys, lab.id) }).status, "done");
});

test("fix: drawing ingest grades a structure outside every plant zone AMBIGUOUS instead of crashing on the bulk-line zones", () => {
  const ont = createOntology(generateWorks(7));
  ont.remove("Z12"); // 40UYA01 sits in Z12; without it, its insertion point lies outside every plant zone
  const files = drawingSet("A"), el = Object.keys(files).find((k) => k.startsWith("RB-EL-001"));
  files[el] = files[el].split("\n").filter((l) => !l.startsWith("40UYA01,")).join("\n");
  const x = extractPlant(files, ont);
  const c = x.cells.find((y) => y.key === "40UYA01|zoneId");
  assert.deepEqual([c.value, c.grade], ["none", "AMBIGUOUS"]);
});

test("fix: record_detection rejects malformed detections, and only an area of interest takes one", () => {
  const sys = createSystem(), t = as(sys, "P-001");
  for (const params of [{ sceneId: "S2-20261012", aoiId: "AOI-DAM", kind: 5, z: 1 }, { sceneId: "S2-20261012", aoiId: "RD-1", kind: "plume", z: 3 }, { sceneId: "S2-20261012", aoiId: "AOI-DAM", kind: "plume", z: "x" }])
    assert.equal(sys.actions.invoke({ action: "record_detection", params, actor: t }).status, "refused", JSON.stringify(params));
});

test("fix: the event stream never names a hidden object in a link; hidden chemicals are not named by trackers", async () => {
  const sys = createSystem(), srv = createServer(sys);
  await new Promise((r) => srv.listen(0, r));
  const tech = sys.ont.list("Person", (p) => p.clearance === "technician")[0].id;
  try {
    const ctl = new AbortController(), res = await fetch(`http://127.0.0.1:${srv.address().port}/api/events?as=${tech}`, { signal: ctl.signal });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let text = "";
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } } catch {} })();
    await new Promise((r) => setTimeout(r, 50));
    sys.actions.resolve(round(sys).id, { verdict: "approve", by: as(sys, first(sys, "shift_supervisor").id) });
    await new Promise((r) => setTimeout(r, 100));
    ctl.abort();
    await pump;
    const hidden = sys.ont.list("Execution").concat(sys.ont.list("Message")).filter((o) => !sys.ont.view({ id: tech, clearance: "technician" }).get(o.id)).map((o) => o.id);
    for (const id of hidden) assert.ok(!text.includes(`"${id}"`), id);
  } finally { srv.close(); }
  const cl2 = regionPayload(sys, { id: tech, clearance: "technician" }).trackers.find((x) => x.id === "TRK-CL2");
  assert.equal(cl2.boundTo, null);
});

test("fix: only a supervisor approves a sampling round, and never for a detection already reviewed", async () => {
  const sys = createSystem(), det = sys.ont.list("GeoDetection")[0];
  assert.equal(sys.actions.resolve(round(sys).id, { verdict: "approve", by: as(sys, "P-028") }).status, "refused");
  sys.ont.upsert({ id: det.id, type: "GeoDetection", status: "rejected" });
  assert.equal(sys.actions.resolve(round(sys).id, { verdict: "approve", by: as(sys, first(sys, "shift_supervisor").id) }).status, "refused");
  assert.equal(sys.ont.list("WorkOrder", (w) => w.source === det.id).length, 0);
});

test("fix: a cloudy scene gives no detection however turbid its statistics look", () => {
  const sys = createSystem(), s = sys.ont.get("S2-20261007");
  const stats = structuredClone(s.stats);
  stats["AOI-INFLOW"].ndti.mean = 0.9;
  sys.ont.upsert({ id: s.id, type: "Scene", stats });
  sys.runtime.run("Geo Watch", { actingUser: SYS, chain: false });
  assert.equal(sys.ont.list("GeoDetection", (d) => d.sceneId === s.id).length, 0);
  sys.ont.upsert({ id: s.id, type: "Scene", usable: { ...s.usable, "AOI-INFLOW": true } });
  sys.runtime.run("Geo Watch", { actingUser: SYS, chain: false });
  assert.equal(sys.ont.list("GeoDetection", (d) => d.sceneId === s.id).length, 1, "the same statistics on a clear scene are detected");
});

test("fix: a delivery's ETA is cleared once it arrives", () => {
  const sys = createSystem();
  sys.tel.tick(20);
  sys.trackers.syncTo(sys.ont, sys.tel.cursor());
  assert.ok(sys.ont.get("TRK-COAG").eta, "on the road at 06:20");
  sys.tel.tick(120);
  sys.trackers.syncTo(sys.ont, sys.tel.cursor());
  assert.equal(sys.ont.get("TRK-COAG").eta, null);
});

test("fix: the supply card weighs demand against capacity; the project panel says until when and what storage is left", () => {
  const sys = createSystem(), r = supplyRisks(sys, as(sys, "P-001"));
  assert.ok(Number.isFinite(r.capacity.demandMlD));
  assert.equal(r.capacity.shortfallMlD, Math.max(0, Math.round((r.capacity.demandMlD - r.capacity.capacityMlD) * 10) / 10));
  assert.ok(r.capacity.shortfallMlD > 0, "demand above the 90 ML/d the works can treat today");
  const p = projectPanel(sys, as(sys, "P-004"), "PRJ-RES2");
  assert.match(p.impact.supplyRisk, /RES-2.*\d+(\.\d)? h of storage/);
  assert.ok(p.impact.outOfService.every((x) => x.to));
});

test("fix: operations lists work orders and plant alerts, so their focus is reachable", () => {
  const sys = createSystem();
  sys.runtime.run("Process Watch", { actingUser: SYS, chain: false });
  const ops = regionPayload(sys, as(sys, "P-001")).operations;
  assert.ok(ops.some((o) => o.kind === "alert" && /F07/.test(o.label)));
  assert.ok(ops.some((o) => o.kind === "workorder"));
  assert.ok(ops.some((o) => o.kind === "detection"));
});
