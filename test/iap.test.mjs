import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { verifyIapJwt, googleIapKeys, parseOperators, mayActAs } from "../src/iap.mjs";

const AUD = "/projects/1/locations/r/services/s";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "ES256", use: "sig" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const nowS = () => Math.floor(Date.now() / 1000);
const sign = (claims = {}, header = {}) => {
  const h = b64({ alg: "ES256", typ: "JWT", kid: "k1", ...header });
  const p = b64({ iss: "https://cloud.google.com/iap", aud: AUD, email: "a@b.co", sub: "s", iat: nowS(), exp: nowS() + 600, ...claims });
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${h}.${p}.${sig}`;
};
const opts = { audience: AUD, keys: async () => [jwk] };

test("a valid token gives its email", async () => {
  assert.deepEqual(await verifyIapJwt(sign(), opts), { email: "a@b.co", sub: "s" });
});

test("wrong audience", async () => {
  await assert.rejects(verifyIapJwt(sign({ aud: "/projects/2/locations/r/services/s" }), opts), /audience/);
  await assert.rejects(verifyIapJwt(sign({ aud: [AUD] }), opts), /audience/, "an array is not the audience string");
});

test("wrong issuer", async () => {
  await assert.rejects(verifyIapJwt(sign({ iss: "https://accounts.google.com" }), opts), /issuer/);
});

test("expired", async () => {
  await assert.rejects(verifyIapJwt(sign({ exp: nowS() - 90 }), opts), /expired/);
  await assert.rejects(verifyIapJwt(sign({ exp: undefined }), opts), /expired/, "no exp is not forever");
  assert.equal((await verifyIapJwt(sign({ exp: nowS() - 30 }), opts)).email, "a@b.co", "30 s of clock skew is allowed");
});

test("iat 30 s ahead is accepted", async () => {
  assert.equal((await verifyIapJwt(sign({ iat: nowS() + 30 }), opts)).email, "a@b.co");
  await assert.rejects(verifyIapJwt(sign({ iat: nowS() + 120 }), opts), /not yet valid/);
});

test("tampered payload", async () => {
  const [h, , s] = sign().split(".");
  const p = b64({ iss: "https://cloud.google.com/iap", aud: AUD, email: "evil@x.co", sub: "s", iat: nowS(), exp: nowS() + 600 });
  await assert.rejects(verifyIapJwt(`${h}.${p}.${s}`, opts), /signature/);
});

test("alg HS256", async () => {
  await assert.rejects(verifyIapJwt(sign({}, { alg: "HS256" }), opts), /algorithm/);
  const [, p] = sign().split(".");
  await assert.rejects(verifyIapJwt(`${b64({ alg: "none", kid: "k1" })}.${p}.`, opts), /algorithm/);
});

test("unknown kid refetches once", async () => {
  const calls = [];
  const keys = async (refresh) => { calls.push(refresh); return refresh ? [jwk] : [{ ...jwk, kid: "old" }]; };
  assert.equal((await verifyIapJwt(sign(), { audience: AUD, keys })).email, "a@b.co");
  assert.deepEqual(calls, [false, true]);
  calls.length = 0;
  await assert.rejects(verifyIapJwt(sign({}, { kid: "k9" }), { audience: AUD, keys }), /unknown key/);
  assert.deepEqual(calls, [false, true], "one refetch, not a loop");
});

test("google keys are cached for an hour and refetched on refresh", async () => {
  const urls = [];
  const keys = googleIapKeys(async (u) => { urls.push(u); return { ok: true, json: async () => ({ keys: [jwk] }) }; });
  assert.deepEqual(await keys(false), [jwk]);
  await keys(false);
  assert.deepEqual(urls, ["https://www.gstatic.com/iap/verify/public_key-jwk"]);
  await keys(true);
  assert.equal(urls.length, 2);
});

test("email match ignores case", () => {
  assert.equal(mayActAs(parseOperators("matthew@novatekllc.co.za=*"), "Matthew@NovatekLLC.co.za", "P-028"), true);
});

test("a listed persona only", () => {
  const ops = parseOperators("x@y.z=P-028|P-002");
  assert.equal(mayActAs(ops, "x@y.z", "P-001"), false);
  assert.equal(mayActAs(ops, "x@y.z", "P-002"), true);
  assert.equal(mayActAs(ops, "other@y.z", "P-028"), false);
});

// The server behind IAP.
let srv, base, sys;
before(async () => {
  sys = createSystem({ seed: 7 });
  srv = createServer(sys, { iap: { audience: AUD, keys: async () => [jwk], operators: parseOperators("ok@x.co=*,one@x.co=P-028") } });
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

const call = (path, { email, as, method = "GET", body } = {}) => fetch(base + path, {
  method,
  headers: { "content-type": "application/json", ...(email ? { "x-goog-iap-jwt-assertion": sign({ email }) } : {}), ...(as ? { "x-acting-user": as } : {}) },
  body: body ? JSON.stringify(body) : undefined
});

test("no JWT is a 401", async () => {
  assert.equal((await call("/api/plant", { as: "P-001" })).status, 401);
  const forged = await fetch(base + "/api/plant", { headers: { "x-acting-user": "P-001", "x-goog-iap-jwt-assertion": sign({ email: "ok@x.co", aud: "/projects/9/locations/r/services/s" }) } });
  assert.equal(forged.status, 401, "a token for another service is refused");
});

test("valid JWT and allowed persona is a 200", async () => {
  assert.equal((await call("/api/plant", { email: "ok@x.co", as: "P-001" })).status, 200);
  assert.equal((await call("/api/plant", { email: "one@x.co", as: "P-028" })).status, 200);
});

test("persona not allowed is a 403", async () => {
  assert.equal((await call("/api/plant", { email: "one@x.co", as: "P-001" })).status, 403);
  assert.equal((await call("/api/plant", { email: "stranger@x.co", as: "P-001" })).status, 403);
});

test("no persona is a 400", async () => {
  const r = await call("/api/plant", { email: "ok@x.co" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /say which person you are acting as/);
});

test("events and mcp need the JWT too", async () => {
  const ev = await call("/api/events?as=P-001");
  assert.equal(ev.status, 401);
  await ev.body?.cancel();
  const mcp = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  assert.equal((await call("/mcp", { as: "P-001", method: "POST", body: mcp })).status, 401);
  // signed in, both work: the awaited viewer reaches the stream and the MCP handler
  const ok = await fetch(`${base}/api/events?as=P-001`, { headers: { "x-goog-iap-jwt-assertion": sign({ email: "ok@x.co" }) } });
  assert.equal(ok.status, 200);
  await ok.body.cancel();
  const m = await call("/mcp", { email: "ok@x.co", as: "P-001", method: "POST", body: mcp });
  assert.equal(m.status, 200);
  assert.ok((await m.json()).result.tools.length > 0);
  assert.equal((await call("/mcp", { email: "one@x.co", as: "P-001", method: "POST", body: mcp })).status, 403);
});

test("behind IAP, /mcp accepts the browser's own https origin and still refuses a foreign one", async () => {
  const post = (origin) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", origin, "x-acting-user": "P-001", "x-goog-iap-jwt-assertion": sign({ email: "ok@x.co" }) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal((await post(`https://${new URL(base).host}`)).status, 200, "the graph view's same-origin call");
  assert.equal((await post("https://evil.example")).status, 403);
  assert.equal((await post(`http://evil.example:${new URL(base).port}`)).status, 403);
});

