// Digester actions and the digester template (plan 3b Task 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { specId } from "../src/harness.mjs";
import { TEMPLATES } from "../src/templates.mjs";

const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance });
const act = (s, by, action, params) => s.actions.invoke({ action, params, actor: as(s, by) });
const SINCE = new Date(Date.parse("2026-10-14T06:00:00Z") - 14 * 86400000).toISOString();
const TOOLS = { digest_document: "act", file_document: "act", post_invoice_match: "propose", raise_issue: "act" };

// a bounded digester built by the clerk, as the studio will build one (Task 7 adds create_studio_agent)
// the window's mail as if it had just arrived: the clerk has not posted or filed it yet
function fresh(s) {
  const c = s.connectors;
  for (const i of c.erp.invoices().filter((x) => x.receivedAt >= SINCE)) c.erp.unpost(i.id);
  for (const m of c.m365.files.moves().filter((x) => x.at >= SINCE)) c.m365.files.remove(m.itemId);
}
function digester(s, { name = "Clerk Digester", source = { kind: "m365.mail", mailbox: "accounts@riverbend.example" }, signOff = true, unprocessed = true } = {}) {
  if (unprocessed) fresh(s);
  if (signOff) assert.equal(act(s, "P-045", "sign_off_catalogue_line", { kind: "m365.files", op: "write", role: "accounts_clerk" }).status, "done");
  s.ont.upsert({ id: specId(name), type: "AgentSpec", name, version: "1.0.0", builderId: "P-043", owner: "P-043", template: "digester", params: { source, tolerancePct: 2 },
    reads: [{ source: "connector:m365.mail" }, { source: "connector:m365.files" }, { source: "connector:erp" }],
    tools: Object.entries(TOOLS).map(([action, level]) => ({ action, level, enabled: true })), constraints: [], approver: "P-044", backup: "P-001", escalateAfterMin: 240, onTimeout: "hold",
    mode: "bounded", state: "live", promotion: { minCases: 20, minAgreePct: 90, maxBreaches: 0, maxStalePct: 5 } });
  s.runtime.register({ name, version: "1.0.0", owner: "P-043", trigger: { kind: "schedule", every: "weekdays at 07:00" }, tools: Object.keys(TOOLS), autonomy: { ...TOOLS } }, TEMPLATES.digester.run);
  return name;
}
const attOf = (s, msgId) => s.connectors.m365.mail.list("accounts@riverbend.example").find((m) => m.id === msgId).attachments[0].id;
const intakeFor = (s, attId) => s.ont.list("DocumentIntake", (d) => d.attachmentId === attId)[0];

test("a bounded digester over the 14-day window files 23, proposes every post, and never files a trap", () => {
  const s = createSystem(), name = digester(s);
  const run = s.runtime.run(name, { actingUser: as(s, "P-001"), scope: { since: SINCE } });
  assert.equal(run.status, "completed", run.error);
  const decs = s.ont.list("Decision", (d) => d.actorId === name);
  assert.equal(decs.filter((d) => d.action === "file_document").length, 23);
  assert.equal(decs.filter((d) => d.action === "post_invoice_match").length, 0);
  const posts = s.ont.list("Proposal", (p) => p.actorId === name && p.action === "post_invoice_match");
  assert.equal(posts.length, 23);
  assert.ok(posts.every((p) => p.state === "open" && p.approver === "P-044"));
  for (const trap of ["duplicate", "smudged"]) {
    const att = attOf(s, s.connectors.traps[trap]);
    assert.ok(!decs.some((d) => d.action === "file_document" && d.params.attachmentId === att), trap);
    assert.ok(!posts.some((p) => p.params.attachmentId === att), trap);
    assert.equal(intakeFor(s, att).verdict, "review");
  }
});

test("Review Focus 2: the bank-change invoice is never filed or posted; an issue goes to the finance officer", () => {
  const s = createSystem(), name = digester(s), att = attOf(s, s.connectors.traps.bankChange);
  s.runtime.run(name, { actingUser: as(s, "P-043"), scope: { since: "2026-09-01T00:00:00Z", messageIds: [s.connectors.traps.bankChange] } });
  assert.equal(intakeFor(s, att).verdict, "person");
  assert.equal(s.ont.list("Decision", (d) => ["file_document", "post_invoice_match"].includes(d.action) && d.params.attachmentId === att).length, 0);
  assert.equal(s.ont.list("Proposal", (p) => p.params.attachmentId === att).length, 0);
  const iss = s.ont.list("Issue", (i) => i.title === "Supplier query: bank details changed" && i.raisedBy === "P-043");
  assert.equal(iss.length, 1);
  assert.equal(iss[0].assigneeId, "P-044");
});

