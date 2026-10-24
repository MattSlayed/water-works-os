// Final review of plan 3b (studio, connectors, digester, recommender): each test reproduces a confirmed finding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { planFromText, validateStatement, replay } from "../src/studio.mjs";
import { specFor, shadowRecord } from "../src/harness.mjs";
import { extractFields, matchInvoice, digestVerdict } from "../src/digest.mjs";

const J25 = "When a supplier invoice comes into the accounts inbox, read it, check it against the PO and file it in the right supplier folder.";
const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance, role: s.ont.get(id).role });
const act = (s, by, action, params) => s.actions.invoke({ action, params, actor: as(s, by) });
const plan = (s, text, id) => planFromText(text, { builder: s.ont.get(id), ont: s.ont });
const mail = (s, id) => s.connectors.m365.mail.list("accounts@riverbend.example").find((m) => m.id === id);
const MAILBOX = { kind: "m365.mail", mailbox: "accounts@riverbend.example" };

test("final: a person whose role IT does not allow cannot digest, file or post accounts documents", () => {
  const s = createSystem(), att = mail(s, "M365-MSG-034").attachments[0].id;
  assert.match(act(s, "P-028", "digest_document", { attachmentId: att, source: MAILBOX }).reason, /not allowed/);
  assert.equal(act(s, "P-043", "digest_document", { attachmentId: att, source: MAILBOX }).status, "done");
  assert.match(act(s, "P-028", "file_document", { attachmentId: att, path: "Anywhere/x" }).reason, /not allowed/);
  assert.match(act(s, "P-028", "post_invoice_match", { attachmentId: att, poId: "PO-2026-0301" }).reason, /not allowed/);
});

test("final: a total corrected to something that is not an amount is refused, and a document with no total never files", () => {
  const s = createSystem(), att = mail(s, s.connectors.traps.smudged).attachments[0].id;
  const d = act(s, "P-043", "digest_document", { attachmentId: att, source: MAILBOX }).decision.objects[0];
  assert.match(act(s, "P-043", "review_intake_cells", { intakeId: d, marks: [{ key: "total", verdict: "correct", value: "?????.??" }] }).reason, /amount/);
  const { cells, fields } = extractFields(s.connectors.attachment(att), { erp: s.connectors.erp });
  const reviewed = cells.map((c) => (c.key === "total" ? { ...c, reviewed: { by: "P-043", at: "x" } } : c));
  assert.equal(digestVerdict({ cells: reviewed, match: matchInvoice({ ...fields, total: null }, { erp: s.connectors.erp }) }), "review");
});

test("final: a statement whose reads leave out its source is still checked against the catalogue (replay and create)", () => {
  const s = createSystem(), spec = { ...plan(s, J25, "P-028").spec, reads: [] };
  assert.match(validateStatement(spec, { ont: s.ont }).problems.join("; "), /m365.mail.*not allowed/);
});

test("final: replay writes nothing; starting the agent records the replay of the statement it starts with", () => {
  const s = createSystem(), spec = plan(s, J25, "P-043").spec;
  const before = s.ont.list("ShadowAction").length;
  assert.equal(replay(s, spec).cases, 25);
  assert.equal(s.ont.list("ShadowAction").length, before);
  assert.equal(act(s, "P-043", "create_studio_agent", { spec }).status, "done");
  assert.deepEqual([shadowRecord(s.ont, spec.name).cases, shadowRecord(s.ont, spec.name).agreePct], [25, 92]);
});

test("final: replay covers the last 14 days of the source, so the J25 record holds as the plant clock runs", () => {
  const s = createSystem();
  s.tel.tick(72 * 60);
  const r = replay(s, plan(s, J25, "P-043").spec);
  assert.deepEqual([r.cases, r.agreed, r.unsure, r.caught], [25, 23, 1, 1]);
});

