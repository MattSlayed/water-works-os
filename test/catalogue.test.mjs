// People, IT's connector catalogue, and agents that run as their builder (plan 3b Task 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { catalogueAllows } from "../src/actions.mjs";
import { specId } from "../src/harness.mjs";

// P-001..P-042 as the generator made them before the accounts and IT people were added: no seeded value may move
const PEOPLE_42 = [["P-001","Precious Sithole","works_manager","manager"],["P-002","Megan Ismail","reliability_engineer","engineer"],["P-003","Gift Venter","reliability_engineer","engineer"],["P-004","Refilwe Ndlovu","planner","supervisor"],["P-005","Dineo Khumalo","lab_analyst","operator"],["P-006","Tshepo Pretorius","lab_analyst","operator"],["P-007","Zanele Naidoo","lab_analyst","operator"],["P-008","Werner Jacobs","shift_supervisor","supervisor"],["P-009","Dineo Molefe","shift_supervisor","supervisor"],["P-010","Gift Naidoo","shift_supervisor","supervisor"],["P-011","Yusuf Zulu","shift_supervisor","supervisor"],["P-012","Ayanda Pillay","process_controller","operator"],["P-013","Andile Botha","process_controller","operator"],["P-014","Musa Zulu","process_controller","operator"],["P-015","Refilwe Mahlangu","process_controller","operator"],["P-016","Lerato Molefe","process_controller","operator"],["P-017","Hendrik Ndlovu","process_controller","operator"],["P-018","Palesa Pretorius","process_controller","operator"],["P-019","Zanele Coetzee","process_controller","operator"],["P-020","Sipho Ismail","process_controller","operator"],["P-021","Ayanda Naidoo","process_controller","operator"],["P-022","Werner Naidoo","process_controller","operator"],["P-023","Megan Coetzee","process_controller","operator"],["P-024","Musa Mthembu","process_controller","operator"],["P-025","Aisha Smit","process_controller","operator"],["P-026","Pieter Dlamini","process_controller","operator"],["P-027","Gift Ismail","process_controller","operator"],["P-028","Nomsa Dlamini","millwright","technician"],["P-029","Werner Pretorius","millwright","technician"],["P-030","Zanele Zulu","millwright","technician"],["P-031","Hendrik van Wyk","millwright","technician"],["P-032","Musa Pretorius","fitter","technician"],["P-033","Zanele Botha","fitter","technician"],["P-034","Refilwe Botha","fitter","technician"],["P-035","Musa Smit","electrician","technician"],["P-036","Dineo Sithole","electrician","technician"],["P-037","Yusuf Jacobs","electrician","technician"],["P-038","Precious Zulu","instrument_technician","technician"],["P-039","Yusuf Mahlangu","instrument_technician","technician"],["P-040","Lwazi Jacobs","safety_officer","supervisor"],["P-041","Dineo Ismail","contractor","technician"],["P-042","Gift Venter","contractor","technician"]];
const as = (s, id) => ({ kind: "person", id, clearance: s.ont.get(id).clearance });
const act = (s, by, action, params) => s.actions.invoke({ action, params, actor: as(s, by) });
const FILES = { kind: "m365.files", op: "write", role: "accounts_clerk", level: "act" };

test("45 people; the first 42 are unchanged; the IT administrator is flagged", () => {
  const s = createSystem(), people = s.ont.list("Person");
  assert.equal(people.length, 45);
  assert.deepEqual(people.slice(0, 42).map(({ id, name, role, clearance }) => [id, name, role, clearance]), PEOPLE_42);
  assert.deepEqual(["P-043", "P-044", "P-045"].map((id) => [s.ont.get(id).name, s.ont.get(id).role, s.ont.get(id).clearance]),
    [["Lerato Khumalo", "accounts_clerk", "operator"], ["Thandi Mokoena", "finance_officer", "supervisor"], ["Ayanda Mthembu", "it_admin", "operator"]]);
  assert.equal(s.ont.get("P-045").itAdmin, true);
  assert.ok(!s.ont.get("P-001").itAdmin);
  for (const id of ["P-043", "P-044", "P-045"]) assert.deepEqual(s.ont.get(`CHN-${id}`).audience, [id]);
});

