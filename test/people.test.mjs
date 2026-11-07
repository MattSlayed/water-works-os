// Worker profiles and the people on each plant node and edge: reasons backed by records, clearance both ways, WaterOS only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { profiles, profileOf, peopleFor, resolvePlant, onShift } from "../src/people.mjs";
import { atlasModel } from "../src/timebase/atlas-model.mjs";
import { parseQuery } from "../web/bloom.js";

const sys = createSystem({ seed: 7 });
const { ont, tel } = sys, now = tel.now();
const as = (id) => { const p = ont.get(id); return { id: p.id, kind: "person", clearance: p.clearance, role: p.role }; };
const MGR = as("P-001"), NOMSA = as("P-028"), TECH2 = as(ont.list("Person", (p) => p.clearance === "technician" && p.id !== "P-028")[0].id);

test("profiles: everyone on the works, checked-in first; the whole profile for oneself and supervisors up only", () => {
  const all = profiles(ont, MGR, now);
  assert.equal(all.length, ont.list("Person").length);
  const firstOff = all.findIndex((p) => !p.onSite);
  assert.ok(firstOff > 0 && all.slice(firstOff).every((p) => !p.onSite), "checked-in people come first");
  assert.ok(all.every((p) => p.full && Array.isArray(p.competencies)));
  const mine = profileOf(ont, NOMSA, "P-028", now), theirs = profileOf(ont, TECH2, "P-028", now);
  assert.ok(mine.full && mine.competencies.some((c) => c.competency === "trade:millwright" && c.status === "valid"));
  assert.ok(mine.workOrders.some((w) => w.id === "WO-26043"));
  assert.equal(theirs.full, false);
  assert.deepEqual(Object.keys(theirs).sort(), ["employer", "full", "id", "name", "onShift", "onSite", "role", "shift", "trade"]);
});

test("people on HLP-B: the assignee first, then millwrights checked in there, every reason citing a record", () => {
  const r = peopleFor(ont, MGR, resolvePlant(ont, MGR, "HLP-B"), now);
  assert.equal(r.people[0].id, "P-028");
  assert.deepEqual(r.people[0].reasons.map((x) => x.kind), ["assigned", "competent"]);
  assert.equal(r.people[0].reasons[0].cite, "WO-26043");
  assert.ok(r.people.slice(1, 3).every((p) => p.reasons.some((x) => x.kind === "here")));
  for (const p of r.people) for (const x of p.reasons) assert.ok(ont.get(x.cite), `${x.cite} is a record`);
  assert.ok(r.people.every((p, i, a) => i === 0 || a[i - 1].score >= p.score), "most relevant first");
});

test("a line (an edge) gets its pipework people and whoever is in its zones; both ends of an edge are one union", () => {
  const line = resolvePlant(ont, MGR, "RB-L-210");
  assert.equal(ont.get(line).type, "Line");
  const r = peopleFor(ont, MGR, line, now);
  assert.ok(r.people.some((p) => p.reasons.some((x) => x.kind === "competent" && /pipework/.test(x.text))));
  assert.ok(r.people.some((p) => p.reasons.some((x) => x.kind === "here")));
  const pos = resolvePlant(ont, MGR, "HLP-B"), ast = ont.links(pos, { rel: "INSTALLED_AT", dir: "in" })[0].from;
  const both = peopleFor(ont, MGR, [ast, pos], now);
  assert.deepEqual(both.ids, [ast, pos]);
  assert.equal(both.people[0].id, "P-028");
});

test("clearance both ways: nobody is offered for a zone above their clearance; a viewer gets nothing they cannot see", () => {
  const chl = resolvePlant(ont, MGR, "CHL-A");
  const r = peopleFor(ont, MGR, chl, now);
  assert.ok(ont.list("Competency", (c) => c.personId === "P-028" && c.competency === "gas-safety:chlorine").length, "Nomsa holds the chlorine ticket");
  assert.ok(!r.people.some((p) => p.id === "P-028" && p.reasons.some((x) => x.kind === "competent")), "but a technician is not offered for Z06");
  assert.ok(r.people.some((p) => p.reasons.some((x) => x.kind === "competent")), "supervisors with the ticket are");
  assert.equal(resolvePlant(ont, NOMSA, "CHL-A"), null);
  assert.equal(peopleFor(ont, NOMSA, chl, now), null);
});

