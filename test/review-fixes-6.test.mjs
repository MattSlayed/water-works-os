// Final review of plan 4 (job briefs and spec triage): each test reproduces a confirmed finding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { jobBrief } from "../src/brief.mjs";
import { parseMessage } from "../src/parse.mjs";

const SM = { id: "P-001", kind: "person", clearance: "manager", role: "works_manager" };
const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance, role: s.ont.get(id).role });
const triage = (s) => s.runtime.run("Spec Triage", { actingUser: SM, chain: false });
const open = (s) => s.ont.list("Proposal", (x) => x.action === "update_spec" && x.state === "open");
const dp2 = (s) => s.ont.list("Asset").find((a) => a.positionTag === "DP-2");
const say = (s, text) => s.channels.inbound("CHN-P-032", "P-032", { text });
const permit = (s) => {
  const p = s.actions.invoke({ action: "open_permit", params: { assetId: dp2(s).id, kind: "general", holderId: "P-032" }, actor: as(s, "P-008") });
  s.actions.invoke({ action: "record_isolation", params: { permitId: p.decision.objects[0], point: "MCC-1 feeder 2" }, actor: as(s, "P-008") });
};
const chatSays = (s, text, at = "2026-10-14T05:00:00Z") => s.ont.upsert({ id: `MSG-T-${text.length}`, type: "Message", channelId: "CHN-P-001", direction: "in", from: "P-001", at, text, media: [], audience: ["P-001"] });

test("final: no source text is stored on candidates or their decision, so no object route can leak it", async () => {
  const s = createSystem(), srv = createServer(s);
  assert.ok(!JSON.stringify(s.ont.list("SpecCandidate")).includes("Team, run DP-2"));
  assert.ok(!JSON.stringify(s.ont.list("Decision")).includes("Team, run DP-2"));
  assert.ok(!JSON.stringify(s.ont.list("SpecCandidate")).includes("delivering 125"));
  await new Promise((r) => srv.listen(0, r));
  try {
    const get = (p, who) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, { headers: { "x-acting-user": who } }).then((x) => x.json());
    assert.ok(!JSON.stringify(await get("/api/objects?type=Decision", "P-032")).includes("Team, run DP-2"));
    // the site manager still reads the line, live from the source
    const sp = (await get(`/api/assets/${dp2(s).id}/specs`, "P-001")).specs.find((x) => x.id === "SPC-DP-2-delivery");
    assert.match(sp.pending.text, /Team, run DP-2 at 135/);
  } finally { srv.close(); }
});

test("final: only Spec Triage records candidates, and only its own SCD- records", () => {
  const s = createSystem();
  assert.equal(s.actions.invoke({ action: "record_spec_candidates", params: { candidates: [{ id: "WO-26044", subject: "x" }] }, actor: as(s, "P-032") }).status, "refused");
  const agent = { kind: "agent", id: "Spec Triage", clearance: "manager", onBehalfOf: "P-001" };
  assert.equal(s.actions.invoke({ action: "record_spec_candidates", params: { candidates: [{ id: "WO-26044", subject: "x" }] }, actor: agent, autonomy: "act" }).status, "refused");
  assert.equal(s.ont.get("WO-26044").type, "WorkOrder");
});

test("final: a newer different value withdraws the stale spec change, and a change made against an old version is refused", () => {
  const s = createSystem();
  triage(s);
  const first = open(s)[0];
  chatSays(s, "DP-2 delivery 128–132 L/h from now");
  triage(s);
  assert.deepEqual(open(s).map((p) => [p.params.lo, p.params.hi]), [[128, 132]]);
  assert.equal(s.ont.get(first.id).state, "withdrawn");
  // a proposal made against v2 cannot apply once the spec has moved on
  assert.equal(s.actions.resolve(open(s)[0].id, { verdict: "approve", by: SM }).status, "done");
  assert.match(s.actions.invoke({ action: "update_spec", params: { specId: "SPC-DP-2-delivery", lo: 128.25, hi: 141.75, fromVersion: 2 }, actor: SM }).reason, /changed since/);
});

test("final: only the latest confirmation reverses, and reversing writes a new version with the history kept", () => {
  const s = createSystem();
  triage(s);
  const d3 = s.actions.resolve(open(s)[0].id, { verdict: "approve", by: SM }).decision.id;
  const d4 = s.actions.invoke({ action: "update_spec", params: { specId: "SPC-DP-2-delivery", lo: 130, hi: 140, why: "tightened" }, actor: SM }).decision.id;
  assert.equal(s.actions.reverse(d3, SM).status, "refused");
  assert.equal(s.ont.get("SPC-DP-2-delivery").version, 4);
  assert.equal(s.actions.reverse(d4, SM).status, "done");
  const sp = s.ont.get("SPC-DP-2-delivery");
  assert.deepEqual([sp.version, sp.lo, sp.hi, sp.history.map((h) => h.version)], [5, 128.25, 141.75, [1, 2, 3, 4]]);
});

