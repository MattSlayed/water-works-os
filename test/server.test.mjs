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

// ---- Phase 2: workforce routes ----
const send = async (channel, sender, text) => {
  const res = await fetch(`${base}/api/channels/${channel}/inbound`, { method: "POST", headers: { "content-type": "application/json", ...(sender ? { "x-channel-sender": sender } : {}) }, body: JSON.stringify({ text }) });
  return { status: res.status, json: await res.json() };
};

test("inbound chat: a member gets one reply; a non-member, a missing sender or an unknown channel is refused", async () => {
  const survey = sys.ont.list("WorkOrder", (w) => w.title === "HLP-B: 6-monthly vibration survey")[0].id;
  const r = await send("CHN-P-028", "P-028", `start ${survey}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.replies.length, 1);
  assert.match(r.json.replies[0].text, /Step 1\/11/);
  assert.equal((await send("CHN-P-028", "P-029", "start")).status, 403);
  assert.equal((await send("CHN-P-028", null, "start")).status, 401);
  assert.equal((await send("CHN-NOPE", "P-028", "start")).status, 404);
  assert.equal((await send("CHN-GRP-CL3", "PAR-001", "Bearings out and slewing ring replaced")).status, 200);
});

test("channels and messages are private to their members (and the manager)", async () => {
  const mine = await call("/api/channels", { as: "P-028" });
  assert.ok(mine.json.some((c) => c.id === "CHN-P-028"));
  assert.ok(!mine.json.some((c) => c.id === "CHN-P-029"));
  assert.equal((await call("/api/channels/CHN-P-028/messages", { as: "P-029" })).status, 404);
  const msgs = await call("/api/channels/CHN-P-028/messages", { as: "P-028" });
  assert.equal(msgs.status, 200);
  assert.ok(msgs.json.some((m) => m.direction === "out"));
  assert.equal((await call("/api/channels/CHN-P-028/messages", { as: "P-001" })).status, 200);
});

test("performance: the person, their supervisor, engineers and the manager; nobody else", async () => {
  for (const who of ["P-028", "P-009", "P-002", "P-001"]) assert.equal((await call("/api/performance/person/P-028", { as: who })).status, 200, who);
  for (const who of ["P-008", "P-029"]) assert.equal((await call("/api/performance/person/P-028", { as: who })).status, 403, who);
  assert.equal((await call("/api/performance/procedure/PRC-CENTRIFUGAL_PUMP-v3", { as: "P-028" })).status, 403);
  const proc = await call("/api/performance/procedure/PRC-CENTRIFUGAL_PUMP-v3", { as: "P-002" });
  assert.equal(proc.status, 200);
  assert.ok(proc.json.steps.length === 11);
  assert.equal((await call("/api/performance/crew", { as: "P-028" })).status, 403);
  const crew = await call("/api/performance/crew", { as: "P-008" });
  assert.equal(crew.status, 200);
  assert.ok(crew.json.procedures.length >= 3);
  assert.doesNotMatch(JSON.stringify(crew.json), /P-0\d\d/);
});

test("projects carry their status and claims; executions, issues and procedures list through the viewer", async () => {
  const p = await call("/api/projects/PRJ-CL3", { as: "P-004" });
  assert.equal(p.status, 200);
  assert.equal(p.json.status.daysSinceReport, 0); // the contractor post in the inbound test above resets the quiet clock
  assert.equal(p.json.status.milestones.claimed, 3);
  assert.ok(p.json.claims.length >= 4);
  assert.ok((await call("/api/projects", { as: "P-004" })).json[0].status);
  assert.ok((await call("/api/issues", { as: "P-028" })).json.length >= 6);
  const procs = await call("/api/procedures", { as: "P-028" });
  assert.ok(procs.json.some((x) => x.id === "PRC-CENTRIFUGAL_PUMP-v3" && x.state === "released"));
  const one = await call("/api/procedures/PRC-CENTRIFUGAL_PUMP-v3", { as: "P-028" });
  assert.equal(one.json.notes.filter((n) => n.step === 8).length, 3);
  assert.equal(one.json.perf, null);
  assert.ok((await call("/api/procedures/PRC-CENTRIFUGAL_PUMP-v3", { as: "P-002" })).json.perf.steps.length === 11);
  const ex = await call("/api/executions?personId=P-028", { as: "P-029" });
  assert.equal(ex.json.length, 0);
});

test("moving an issue to done drafts its close-out; a person can turn on agent submission for themselves only", async () => {
  const r = await call("/api/actions/update_issue", { as: "P-009", method: "POST", body: { params: { issueId: "ISS-H01", patch: { state: "done" } } } });
  assert.equal(r.status, 200);
  assert.ok(sys.ont.list("Draft", (d) => d.kind === "issue-closeout" && d.aboutId === "ISS-H01").length === 1);
  const c = await call("/api/me/consent", { as: "P-031", method: "PUT", body: { autoSubmit: true } });
  assert.equal(c.status, 200);
  assert.equal(sys.ont.get("P-031").autoSubmit, true);
  assert.equal((await call("/api/me/consent", { as: "P-031", method: "PUT", body: { autoSubmit: "yes" } })).status, 400);
});
