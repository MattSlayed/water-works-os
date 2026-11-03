import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createCopilot } from "../src/copilot.mjs";

const johan = { id: "P-023", clearance: "technician", kind: "person" };
const sup = { id: "P-008", clearance: "supervisor", kind: "person" };
const setup = () => {
  const sys = createSystem({ seed: 7 });
  sys.runtime.run("Asset Watch", { actingUser: { id: "P-001", clearance: "manager" }, chain: false });
  const hlpb = sys.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  return { sys, hlpb };
};

test("open on an HLP-B part returns situational insight", () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: johan });
  assert.equal(s.insight.part.name, "Bearing housing");
  assert.ok(s.insight.alerts.length >= 1);
  assert.ok(s.insight.findings.some((f) => f.id === "FND-001"));
  assert.ok(s.insight.sensors.some((x) => x.id === "SEN-HLP-B-vib_de"));
});

test("open on an asset the user cannot see throws not found", () => {
  const { sys } = setup();
  const chl = sys.ont.list("Asset", (a) => a.positionTag === "CHL-A")[0];
  assert.throws(() => sys.copilot.open({ assetId: chl.id, user: johan }), /not found/);
});

test("next checks are ordered and cited; intrusive ones withheld without a permit", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, user: johan });
  const r = await s.ask("What should I check next?");
  assert.ok(r.checks.length >= 2);
  assert.ok(r.citations.length >= 1);
  assert.ok(r.checks.every((c) => !c.intrusive));
  assert.match(r.withheld, /permit/);
});

test("with an open permit and isolation, intrusive checks appear, soft foot first", async () => {
  const { sys, hlpb } = setup();
  const p = sys.actions.invoke({ action: "open_permit", params: { assetId: hlpb.id, kind: "general", holderId: johan.id }, actor: sup });
  sys.actions.invoke({ action: "record_isolation", params: { permitId: p.decision.objects[0], point: "MCC-2 feeder 4" }, actor: sup });
  const s = sys.copilot.open({ assetId: hlpb.id, user: johan });
  const r = await s.ask("what next");
  assert.ok(r.checks.some((c) => c.intrusive));
  assert.equal(r.withheld, null);
  const intrusive = r.checks.filter((c) => c.intrusive);
  assert.match(intrusive[0].text, /soft foot/i);
  assert.ok(r.lookHere.length >= 1);
});

test("a reading over the band is called out and a deviation is proposed", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: johan });
  await s.ask("Can I reuse the housing? bore reads 110.065");
  const r = await s.ask("yes");
  assert.match(r.answer, /over the limit/i);
  assert.ok(sys.ont.list("Proposal", (p) => p.action === "raise_deviation").length === 1);
  assert.ok(sys.ont.list("Reading", (x) => !x.id.startsWith("RDG-H")).length === 1); // the seeded morning checks aside
});

test("a reading inside the band is accepted", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: johan });
  await s.ask("bore is 110.020, ok to reuse?");
  const r = await s.ask("yes");
  assert.match(r.answer, /within/i);
  assert.equal(sys.ont.list("Proposal", (p) => p.action === "raise_deviation").length, 0);
});

test("history question cites past work and findings", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, user: johan });
  const r = await s.ask("Has this happened before?");
  assert.ok(r.citations.some((c) => c.id === "FND-001"));
});

test("tag creates a finding linked to part and work order and emits tagged", () => {
  const { sys, hlpb } = setup();
  const events = [];
  sys.copilot.on((e) => events.push(e));
  const s = sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", workOrderId: "WO-26043", user: johan });
  const f = s.tag({ partId: "PRT-HLP-B-05", note: "fretting on the bore, 12 o'clock", reading: 110.065 });
  assert.equal(f.type, "Finding");
  assert.ok(sys.ont.links(f.id, { rel: "ABOUT" }).some((l) => l.to === "PRT-HLP-B-05"));
  assert.ok(sys.ont.links(f.id, { rel: "ON" }).some((l) => l.to === "WO-26043"));
  assert.equal(events[0].kind, "tagged");
});

