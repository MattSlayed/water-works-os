// The Agent Studio (plan 3b Tasks 5-7): screen, keyword planner, statement checks, read-back, lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { screen, planFromText, validateStatement } from "../src/studio.mjs";

export const J25 = "When a supplier invoice comes into the accounts inbox, read it, check it against the PO and file it in the right supplier folder.";
const person = (s, id) => s.ont.get(id);
const plan = (s, text, id) => planFromText(text, { builder: person(s, id), ont: s.ont });
const tool = (spec, action) => spec.tools.find((t) => t.action === action);

test("J25: the invoice text is an agent, and the planner composes the clerk's digester", () => {
  const s = createSystem();
  assert.equal(screen(J25).verdict, "agent");
  const { template, spec } = plan(s, J25, "P-043");
  assert.equal(template, "digester");
  assert.deepEqual(spec.trigger, { kind: "schedule", every: "weekdays at 07:00" });
  assert.deepEqual(spec.params.source, { kind: "m365.mail", mailbox: "accounts@riverbend.example" });
  assert.equal(spec.params.tolerancePct, 2);
  for (const r of ["connector:m365.mail", "connector:erp"]) assert.ok(spec.reads.some((x) => x.source === r), r);
  assert.deepEqual([tool(spec, "digest_document").level, tool(spec, "file_document").level, tool(spec, "file_document").locked, tool(spec, "post_invoice_match").level], ["act", "act", true, "propose"]);
  assert.deepEqual([spec.approver, spec.backup, spec.escalateAfterMin, spec.mode, spec.builderId, spec.onTimeout], ["P-044", "P-001", 240, "shadow", "P-043", "hold"]);
  assert.deepEqual(validateStatement(spec, { ont: s.ont }), { ok: true, problems: [] });
});

test("a threshold and a notify is a rule, planned as a watch", () => {
  const s = createSystem(), text = "Tell me when HLP-B bearing temperature goes above 80";
  assert.equal(screen(text).verdict, "rule");
  const { template, spec } = plan(s, text, "P-028");
  assert.equal(template, "watch");
  assert.deepEqual([spec.params.sensorId, spec.params.above], ["SEN-HLP-B-temp_de", 80]);
  assert.ok(validateStatement(spec, { ont: s.ont }).ok, JSON.stringify(validateStatement(spec, { ont: s.ont })));
});

test("compliance sign-off stays with a person", () => {
  const r = screen("Submit the Blue Drop compliance pack every month");
  assert.equal(r.verdict, "person");
  assert.match(r.reason, /compliance/);
  assert.equal(planFromText("Submit the Blue Drop compliance pack every month", { builder: person(createSystem(), "P-001"), ont: createSystem().ont }).template, null);
});

test("unsure text asks the three questions; a yes on judgement makes it an agent", () => {
  const r = screen("Sort out the monthly stores count");
  assert.equal(r.verdict, "rule");
  assert.deepEqual(r.questions.map((q) => q.id), ["judgement", "frequency", "cost"]);
  assert.equal(screen("Sort out the monthly stores count", { judgement: "yes" }).verdict, "agent");
  assert.deepEqual(screen("Tell me when HLP-B bearing temperature goes above 80").questions, []);
});

test("statement checks: a millwright cannot read the accounts inbox; levels stay within ceilings; never apply on timeout", () => {
  const s = createSystem();
  const mill = plan(s, J25, "P-028").spec;
  assert.match(validateStatement(mill, { ont: s.ont }).problems.join("; "), /m365.mail.*not allowed/);
  const clerk = plan(s, J25, "P-043").spec;
  const act = { ...clerk, tools: clerk.tools.map((t) => (t.action === "post_invoice_match" ? { ...t, level: "act" } : t)) };
  assert.match(validateStatement(act, { ont: s.ont }).problems.join("; "), /above/);
  assert.equal(validateStatement({ ...clerk, onTimeout: "apply" }, { ont: s.ont }).ok, false);
  assert.match(validateStatement({ ...clerk, approver: "P-999" }, { ont: s.ont }).problems.join("; "), /approver/);
  assert.match(validateStatement({ ...clerk, tools: [...clerk.tools, { action: "release_plant_model", level: "act", enabled: true }] }, { ont: s.ont }).problems.join("; "), /release_plant_model/);
});

test("a chaser for open supplier queries older than 5 days", () => {
  const s = createSystem(), { template, spec } = plan(s, "Remind people about open supplier queries older than 5 days", "P-043");
  assert.equal(template, "chaser");
  assert.equal(spec.params.olderThanDays, 5);
  assert.ok(validateStatement(spec, { ont: s.ont }).ok, JSON.stringify(validateStatement(spec, { ont: s.ont })));
});

test("a weekly report and a supplier tidy-up plan and pass their checks", () => {
  const s = createSystem();
  const rep = plan(s, "Send me a weekly report of open issues and work orders", "P-004");
  assert.equal(rep.template, "weekly-report");
  assert.equal(tool(rep.spec, "send_message").level, "notify");
  const tidy = plan(s, "Find duplicate suppliers in the ERP", "P-044");
  assert.equal(tidy.template, "data-tidy");
  for (const p of [rep, tidy]) assert.ok(validateStatement(p.spec, { ont: s.ont }).ok, JSON.stringify(validateStatement(p.spec, { ont: s.ont })));
});

test("text the planner has no template for says so", () => {
  const s = createSystem(), r = plan(s, "Make the coffee", "P-001");
  assert.equal(r.template, null);
  assert.ok(r.reason);
});