test("final: a value the site manager edited or rejected is not proposed again, single values included", () => {
  const s = createSystem();
  triage(s);
  assert.equal(s.actions.resolve(open(s)[0].id, { verdict: "edit", params: { lo: 125, hi: 135, candidateId: null }, reason: "half-way for now", by: SM }).status, "done");
  triage(s);
  assert.equal(open(s).length, 0);
  // a single value from the chat, rejected, stays rejected
  const t = createSystem();
  chatSays(t, "DP-2 delivery 130 L/h now");
  triage(t);
  const p = open(t).find((x) => x.params.sourceId === "MSG-T-25");
  assert.ok(p, JSON.stringify(open(t).map((x) => x.params.sourceId)));
  t.actions.resolve(p.id, { verdict: "reject", reason: "no", by: SM });
  triage(t);
  assert.ok(!open(t).some((x) => x.params.sourceId === "MSG-T-25"));
});

test("final: mid-job, the full brief shows the band the job is held to", async () => {
  const s = createSystem();
  triage(s);
  await say(s, "start WO-26044");
  s.actions.resolve(open(s)[0].id, { verdict: "approve", by: SM });
  const full = (await say(s, "brief")).replies[0].text;
  assert.match(full, /114–126 L\/h/);
  assert.match(full, /this job is held to v2/);
});

test("final: after a procedure revision renumbers the steps, the pin follows the step's text", async () => {
  const s = createSystem(), v3 = s.ont.get("PRC-DOSING_PUMP-v3");
  const steps = [{ ...v3.steps[0], id: "PRC-DOSING_PUMP-v4-S01", step: 1, text: "Walk down the dosing skid", requires: { permit: false, isolation: false, reading: null } },
    ...v3.steps.map((x, i) => ({ ...x, id: `PRC-DOSING_PUMP-v4-S0${i + 2}`, step: i + 2 }))];
  s.ont.upsert({ id: v3.id, type: "Procedure", state: "superseded" });
  s.ont.upsert({ ...v3, id: "PRC-DOSING_PUMP-v4", version: 4, state: "released", steps });
  await say(s, "start WO-26044");
  const ex = s.ont.list("Execution", (e) => e.personId === "P-032" && e.state === "running")[0];
  assert.deepEqual(ex.specPins.map((p) => [p.specId, p.step]), [["SPC-DP-2-delivery", 3]]);
});

test("final: a supervisor cannot reverse the site manager's correction", () => {
  const s = createSystem();
  const r = s.actions.invoke({ action: "record_correction", params: { line: "x is wrong.", scope: { assetId: dp2(s).id } }, actor: SM });
  assert.equal(s.actions.reverse(r.decision.id, as(s, "P-008")).status, "refused");
});

test("final: a group message that starts with 'Brief' is not taken as a command", () => {
  assert.notEqual(parseMessage({ text: "Brief update: scaffold is up" }, { group: true }).kind, "brief");
  assert.equal(parseMessage({ text: "brief" }, {}).kind, "brief");
});

test("final: the Specs tab does not list a pending, disagreeing source as agreeing", async () => {
  const s = createSystem(), srv = createServer(s);
  await new Promise((r) => srv.listen(0, r));
  try {
    const d = await fetch(`http://127.0.0.1:${srv.address().port}/api/assets/${dp2(s).id}/specs`, { headers: { "x-acting-user": "P-001" } }).then((x) => x.json());
    assert.ok(!d.specs.find((x) => x.id === "SPC-DP-2-delivery").sources.some((x) => x.sourceId === "M365-WRK-001"));
  } finally { srv.close(); }
});

// ---- tidy-up of the deferred minors ----
import { readFileSync } from "node:fs";

test("minor: DP-1's brief says the suction-ball lesson once", () => {
  const s = createSystem(), dp1 = s.ont.list("Asset").find((a) => a.positionTag === "DP-1");
  s.ont.upsert({ id: "WO-T-DP1", type: "WorkOrder", kind: "CM", assetId: dp1.id, title: "DP-1 check", state: "open", assigneeId: "P-032", planned: "2026-10-14" });
  const b = jobBrief(s.ont.view(as(s, "P-032")), "WO-T-DP1");
  assert.equal(b.lines.filter((l) => /suction ball|suction check-valve ball|Check the ball/i.test(l)).length, 1, b.lines.join("\n"));
});

test("minor: Re-check records who asked; the Copilot brief has no chat-only footer", async () => {
  const s = createSystem(), srv = createServer(s);
  await new Promise((r) => srv.listen(0, r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`, h = (who) => ({ "x-acting-user": who, "content-type": "application/json" });
    const r = await fetch(`${base}/api/assets/${dp2(s).id}/recheck-specs`, { method: "POST", headers: h("P-032") }).then((x) => x.json());
    assert.equal(s.ont.get(r.runId).trigger.by, "P-032");
    const o = await fetch(`${base}/api/copilot/open`, { method: "POST", headers: h("P-032"), body: JSON.stringify({ assetId: dp2(s).id }) }).then((x) => x.json());
    const a = await fetch(`${base}/api/copilot/${o.id}/ask`, { method: "POST", headers: h("P-032"), body: JSON.stringify({ question: "brief me on DP-2" }) }).then((x) => x.json());
    assert.doesNotMatch(a.answer, /Reply "brief"/);
  } finally { srv.close(); }
});

test("minor: a correction note keeps its source; unsure sources stay listed when nothing is open", () => {
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.ok(app.includes("note ? `${po.title}: ${note}`"));
  assert.ok(app.includes('/api/objects?type=SpecCandidate'));
});
