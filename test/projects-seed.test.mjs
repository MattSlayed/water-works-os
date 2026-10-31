import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { seedProjects } from "../src/kg/projects-seed.mjs";
import { atlasModel } from "../src/timebase/atlas-model.mjs";

const ACTIVE = ["PRJ-CL4", "PRJ-RWM", "PRJ-RES2", "PRJ-FMR", "PRJ-INT", "PRJ-SLG", "PRJ-PS2"];
const CLOCK = Date.parse("2026-10-14T06:00:00Z"), DAY = 86400000;
const out = (ont, id, rel) => ont.links(id, { rel, dir: "out" });
const counts = (ont) => ({ objects: ont.list(null).length, links: ont.list(null).reduce((n, o) => n + out(ont, o.id).length, 0) });

test("projects seed: every active project has a zone, a crew, 2+ progress reports with chunks, and USES/REQUIRES links", () => {
  const { ont } = createSystem({ seed: 7 });
  for (const id of ACTIVE) {
    assert.ok(out(ont, id, "LOCATED_IN").length >= 1, `${id} located`);
    assert.deepEqual(out(ont, id, "LOCATED_IN").map((l) => l.to), ont.get(id).zoneIds);
    assert.ok(ont.links(id, { rel: "WORKS_ON", dir: "in" }).length >= 1, `${id} crew`);
    assert.ok(out(ont, id, "USES").length >= 1, `${id} uses`);
    assert.ok(out(ont, id, "REQUIRES").length >= 1, `${id} requires`);
    const reports = ont.links(id, { rel: "ABOUT", dir: "in" }).map((l) => ont.get(l.from)).filter((d) => d.kind === "progress-report");
    assert.ok(reports.length >= 2, `${id} reports`);
    for (const d of reports) {
      assert.equal(d.aboutId, id);
      const chunks = out(ont, d.id, "HAS_CHUNK").map((l) => ont.get(l.to));
      assert.deepEqual(chunks.map((c) => c.heading), ["Summary", "Progress", "Safety", "Next week"]);
      for (const c of chunks) assert.ok(out(ont, c.id, "ABOUT").some((l) => l.to === id) && c.zoneId === d.zoneId);
    }
  }
  assert.equal(ont.get("PRJ-H2025-DOSE").zoneIds, undefined);
});

test("projects seed: report chunks and permits carry the project zone, so a technician cannot see PRJ-PS2's Z15 parts", () => {
  const { ont } = createSystem({ seed: 7 });
  const z15 = (o) => o.zoneId === "Z15";
  for (const t of ["Permit", "Document", "Chunk"]) assert.ok(ont.list(t, z15).length > 0, `${t} in Z15 exists`);
  const tech = ont.view({ id: "P-028", clearance: "technician" });
  for (const t of ["Permit", "Document", "Chunk"]) assert.deepEqual(tech.list(t, z15), [], t);
  assert.ok(ont.view({ id: "P-008", clearance: "supervisor" }).list("Permit", z15).length > 0);
});

test("projects seed: running seedProjects twice changes nothing", () => {
  const { ont } = createSystem({ seed: 7 });
  const before = counts(ont);
  seedProjects(ont);
  assert.deepEqual(counts(ont), before);
});

test("projects seed: no new permit or isolation on the raw-water pumps", () => {
  const { ont } = createSystem({ seed: 7 });
  const permits = ont.list("Permit", (p) => p.projectId);
  assert.ok(permits.length >= 5);
  // project permits are zone-bound: an asset permit would cap agent writes on that asset
  for (const p of permits) assert.ok(p.assetId === undefined && !["AST-30819", "AST-98455", "AST-42245"].includes(p.assetId), p.id);
  assert.deepEqual(ont.list("Permit", (p) => !p.projectId).map((p) => p.id), ["PTW-0412"]);
});

test("projects seed: projects.json names no person", () => {
  const { ont } = createSystem({ seed: 7 });
  const text = readFileSync(new URL("../data/riverbend/projects.json", import.meta.url), "utf8");
  for (const p of ont.list("Person")) assert.ok(!text.includes(p.name), p.name);
  const ids = (s) => s.match(/\bP-\d+/g) || [];
  const crewIds = Object.values(JSON.parse(text).projects).flatMap((p) => p.crew.map((c) => c.personId));
  assert.ok(crewIds.length >= 7);
  assert.deepEqual(ids(text).sort(), crewIds.sort());
});