test("the audit records who signed in", async () => {
  const r = await call("/api/actions/raise_alert", { email: "ok@x.co", as: "P-001", method: "POST", body: { params: { targetId: "SEN-FW-turb", title: "signed-in alert" } } });
  assert.equal(r.status, 200);
  const last = sys.audit.all().at(-1);
  assert.equal(last.action, "raise_alert");
  assert.equal(last.actor, "P-001");
  assert.equal(last.signedIn, "ok@x.co");
  assert.ok(sys.audit.verify());
});

test("approving and reversing record who signed in", async () => {
  const p = sys.actions.invoke({ action: "reserve_parts", params: { partIds: ["PRT-HLP-B-06"] }, actor: { kind: "agent", id: "Parts Readiness", clearance: "manager" }, autonomy: "propose" });
  assert.equal(p.status, "proposed");
  const as = "P-001"; // the proposal names a clearance, not a person, as its approver
  const r = await call(`/api/proposals/${p.proposal.id}/resolve`, { email: "ok@x.co", as, method: "POST", body: { verdict: "approve" } });
  assert.equal(r.status, 200);
  const done = sys.audit.all().at(-1);
  assert.deepEqual([done.outcome, done.actor, done.approvedBy, done.signedIn], ["done", "Parts Readiness", as, "ok@x.co"]);
  assert.equal((await call(`/api/decisions/${(await r.json()).decision.id}/reverse`, { email: "ok@x.co", as, method: "POST", body: {} })).status, 200);
  assert.deepEqual([sys.audit.all().at(-1).action, sys.audit.all().at(-1).signedIn], ["reverse", "ok@x.co"]);
});

