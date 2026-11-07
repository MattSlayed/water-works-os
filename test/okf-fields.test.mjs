// OKF v0.2 §5 fields on procedures and notes: role-only review events, a status that follows the workflow, a review date that surfaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { isStale, staleAfter } from "../src/functions.mjs";
import { jobBrief } from "../src/brief.mjs";

const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance });
const STATUS = { draft: "draft", released: "stable", superseded: "deprecated", withdrawn: "deprecated" };

test("every seeded procedure and note carries the fields, and no review event names a person", () => {
  const s = createSystem({ seed: 7 });
  const procs = s.ont.list("Procedure");
  assert.ok(procs.length > 5);
  for (const p of procs) {
    assert.equal(p.status, STATUS[p.state], p.id);
    assert.ok(p.sources.length && p.sources.every((x) => x.resource), p.id);
    assert.ok(p.stale_after > p.releasedAt, p.id);
    assert.ok(p.verified.length && p.verified.every((v) => /^human:[a-z_]+$/.test(v.by) && v.at), p.id);
  }
  for (const n of s.ont.list("KnowledgeNote")) {
    assert.equal("verified" in n, false, `${n.id}: OKF reads no key as unverified`);
    assert.equal(n.status, "draft");
    assert.ok(n.stale_after > n.at && n.sources[0].resource, n.id);
  }
});

test("a draft is unreviewed with no date; releasing reviews it, dates it and deprecates the old version", () => {
  const s = createSystem({ seed: 7 });
  const v3 = s.ont.get("PRC-CENTRIFUGAL_PUMP-v3");
  const author = s.ont.list("Competency", (x) => x.competency === "c-author" && x.validTo >= s.tel.now().slice(0, 10))[0].personId;
  const r = s.actions.invoke({ action: "propose_procedure_version", params: { procedureId: v3.id, steps: v3.steps, reason: "Reviewed, no change" }, actor: as(s, author) });
  assert.equal(r.status, "done", r.reason);
  const v4 = s.ont.get("PRC-CENTRIFUGAL_PUMP-v4");
  assert.equal(v4.status, "draft");
  assert.equal(v4.verified, undefined);
  assert.equal(v4.stale_after, undefined);
  assert.deepEqual(v4.sources.map((x) => x.resource), [...v3.sources.map((x) => x.resource), v3.id]);
  assert.equal(s.actions.invoke({ action: "release_procedure", params: { procedureId: v4.id }, actor: as(s, "P-001") }).status, "done");
  const out = s.ont.get(v4.id);
  assert.equal(out.status, "stable");
  assert.equal(out.verified.at(-1).by, "human:works_manager");
  assert.equal(out.stale_after, staleAfter(s.tel.now()));
  assert.equal(s.ont.get(v3.id).status, "deprecated");
});

test("a new note is unverified until a person checks it, and it can't be verified twice", () => {
  const s = createSystem({ seed: 7 });
  const asset = s.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const r = s.actions.invoke({ action: "add_knowledge_note", params: { text: "Check the flush line.", assetId: asset.id }, actor: as(s, "P-028") });
  assert.equal(r.status, "done", r.reason);
  const id = s.ont.list("KnowledgeNote", (n) => n.text === "Check the flush line.")[0].id;
  assert.ok(!s.ont.get(id).verified);
  assert.equal(s.ont.get(id).status, "draft");
  assert.equal(s.ont.get(id).sources[0].resource, asset.id);
  const engineer = s.ont.list("Person", (p) => p.clearance === "engineer")[0];
  assert.equal(s.actions.invoke({ action: "verify_knowledge_note", params: { noteId: id }, actor: as(s, engineer.id) }).status, "done");
  const n = s.ont.get(id);
  assert.deepEqual(n.verified.map((v) => v.by), [`human:${engineer.role}`]);
  assert.equal(n.status, "stable");
  assert.equal(s.actions.invoke({ action: "verify_knowledge_note", params: { noteId: id }, actor: as(s, engineer.id) }).status, "refused");
});

test("stale means now is on or after the date; a missing date is never stale", () => {
  const o = { stale_after: "2027-02-01T00:00:00.000Z" };
  assert.equal(isStale(o, "2027-01-31T23:59:59Z"), false);
  assert.equal(isStale(o, "2027-02-01T00:00:00Z"), true);
  assert.equal(isStale({}, "2030-01-01T00:00:00Z"), false);
});

test("nothing is overdue today; a job on an overdue procedure says so in the brief and the steward tells the engineers once", () => {
  const s = createSystem({ seed: 7 });
  const now = s.tel.now();
  const wo = s.ont.list("WorkOrder", (w) => (s.ont.get(w.assetId) || {}).template === "centrifugal_pump")[0];
  const viewer = s.ont.view(as(s, "P-001"));
  assert.doesNotMatch(jobBrief(viewer, wo.id, { now }).lines.join("\n"), /review date/);

  const p = s.ont.get("PRC-CENTRIFUGAL_PUMP-v3");
  s.ont.upsert({ id: p.id, type: p.type, stale_after: "2026-01-01T00:00:00.000Z" });
  const note = s.ont.get("KN-H01");
  s.ont.upsert({ id: note.id, type: note.type, stale_after: "2026-01-01T00:00:00.000Z" });
  const b = jobBrief(viewer, wo.id, { now });
  assert.match(b.full.open[0].text, /past its review date \(2026-01-01\)/);
  assert.ok(b.full.watchOuts.some((x) => /KN-H01, past its review date/.test(x.text)));

  const SYS = { kind: "system", id: "system", clearance: "manager" };
  const told = () => s.ont.list("Notification", (n) => n.aboutId === p.id && /past its review date/.test(n.message));
  s.runtime.run("Procedure Steward", { actingUser: SYS, chain: false });
  assert.equal(told().length, 1);
  s.runtime.run("Procedure Steward", { actingUser: SYS, chain: false });
  assert.equal(told().length, 1, "once a week");
});