test("projects seed: the seeded outcomes the dashboard demo depends on", () => {
  const { ont } = createSystem({ seed: 7 });
  const iso = (s) => Date.parse(s);
  // RES-2: confined-space permit expired, with an execution step in the 24 h before the clock
  const res2 = ont.list("Permit", (p) => p.projectId === "PRJ-RES2" && p.kind === "confined-space")[0];
  assert.ok(res2.state === "open" && iso(res2.expires) < CLOCK);
  const steps = ont.list("Execution", (e) => e.projectId === "PRJ-RES2").flatMap((e) => e.steps);
  assert.ok(steps.some((s) => s.state === "done" && CLOCK - iso(s.at) <= DAY && iso(s.at) <= CLOCK));
  // a crew competence that runs out inside 14 days
  const crew = (id) => ont.links(id, { rel: "WORKS_ON", dir: "in" }).map((l) => l.from);
  const key = ont.get("PRJ-RES2").requiredCompetence[0];
  const expiring = ont.list("Competency", (c) => crew("PRJ-RES2").includes(c.personId) && c.competency === key && iso(c.validTo) > CLOCK && iso(c.validTo) - CLOCK <= 14 * DAY);
  assert.equal(expiring.length, 1);
  assert.ok(ont.get("PRJ-RES2").requiredCompetence.includes("confined-space"));
  // PS-2: a done step that needs an isolation, and the only isolation on the project is applied but not verified
  const needsIso = (proc, n) => { const s = ont.get(proc).steps[n - 1]; return s.requiresIsolation || s.hazard === "LOTO"; };
  const ps2 = ont.list("Execution", (e) => e.projectId === "PRJ-PS2")[0];
  assert.ok(ps2.steps.some((s) => s.state === "done" && needsIso(ps2.procedureId, s.step)));
  assert.ok(ont.list("Permit", (p) => p.projectId === "PRJ-PS2").every((p) => p.isolations.every((i) => i.state === "applied" && !i.verifiedBy)));
  // sludge lagoon: every requirement evidenced and valid, every step done
  for (const l of out(ont, "PRJ-SLG", "REQUIRES")) {
    const ev = ont.links(l.to, { rel: "EVIDENCES", dir: "in" }).map((e) => ont.get(e.from));
    assert.ok(ev.some((d) => iso(d.validTo) > CLOCK), l.to);
  }
  for (const e of ont.list("Execution", (x) => x.projectId === "PRJ-SLG")) assert.ok(e.state === "done" && e.steps.length === ont.get(e.procedureId).steps.length && e.steps.every((s) => s.state === "done"));
  // report recency: RWM is quiet (10 days), the rest are within a week
  const last = (id) => Math.max(...ont.list("Document", (d) => d.kind === "progress-report" && d.aboutId === id).map((d) => iso(d.at)));
  assert.equal(Math.round((CLOCK - last("PRJ-RWM")) / DAY), 10);
  for (const id of ACTIVE.filter((x) => x !== "PRJ-RWM")) assert.ok(CLOCK - last(id) <= 7 * DAY && last(id) <= CLOCK, id);
});

test("projects seed: the new procedures flag the steps that need a permit or an isolation", () => {
  const { ont } = createSystem({ seed: 7 });
  for (const id of ["PRC-CONFINED_SPACE-v1", "PRC-HOT_WORK-v1"]) {
    const p = ont.get(id);
    assert.equal(p.state, "released");
    assert.ok(p.steps.some((s) => s.requiresPermit) && p.steps.some((s) => s.requiresIsolation) && p.steps.some((s) => !s.requiresPermit));
    p.steps.forEach((s, i) => assert.ok(s.id === `${id}-S0${i + 1}` && s.step === i + 1 && s.requires.permit === s.requiresPermit && s.requires.isolation === s.requiresIsolation));
  }
});

test("projects seed: no project people data or project document is in the Atlas load", () => {
  const { ont } = createSystem({ seed: 7 });
  const m = atlasModel(ont);
  const types = new Set(m.instances.map((i) => i.type.split(":").pop()));
  for (const t of ["Person", "Competency", "Presence", "Participant", "Execution", "Permit", "Requirement", "Chunk"]) assert.ok(!types.has(t), t);
  const names = m.instances.map((i) => i.name);
  const projectDocs = ont.list("Document", (d) => d.projectId).map((d) => d.id);
  assert.ok(projectDocs.length >= 28);
  for (const id of projectDocs) assert.ok(!names.includes(id), id);
  assert.ok(!names.some((n) => /^DOC-(PR|EV)-/.test(n)));
  for (const id of ["DOC-DESIGN-BASIS", "DOC-CAL-FWTURB", "DOC-SOP-BLOWER"]) assert.ok(names.includes(id), id);
});