test("unknown session id throws", async () => {
  const { sys } = setup();
  await assert.rejects(() => sys.copilot.ask("NOPE", "hi"), /session/);
});

test("when every check for the part is withheld, the answer says so and gives the general checks", async () => {
  const { sys, hlpb } = setup();
  const sleeve = sys.ont.list("Part", (p) => p.assetId === hlpb.id && p.name === "Shaft sleeve")[0];
  const r = await sys.copilot.open({ assetId: hlpb.id, partId: sleeve.id, user: johan }).ask("what next");
  assert.ok(r.checks.length > 0);
  assert.ok(r.checks.every((c) => !c.intrusive));
  assert.match(r.answer, /Nothing specific to this part I can show yet\. General checks:/);
  assert.match(r.answer, /withheld/);
});

const readings = (sys) => sys.ont.list("Reading", (x) => !x.id.startsWith("RDG-H")).length;
const deviations = (sys) => sys.ont.list("Proposal", (p) => p.action === "raise_deviation").length;
const withLlm = (sys, reply = "from the model") => {
  const calls = [];
  return { calls, copilot: createCopilot({ ont: sys.ont, tel: sys.tel, actions: sys.actions, runtime: sys.runtime, llm: async (a) => { calls.push(a); return reply; } }) };
};

test("a decimal that cannot be this part's measurement writes nothing and offers nothing", async () => {
  const { sys, hlpb } = setup();
  const r = await sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: johan }).ask("Is 4.5 the vibration alarm limit?");
  assert.equal(r.confirm, undefined);
  assert.equal(readings(sys), 0);
  assert.equal(deviations(sys), 0);
});

test("a likely reading is only offered: nothing is written until the artisan confirms", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: johan });
  const r = await s.ask("I measured 110.53 on this part");
  assert.deepEqual(r.confirm, { partId: "PRT-HLP-B-05", measure: "DE bore diameter", value: 110.53, unit: "mm" });
  assert.match(r.answer, /not recorded yet/i);
  assert.equal(readings(sys), 0);
  assert.equal(deviations(sys), 0);
  await s.ask("yes");
  assert.equal(readings(sys), 1);
  assert.equal(deviations(sys), 1);
  await s.ask("yes");
  assert.equal(readings(sys), 1, "a second yes has nothing left to confirm");
});

test("moving on drops an offered reading, and a corrected figure replaces it", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: johan });
  await s.ask("bore reads 110.53");
  await s.ask("what next");
  await s.ask("yes");
  assert.equal(readings(sys), 0, "the yes came after moving on");
  await s.ask("bore reads 110.53");
  await s.ask("sorry, 110.053");
  await s.ask("yes");
  assert.equal(sys.ont.list("Reading", (x) => !x.id.startsWith("RDG-H"))[0].value, 110.053);
});

test("only a bare yes confirms: a sentence that starts like one does not", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: johan });
  await s.ask("bore reads 110.53");
  await s.ask("ok to reuse?");
  assert.equal(readings(sys), 0);
  await s.ask("bore reads 110.53");
  await s.ask("Yes please.");
  assert.equal(readings(sys), 1);
});

test("the model never words a recorded outcome, and later answers are told what was recorded", async () => {
  const { sys, hlpb } = setup();
  const { calls, copilot } = withLlm(sys, "I have no record that this was logged");
  const s = copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: johan });
  const offered = await s.ask("I measured 110.53 on this part");
  const done = await s.ask("yes");
  assert.equal(calls.length, 0);
  assert.equal(offered.model, undefined);
  assert.equal(done.model, undefined);
  assert.match(done.answer, /I have recorded the reading and proposed a deviation/);
  await s.ask("what next");
  assert.match(JSON.stringify(calls[0].context.recorded), /110\.53/);
});