test("the catalogue: filing is allowed for the clerk but locked until IT signs it off; a millwright may not", () => {
  const s = createSystem();
  assert.deepEqual(catalogueAllows(s.ont, FILES), { ok: true, reason: null, locked: true, maxLevel: "act" });
  assert.equal(catalogueAllows(s.ont, { ...FILES, role: "millwright" }).ok, false);
  assert.match(catalogueAllows(s.ont, { kind: "erp", op: "post", role: "accounts_clerk", level: "act" }).reason, /above propose/);
  assert.equal(catalogueAllows(s.ont, { kind: "cmms", op: "read", role: "millwright" }).ok, true);
});

test("only an IT administrator signs off a line; reversing the sign-off locks it again", () => {
  const s = createSystem();
  assert.match(act(s, "P-001", "sign_off_catalogue_line", { kind: "m365.files", op: "write", role: "accounts_clerk" }).reason, /IT administrators only/);
  const r = act(s, "P-045", "sign_off_catalogue_line", { kind: "m365.files", op: "write", role: "accounts_clerk" });
  assert.equal(r.status, "done");
  assert.deepEqual(catalogueAllows(s.ont, FILES), { ok: true, reason: null, locked: false, maxLevel: "act" });
  assert.ok(s.audit.all().some((e) => e.action === "sign_off_catalogue_line" && e.outcome === "done" && e.actor === "P-045"));
  assert.equal(s.actions.reverse(r.decision.id, as(s, "P-045")).status, "done");
  assert.equal(catalogueAllows(s.ont, FILES).locked, true);
});

test("an IT administrator edits a line; nobody else may", () => {
  const s = createSystem();
  assert.match(act(s, "P-044", "set_catalogue_line", { kind: "erp", op: "read", patch: { roles: ["accounts_clerk"] } }).reason, /IT administrators only/);
  assert.equal(act(s, "P-045", "set_catalogue_line", { kind: "erp", op: "read", patch: { roles: ["accounts_clerk"] } }).status, "done");
  assert.equal(catalogueAllows(s.ont, { kind: "erp", op: "read", role: "planner" }).ok, false);
});

const register = (s, name, reads, fn) => {
  s.ont.upsert({ id: specId(name), type: "AgentSpec", name, builderId: "P-043", owner: "P-043", reads, tools: [], constraints: [], mode: "bounded", state: "live", promotion: { minCases: 20, minAgreePct: 90, maxBreaches: 0, maxStalePct: 5 } });
  s.runtime.register({ name, version: "1.0.0", owner: "P-043", tools: [], autonomy: {} }, fn);
};

test("Review Focus 1: an agent runs as its builder, whoever triggers it, and reads only what its contract lists", () => {
  const s = createSystem();
  let seen = null;
  register(s, "Clerk Mail Count", [{ source: "connector:m365.mail" }], (ctx) => { seen = ctx.connector("m365.mail").list("accounts@riverbend.example").length; });
  const run = s.runtime.run("Clerk Mail Count", { actingUser: as(s, "P-001") });
  assert.deepEqual([run.status, run.actingUserId, run.triggeredBy, seen], ["completed", "P-043", "P-001", 48]);
  register(s, "Clerk ERP Peek", [{ source: "connector:m365.mail" }], (ctx) => ctx.connector("erp").suppliers());
  const bad = s.runtime.run("Clerk ERP Peek", { actingUser: as(s, "P-001") });
  assert.equal(bad.status, "failed");
  assert.match(bad.error, /not in its evidence contract/);
});

test("a connector read the builder's role is not allowed fails the run", () => {
  const s = createSystem();
  act(s, "P-045", "set_catalogue_line", { kind: "erp", op: "read", patch: { roles: ["finance_officer"] } });
  register(s, "Clerk ERP Read", [{ source: "connector:erp" }], (ctx) => ctx.connector("erp").suppliers());
  assert.match(s.runtime.run("Clerk ERP Read", { actingUser: as(s, "P-001") }).error, /not allowed/);
});

test("record_reading stores who took it", () => {
  const s = createSystem(), t = s.ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  const r = act(s, "P-028", "record_reading", { targetId: t.id, measure: "bearing temp", value: 61 });
  assert.equal(s.ont.get(r.decision.objects[0]).by, "P-028");
});
