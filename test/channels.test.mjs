import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";

const as = (sys, id) => ({ kind: "person", id, clearance: sys.ont.get(id).clearance });
const setup = () => {
  const sys = createSystem({ seed: 7 });
  const hlpb = sys.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const say = async (text, { ch = "CHN-P-028", from = "P-028", media } = {}) => {
    const r = await sys.channels.inbound(ch, from, { text, media });
    assert.ok(r.replies.length <= 1, `one reply per message: ${text} -> ${r.replies.length}`);
    return r;
  };
  const permit = () => {
    const p = sys.actions.invoke({ action: "open_permit", params: { assetId: hlpb.id, kind: "general", holderId: "P-028" }, actor: as(sys, "P-009") });
    sys.actions.invoke({ action: "record_isolation", params: { permitId: p.decision.objects[0], point: "MCC-2 feeder 4" }, actor: as(sys, "P-009") });
  };
  const running = () => sys.ont.list("Execution", (e) => e.personId === "P-028" && e.state === "running")[0];
  return { sys, hlpb, say, permit, running };
};

test("J8: start, a locked step, the permit, steps by chat, and an out-of-band reading proposes a deviation", async () => {
  const t = setup();
  const s = await t.say("start");
  assert.equal(s.outcome, "recorded");
  assert.match(s.replies[0].text, /Step 1\/11/);
  assert.match(s.replies[0].text, /permit/);
  assert.ok(t.running());
  const locked = await t.say("done");
  assert.equal(locked.outcome, "asked");
  assert.match(locked.replies[0].text, /permit/);
  assert.equal(t.running().steps[0].state, "todo");
  t.permit();
  for (let n = 1; n <= 6; n++) {
    t.sys.tel.tick(5);
    const r = await t.say("done");
    assert.match(r.replies[0].text, new RegExp(`Step ${n + 1}/11`), `after step ${n}`);
  }
  assert.match((await t.say("step 9 done")).replies[0].text, /next step is 7/);
  const bad = await t.say("step 7 done 110.065 mm");
  assert.equal(bad.outcome, "proposed");
  assert.match(bad.replies[0].text, /0\.03 mm over/);
  assert.match(bad.replies[0].text, /deviation/i);
  assert.ok(t.sys.ont.list("Proposal", (p) => p.action === "raise_deviation" && p.state === "open").length === 1);
  assert.equal(t.running().steps[6].value, 110.065);
});

test("an observation gets a cited Copilot answer and an offer; yes raises the issue", async () => {
  const t = setup();
  await t.say("start");
  const o = await t.say("the sleeve is scored too, not on the job", { media: ["photo:sleeve.jpg"] });
  const reply = o.replies[0];
  assert.match(reply.text, /FND-002/);
  assert.match(reply.text, /Raise an issue\? \(yes\/no\)/);
  assert.equal(reply.sentBy, "Technician Copilot");
  assert.equal(reply.awaiting.kind, "issue");
  const y = await t.say("yes");
  const iss = t.sys.ont.list("Issue", (i) => i.raisedBy === "P-028" && i.state === "open").pop();
  assert.ok(iss, "issue raised");
  assert.equal(iss.assetId, t.hlpb.id);
  assert.equal(t.sys.ont.get(iss.partId).name, "Shaft sleeve");
  assert.equal(iss.workOrderId, t.running().workOrderId);
  assert.deepEqual(iss.evidence, ["photo:sleeve.jpg"]);
  assert.match(y.replies[0].text, new RegExp(iss.id));
});

test("a question about a named asset reaches the Copilot without a running job", async () => {
  const t = setup();
  const r = await t.say("What should I check on HLP-B?");
  assert.match(r.replies[0].text, /Next checks/);
  assert.match(r.replies[0].text, /withheld/);
});

test("done with no job running asks once and writes nothing", async () => {
  const t = setup();
  const before = t.sys.ont.list("Decision").length;
  const r = await t.say("done", { ch: "CHN-P-030", from: "P-030" });
  assert.equal(r.outcome, "asked");
  assert.match(r.replies[0].text, /start/);
  assert.equal(t.sys.ont.list("Execution", (e) => e.personId === "P-030" && e.state === "running").length, 0);
  assert.equal(t.sys.ont.list("Decision").filter((d) => d.action !== "send_message").length, before);
});

