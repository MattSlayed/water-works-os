import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { answerEvidence, writeAnswer } from "../src/answer-evidence.mjs";

const sys = createSystem({ seed: 7 });
const mgr = { id: "P-001", clearance: "manager" }, tech = { id: "P-028", clearance: "technician" };
const ev = (viewer, ...ids) => answerEvidence(sys.ont, sys.tel, viewer, ids.map((id) => ({ id, label: id })));

test("answer evidence: a project is rated as a whole and carries its milestones as dates", () => {
  const [p] = ev(mgr, "PRJ-RES2");
  assert.deepEqual([p.n, p.type, p.status, p.note], [1, "Project", "red", "2 of 4 milestones confirmed"]);
  assert.deepEqual(p.dates.map((d) => [d.at, d.done, d.status]), [["2026-09-14", true, "green"], ["2026-10-02", true, "green"], ["2026-10-30", false, "none"], ["2026-11-14", false, "none"]]);
});

test("answer evidence: a cited permit, requirement and procedure take their indicator item's status, text and area", () => {
  const [ptw, req, prc] = ev(mgr, "PTW-PRJ-2", "REQ-PRJ-5", "PRC-CONFINED_SPACE-v1");
  assert.deepEqual([ptw.status, ptw.area, ptw.dates.map((d) => d.label)], ["red", "compliance", ["Opened", "Expired"]]);
  assert.match(ptw.note, /expired 2026-10-13/);
  assert.deepEqual([req.status, req.dates], ["amber", [{ at: "2026-10-22", label: "Evidence lapses", done: false }]]);
  assert.deepEqual([prc.status, prc.area, prc.dates], ["red", "procedures", []]);
});

test("answer evidence: numbers follow citation order; alerts map severity; unknown and hidden records stay unrated", () => {
  const out = ev(mgr, "ALT-00005", "SEN-RAW-turb@2026-10-14T05:00Z..2026-10-14T06:00Z", "NOPE");
  assert.deepEqual(out.map((s) => [s.n, s.type, s.status]), [[1, "Alert", "amber"], [2, "Sensor", "none"], [3, "Record", "none"]]);
  assert.equal(out[0].dates[0].at, "2026-10-14");
  const [hidden] = ev(tech, "SEN-CHL-A-flow");
  assert.deepEqual([hidden.type, hidden.status, hidden.dates], ["Record", "none", []]);
});

test("answer evidence: a progress-report chunk is dated by its report", () => {
  const chunk = sys.ont.list("Chunk", (c) => c.documentId === "DOC-PR-PRJ-CL4-20261009")[0];
  const [s] = ev(mgr, chunk.id);
  assert.deepEqual(s.dates, [{ at: "2026-10-09", label: "Report", done: true }]);
});

test("answer evidence: a permit that expired earlier today is expired; evidence documents carry their valid-to date", () => {
  const s = createSystem({ seed: 7 });
  s.ont.upsert({ id: "PTW-T", type: "Permit", kind: "hot-work", state: "open", opened: "2026-10-13T08:00:00Z", expires: "2026-10-14T05:00:00Z", isolations: [] });
  const [p] = answerEvidence(s.ont, s.tel, mgr, [{ id: "PTW-T" }]);
  assert.deepEqual(p.dates.at(-1), { at: "2026-10-14", label: "Expired", done: true });
  const doc = s.ont.list("Document", (d) => d.validTo && d.validTo >= "2026-10-14")[0];
  assert.ok(answerEvidence(s.ont, s.tel, mgr, [{ id: doc.id }])[0].dates.some((d) => d.label === "Valid to" && d.at === doc.validTo.slice(0, 10)));
  assert.deepEqual(answerEvidence(s.ont, s.tel, mgr, []), []);
});

test("write-back: an answer that may quote an audience-restricted record is kept at manager; ids never reuse a number", () => {
  const s = createSystem({ seed: 7 });
  const issue = s.ont.list("Issue", (i) => i.audience)[0] || s.ont.upsert({ id: "ISS-T", type: "Issue", title: "t", audience: ["P-028"] });
  assert.equal(writeAnswer(s.ont, tech, { answer: "a", citations: [{ id: "PRJ-RES2" }], model: null }, "t").minClearance, "technician");
  assert.equal(writeAnswer(s.ont, tech, { answer: "b", citations: [{ id: issue.id }], model: null }, "t").minClearance, "manager");
  const c = writeAnswer(s.ont, { id: "P-008", clearance: "supervisor" }, { answer: "c", citations: [], model: "m" }, "t");
  assert.deepEqual([c.id, c.minClearance], ["ANS-3", "manager"]);
  assert.equal(writeAnswer(s.ont, mgr, { answer: "d", citations: [], model: "m" }, "t").minClearance, "manager");
  s.ont.remove("ANS-2");
  assert.equal(writeAnswer(s.ont, mgr, { answer: "e", citations: [], model: null }, "t").id, "ANS-5");
});
