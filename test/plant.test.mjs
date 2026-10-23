import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { currentPlantModel, packageHash } from "../src/plant.mjs";

const person = (sys, id) => ({ kind: "person", id, clearance: sys.ont.get(id).clearance });
const run = (sys, action, params, id) => sys.actions.invoke({ action, params, actor: person(sys, id) });

test("seed: rev A is the current released model, reviewed by P-002 and released by P-001", () => {
  const { ont } = createSystem();
  const m = currentPlantModel(ont);
  assert.deepEqual([m.id, m.rev, m.status, m.release.by, m.release.at], ["PM-RB-A", "A", "released", "P-001", "2025-02-01T00:00:00Z"]);
  assert.ok(m.cells.length > 900);
  assert.ok(m.cells.every((c) => c.reviewed && c.reviewed.by === "P-002"));
  assert.equal(m.packageHash, packageHash(m));
  assert.equal(m.release.hash, m.packageHash);
  assert.ok(ont.get("PM-RB-A:STR-15HFA07").modelId === "PM-RB-A");
  assert.equal(ont.get("PM-RB-A:MCH-DP-2").positionId, "POS-DP-2");
  assert.equal(ont.list("Drawing", (d) => d.rev === "B" && d.status === "received").length, 3);
  assert.equal(ont.list("Drawing", (d) => d.rev === "A").length, 14);
});

test("the package hash ignores status, governs and release", () => {
  const m = structuredClone(currentPlantModel(createSystem().ont));
  const h = packageHash(m);
  Object.assign(m, { status: "superseded", governs: { from: "x", to: "y" }, release: null });
  assert.equal(packageHash(m), h);
  m.cells[0].value = "changed";
  assert.notEqual(packageHash(m), h);
});

test("technician view hides a plant Line whose zones include Z06", () => {
  const { ont } = createSystem();
  const line = ont.get("PM-RB-A:LIN-RB-L-511");
  assert.ok(line.zones.includes("Z06"));
  assert.equal(ont.view({ id: "T", clearance: "technician" }).get(line.id), null);
  assert.ok(ont.view({ id: "S", clearance: "supervisor" }).get(line.id));
  assert.ok(ont.view({ id: "T", clearance: "technician" }).get("PM-RB-A:LIN-RB-L-001"));
});

test("rev B: ingest, carried-forward marks, refusals, four-eyes release", () => {
  const sys = createSystem();
  const { ont, plant } = sys;
  const A = currentPlantModel(ont);
  const hlpB = JSON.stringify(ont.get("POS-HLP-B"));
  const bIds = ont.list("Drawing", (d) => d.rev === "B").map((d) => d.id);

  const draft = plant.ingest(bIds, person(sys, "P-002"));
  assert.deepEqual([draft.id, draft.rev, draft.status], ["PM-RB-B", "B", "draft"]);
  const aCell = new Map(A.cells.map((c) => [c.key, JSON.stringify(c.value)]));
  const open = draft.cells.filter((c) => !c.reviewed);
  for (const c of open) assert.notEqual(aCell.get(c.key), JSON.stringify(c.value), `${c.key} unchanged but unreviewed`);
  const openKeys = new Set(open.map((c) => c.key));
  for (const k of ["15HFA01|filterToWaste", "15HFA04|filterToWaste", "RB-L-601|service", "RB-L-421X|presence"]) assert.ok(openKeys.has(k), k);
  assert.ok(!openKeys.has("15HFA05|filterToWaste") && !openKeys.has("RB-L-210|dn"));
  assert.equal(draft.cells.find((c) => c.key === "RB-L-421X|presence").grade, "AMBIGUOUS");

  // Review Focus 1: the same revision again, or an older one, is refused and makes no draft.
  const models = ont.list("PlantModel").length;
  assert.throws(() => plant.ingest(bIds, person(sys, "P-002")), /already/);
  assert.throws(() => plant.ingest(ont.list("Drawing", (d) => d.rev === "A" && d.number === "RB-GA-001").map((d) => d.id), person(sys, "P-002")), /already|older/);
  assert.equal(ont.list("PlantModel").length, models);

  // P-002 reviews everything but the old washwater outlet.
  for (const sheet of new Set(draft.cells.map((c) => c.sheet))) assert.equal(run(sys, "review_cells", { modelId: "PM-RB-B", accept: "EXTRACTED", sheet }, "P-002").status, "done");
  const marks = ont.get("PM-RB-B").cells.filter((c) => !c.reviewed && c.key !== "RB-L-421X|presence").map((c) => ({ key: c.key }));
  assert.ok(marks.length > 0);
  assert.equal(run(sys, "review_cells", { modelId: "PM-RB-B", marks }, "P-002").status, "done");
  const hash = () => ont.get("PM-RB-B").packageHash;

  // Review Focus 2: unresolved AMBIGUOUS, last reviewer, stale hash.
  assert.match(run(sys, "release_plant_model", { modelId: "PM-RB-B", hash: hash() }, "P-001").reason, /unreviewed/);
  assert.equal(run(sys, "review_cells", { modelId: "PM-RB-B", marks: [{ key: "RB-L-421X|presence", value: "excluded" }] }, "P-002").status, "done");
  assert.match(run(sys, "release_plant_model", { modelId: "PM-RB-B", hash: hash() }, "P-002").reason, /last reviewer/);
  assert.match(run(sys, "release_plant_model", { modelId: "PM-RB-B", hash: "0".repeat(64) }, "P-001").reason, /stale/);
  assert.match(run(sys, "release_plant_model", { modelId: "PM-RB-B", hash: hash() }, "P-004").reason, /engineer/);

  const r = run(sys, "release_plant_model", { modelId: "PM-RB-B", hash: hash() }, "P-001");
  assert.equal(r.status, "done", r.reason);
  assert.equal(currentPlantModel(ont).id, "PM-RB-B");
  const a = ont.get("PM-RB-A");
  assert.equal(a.status, "superseded");
  assert.equal(a.governs.to, ont.get("PM-RB-B").governs.from);
  for (const f of ["601", "602", "603", "604"]) {
    assert.ok(ont.get(`PM-RB-B:LIN-RB-L-${f}`), f);
    assert.equal(ont.get(`PM-RB-A:LIN-RB-L-${f}`), null);
  }
  assert.equal(JSON.stringify(ont.get("POS-HLP-B")), hlpB);
  assert.equal(ont.get("PM-RB-B:LIN-RB-L-421X"), null, "a presence cell resolved as excluded keeps the item out of the release");
  assert.ok(ont.get("PM-RB-B:LIN-RB-L-421"));

  // A reviewed AMBIGUOUS cell citing an existing record raises one Issue, once.
  const issues = () => ont.list("Issue", (i) => i.title === "Drawing disagrees with record: 15CQ13|binding");
  assert.equal(issues().length, 1);
  assert.equal(issues().filter((i) => /17BBB01|RB-L-210/.test(i.title)).length, 0);
  assert.match(run(sys, "release_plant_model", { modelId: "PM-RB-B", hash: hash() }, "P-003").reason, /not a draft/);
  assert.equal(issues().length, 1);
});

