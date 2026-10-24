// Plan 4 Task 6: specs pinned at job start, readings tested to the confirmed spec, and the brief in chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { jobBrief, readingNeed } from "../src/brief.mjs";

const SM = { id: "P-001", kind: "person", clearance: "manager", role: "works_manager" };
const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance, role: s.ont.get(id).role });
const setup = () => {
  const s = createSystem({ seed: 7 });
  const dp2 = s.ont.list("Asset").find((a) => a.positionTag === "DP-2");
  const say = async (text) => {
    const r = await s.channels.inbound("CHN-P-032", "P-032", { text });
    assert.ok(r.replies.length <= 1, `one reply per message: ${text}`);
    return r;
  };
  const permit = () => {
    const p = s.actions.invoke({ action: "open_permit", params: { assetId: dp2.id, kind: "general", holderId: "P-032" }, actor: as(s, "P-008") });
    s.actions.invoke({ action: "record_isolation", params: { permitId: p.decision.objects[0], point: "MCC-1 feeder 2" }, actor: as(s, "P-008") });
  };
  const triage = () => s.runtime.run("Spec Triage", { actingUser: SM, chain: false });
  const approve = () => s.actions.resolve(s.ont.list("Proposal", (x) => x.action === "update_spec" && x.state === "open")[0].id, { verdict: "approve", by: SM });
  const running = () => s.ont.list("Execution", (e) => e.personId === "P-032" && e.state === "running")[0];
  const newJob = (id = "WO-T32") => s.ont.upsert({ id, type: "WorkOrder", kind: "CM", assetId: dp2.id, title: "DP-2 delivery check", state: "open", priority: "P2", assigneeId: "P-032", planned: "2026-10-14" });
  return { s, dp2, say, permit, triage, approve, running, newJob };
};

test("J30 in chat: start sends the brief; start step 1 then gives step 1, and step 2 names its target", async () => {
  const t = setup();
  const expected = jobBrief(t.s.ont.view(as(t.s, "P-032")), "WO-26044").lines;
  const r = await t.say("start WO-26044");
  assert.equal(r.outcome, "recorded");
  assert.deepEqual(r.replies[0].text.split("\n"), expected);
  assert.equal(expected.length, 8);
  const ex = t.running();
  const br = t.s.ont.list("Brief", (b) => b.executionId === ex.id)[0];
  assert.deepEqual(br.specVersions, [{ specId: "SPC-DP-2-delivery", version: 2 }]);
  assert.deepEqual(br.audience, ["P-032", "P-008", "P-001"]);
  assert.deepEqual(br.lines, expected);
  assert.deepEqual(ex.specPins.map((p) => [p.specId, p.version, p.step, p.lo, p.hi]), [["SPC-DP-2-delivery", 2, 2, 114, 126]]);
  t.permit();
  assert.match((await t.say("start step 1")).replies[0].text, /Step 1\/4/);
  assert.match((await t.say("done")).replies[0].text, /Step 2\/4.*target 114–126/);
});

test("J32: after confirmation a new job tests to v3 and 127 L/h is out of band", async () => {
  const t = setup();
  t.triage(); t.approve(); t.newJob();
  const r = await t.say("start WO-T32");
  assert.match(r.replies[0].text, /Target: delivery at 60% stroke 128\.25–141\.75 L\/h/);
  t.permit();
  await t.say("done");
  const bad = await t.say("done 127");
  assert.match(bad.replies[0].text, /1\.25 L\/h under the band 128\.25–141\.75/);
  const st = t.s.ont.get(t.running().id).steps.find((x) => x.step === 2);
  assert.deepEqual([st.inBand, st.specId, st.specVersion], [false, "SPC-DP-2-delivery", 3]);
});

test("a mid-job change does not move the job", async () => {
  const t = setup();
  t.triage();
  await t.say("start WO-26044");
  t.permit();
  await t.say("done");
  t.approve();
  const r = await t.say("done 120");
  assert.match(r.replies[0].text, /changed to v3 after you started; this job keeps v2/);
  const ex = t.s.ont.get(t.running().id), st = ex.steps.find((x) => x.step === 2);
  assert.deepEqual([st.inBand, st.specVersion], [true, 2]);
  assert.deepEqual([ex.specNotice.from, ex.specNotice.to, ex.specNotice.atStep], [2, 3, 2]);
  assert.doesNotMatch((await t.say("done")).replies[0].text, /changed to v3/, "said once");
});

test("old executions keep the version they were held to", async () => {
  const t = setup();
  t.triage(); t.approve(); t.newJob();
  await t.say("start WO-T32");
  t.permit();
  await t.say("done");
  await t.say("done 135");
  const exId = t.running().id;
  assert.equal(t.s.actions.invoke({ action: "update_spec", params: { specId: "SPC-DP-2-delivery", lo: 130, hi: 140, why: "tightened" }, actor: SM }).status, "done");
  assert.equal(t.s.ont.get("SPC-DP-2-delivery").version, 4);
  assert.equal(t.s.ont.get(exId).steps.find((x) => x.step === 2).specVersion, 3);
});

test("a step with no pin falls back to the part band", () => {
  const s = createSystem();
  const ex = s.ont.list("Execution", (e) => e.procedureId === "PRC-CENTRIFUGAL_PUMP-v3" && !e.specPins)[0];
  const st = s.ont.get(ex.procedureId).steps.find((x) => x.requires && x.requires.reading);
  const need = readingNeed(s.ont, ex, st);
  const part = s.ont.list("Part", (p) => p.assetId === ex.assetId && p.name === st.requires.reading.partName)[0];
  assert.deepEqual([need.specId, need.lo, need.hi, need.unit], [null, part.band.lo, part.band.hi, part.band.unit]);
});

test("brief in chat: the full brief during a job, and a nudge with none running", async () => {
  const t = setup();
  assert.match((await t.say("brief")).replies[0].text, /No job is running/);
  await t.say("start WO-26044");
  const full = (await t.say("brief")).replies[0].text;
  assert.match(full, /Same model: check delivery by draw-down/);
  assert.match(full, /ISS-H04/);
});
