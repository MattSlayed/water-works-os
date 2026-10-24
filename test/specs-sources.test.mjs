// Plan 4 Task 1: the engineering sources spec triage reads (works mailbox, Engineering folders, the dose sheet).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectors } from "../src/connectors/index.mjs";

const make = () => createConnectors({ nowIso: "2026-10-14T06:00:00Z" });

test("the works mailbox, engineering folders and dose sheet hold the DP-2 sources", () => {
  const c = make();
  const mail = c.m365.mail.list("works@riverbend.example");
  assert.deepEqual(mail.map((m) => m.id), ["M365-WRK-002", "M365-WRK-001"]);
  assert.match(mail[1].body.content, /run DP-2 at 135 L\/h ±5%/);
  assert.equal(mail[1].from.emailAddress.address, "precious.sithole@riverbend.example");
  assert.deepEqual(c.m365.files.list("Engineering").map((f) => f.attachmentId), ["ATT-ENG-01", "ATT-ENG-02", "ATT-ENG-03"]);
  assert.match(c.attachment("ATT-ENG-01").textLayer, /^Signed: /m);
  assert.match(c.attachment("ATT-ENG-03").textLayer, /1\?5/);
  assert.equal(c.google.sheets.values("Coagulant dose calc!A1:F20").values[2][3], "110");
  assert.deepEqual(c.google.sheets.values("Other!A1:B2").values, []);
});

test("the accounts mailbox and filing log are unchanged by the engineering seed", () => {
  const c = make();
  assert.equal(c.m365.mail.list("accounts@riverbend.example").length, 48);
  assert.equal(c.m365.files.moves().length, 57);
  assert.ok(!c.m365.files.list("Accounts").some((f) => f.attachmentId));
});
