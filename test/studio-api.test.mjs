// Studio, catalogue, suggestion and intake routes (plan 3b Task 9).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
const J25 = "When a supplier invoice comes into the accounts inbox, read it, check it against the PO and file it in the right supplier folder.";

let srv, base, sys;
before(async () => {
  sys = createSystem({ seed: 7 });
  srv = createServer(sys);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());
const call = async (path, { as = "P-001", method = "GET", body } = {}) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", "x-acting-user": as }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const plan = (as, text = J25) => call("/api/studio/plan", { as, method: "POST", body: { text } });

test("the clerk's J25 text plans a digester, with Claude off", async () => {
  const r = await plan("P-043");
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.screen.verdict, r.json.plan.template, r.json.claude, r.json.problems], ["agent", "digester", "off", []]);
  assert.ok(r.json.sentences.some((s) => /Thandi Mokoena/.test(s)));
});

test("a millwright's J25 plan says the inbox is not allowed", async () => {
  const r = await plan("P-028");
  assert.match(r.json.problems.join("; "), /not allowed/);
});

test("sentences route: an edit comes back parsed; a forbidden one comes back refused", async () => {
  const { plan: { spec }, sentences } = (await plan("P-043")).json;
  const ok = await call("/api/studio/sentences", { as: "P-043", method: "POST", body: { spec, sentences: sentences.map((l) => l.replace("in 4 hours", "in 2 hours")) } });
  assert.deepEqual([ok.status, ok.json.spec.escalateAfterMin, ok.json.problems], [200, 120, []]);
  const bad = await call("/api/studio/sentences", { as: "P-043", method: "POST", body: { spec, sentences: sentences.map((l) => (/post invoice match/.test(l) ? "It may post invoice match without asking." : l)) } });
  assert.match(bad.json.problems.join("; "), /above propose/);
  assert.equal((await call("/api/studio/sentences", { as: "P-044", method: "POST", body: { spec, sentences } })).status, 403);
});

test("replay by the builder gives the J25 counts; nobody else may replay their statement", async () => {
  const { spec } = (await plan("P-043")).json.plan;
  const r = await call("/api/studio/replay", { as: "P-043", method: "POST", body: { spec } });
  assert.deepEqual([r.status, r.json.cases, r.json.agreed], [200, 25, 23]);
  assert.equal((await call("/api/studio/replay", { as: "P-001", method: "POST", body: { spec } })).status, 403);
});

test("the catalogue: the IT administrator and the works manager read it; a millwright may not", async () => {
  assert.equal((await call("/api/catalogue")).status, 200);
  const it = await call("/api/catalogue", { as: "P-045" });
  assert.ok(it.json.connectors.some((c) => c.kind === "m365.files") && it.json.canEdit === true);
  assert.equal((await call("/api/catalogue")).json.canEdit, false);
  assert.equal((await call("/api/catalogue", { as: "P-028" })).status, 403);
});

test("suggestions: a person sees their own open ones only", async () => {
  const r = await call("/api/suggestions", { as: "P-028" });
  assert.ok(r.json.length > 0 && r.json.every((x) => x.personId === "P-028" && x.state === "open"));
  assert.ok((await call("/api/suggestions", { as: "P-001" })).json.every((x) => x.personId === "P-001"));
});

test("intakes: the clerk sees the document beside its cells; a technician gets 404", async () => {
  const att = sys.connectors.m365.mail.list("accounts@riverbend.example").find((m) => m.id === sys.connectors.traps.smudged).attachments[0];
  const d = await call("/api/actions/digest_document", { as: "P-043", method: "POST", body: { params: { attachmentId: att.id, source: { kind: "m365.mail", mailbox: "accounts@riverbend.example" } } } });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  const id = d.json.decision.objects[0];
  const one = await call(`/api/intakes/${id}`, { as: "P-043" });
  assert.deepEqual([one.status, one.json.preview.quality, /\?/.test(one.json.preview.textLayer)], [200, "smudged", true]);
  assert.ok((await call("/api/intakes", { as: "P-043" })).json.some((x) => x.id === id));
  assert.equal((await call(`/api/intakes/${id}`, { as: "P-028" })).status, 404);
  assert.ok(!(await call("/api/intakes", { as: "P-028" })).json.some((x) => x.id === id));
});
