// Plan 4 Task 3: the pure triage functions (job brief design §5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokens, matchAssets, readValue, authorityOf, rank, decide } from "../src/specs.mjs";

const A = [{ id: "A1", positionTag: "DP-1", kks: "13QCA10AP001", name: "Coagulant dosing pump 1" }, { id: "A2", positionTag: "DP-2", kks: "13QCA10AP002", name: "Coagulant dosing pump 2" }];
const pick = (r) => ({ lo: r.lo, hi: r.hi, target: r.target, unit: r.unit, grade: r.grade, condition: r.condition });

test("tokens split letters from digits", () => {
  assert.deepEqual(tokens("DP-2 at 13QCA10AP002"), ["dp", "2", "at", "13", "qca", "10", "ap", "002"]);
});

test("matching: tag, KKS, two named assets, and a name-only tie", () => {
  assert.deepEqual(matchAssets("run DP-2 at 135 L/h", A).map((m) => [m.assetId, m.matchedBy]), [["A2", "tag"]]);
  assert.deepEqual(matchAssets("DP-1 and DP-2 delivery at 60% stroke: 120 L/h ±5%", A).map((m) => m.assetId), ["A1", "A2"]);
  assert.deepEqual(matchAssets("Tag: 13QCA10AP002 design delivery 100 L/h", A).map((m) => [m.assetId, m.matchedBy]), [["A2", "kks"]]);
  const tie = matchAssets("the coagulant dosing pump is noisy", A);
  assert.equal(tie.length, 2);
  assert.ok(tie.every((m) => m.tie && m.matchedBy === "name"));
  assert.deepEqual(matchAssets("Canteen closed on Friday", A), []);
});

test("reading values at every grade", () => {
  assert.deepEqual(pick(readValue("Team, run DP-2 at 135 L/h ±5% until raw turbidity settles. Precious", { measureKeys: ["delivery"] })),
    { lo: 128.25, hi: 141.75, target: 135, unit: "L/h", grade: "INFERRED", condition: "raw turbidity settles" });
  assert.deepEqual(pick(readValue("DP-1 and DP-2 delivery at 60% stroke: 120 L/h ±5%", {})), { lo: 114, hi: 126, target: 120, unit: "L/h", grade: "EXTRACTED", condition: null });
  assert.equal(readValue("we've had DP-2 delivering 125 L/h since the storm", {}).grade, "EXTRACTED");
  assert.equal(readValue("Tag: 13QCA10AP002 design delivery 100 L/h", {}).target, 100);
  assert.equal(readValue("DP-2 delivery 1?5 L/h", {}).grade, "AMBIGUOUS");
  assert.equal(readValue("DP-2 delivery 125 gal/h", {}).grade, "AMBIGUOUS");
  assert.equal(readValue("Canteen closed on Friday", {}), null);
  assert.equal(readValue("The canteen is closed on Friday for maintenance.", {}), null);
});

test("a sheet cell reads with the measure and unit from its header", () => {
  assert.deepEqual(pick(readValue("110", { measure: "delivery", unit: "L/h" })), { lo: null, hi: null, target: 110, unit: "L/h", grade: "EXTRACTED", condition: null });
});

test("units: mL/min converts to L/h, and ranges read as a band", () => {
  assert.equal(readValue("delivery 2000 mL/min", {}).target, 120);
  assert.deepEqual(pick(readValue("delivery 100–140 L/h", {})).lo, 100);
});

test("authority from where a source came", () => {
  const people = [{ id: "P-001", name: "Precious Sithole", role: "works_manager" }, { id: "P-010", name: "Gift Naidoo", role: "shift_supervisor" }];
  assert.equal(authorityOf({ kind: "m365.mail", from: "precious.sithole@riverbend.example" }, people), "manager");
  assert.equal(authorityOf({ kind: "chat", from: "P-001" }, people), "manager");
  assert.equal(authorityOf({ kind: "chat", from: "P-010" }, people), "report");
  assert.equal(authorityOf({ kind: "m365.files", path: "Engineering/Specs", text: "Signed: J. Molefe, for the owner" }, people), "client-spec");
  assert.equal(authorityOf({ kind: "m365.files", path: "Engineering/Drawings", text: "" }, people), "drawing");
  assert.equal(authorityOf({ kind: "m365.files", path: "Engineering/Site photos", text: "" }, people), "report");
  assert.equal(authorityOf({ kind: "google.sheets" }, people), "spreadsheet");
  assert.equal(authorityOf({ kind: "Document", docKind: "manual" }, people), "oem");
});

