// The slim Atlas model fits the unlicensed Instances limit and still holds the whole flow graph between structures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorks } from "../src/generate.mjs";
import { createOntology } from "../src/ontology.mjs";
import { seedPlant } from "../src/plant.mjs";
import { seedKg } from "../src/kg/seed.mjs";
import { atlasModel, slimModel } from "../src/timebase/atlas-model.mjs";

test("slim model: small enough for the 500 limit, only structures and feeds, every edge end kept", () => {
  const ont = createOntology(generateWorks(7));
  seedPlant(ont);
  seedKg(ont);
  const full = atlasModel(ont, { domain: "riverbend" });
  const slim = slimModel(full);
  assert.deepEqual(slim.relationshipTypes.map((r) => r.name), ["feeds"], "the Types limit is 100 too");
  assert.ok(slim.instances.length + slim.edges.length < 87, "87 instances compiled to 556, over the limit");
  assert.equal(slim.edges.length, full.edges.filter((e) => e.type.endsWith(":feeds")).length);
  assert.ok(slim.instances.every((x) => x.type.endsWith(":Structure") && x.properties["urn:atlas:ontology:riverbend:wosId"]));
  const ids = new Set(slim.instances.map((x) => x.instanceId));
  assert.ok(slim.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
});
