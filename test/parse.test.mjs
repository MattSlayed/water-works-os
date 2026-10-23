import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "../src/parse.mjs";

const ex = { id: "EXE-1", state: "running" };
const p = (text, ctx = {}, media = []) => parseMessage({ text, media }, { group: false, awaiting: null, execution: null, ...ctx });

test("1: replies to an awaiting question", () => {
  assert.equal(p("Yes", { awaiting: { kind: "submit" } }).kind, "yes");
  assert.equal(p("ok", { awaiting: { kind: "issue" } }).kind, "yes");
  assert.equal(p("no", { awaiting: { kind: "issue" } }).kind, "no");
  assert.deepEqual(p("Check the flush line first", { awaiting: { kind: "note" } }), { kind: "note", confidence: 0.9, fields: { text: "Check the flush line first" } });
});

test("2: start, with or without a work order id", () => {
  assert.deepEqual(p("start").fields, { workOrderId: null });
  assert.deepEqual(p("Start WO-26042 please").fields, { workOrderId: "WO-26042" });
});

test("3: done, with an optional step, value and unit", () => {
  assert.deepEqual(p("done", { execution: ex }), { kind: "done", confidence: 0.9, fields: { step: null, value: null, unit: null } });
  assert.deepEqual(p("step 7 done 110.065 mm", { execution: ex }).fields, { step: 7, value: 110.065, unit: "mm" });
  assert.deepEqual(p("Done 64.98", { execution: ex }).fields, { step: null, value: 64.98, unit: null });
});

test("4: a bare reading is a done for the running job, or a question back without one", () => {
  assert.deepEqual(p("110.02 mm", { execution: ex }).fields, { step: null, value: 110.02, unit: "mm" });
  assert.equal(p("110.02 mm", { execution: ex }).kind, "done");
  const noJob = p("110.02");
  assert.equal(noJob.kind, "ask");
  assert.match(noJob.fields.question, /Which job/);
});

test("5: issue", () => {
  assert.deepEqual(p("Issue: wrong gasket size on the drawing").fields, { title: "wrong gasket size on the drawing" });
});

test("6: question", () => {
  assert.equal(p("Pump C trips on start, what do I check?").kind, "question");
  assert.equal(p("how do I bleed the suction line").kind, "question");
});

test("7: observation", () => {
  const o = p("the sleeve is scored too, not on the job", {}, ["photo:sleeve.jpg"]);
  assert.equal(o.kind, "observation");
  assert.equal(o.confidence, 0.7);
});

test("8: progress in a group, with the first milestone keyword as a hint", () => {
  assert.deepEqual(p("Scraper arms off, bearings out, weld repair tomorrow", { group: true }).fields, { text: "Scraper arms off, bearings out, weld repair tomorrow", milestoneHint: "scraper" });
  assert.equal(p("Bearings out and slewing ring replaced", { group: true }).fields.milestoneHint, "bearing");
  assert.equal(p("Crew on site today", { group: true }).fields.milestoneHint, null);
  assert.equal(p("Scraper arms off", { group: false }).kind, "offtopic");
});

test("9: off-topic, including a yes with nothing awaiting", () => {
  assert.deepEqual(p("yes"), { kind: "offtopic", confidence: 0.3, fields: {} });
  assert.equal(p("Braai at mine on Saturday", { group: true }).kind, "offtopic");
  assert.equal(p("").kind, "offtopic");
  assert.equal(p(null).kind, "offtopic");
});
