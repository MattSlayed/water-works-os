import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";

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
  const r = await s.ask("Can I reuse the housing? bore reads 110.065");
  assert.match(r.answer, /over the limit/i);
  assert.ok(sys.ont.list("Proposal", (p) => p.action === "raise_deviation").length === 1);
  assert.ok(sys.ont.list("Reading", (x) => !x.id.startsWith("RDG-H")).length === 1); // the seeded morning checks aside
});

test("a reading inside the band is accepted", async () => {
  const { sys, hlpb } = setup();
  const s = sys.copilot.open({ assetId: hlpb.id, partId: "PRT-HLP-B-05", user: johan });
  const r = await s.ask("bore is 110.020, ok to reuse?");
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

test("when every check for the part is withheld, the answer says so instead of an empty list", async () => {
  const { sys, hlpb } = setup();
  const sleeve = sys.ont.list("Part", (p) => p.assetId === hlpb.id && p.name === "Shaft sleeve")[0];
  const r = await sys.copilot.open({ assetId: hlpb.id, partId: sleeve.id, user: johan }).ask("what next");
  assert.equal(r.checks.length, 0);
  assert.match(r.answer, /Next checks: none I can show yet\./);
  assert.match(r.answer, /withheld/);
});
