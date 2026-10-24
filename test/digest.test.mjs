// The digester's core (plan 3b Task 3): graded extraction, three-way match, duplicates, bank changes, learnt filing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectors } from "../src/connectors/index.mjs";
import { extractFields, matchInvoice, destinationFor, digestVerdict } from "../src/digest.mjs";

const c = createConnectors({ seed: 7, nowIso: () => "2026-10-14T06:00:00.000Z" });
const mails = c.m365.mail.list("accounts@riverbend.example");
const digest = (msgId, opts = {}) => {
  const m = mails.find((x) => x.id === msgId), att = m.attachments[0], at = m.receivedDateTime;
  const { cells, fields } = extractFields(att, { erp: c.erp, at });
  const match = matchInvoice(fields, { erp: c.erp, at, sourceId: att.id, ...opts });
  const history = c.m365.files.moves().filter((x) => x.at < at);
  return { att, cells, fields, match, verdict: digestVerdict({ cells, match }), dest: destinationFor(fields, history) };
};
const cell = (d, key) => d.cells.find((x) => x.key === key);

test("a clean invoice: every cell read clearly, matched, filed where the clerk filed it", () => {
  const d = digest("M365-MSG-001");
  assert.deepEqual(d.cells.map((x) => x.key), ["supplier", "invoiceNo", "date", "poNo", "lines", "vat", "total", "bank"]);
  assert.ok(d.cells.every((x) => x.grade === "EXTRACTED" && x.region.line > 0 && x.reviewed === null), JSON.stringify(d.cells.filter((x) => x.grade !== "EXTRACTED")));
  assert.equal(d.match.ok, true);
  assert.ok(d.match.po && d.match.receipt);
  assert.equal(d.verdict, "file");
  const filed = c.m365.files.moves().find((x) => x.sourceId === d.att.id);
  assert.equal(d.dest.path, filed.path);
  assert.ok(Array.isArray(d.dest.basis) && d.dest.basis.length);
});

test("no PO on the document: the single open PO from that supplier within tolerance is inferred", () => {
  const d = digest(c.traps.noPo), po = cell(d, "poNo");
  assert.equal(po.grade, "INFERRED");
  assert.match(po.reasoning, new RegExp(po.value));
  assert.match(po.value, /^PO-2026-03\d\d$/);
  assert.equal(d.verdict, "file");
});

test("a total 6% over its PO goes to review; a 10% tolerance files it", () => {
  const d = digest(c.traps.overPo);
  const over = d.match.issues.find((i) => i.kind === "over-tolerance");
  assert.match(over.detail, /6(\.\d)?%/);
  assert.equal(d.verdict, "review");
  assert.equal(digest(c.traps.overPo, { tolerancePct: 10 }).verdict, "file");
});

test("a duplicate of an earlier invoice goes to review; the original does not", () => {
  const d = digest(c.traps.duplicate);
  assert.ok(d.match.issues.some((i) => i.kind === "duplicate"));
  assert.equal(d.verdict, "review");
  const orig = mails.find((m) => m.id !== c.traps.duplicate && m.attachments[0] && m.attachments[0].textLayer.includes(`Invoice No: ${d.fields.invoiceNo}`));
  assert.ok(!digest(orig.id).match.issues.some((i) => i.kind === "duplicate"));
});

test("a smudged photo's total is unsure, so it goes to review", () => {
  const d = digest(c.traps.smudged);
  assert.equal(cell(d, "total").grade, "AMBIGUOUS");
  assert.equal(d.fields.total, null);
  assert.equal(d.verdict, "review");
});

test("Review Focus 2: changed bank details go to a person even when the PO, receipt and total match", () => {
  const d = digest(c.traps.bankChange);
  assert.deepEqual(d.match.issues.map((i) => i.kind), ["bank-change"]);
  assert.ok(d.match.po && cell(d, "total").grade === "EXTRACTED");
  assert.equal(d.verdict, "person");
});

test("Review Focus 5: an image with no text layer is unsure in every field and goes to review", () => {
  const { cells, fields } = extractFields({ id: "ATT-X", textLayer: null, quality: "photo" }, { erp: c.erp });
  assert.equal(cells.length, 8);
  assert.ok(cells.every((x) => x.grade === "AMBIGUOUS" && x.reasoning === "no text layer"));
  assert.equal(digestVerdict({ cells, match: matchInvoice(fields, { erp: c.erp }) }), "review");
  assert.doesNotThrow(() => extractFields(null, { erp: c.erp }));
});

test("with no filing history the destination follows the folder pattern", () => {
  const d = digest("M365-MSG-001");
  assert.deepEqual(destinationFor(d.fields, []), { path: `Accounts/Supplier invoices/${d.fields.supplier}/${d.fields.date.slice(0, 7)}`, basis: "pattern" });
});
