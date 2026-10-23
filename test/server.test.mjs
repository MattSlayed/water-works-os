import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";

let srv, base, sys;
before(async () => {
  sys = createSystem({ seed: 7 });
  srv = createServer(sys);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

const call = async (path, { as = "P-001", method = "GET", body } = {}) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(as ? { "x-acting-user": as } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const techId = () => sys.ont.list("Person", (p) => p.clearance === "technician")[0].id;

test("missing or unknown acting user is 401", async () => {
  assert.equal((await call("/api/me", { as: null })).status, 401);
  assert.equal((await call("/api/me", { as: "P-999" })).status, 401);
});

test("unknown object is 404", async () => {
  assert.equal((await call("/api/objects/NOPE")).status, 404);
});

test("technician cannot fetch a Z06 object; manager can", async () => {
  const chl = sys.ont.list("Asset", (a) => a.positionTag === "CHL-A")[0];
  assert.equal((await call(`/api/objects/${chl.id}`, { as: techId() })).status, 404);
  const r = await call(`/api/objects/${chl.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.object.id, chl.id);
});

test("technician map has no Z06", async () => {
  const r = await call("/api/map", { as: techId() });
  assert.ok(!r.json.zones.some((z) => z.id === "Z06"));
  assert.ok(r.json.zones.some((z) => z.id === "Z07"));
});

test("console payload has train, alerts, proposals, people and runs", async () => {
  const r = await call("/api/console");
  for (const k of ["clock", "train", "alerts", "proposals", "people", "runs", "chemicals"]) assert.ok(k in r.json, k);
  assert.equal(r.json.train.length, 10);
});

test("asset model returns parts with geometry", async () => {
  const hlpb = sys.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const r = await call(`/api/assets/${hlpb.id}/model`);
  assert.equal(r.status, 200);
  assert.ok(r.json.parts.length >= 12);
  assert.ok(r.json.parts[0].geom);
});

test("running an agent returns its run; unknown agent is 404", async () => {
  const r = await call("/api/agents/Asset%20Watch/run", { method: "POST", body: {} });
  assert.equal(r.status, 200);
  assert.match(r.json.id, /^RUN-/);
  assert.equal((await call("/api/agents/Nobody/run", { method: "POST", body: {} })).status, 404);
});

test("resolving a proposal twice gives 409 on the second", async () => {
  const p = sys.ont.list("Proposal", (x) => x.state === "open")[0];
  assert.ok(p, "chain left an open proposal");
  const a = await call(`/api/proposals/${p.id}/resolve`, { method: "POST", as: "P-004", body: { verdict: "approve", reason: "ok" } });
  assert.equal(a.status, 200);
  const b = await call(`/api/proposals/${p.id}/resolve`, { method: "POST", as: "P-004", body: { verdict: "approve" } });
  assert.equal(b.status, 409);
});

test("autonomy change needs engineer clearance", async () => {
  const body = { action: "reserve_parts", level: "propose" };
  assert.equal((await call("/api/agents/Parts%20Readiness/autonomy", { method: "PUT", as: techId(), body })).status, 403);
  assert.equal((await call("/api/agents/Parts%20Readiness/autonomy", { method: "PUT", as: "P-002", body })).status, 200);
});

test("copilot open, ask and tag over HTTP", async () => {
  const hlpb = sys.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const o = await call("/api/copilot/open", { method: "POST", as: techId(), body: { assetId: hlpb.id, partId: "PRT-HLP-B-05" } });
  assert.equal(o.status, 200);
  const a = await call(`/api/copilot/${o.json.id}/ask`, { method: "POST", as: techId(), body: { question: "what should I check next?" } });
  assert.ok(a.json.checks.length > 0);
  const t = await call(`/api/copilot/${o.json.id}/tag`, { method: "POST", as: techId(), body: { partId: "PRT-HLP-B-05", note: "fretting" } });
  assert.equal(t.json.type, "Finding");
});

test("malformed JSON body is 400", async () => {
  const res = await fetch(`${base}/api/agents/Ask/run`, { method: "POST", headers: { "x-acting-user": "P-001", "content-type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 400);
});

test("compliance, knowledge, evals and audit endpoints respond", async () => {
  assert.equal((await call("/api/compliance")).json.items.length, 5);
  assert.ok(Array.isArray((await call("/api/knowledge")).json.findings));
  assert.equal((await call("/api/evals/Ask")).json.total, 4);
  assert.equal((await call("/api/audit")).json.verified, true);
});

test("static index is served", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
});
