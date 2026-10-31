// Riverbend Atlas, Task 5: the physical layer as Atlas REST bodies, and the idempotent load plan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOntology } from "../src/ontology.mjs";
import { generateWorks } from "../src/generate.mjs";
import { seedPlant, currentPlantModel } from "../src/plant.mjs";
import { seedKg } from "../src/kg/seed.mjs";
import { atlasModel, slug, planLoad, ATLAS_TYPES } from "../src/timebase/atlas-model.mjs";

const ont = createOntology(generateWorks(7));
seedPlant(ont);
seedKg(ont);
const model = atlasModel(ont);
const O = (n) => `urn:atlas:ontology:riverbend:${n}`, I = (id) => `urn:atlas:instance:riverbend:${slug(id)}`;
const values = (x) => Object.values(x.properties || {}).flatMap((s) => s.map((e) => e.value ?? e.bindingPath));
const modelId = currentPlantModel(ont).id, RES2 = `${modelId}:STR-20UBA02`;

test("allowlist only: twelve types, nothing about people", () => {
  assert.deepEqual(ATLAS_TYPES, ["Site", "Zone", "ProcessUnit", "Structure", "Position", "Asset", "Part", "Sensor", "Line", "Valve", "SamplePoint", "Document"]);
  const allowed = new Set(ATLAS_TYPES.map(O));
  for (const i of model.instances) assert.ok(allowed.has(i.type), i.type);
  const people = ont.list("Person").flatMap((p) => [p.id, p.name]);
  for (const x of [...model.instances, ...model.edges]) {
    const text = JSON.stringify([x.label, x.name, values(x)]);
    for (const p of people) assert.ok(!text.includes(p), `${x.id} mentions ${p}`);
  }
});

test("full URNs: types, property keys and edge endpoints", () => {
  for (const p of model.properties) assert.deepEqual(p.attachToTypes, [], p.name);
  for (const x of [...model.instances, ...model.edges]) {
    assert.match(x.type, /^urn:atlas:/);
    assert.match(x.instanceId, /^urn:atlas:instance:riverbend:/);
    for (const k of Object.keys(x.properties || {})) assert.match(k, /^urn:atlas:ontology:riverbend:/);
  }
  for (const e of model.edges) for (const k of ["instanceId", "source", "target"]) assert.match(e[k], /^urn:atlas:instance:/, `${e.id}.${k}`);
  // Atlas interpolates [Name] in static values and silently drops an instance whose placeholder is unknown ([836,...])
  for (const x of [...model.instances, ...model.edges]) for (const v of values(x)) if (typeof v === "string" && !v.startsWith("historian-rb/")) assert.doesNotMatch(v, /\[\w/, x.id);
  const ids = new Set(model.instances.map((i) => i.instanceId));
  for (const e of model.edges) assert.ok(ids.has(e.source) && ids.has(e.target), e.id);
});

test("one instance per object, and slug is injective", () => {
  const objs = ATLAS_TYPES.flatMap((t) => ont.list(t, (o) => (!o.modelId || o.modelId === modelId) && !o.projectId));
  assert.equal(model.instances.length, objs.length);
  assert.equal(new Set(objs.map((o) => slug(o.id))).size, objs.length);
  assert.equal(new Set([...model.instances, ...model.edges].map((x) => x.id)).size, model.instances.length + model.edges.length);
  assert.equal(slug("PM-RB-A:STR-20UBA02"), "pm-rb-a-str-20uba02");
});

test("feeds edges carry the graph's kind and share; RES-2 is fed; recycle is marked", () => {
  const feeds = model.edges.filter((e) => e.type === O("feeds"));
  const v = (e, k) => e.properties[O(k)]?.[0].value;
  assert.ok(feeds.some((e) => e.target === I(RES2)), "RES-2 has an incoming feeds edge");
  assert.ok(feeds.every((e) => ["flow", "injection"].includes(v(e, "kind"))));
  assert.ok(feeds.some((e) => v(e, "kind") === "injection"));
  const recycle = feeds.filter((e) => ont.get(v(e, "lineId")).recycle);
  assert.ok(recycle.length > 0);
  for (const e of recycle) assert.equal(v(e, "recycle"), true);
  assert.equal(v(feeds.find((e) => e.target === I(RES2)), "share"), 0.25);
});

test("sensors bind their Historian tag; geometry follows CONTAINS; documents are about their chunks' targets", () => {
  const ait = model.instances.find((i) => i.instanceId === I("SEN-F07-turb"));
  assert.deepEqual(ait.properties[O("Value")], [{ type: "BoundStrategy", bindingPath: "historian-rb/Riverbend/AIT-157" }]);
  assert.equal(ait.properties[O("tag")][0].value, "AIT-157");
  const geo = (id) => JSON.parse(model.instances.find((i) => i.instanceId === I(id)).properties[O("geometry")][0].value).map((g) => g.id);
  const f07 = ont.links("POS-F07", { rel: "HAS_GEOMETRY", dir: "out" }).map((l) => l.to);
  assert.ok(f07.length > 0);
  assert.deepEqual(geo("POS-F07").sort(), f07.sort());
  for (const g of f07) assert.ok(geo(`${modelId}:STR-15HFA07`).includes(g));
  const about = model.edges.filter((e) => e.type === O("about") && e.source === I("DOC-DESIGN-BASIS")).map((e) => e.target);
  assert.ok(about.includes(I(RES2)) && about.includes(I("POS-CL-4")));
  assert.equal(new Set(about).size, about.length);
  assert.equal(model.instances.find((i) => i.instanceId === I("Z06")).properties[O("minClearance")][0].value, "supervisor");
});

test("planLoad: no-op, one update with the full set, one remove", () => {
  const desired = model.instances.slice(0, 3);
  const existing = structuredClone(desired);
  assert.deepEqual(planLoad(desired, existing), { create: [], update: [], remove: [] });
  const k = Object.keys(existing[1].properties)[0];
  existing[1].properties[k] = [{ type: "StaticStrategy", value: "changed" }];
  let p = planLoad(desired, existing);
  assert.equal(p.update.length, 1);
  assert.deepEqual(p.update[0].properties, desired[1].properties);
  assert.deepEqual([p.create, p.remove], [[], []]);
  p = planLoad(desired.slice(1), structuredClone(desired));
  assert.deepEqual(p.remove.map((x) => x.id), [desired[0].id]);
  assert.deepEqual([p.create, p.update], [[], []]);
});