const chat = (email, sender, text = "start") => fetch(`${base}/api/channels/CHN-P-028/inbound`, { method: "POST", headers: { "content-type": "application/json", "x-channel-sender": sender, ...(email ? { "x-goog-iap-jwt-assertion": sign({ email }) } : {}) }, body: JSON.stringify({ text }) });

test("a document submitted from chat records who signed in", async () => {
  // the Scribe drafts P-028's job card and asks in chat; "yes" submits it as P-028
  const e = sys.ont.list("Execution", (x) => x.state === "done")[0];
  sys.ont.upsert({ id: e.id, type: "Execution", personId: "P-028", audience: ["P-028"] });
  sys.runtime.run("Scribe", { actingUser: { id: "P-028", clearance: "technician" }, scope: { executionId: e.id } });
  assert.equal((await chat("one@x.co", "P-028", "yes")).status, 200);
  const sub = sys.audit.all().findLast((x) => x.action === "submit_document");
  assert.deepEqual([sub.outcome, sub.actor, sub.signedIn], ["done", "P-028", "one@x.co"]);
});

test("the chat webhook needs the JWT and a sender the email may act as", async () => {
  assert.equal((await chat(null, "P-028")).status, 401);
  assert.equal((await chat("one@x.co", "P-001")).status, 403, "one@x.co may act only as P-028");
  assert.equal((await chat("one@x.co", "P-028")).status, 200);
});

test("a write must name its person in a header and be JSON", async () => {
  const jwt = { "x-goog-iap-jwt-assertion": sign({ email: "ok@x.co" }) }, body = JSON.stringify({ params: { targetId: "SEN-FW-turb", title: "t" } });
  const viaQuery = await fetch(`${base}/api/actions/raise_alert?as=P-001`, { method: "POST", headers: { ...jwt, "content-type": "application/json" }, body });
  assert.equal(viaQuery.status, 400);
  assert.match((await viaQuery.json()).error, /header.*\?as=/);
  const form = await fetch(`${base}/api/actions/raise_alert`, { method: "POST", headers: { ...jwt, "x-acting-user": "P-001", "content-type": "application/x-www-form-urlencoded" }, body: "params=x" });
  assert.equal(form.status, 400);
  assert.match((await form.json()).error, /application\/json/);
  const ev = await fetch(`${base}/api/events?as=P-001`, { headers: jwt });
  assert.equal(ev.status, 200, "EventSource cannot send headers, so a GET keeps ?as=");
  await ev.body.cancel();
});

test("no iap option keeps today's behaviour", async () => {
  const s2 = createSystem({ seed: 7 }), plain = createServer(s2);
  await new Promise((r) => plain.listen(0, r));
  try {
    const at = `http://127.0.0.1:${plain.address().port}`;
    assert.equal((await fetch(`${at}/api/plant`, { headers: { "x-acting-user": "P-001" } })).status, 200);
    const r = await fetch(`${at}/api/actions/raise_alert`, { method: "POST", headers: { "content-type": "application/json", "x-acting-user": "P-001" }, body: JSON.stringify({ params: { targetId: "SEN-FW-turb", title: "t" } }) });
    assert.equal(r.status, 200);
    assert.equal(s2.audit.all().at(-1).signedIn, null, "no sign-in, so the audit says so");
    assert.equal((await fetch(`${at}/api/actions/raise_alert?as=P-001`, { method: "POST", body: JSON.stringify({ params: { targetId: "SEN-FW-turb", title: "t" } }) })).status, 200, "a local write may still use ?as=");
  } finally { plain.close(); }
});