test("an expired competency is never offered; shifts read from the roster", () => {
  const s = createSystem({ seed: 7 });
  const c = s.ont.list("Competency", (x) => x.personId === "P-028" && x.competency === "trade:millwright")[0];
  s.ont.upsert({ ...c, validTo: "2020-01-01" });
  const r = peopleFor(s.ont, MGR, resolvePlant(s.ont, MGR, "HLP-B"), s.tel.now());
  assert.deepEqual(r.people.find((p) => p.id === "P-028").reasons.map((x) => x.kind), ["assigned"]);
  assert.equal(profileOf(s.ont, MGR, "P-028", s.tel.now()).competencies.find((x) => x.id === c.id).status, "expired");
  assert.equal(onShift(ont, ont.get("P-028"), "2026-10-14T07:00:00Z"), true);
  assert.equal(onShift(ont, ont.get("P-028"), "2026-10-14T20:00:00Z"), false);
  const crew = ont.list("Person", (p) => p.shift === "B")[0];
  assert.equal(onShift(ont, crew, "2026-10-15T20:00:00Z"), true);
  assert.equal(onShift(ont, crew, "2026-10-15T08:00:00Z"), false);
  assert.equal(onShift(ont, crew, "2027-01-01T08:00:00Z"), null, "no roster covers it");
});

test("people never reach Atlas", () => {
  const types = new Set(atlasModel(ont).instances.map((x) => x.type.split(":").pop()));
  for (const t of ["Person", "Competency", "Presence", "Shift"]) assert.ok(!types.has(t), t);
});

test("graph query phrases", () => {
  assert.deepEqual(parseQuery("people on site"), { tool: "people:site", args: {} });
  assert.deepEqual(parseQuery("Who is here"), { tool: "people:site", args: {} });
  assert.deepEqual(parseQuery("people on HLP-B"), { tool: "people:on", args: { q: "HLP-B" } });
  assert.deepEqual(parseQuery("who can fix 15HFA01"), { tool: "people:on", args: { q: "15HFA01" } });
  assert.deepEqual(parseQuery("upstream of RES-2"), { tool: "upstream", args: { id: "RES-2" } });
});

let srv, base;
before(async () => { srv = createServer(sys); await new Promise((r) => srv.listen(0, r)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv.close());
const get = async (who, p) => { const r = await fetch(base + p, { headers: { "x-acting-user": who } }); return { status: r.status, body: await r.json() }; };

test("routes: profiles, one profile, the people on a node or edge; the user picker's list is unchanged", async () => {
  const all = await get("P-001", "/api/people/profiles");
  assert.equal(all.body.people.length, ont.list("Person").length);
  assert.ok(all.body.people[0].full);
  const asTech = await get(TECH2.id, "/api/people/profiles");
  assert.ok(asTech.body.people.filter((p) => p.id !== TECH2.id).every((p) => !p.full && !p.competencies));
  assert.equal((await get("P-001", "/api/people/P-028")).body.name, "Nomsa Dlamini");
  assert.equal((await get("P-001", "/api/people/P-999")).status, 404);
  const hlp = await get("P-001", "/api/plant/people?q=HLP-B");
  assert.equal(hlp.body.people[0].id, "P-028");
  assert.equal(hlp.body.labels[hlp.body.ids[0]], "HLP-B");
  const line = await get("P-001", "/api/plant/people?q=RB-L-210");
  assert.equal(line.body.ends[line.body.ids[0]].length, 2, "a line names its two ends for the graph");
  assert.equal((await get("P-028", "/api/plant/people?q=CHL-A")).status, 404);
  const picker = await get("P-001", "/api/people");
  assert.deepEqual(Object.keys(picker.body[0]).sort(), ["clearance", "id", "name", "role"]);
});