test("naming a part focuses it: its detail, its look-here, and the session follows it", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, user: johan });
  const seal = sys.ont.list("Part", (p) => p.assetId === hlpb.id && p.name === "Mechanical seal")[0];
  const r = await s.ask("Tell me about the mechanical seal");
  assert.equal(r.focus, seal.id);
  assert.deepEqual(r.lookHere, [seal.id]);
  assert.match(r.answer, /^Mechanical seal/);
  assert.ok(r.answer.includes(seal.erpNo));
  assert.equal(sys.copilot.get(s.id).partId, seal.id);
  const next = await s.ask("Tell me about the seal");
  assert.equal(next.focus, seal.id, "the last word of a name is enough when only one part ends in it");
});

test("a named part still withholds intrusive steps without a permit", async () => {
  const { sys, hlpb } = setup();
  const r = await sys.copilot.open({ assetId: hlpb.id, user: johan }).ask("Tell me about the mechanical seal");
  assert.ok(r.withheld, "the seal's strip-out steps are intrusive");
  assert.ok((r.checks || []).every((c) => !c.intrusive));
});

test("a part with no check it can show falls back to the general safe checks, still looking at the part", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, user: johan });
  const seal = await s.ask("Tell me about the mechanical seal");
  const r = await s.ask("What should I check next?");
  assert.ok(r.checks.length > 0, "confirming the permit is what the seal is waiting on");
  assert.ok(r.checks.every((c) => !c.intrusive));
  assert.ok(r.withheld);
  assert.deepEqual(r.lookHere, [seal.focus]);
});

test("an ambiguous name lights every match but focuses none; no name changes nothing", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, user: johan });
  const both = sys.ont.list("Part", (p) => p.assetId === hlpb.id && /\bbearing$/i.test(p.name)).map((p) => p.id);
  const r = await s.ask("Tell me about the bearing");
  assert.equal(r.focus, undefined);
  assert.deepEqual([...r.lookHere].sort(), [...both].sort());
  assert.equal(sys.copilot.get(s.id).partId, null);
  assert.equal((await s.ask("What should I check next?")).focus, undefined);
});

test("drive-end and DE name the same bearing, and non-drive-end is not it", async () => {
  const { sys, hlpb } = setup();
  const name = (id) => sys.ont.get(id).name;
  assert.equal(name((await sys.copilot.open({ assetId: hlpb.id, user: johan }).ask("check the DE bearing")).focus), "Drive-end bearing");
  assert.equal(name((await sys.copilot.open({ assetId: hlpb.id, user: johan }).ask("check the non-drive-end bearing")).focus), "Non-drive-end bearing");
});

test("naming a part narrows a stock answer to it, and safety answers look at it", async () => {
  const { sys, hlpb } = setup();
  const seal = sys.ont.list("Part", (p) => p.assetId === hlpb.id && p.name === "Mechanical seal")[0];
  const stock = await sys.copilot.open({ assetId: hlpb.id, user: johan }).ask("Do we have a spare mechanical seal?");
  assert.equal(stock.answer.split("\n").length, 1);
  assert.ok(stock.answer.startsWith("Mechanical seal"));
  assert.ok(seal);
  const casing = await sys.copilot.open({ assetId: hlpb.id, user: johan }).ask("Is it safe to open the casing?");
  assert.equal(sys.ont.get(casing.focus).name, "Volute casing");
});

test("the model is given the asset's parts, so it cannot say a real part is not on record", async () => {
  const { sys, hlpb } = setup();
  const { calls, copilot } = withLlm(sys);
  await copilot.open({ assetId: hlpb.id, user: johan }).ask("What should I check next?");
  assert.ok(calls[0].context.parts.some((p) => p.name === "Mechanical seal" && p.id && p.erpNo));
  assert.equal(calls[0].context.part, null);
  await copilot.open({ assetId: hlpb.id, user: johan }).ask("Tell me about the mechanical seal");
  assert.equal(calls[1].context.part.name, "Mechanical seal");
});