test("final: a studio agent's runs and shadow actions are seen by its builder and approver only; a stranger who starts it gets a summary", async () => {
  const s = createSystem(), srv = createServer(s), spec = plan(s, J25, "P-043").spec;
  act(s, "P-043", "create_studio_agent", { spec });
  await new Promise((r) => srv.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/agents/${encodeURIComponent(spec.name)}/run`, { method: "POST", headers: { "x-acting-user": "P-008", "content-type": "application/json" }, body: JSON.stringify({ scope: { since: "2026-10-10T00:00:00Z" } }) });
    const run = await res.json();
    assert.equal(res.status, 200);
    assert.equal(run.reasoning, undefined);
    assert.equal(run.calls, undefined);
    assert.deepEqual(s.ont.get(run.id).audience, ["P-043", "P-044"]);
    const shas = s.ont.list("ShadowAction", (x) => x.agent === spec.name && !x.replay);
    assert.ok(shas.length && shas.every((x) => JSON.stringify(x.audience) === JSON.stringify(["P-043", "P-044"])));
  } finally { srv.close(); }
});

test("final: the agent's approver gets the Promote button", () => {
  assert.ok(readFileSync(new URL("../web/app.js", import.meta.url), "utf8").includes("s.approver === state.me.id"));
});

test("final: a watch only tells its builder, so it is promoted on a second person's say, not on a record it cannot build", () => {
  const s = createSystem(), { spec } = plan(s, "Tell me when HLP-B bearing temperature goes above 80", "P-028");
  assert.equal(act(s, "P-028", "create_studio_agent", { spec }).status, "done");
  assert.equal(specFor(s.ont, spec.name).promotion.minCases, 0);
  assert.equal(act(s, spec.approver, "promote_agent", { agent: spec.name, to: "assisted" }).status, "done");
});

test("final: a schedule the studio cannot run is refused", () => {
  const s = createSystem(), spec = plan(s, J25, "P-043").spec;
  assert.match(validateStatement({ ...spec, trigger: { kind: "schedule", every: "every hour" } }, { ont: s.ont }).problems.join("; "), /schedule/);
});

test("final: the planner builds a watch on a filter's head loss", () => {
  const s = createSystem(), r = plan(s, "Tell me when F07 head loss goes above 2", "P-004");
  assert.equal(r.template, "watch", r.reason);
  assert.equal(r.spec.params.sensorId, "SEN-F07-headloss");
});

test("final: an invoice already posted in the ERP, or billed again on an invoiced PO, goes to review", () => {
  const s = createSystem(), c = s.connectors, m = mail(s, "M365-MSG-002"), att = m.attachments[0], now = "2026-10-14T06:00:00Z";
  const { fields } = extractFields(att, { erp: c.erp, at: m.receivedDateTime });
  assert.ok(matchInvoice(fields, { erp: c.erp, at: m.receivedDateTime, asOf: now, sourceId: att.id }).issues.some((i) => i.kind === "already-posted"));
  const again = matchInvoice({ ...fields, invoiceNo: "INV-00001" }, { erp: c.erp, at: now, asOf: now, sourceId: "ATT-NEW" });
  assert.ok(again.issues.some((i) => i.kind === "po-invoiced"), JSON.stringify(again.issues));
  // in a replay, at the time the mail arrived, the clerk had not posted it yet
  assert.deepEqual(matchInvoice(fields, { erp: c.erp, at: m.receivedDateTime, sourceId: att.id }).issues, []);
});

test("final: changed bank details are caught when the supplier is written differently from the ERP", () => {
  const s = createSystem(), att = s.connectors.attachment(mail(s, s.connectors.traps.bankChange).attachments[0].id);
  const name = att.textLayer.match(/^Supplier: (.+)$/m)[1];
  for (const variant of [name.toUpperCase(), name.replace(" (Pty) Ltd", "").replace(" CC", "")]) {
    const a = { ...att, textLayer: att.textLayer.replace(`Supplier: ${name}`, `Supplier: ${variant}`) };
    const { cells, fields } = extractFields(a, { erp: s.connectors.erp });
    assert.equal(digestVerdict({ cells, match: matchInvoice(fields, { erp: s.connectors.erp, sourceId: a.id }) }), "person", variant);
  }
});

test("final: the builder cannot approve their own agent", () => {
  const s = createSystem(), spec = plan(s, J25, "P-043").spec;
  assert.match(validateStatement({ ...spec, approver: "P-043" }, { ont: s.ont }).problems.join("; "), /approver/);
});