test("without IT's sign-off the digester may not file", () => {
  const s = createSystem(), name = digester(s, { signOff: false });
  const run = s.runtime.run(name, { actingUser: as(s, "P-043"), scope: { since: SINCE } });
  assert.ok(run.refusals.some((r) => r.action === "file_document" && /needs IT sign-off: m365.files write/.test(r.reason)), JSON.stringify(run.refusals.slice(0, 2)));
  assert.equal(s.ont.list("Decision", (d) => d.action === "file_document").length, 0);
});

test("an intake is seen by the clerk and the approver only", () => {
  const s = createSystem(), name = digester(s);
  s.runtime.run(name, { actingUser: as(s, "P-043"), scope: { since: SINCE } });
  const d = s.ont.list("DocumentIntake")[0];
  assert.deepEqual(d.audience, ["P-043", "P-044"]);
  assert.equal(s.ont.view({ id: "P-028", clearance: "technician" }).get(d.id), null);
  assert.ok(s.ont.view({ id: "P-044", clearance: "supervisor" }).get(d.id));
});

test("correcting the smudged total moves it to file; reversing the review moves it back", () => {
  const s = createSystem(), name = digester(s);
  s.runtime.run(name, { actingUser: as(s, "P-043"), scope: { since: SINCE } });
  const d = intakeFor(s, attOf(s, s.connectors.traps.smudged));
  const po = s.connectors.erp.purchaseOrders().find((p) => p.id === d.fields.poNo);
  const r = act(s, "P-043", "review_intake_cells", { intakeId: d.id, marks: [{ key: "total", verdict: "correct", value: po.total }] });
  assert.equal(r.status, "done", r.reason);
  assert.equal(s.ont.get(d.id).verdict, "file");
  assert.equal(s.ont.get(d.id).fields.total, po.total);
  assert.equal(s.actions.reverse(r.decision.id, as(s, "P-043")).status, "done");
  assert.equal(s.ont.get(d.id).verdict, "review");
});

test("reversing a filing removes the copied file", () => {
  const s = createSystem(), name = digester(s);
  s.runtime.run(name, { actingUser: as(s, "P-043"), scope: { since: SINCE } });
  const dec = s.ont.list("Decision", (d) => d.action === "file_document")[0];
  const item = s.ont.get(dec.params.intakeId).filedItemId;
  assert.ok(s.connectors.m365.files.list().some((f) => f.id === item));
  assert.equal(s.actions.reverse(dec.id, as(s, "P-043")).status, "done");
  assert.ok(!s.connectors.m365.files.list().some((f) => f.id === item));
});

test("a digester reading the clerk's chat digests the photographed invoice", () => {
  const s = createSystem(), name = digester(s, { name: "Clerk Chat Digester", source: { kind: "chat", channelId: "CHN-P-043" } });
  s.runtime.run(name, { actingUser: as(s, "P-043"), scope: { since: SINCE } });
  const ds = s.ont.list("DocumentIntake", (d) => d.source.kind === "chat");
  assert.equal(ds.length, 1);
  assert.equal(ds[0].attachmentId, "ATT-CHAT-0001");
  assert.equal(ds[0].messageId, "MSG-CHAT-PHOTO");
});

test("running twice does not digest the same document twice", () => {
  const s = createSystem(), name = digester(s);
  s.runtime.run(name, { actingUser: as(s, "P-043"), scope: { since: SINCE } });
  const n = s.ont.list("DocumentIntake").length;
  s.runtime.run(name, { actingUser: as(s, "P-043"), scope: { since: SINCE } });
  assert.equal(s.ont.list("DocumentIntake").length, n);
});

test("mail the clerk already posted is not filed or posted again: it goes to review", () => {
  const s = createSystem(), name = digester(s, { unprocessed: false });
  s.runtime.run(name, { actingUser: as(s, "P-043"), scope: { since: SINCE } });
  assert.equal(s.ont.list("Decision", (d) => d.action === "file_document").length, 0);
  assert.equal(s.ont.list("Proposal", (p) => p.action === "post_invoice_match").length, 0);
  const ds = s.ont.list("DocumentIntake");
  assert.equal(ds.length, 25);
  assert.ok(ds.every((d) => d.verdict !== "file"));
  assert.equal(ds.filter((d) => d.match.issues.some((i) => i.kind === "already-posted")).length, 25);
});