test("the watch, weekly-report and tidy-up templates act only through their tools", async () => {
  const { TEMPLATES } = await import("../src/templates.mjs");
  const s = createSystem(), as = (id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance });
  const start = (text, id) => {
    const { spec } = plan(s, text, id);
    s.ont.upsert({ ...spec, mode: "bounded" });
    s.runtime.register({ name: spec.name, version: "1.0.0", owner: id, trigger: spec.trigger, tools: spec.tools.map((t) => t.action), autonomy: Object.fromEntries(spec.tools.map((t) => [t.action, t.level])) }, TEMPLATES[spec.template].run);
    return s.runtime.run(spec.name, { actingUser: as(id) });
  };
  const w = start("Tell me when HLP-B bearing temperature goes above 70", "P-028");
  assert.deepEqual(w.outputs.map((o) => [o.action, o.status]), [["notify", "done"]], JSON.stringify(w.refusals));
  assert.deepEqual(start("Tell me when HLP-B bearing temperature goes above 70", "P-028").outputs, []); // told within the hour
  const r = start("Send me a weekly report of open issues and work orders", "P-004");
  assert.deepEqual(r.outputs.map((o) => [o.action, o.status]), [["draft_document", "done"], ["send_message", "done"]], JSON.stringify(r.refusals));
  const d = start("Find duplicate suppliers in the ERP", "P-044");
  assert.deepEqual(d.outputs.map((o) => [o.action, o.status]), [["draft_document", "done"]], JSON.stringify(d.refusals || d.error));
});

// ---- Task 6: read-back that round-trips ----
const ROUND = ["trigger", "tools", "approver", "backup", "escalateAfterMin", "onTimeout"];
const pick = (o) => Object.fromEntries(ROUND.map((k) => [k, o[k] ?? null]));

test("read-back round-trips for the J25 digester and for default agents", async () => {
  const { statementSentences, specFor } = await import("../src/harness.mjs");
  const { statementFromSentences } = await import("../src/studio.mjs");
  const s = createSystem(), j25 = plan(s, J25, "P-043").spec;
  for (const spec of [j25, specFor(s.ont, "Process Watch"), specFor(s.ont, "Scheduler"), specFor(s.ont, "Chat Intake")]) {
    const back = statementFromSentences(statementSentences(spec, s.ont), spec, s.ont);
    assert.deepEqual(back.problems, [], spec.name);
    assert.deepEqual(pick(back.spec), pick(spec), spec.name);
  }
  const text = statementSentences(j25, s.ont);
  for (const line of ["Every weekday at 07:00 it reads new mail in the Accounts inbox.", "It asks Thandi Mokoena before it will post invoice match.",
    "If Thandi Mokoena does not answer in 4 hours it asks Precious Sithole; if nobody answers it does nothing.", "It is in shadow: it records what it would do and changes nothing."]) assert.ok(text.includes(line), `${line}\n${text.join("\n")}`);
  assert.ok(text.some((l) => /file document.*once IT signs it off/.test(l)), text.join("\n"));
});

test("editing a sentence changes the statement: escalation after 2 hours", async () => {
  const { statementSentences } = await import("../src/harness.mjs");
  const { statementFromSentences } = await import("../src/studio.mjs");
  const s = createSystem(), j25 = plan(s, J25, "P-043").spec;
  const edited = statementSentences(j25, s.ont).map((l) => l.replace("does not answer in 4 hours", "does not answer in 2 hours"));
  const r = statementFromSentences(edited, j25, s.ont);
  assert.deepEqual(r.problems, []);
  assert.equal(r.spec.escalateAfterMin, 120);
  const named = statementFromSentences(statementSentences(j25, s.ont).map((l) => l.replace("It asks Thandi Mokoena before", "It asks Precious Sithole before")), j25, s.ont);
  assert.equal(named.spec.approver, "P-001");
});

test("Review Focus 3: a sentence edited into something forbidden is refused and the statement stays as it was", async () => {
  const { statementSentences } = await import("../src/harness.mjs");
  const { statementFromSentences } = await import("../src/studio.mjs");
  const s = createSystem(), j25 = plan(s, J25, "P-043").spec;
  const edited = statementSentences(j25, s.ont).map((l) => (/post invoice match/.test(l) ? "It may post invoice match without asking." : l));
  const r = statementFromSentences(edited, j25, s.ont);
  assert.match(r.problems.join("; "), /above propose/);
  assert.equal(r.spec.tools.find((t) => t.action === "post_invoice_match").level, "propose");
  const timeout = statementFromSentences(statementSentences(j25, s.ont).map((l) => l.replace("it does nothing", "it goes ahead")), j25, s.ont);
  assert.ok(timeout.problems.length);
  assert.equal(timeout.spec.onTimeout, "hold");
});

test("a shadow statement says it changes nothing and never 'without asking'", async () => {
  const { statementSentences, specFor } = await import("../src/harness.mjs");
  const s = createSystem(), j25 = plan(s, J25, "P-043").spec, text = statementSentences(j25, s.ont).join(" ");
  assert.match(text, /it records what it would do and changes nothing/);
  assert.doesNotMatch(text, /without asking/);
  assert.match(statementSentences({ ...j25, mode: "bounded" }, s.ont).join(" "), /may digest document without asking/);
  assert.match(statementSentences({ ...specFor(s.ont, "Scheduler"), mode: "assisted" }, s.ont).join(" "), /It asks before every change/);
});