// ---------- final review fixes ----------
const reviewB = (sys) => {
  const bIds = sys.ont.list("Drawing", (d) => d.rev === "B").map((d) => d.id);
  sys.plant.ingest(bIds, person(sys, "P-002"));
  const decs = [];
  for (const sheet of new Set(sys.ont.get("PM-RB-B").cells.map((c) => c.sheet))) decs.push(run(sys, "review_cells", { modelId: "PM-RB-B", accept: "EXTRACTED", sheet }, "P-002"));
  return decs.filter((d) => d.status === "done");
};

test("final: reversing a review after release is refused and the released plant stays current", () => {
  const sys = createSystem();
  reviewB(sys);
  const marks = sys.ont.get("PM-RB-B").cells.filter((c) => !c.reviewed).map((c) => ({ key: c.key }));
  const last = run(sys, "review_cells", { modelId: "PM-RB-B", marks }, "P-002");
  assert.equal(run(sys, "release_plant_model", { modelId: "PM-RB-B", hash: sys.ont.get("PM-RB-B").packageHash }, "P-001").status, "done");
  const r = sys.actions.reverse(last.decision.id, person(sys, "P-002"));
  assert.equal(r.status, "refused");
  assert.equal(currentPlantModel(sys.ont).id, "PM-RB-B");
});

test("final: reversing an earlier review keeps later reviewers' marks and corrections", () => {
  const sys = createSystem();
  const [first] = reviewB(sys);
  assert.equal(run(sys, "review_cells", { modelId: "PM-RB-B", marks: [{ key: "RB-L-421X|presence", value: "excluded" }] }, "P-003").status, "done");
  assert.equal(sys.actions.reverse(first.decision.id, person(sys, "P-002")).status, "done");
  const m = sys.ont.get("PM-RB-B");
  const c = m.cells.find((x) => x.key === "RB-L-421X|presence");
  assert.deepEqual([c.value, c.reviewed && c.reviewed.by], ["excluded", "P-003"]);
  assert.ok(m.reviews.some((x) => x.by === "P-003"));
  assert.ok(m.cells.some((x) => x.grade === "EXTRACTED" && !x.reviewed), "the first review's bulk accept is undone");
  assert.equal(m.packageHash, packageHash(m));
});

test("final: a corrected binding is what the release links; no Issue for a resolved disagreement", () => {
  const sys = createSystem();
  reviewB(sys);
  const marks = sys.ont.get("PM-RB-B").cells.filter((c) => !c.reviewed && c.key !== "15CQ13|binding").map((c) => ({ key: c.key }));
  run(sys, "review_cells", { modelId: "PM-RB-B", marks }, "P-002");
  // 15CQ13|binding was reviewed in rev A and carried forward; correct it in B
  assert.equal(run(sys, "review_cells", { modelId: "PM-RB-B", marks: [{ key: "15CQ13|binding", value: "SEN-F12-turb" }] }, "P-002").status, "done");
  assert.equal(run(sys, "release_plant_model", { modelId: "PM-RB-B", hash: sys.ont.get("PM-RB-B").packageHash }, "P-001").status, "done");
  assert.equal(sys.ont.get("PM-RB-B:SPT-SP-15CQ13").sensorId, "SEN-F12-turb");
  assert.equal(sys.ont.list("Issue", (i) => i.title === "Drawing disagrees with record: 15CQ13|binding").length, 0);
});

test("final: a review that marks nothing is refused, so it cannot satisfy four eyes", () => {
  const sys = createSystem();
  reviewB(sys);
  const r = run(sys, "review_cells", { modelId: "PM-RB-B", accept: "EXTRACTED", sheet: "RB-NOPE-001" }, "P-003");
  assert.equal(r.status, "refused");
  assert.match(r.reason, /nothing to review|no cells/);
});
