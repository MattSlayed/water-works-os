import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { projectStatus } from "../src/functions.mjs";
import { spendAt } from "../src/regionview.mjs";
import { projectIndicators, worst } from "../src/project-indicators.mjs";

const sys = createSystem({ seed: 7 });
const { ont, tel } = sys;
const mgr = { id: "P-001", clearance: "manager" };
const sup = { id: "P-008", clearance: "supervisor" };
const tech = { id: "P-028", clearance: "technician" };
const ACTIVE = ["PRJ-CL4", "PRJ-RWM", "PRJ-RES2", "PRJ-FMR", "PRJ-INT", "PRJ-SLG", "PRJ-PS2"];
const items = (r) => Object.values(r.areas).flatMap((a) => a.items);

test("indicators: RES-2 compliance is red for the expired confined-space permit", () => {
  const r = projectIndicators(ont, tel, mgr, "PRJ-RES2");
  assert.equal(r.areas.compliance.status, "red");
  const permit = ont.list("Permit", (p) => p.projectId === "PRJ-RES2")[0];
  assert.ok(r.areas.compliance.items.some((i) => i.status === "red" && i.cite === permit.id && /expired/i.test(i.text)));
});

test("indicators: SLG is green across people, procedures and compliance", () => {
  const r = projectIndicators(ont, tel, mgr, "PRJ-SLG");
  for (const a of ["people", "procedures", "compliance"]) {
    assert.equal(r.areas[a].status, "green", a);
    assert.ok(r.areas[a].items.length > 0 && r.areas[a].summary, a);
  }
});

test("indicators: a competence expiring within 14 days makes people amber, with role text and no person name or id", () => {
  const r = projectIndicators(ont, tel, mgr, "PRJ-RES2");
  assert.equal(r.areas.people.status, "amber");
  assert.ok(r.areas.people.items.some((i) => i.status === "amber" && /millwright.*confined-space.*2026-10-24/i.test(i.text)));
  const names = ont.list("Person").map((p) => p.name);
  for (const id of ACTIVE) for (const viewer of [mgr, sup, tech]) {
    for (const i of projectIndicators(ont, tel, viewer, id)?.areas.people.items || []) {
      assert.ok(!names.some((n) => i.text.includes(n)), i.text);
      assert.doesNotMatch(i.text, /\bP-\d+\b/);
      assert.ok(!i.cite.startsWith("P-"), i.cite);
    }
  }
});

test("indicators: a done isolation step with no verified isolation makes procedures red", () => {
  const r = projectIndicators(ont, tel, mgr, "PRJ-PS2");
  assert.equal(r.areas.procedures.status, "red");
  assert.ok(r.areas.procedures.items.some((i) => i.status === "red" && /isolat/i.test(i.text)));
  assert.equal(r.areas.compliance.status, "amber"); // the same isolation, applied but not verified
});

test("indicators: a supervisor outside an execution's audience still sees the procedure progress, without a person", () => {
  const r = projectIndicators(ont, tel, sup, "PRJ-CL4");
  assert.match(r.areas.procedures.items[0].text, /2 of \d+ steps/);
  assert.equal(r.areas.procedures.status, "amber"); // M2 is overdue and steps remain
});

test("indicators: an area with no data is none with an empty items list", () => {
  const s = createSystem({ seed: 7 });
  for (const l of s.ont.links("PRJ-INT", { rel: "USES", dir: "out" })) s.ont.remove(l.to); // no unlink on the ontology: a link to a missing object is gone
  const a = projectIndicators(s.ont, s.tel, mgr, "PRJ-INT").areas.procedures;
  assert.equal(a.status, "none");
  assert.deepEqual(a.items, []);
});

test("indicators: header reuses projectStatus milestones and spendAt", () => {
  const p = ont.get("PRJ-CL4"), st = projectStatus(p, ont.list("ProgressClaim"), ont.list("Issue"), tel.now());
  const h = projectIndicators(ont, tel, mgr, "PRJ-CL4").header;
  assert.deepEqual(h.milestones, { ...st.milestones, overdue: st.overdue });
  assert.equal(h.spendZar, spendAt(p, tel.now()));
  assert.equal(h.budgetZar, p.budgetZar);
  assert.equal(h.lastReportAt, "2026-10-09T15:00:00Z"); // the latest progress report document
  assert.equal(h.daysSinceReport, 4);
});

test("indicators: a technician sees PRJ-PS2 with no item citing a Z15 object", () => {
  const r = projectIndicators(ont, tel, tech, "PRJ-PS2");
  assert.equal(r.id, "PRJ-PS2");
  for (const i of items(r)) assert.notEqual(ont.get(i.cite)?.zoneId, "Z15", i.text);
  assert.equal(r.areas.compliance.status, "green"); // only the Z14 requirement and its evidence are visible; the Z15 certificate is not
  assert.equal(r.areas.procedures.status, "none"); // the execution sits in Z15, which the technician cannot see
  assert.equal(projectIndicators(ont, tel, tech, "PRJ-NOPE"), null);
});

test("worst: red beats amber beats green; empty is none", () => {
  assert.equal(worst(["green", "amber", "red"]), "red");
  assert.equal(worst(["green", "amber"]), "amber");
  assert.equal(worst(["green"]), "green");
  assert.equal(worst([]), "none");
});

test("indicators: finished work stays green after its permit expires; work in progress on an expired permit is red", () => {
  const later = { now: () => "2026-10-25T06:00:00Z", latest: (id) => tel.latest(id) }; // SLG's permit ran to 23 Oct
  assert.equal(projectIndicators(ont, later, mgr, "PRJ-SLG").areas.procedures.status, "green");
  const res2 = projectIndicators(ont, tel, mgr, "PRJ-RES2").areas.procedures;
  assert.equal(res2.status, "red");
  assert.match(res2.items[0].text, /started without/);
});

test("indicators: a done step needs a permit valid at its own time", () => {
  const s = createSystem({ seed: 7 });
  const p = s.ont.list("Permit", (x) => x.projectId === "PRJ-SLG")[0];
  s.ont.upsert({ ...p, opened: "2026-10-12T09:00:00Z" }); // opened after the early steps were done
  assert.equal(projectIndicators(s.ont, s.tel, mgr, "PRJ-SLG").areas.procedures.status, "red");
});

test("indicators: PRJ-PS2 spans Z15 and Z14, a technician sees the Z14 report and requirement but not the Z15 permit", () => {
  const r = projectIndicators(ont, tel, tech, "PRJ-PS2");
  assert.notEqual(r.areas.compliance.status, "none");
  const cites = items(r).map((i) => i.cite);
  const req = ont.list("Requirement", (q) => q.projectId === "PRJ-PS2" && q.zoneId === "Z14")[0];
  assert.ok(req && cites.includes(req.id));
  assert.ok(r.header.lastReportAt, "the Z14 progress reports reach a technician's header");
  const permit = ont.list("Permit", (p) => p.projectId === "PRJ-PS2")[0];
  assert.ok(!cites.includes(permit.id));
  const sc = items(projectIndicators(ont, tel, sup, "PRJ-PS2")).map((i) => i.cite);
  assert.ok(sc.includes(permit.id) && sc.includes(req.id));
  assert.ok(sc.includes(ont.list("Requirement", (q) => q.projectId === "PRJ-PS2" && q.zoneId === "Z15")[0].id));
});
