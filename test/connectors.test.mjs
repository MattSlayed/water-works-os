// Synthetic connectors (plan 3b Task 1): real API shapes, seeded accounts history, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectors, CONNECTOR_KINDS } from "../src/connectors/index.mjs";

const CLOCK = "2026-10-14T06:00:00.000Z", WINDOW = Date.parse(CLOCK) - 14 * 86400000;
const make = (seed = 7) => createConnectors({ seed, nowIso: () => CLOCK });
const mail = (c) => c.m365.mail.list("accounts@riverbend.example");
const isInvoice = (m) => m.attachments.some((a) => /^TAX INVOICE/.test(a.textLayer || "") || /invoice/i.test(a.name));

test("every connector kind except the CMMS has a store", () => {
  const c = make();
  for (const k of CONNECTOR_KINDS.filter((k) => k !== "cmms")) {
    const [app, store] = k.split(".");
    assert.ok(store ? c[app][store] : c[app], k);
  }
});

test("the accounts mailbox holds 48 Graph messages over 30 days, none after the clock", () => {
  const ms = mail(make());
  assert.equal(ms.length, 48);
  for (const m of ms) {
    assert.ok(m.receivedDateTime <= CLOCK, m.id);
    assert.ok(Date.parse(m.receivedDateTime) >= Date.parse(CLOCK) - 30 * 86400000, m.id);
    assert.ok(m.from.emailAddress.address && typeof m.hasAttachments === "boolean");
  }
  assert.equal(ms.filter(isInvoice).length, 38);
  assert.equal(ms.filter((m) => !m.hasAttachments).length, 4);
});

test("the 14 days before the clock hold 25 invoices, all filed by the clerk", () => {
  const c = make();
  assert.equal(mail(c).filter((m) => Date.parse(m.receivedDateTime) >= WINDOW && isInvoice(m)).length, 25);
  const moves = c.m365.files.moves().filter((x) => Date.parse(x.at) >= WINDOW);
  assert.equal(moves.length, 25);
  assert.ok(moves.every((x) => x.by === "P-043"));
  assert.equal(c.m365.files.moves().filter((x) => Date.parse(x.at) >= Date.parse(CLOCK) - 30 * 86400000).length, 37);
});

test("each trap is findable by its marker", () => {
  const c = make(), byId = new Map(mail(c).map((m) => [m.id, m]));
  for (const k of ["duplicate", "smudged", "noPo", "overPo", "bankChange"]) assert.ok(byId.get(c.traps[k]), k);
  const att = (k) => byId.get(c.traps[k]).attachments[0];
  assert.equal(att("smudged").quality, "smudged");
  assert.match(att("smudged").textLayer, /Total: R \?+/);
  assert.doesNotMatch(att("noPo").textLayer, /^PO:/m);
  const bank = att("bankChange").textLayer.match(/^Bank: (\S+)/m)[1];
  const supplier = att("bankChange").textLayer.match(/^Supplier: (.+)$/m)[1];
  assert.notEqual(bank, c.erp.suppliers().find((s) => s.name === supplier).bank.account);
  // the bank change was never filed; the duplicate was
  assert.ok(!c.m365.files.moves().some((x) => x.sourceId === att("bankChange").id));
  assert.ok(c.m365.files.moves().some((x) => x.sourceId === att("duplicate").id));
});

test("the ERP holds 8 suppliers, 40 POs and receipts for the 37 invoiced", () => {
  const { erp } = make();
  assert.equal(erp.suppliers().length, 8);
  assert.ok(erp.suppliers().every((s) => s.bank.account && s.bank.branch));
  assert.deepEqual(erp.purchaseOrders().map((p) => p.id), Array.from({ length: 40 }, (_, i) => `PO-2026-${String(301 + i).padStart(4, "0")}`));
  assert.equal(new Set(erp.goodsReceipts().map((g) => g.poId)).size, 37);
});

test("a chat photo resolves as an attachment", () => {
  const c = make();
  const a = c.attachment(c.chatPhoto.attachmentId);
  assert.equal(a.quality, "photo");
  assert.equal(c.chatPhoto.channelId, "CHN-P-043");
  assert.equal(c.attachment("ATT-NOPE"), null);
});

test("the seed is deterministic", () => {
  assert.deepEqual(mail(make(7)), mail(make(7)));
  assert.notDeepEqual(mail(make(7)), mail(make(8)));
});

test("filing copies an attachment into a folder and records it; remove undoes it", () => {
  const c = make(), att = mail(c)[0].attachments[0] || mail(c).find((m) => m.hasAttachments).attachments[0];
  const before = c.m365.files.moves().length;
  const item = c.m365.files.copy(att.id, "Accounts/Supplier invoices/Test/2026-10", { by: "P-043", at: CLOCK });
  assert.equal(item.parentReference.path, "/drive/root:/Accounts/Supplier invoices/Test/2026-10");
  assert.ok(c.m365.files.list("Accounts/Supplier invoices/Test").some((x) => x.id === item.id));
  assert.equal(c.m365.files.moves().length, before + 1);
  c.m365.files.remove(item.id);
  assert.equal(c.m365.files.moves().length, before);
  assert.ok(!c.m365.files.list("Accounts/Supplier invoices/Test").length);
});

test("creating the connectors never touches the network", () => {
  const real = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network"); };
  try { make(); } finally { globalThis.fetch = real; }
});