test("the last step asks for a note; the note lands on the part and the procedure step", async () => {
  const t = setup();
  t.permit();
  await t.say("start");
  const values = { 7: "110.02", 8: "64.98", 10: "0.5" };
  let last;
  for (let n = 1; n <= 11; n++) last = await t.say(values[n] ? `done ${values[n]}` : "done");
  assert.match(last.replies[0].text, /next person/);
  assert.equal(last.replies[0].awaiting.kind, "note");
  const r = await t.say("Sleeve OD was fine but check under the seal face.");
  const kn = t.sys.ont.list("KnowledgeNote", (n) => n.authorId === "P-028").pop();
  assert.equal(kn.text, "Sleeve OD was fine but check under the seal face.");
  assert.equal(kn.assetId, t.hlpb.id);
  assert.equal(kn.procedureId, "PRC-CENTRIFUGAL_PUMP-v3");
  assert.equal(kn.messageId, r.message.id);
  assert.match(r.replies[0].text, /Noted/);
});

test("a contractor's post becomes a claim with photo evidence; a contractor's 'done' writes nothing", async () => {
  const t = setup();
  const claims = () => t.sys.ont.list("ProgressClaim").length;
  const n = claims();
  const r = await t.say("Bearings out and slewing ring replaced", { ch: "CHN-GRP-CL3", from: "PAR-001", media: ["photo:cl3-ring.jpg"] });
  assert.equal(r.replies.length, 0);
  assert.equal(claims(), n + 1);
  const c = t.sys.ont.list("ProgressClaim").pop();
  assert.equal(c.by, "PAR-001");
  assert.equal(c.milestoneId, "M3");
  assert.deepEqual(c.evidence, ["photo:cl3-ring.jpg"]);
  assert.equal(t.sys.ont.get("PRJ-CL3").milestones.find((m) => m.id === "M3").confirmedAt, null);
  const decisions = t.sys.ont.list("Decision").length;
  const d = await t.say("done with the welds, HLP-B is running fine", { ch: "CHN-GRP-CL3", from: "PAR-002" });
  assert.equal(d.outcome, "dropped"); // a group keeps only claims and issues (review #25)
  assert.equal(d.message, null);
  assert.equal(t.sys.ont.list("Decision").length, decisions);
  const i = await t.say("issue: gearbox breather missing", { ch: "CHN-GRP-CL3", from: "PAR-003" });
  assert.equal(i.outcome, "recorded");
  assert.equal(t.sys.ont.list("Issue").pop().projectId, "PRJ-CL3");
});

test("a sender who is not in the channel is refused; off-topic chat is not stored", async () => {
  const t = setup();
  await assert.rejects(t.sys.channels.inbound("CHN-P-028", "P-029", { text: "start" }), /not a member/);
  await assert.rejects(t.sys.channels.inbound("CHN-NOPE", "P-028", { text: "start" }), /channel not found/);
  const n = t.sys.ont.list("Message").length;
  const r = await t.say("Braai at mine on Saturday", { ch: "CHN-GRP-CL3", from: "P-004" });
  assert.equal(r.outcome, "dropped");
  assert.equal(r.message, null);
  assert.equal(t.sys.ont.list("Message").length, n);
  const a = t.sys.audit.all().pop();
  assert.equal(a.outcome, "dropped");
  assert.ok(!JSON.stringify(a).includes("Braai"));
});

test("a person's chat runs and the decisions they produce stay private", async () => {
  const t = setup();
  const r = await t.say("start");
  const other = t.sys.ont.view({ id: "P-029", clearance: "technician" });
  const own = t.sys.ont.view({ id: "P-028", clearance: "technician" });
  assert.equal(other.get(r.runId), null);
  assert.ok(own.get(r.runId));
  const dec = t.sys.ont.list("Decision", (d) => d.action === "send_message").pop();
  assert.equal(other.get(dec.id), null);
  assert.ok(own.get(dec.id));
  assert.equal(other.get(r.replies[0].id), null);
});
