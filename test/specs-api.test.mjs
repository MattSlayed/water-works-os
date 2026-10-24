// Plan 4 Task 7: the brief, specs and corrections through the API, and the screens that show them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";

const withServer = async (fn) => {
  const s = createSystem(), srv = createServer(s);
  await new Promise((r) => srv.listen(0, r));
  const call = async (path, { as = "P-001", method = "GET", body } = {}) => {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, { method, headers: { "x-acting-user": as, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try { await fn({ s, call, dp2: s.ont.list("Asset").find((a) => a.positionTag === "DP-2") }); } finally { srv.close(); }
};

test("a technician sees citations, not source text", async () => withServer(async ({ call, dp2 }) => {
  const tech = await call(`/api/assets/${dp2.id}/specs`, { as: "P-032" });
  assert.equal(tech.status, 200);
  const sp = tech.json.specs.find((x) => x.id === "SPC-DP-2-delivery");
  assert.deepEqual([sp.pending.sourceTitle, sp.pending.lo, sp.pending.hi, sp.pending.at], ["Coag dosing after the storm", 128.25, 141.75, "2026-10-13T16:40:00Z"]);
  assert.equal(sp.pending.text, null);
  assert.ok(!JSON.stringify(tech.json).includes("Team, run DP-2"));
  assert.deepEqual(tech.json.candidates, []);
  const mgr = await call(`/api/assets/${dp2.id}/specs`, { as: "P-001" });
  assert.match(mgr.json.specs.find((x) => x.id === "SPC-DP-2-delivery").pending.text, /Team, run DP-2 at 135/);
  assert.ok(mgr.json.candidates.some((c) => c.id === "SCD-ATT-ENG-03-DP-2" && c.grade === "AMBIGUOUS"));
  assert.ok(mgr.json.corrections.some((c) => c.id === "COR-H01"));
}));

test("the brief route follows the viewer's view", async () => withServer(async ({ call, s }) => {
  const r = await call("/api/workorders/WO-26044/brief", { as: "P-032" });
  assert.equal(r.status, 200);
  assert.equal(r.json.lines.length, 8);
  assert.ok(r.json.full.target.length);
  assert.equal((await call("/api/workorders/WO-NOPE/brief", { as: "P-032" })).status, 404);
  // a work order in a zone above a technician's clearance stays out of reach
  const high = s.ont.list("Zone").find((z) => z.clearance === "manager" || z.clearance === "engineer");
  const a = s.ont.list("Asset").find((x) => x.zoneId === (high && high.id));
  if (a) {
    s.ont.upsert({ id: "WO-HIGH", type: "WorkOrder", kind: "CM", assetId: a.id, zoneId: high.id, title: "x", state: "open" });
    assert.equal((await call("/api/workorders/WO-HIGH/brief", { as: "P-032" })).status, 404);
  }
}));

test("recheck runs triage for one asset", async () => withServer(async ({ call, dp2 }) => {
  const r = await call(`/api/assets/${dp2.id}/recheck-specs`, { as: "P-001", method: "POST" });
  assert.equal(r.json.proposals.length, 1);
}));

test("the project page lists its inherited corrections", async () => withServer(async ({ call }) => {
  const r = await call("/api/projects/PRJ-H2025-DOSE", { as: "P-004" });
  const ids = r.json.corrections.map((c) => c.id);
  for (const id of ["COR-H01", "COR-H02", "COR-H03"]) assert.ok(ids.includes(id), id); // COR-H03 is DP-1's, one of the project's assets
  assert.equal(r.json.corrections.find((c) => c.id === "COR-H01").inheritedFrom, null); // made on this project, not inherited
}));

test("J33: a new Synthetic Contractor project on DP-1 inherits COR-H02", async () => withServer(async ({ call, s }) => {
  const dp1 = s.ont.list("Asset").find((a) => a.positionTag === "DP-1");
  s.ont.upsert({ id: "PRJ-T33", type: "Project", title: "DP-1 drive replacement", kind: "contract", start: "2026-11-01", end: "2026-11-20", ownerId: "P-004", assetIds: [dp1.id], assetId: dp1.id,
    contractorEmployer: "Synthetic Contractor (Pty) Ltd", contractorOrgId: "ORG-SYNCON", clientOrgId: "ORG-OWNER", milestones: [], channelId: null, autoSubmit: false });
  const r = await call("/api/projects/PRJ-T33", { as: "P-004" });
  const c = r.json.corrections.find((x) => x.id === "COR-H02");
  assert.equal(c.inheritedFrom, "PRJ-H2025-DOSE");
}));

test("the Copilot answers brief me on DP-2", async () => withServer(async ({ call, dp2 }) => {
  const o = await call("/api/copilot/open", { as: "P-032", method: "POST", body: { assetId: dp2.id } });
  assert.equal(o.status, 200);
  const r = await call(`/api/copilot/${o.json.id}/ask`, { as: "P-032", method: "POST", body: { question: "brief me on DP-2" } });
  assert.match(r.json.answer, /Target: delivery at 60% stroke/);
}));

test("the console counts spec changes waiting, for managers", async () => withServer(async ({ call }) => {
  assert.equal((await call("/api/console", { as: "P-001" })).json.specChanges, 1);
  assert.equal((await call("/api/console", { as: "P-032" })).json.specChanges, null);
}));

test("screens: brief panel, specs tab, spec changes with wrong-source ticks", () => {
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  for (const s of ["/brief", "/specs", "recheck-specs", "record_correction", "Read these yourself", "this make and model", "Spec changes waiting", "this source is wrong", "Corrections"]) assert.ok(app.includes(s), s);
});

test("walk: the asset side panel's tabs wrap instead of scrolling it sideways, and the band inputs are dark", () => {
  const css = readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.tabs \{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.side \{[^}]*min-width: 0/);
  assert.match(css, /\[data-lo\][^{]*\{[^}]*background: var\(--bg2\)/);
});

test("walk: a confirmed spec's own source is not listed again as an agreeing source", async () => withServer(async ({ s, call, dp2 }) => {
  const p = s.ont.list("Proposal", (x) => x.action === "update_spec" && x.state === "open")[0];
  s.actions.resolve(p.id, { verdict: "approve", by: { kind: "person", id: "P-001", clearance: "manager", role: "works_manager" } });
  const sp = (await call(`/api/assets/${dp2.id}/specs`)).json.specs.find((x) => x.id === "SPC-DP-2-delivery");
  assert.ok(!sp.sources.some((x) => x.sourceId === "M365-WRK-001"));
}));