const C = {
  b: { id: "b", subject: "A2", authority: "client-spec", at: "2026-03-02", lo: 114, hi: 126, target: 120, grade: "EXTRACTED", source: { id: "ATT-ENG-01" } },
  c: { id: "c", subject: "A2", authority: "spreadsheet", at: "2025-06-10", lo: null, hi: null, target: 110, grade: "EXTRACTED", source: { id: "SHEET#3" } },
  d: { id: "d", subject: "A2", authority: "drawing", at: "2024-11-20", lo: null, hi: null, target: 100, grade: "EXTRACTED", source: { id: "ATT-ENG-02" } },
  e: { id: "e", subject: "A2", authority: "manager", at: "2026-10-13T16:40:00Z", lo: 128.25, hi: 141.75, target: 135, grade: "INFERRED", source: { id: "M365-WRK-001" } },
  f: { id: "f", subject: "A2", authority: "report", at: "2026-10-13T23:15:00Z", lo: null, hi: null, target: 125, grade: "EXTRACTED", source: { id: "MSG-H-SPEC1" } },
  g: { id: "g", subject: "A2", authority: "report", at: "2026-10-12T14:20:00Z", lo: null, hi: null, target: null, grade: "AMBIGUOUS", source: { id: "ATT-ENG-03" } }
};
const reasons = (r) => Object.fromEntries(r.passedOver.map((p) => [p.candidateId, p.reason]));

test("ranking: the site manager's newest word wins; the rest get their reasons", () => {
  const r = rank(Object.values(C), {});
  assert.equal(r.winner.id, "e");
  assert.deepEqual(reasons(r), { b: "older than the site manager's instruction", c: "lower authority", d: "lower authority", f: "lower authority", g: "unsure" });
});

test("ranking without a manager instruction: authority, then the newest", () => {
  const r = rank([C.c, C.d, C.b, { ...C.d, id: "d2", at: "2025-01-01" }], {});
  assert.equal(r.winner.id, "b");
  assert.deepEqual(reasons(r), { c: "lower authority", d: "lower authority", d2: "lower authority" });
  const later = rank([C.b, { ...C.b, id: "b2", at: "2026-04-01" }, { ...C.e, id: "e0", at: "2026-01-01" }], {});
  assert.equal(later.winner.id, "b2");
  assert.deepEqual(reasons(later), { b: "older", e0: "older" });
});

test("a value correction blocks one value from one source; a new value from it takes part again", () => {
  const cor = { id: "COR-1", scope: { assetId: "A2" }, wrongSourceRef: { id: "SHEET#3" }, wrongValue: 110 };
  assert.equal(reasons(rank([C.c, C.f], { corrections: [cor] })).c, "blocked by COR-1");
  assert.equal(rank([{ ...C.c, target: 112 }, C.f], { corrections: [cor] }).winner.id, "c");
  assert.equal(rank([C.c, C.f], { corrections: [{ ...cor, wrongValue: null }] }).winner.id, "c");
  assert.equal(rank([C.c, C.f], { corrections: [{ ...cor, scope: { assetId: "A1" } }] }).winner.id, "c");
  assert.equal(reasons(rank([C.e, C.b], { rejected: [{ sourceId: "M365-WRK-001", lo: 128.25, hi: 141.75 }] })).e, "rejected before");
});

test("decide: agrees within the band, proposes otherwise, flags outside the rated range", () => {
  const conf = { lo: 114, hi: 126, target: 120, unit: "L/h" };
  assert.equal(decide(C.b, conf, {}).kind, "agrees");
  assert.equal(decide({ target: 120, lo: null, hi: null }, conf, {}).kind, "agrees");
  assert.deepEqual(decide(C.e, conf, { ratedRange: [0, 400] }), { kind: "propose", lo: 128.25, hi: 141.75, target: 135, flag: null });
  const single = decide({ target: 110, lo: null, hi: null }, conf, {});
  assert.deepEqual([single.kind, single.lo, single.hi], ["propose", 104.5, 115.5]);
  assert.equal(decide({ target: 450, lo: null, hi: null }, conf, { ratedRange: [0, 400] }).flag, "outside the maker's rated range (0–400 L/h)");
});
