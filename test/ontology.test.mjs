import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorks } from "../src/generate.mjs";
import { createOntology } from "../src/ontology.mjs";

const fresh = () => createOntology(generateWorks(7));
const tech = { id: "P-x", role: "millwright", clearance: "technician" };
const mgr = { id: "P-y", role: "works_manager", clearance: "manager" };

test("get unknown id returns null", () => {
  assert.equal(fresh().get("NOPE"), null);
});

test("search HLP-B finds the position and the asset", () => {
  const hits = fresh().search("HLP-B").map((o) => o.type);
  assert.ok(hits.includes("Position"));
  assert.ok(hits.includes("Asset"));
});

test("technician view prunes objects in a supervisor zone (Z06)", () => {
  const ont = fresh();
  const chl = ont.list("Asset", (a) => a.positionTag === "CHL-A")[0];
  assert.ok(chl);
  const v = ont.view(tech);
  assert.equal(v.get(chl.id), null);
  assert.ok(!v.list("Asset").some((a) => a.id === chl.id));
  assert.ok(!v.search("CHL-A").length);
  assert.equal(v.get("Z06"), null);
  assert.ok(ont.view(mgr).get(chl.id));
});

test("parts and sensors inherit the zone of their asset", () => {
  const ont = fresh();
  const v = ont.view(tech);
  assert.equal(v.get("PRT-CHL-A-01"), null);
  assert.equal(v.get("SEN-FIN-cl"), null);
  assert.ok(v.get("PRT-HLP-B-05"));
});

test("links are pruned if either end is withheld", () => {
  const ont = fresh();
  const chl = ont.list("Asset", (a) => a.positionTag === "CHL-A")[0];
  const v = ont.view(tech);
  const doc = "DOC-SOP-DOSING_PUMP";
  assert.ok(ont.links(doc).some((l) => l.to === chl.id));
  assert.ok(!v.links(doc).some((l) => l.to === chl.id));
});

test("upsert and link emit events and are queryable", () => {
  const ont = fresh();
  const seen = [];
  ont.on((e) => seen.push(e));
  ont.upsert({ id: "FND-T1", type: "Finding", zoneId: "Z07", text: "test" });
  ont.link("FND-T1", "ABOUT", "PRT-HLP-B-05");
  assert.equal(ont.get("FND-T1").text, "test");
  assert.ok(ont.get("FND-T1").prov);
  assert.deepEqual(ont.neighbors("FND-T1", "ABOUT").map((o) => o.id), ["PRT-HLP-B-05"]);
  assert.deepEqual(seen.map((e) => e.kind), ["upsert", "link"]);
});

test("views are read-only", () => {
  const v = fresh().view(tech);
  assert.equal(v.upsert, undefined);
});

test("audience limits an object to named viewers and the manager", () => {
  const o = createOntology({ objects: [{ id: "M1", type: "Message", audience: ["P-028"] }, { id: "M2", type: "Message" }] });
  assert.ok(o.view({ id: "P-028", clearance: "technician" }).get("M1"));
  assert.equal(o.view({ id: "P-029", clearance: "engineer" }).get("M1"), null);
  assert.ok(o.view({ id: "P-001", clearance: "manager" }).get("M1"));
  assert.ok(o.view({ id: "P-029", clearance: "technician" }).get("M2"));
});
