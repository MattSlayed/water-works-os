import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorks } from "../src/generate.mjs";
import { createOntology } from "../src/ontology.mjs";
import { createTelemetry } from "../src/telemetry.mjs";

const make = (seed = 7) => {
  const ont = createOntology(generateWorks(7));
  return createTelemetry({ ont, seed, start: "2026-10-01T00:00:00Z" });
};

test("deterministic by seed", () => {
  const a = make(), b = make();
  assert.deepEqual(a.history("SEN-HLP-A-vib_de", 50), b.history("SEN-HLP-A-vib_de", 50));
});

test("tick advances the clock by minutes", () => {
  const t = make();
  const before = Date.parse(t.now());
  t.tick(60);
  assert.equal(Date.parse(t.now()) - before, 60 * 60000);
});

test("replay starts part-way so tick has data ahead", () => {
  const t = make();
  assert.ok(Date.parse(t.now()) < Date.parse("2026-10-15T00:00:00Z"));
});

test("clock runs past the window while readings hold the last sample", () => {
  const t = make();
  t.tick(1e6);
  const a = t.latest("SEN-HLP-B-vib_de");
  const h = t.history("SEN-HLP-B-vib_de", 10);
  t.tick(60);
  assert.ok(t.now() > "2026-10-15T00:00:00Z");
  assert.equal(t.latest("SEN-HLP-B-vib_de").value, a.value);
  assert.deepEqual(t.history("SEN-HLP-B-vib_de", 10), h);
  assert.equal(h.length, 10);
});

test("HLP-B degrades: DE vibration and bearing temperature above HLP-A at the end", () => {
  const t = make();
  t.tick(1e9);
  assert.ok(t.latest("SEN-HLP-B-vib_de").value > t.latest("SEN-HLP-A-vib_de").value + 1.5);
  assert.ok(t.latest("SEN-HLP-B-temp_de").value > t.latest("SEN-HLP-A-temp_de").value + 8);
});

test("F07 turbidity rises after day 12, F03 stays low", () => {
  const t = make();
  t.tick(1e9);
  assert.ok(t.latest("SEN-F07-turb").value > 0.4);
  assert.ok(t.latest("SEN-F03-turb").value < 0.3);
});

test("unknown sensor returns null and empty history", () => {
  const t = make();
  assert.equal(t.latest("SEN-NOPE"), null);
  assert.deepEqual(t.history("SEN-NOPE", 10), []);
});

test("sensorsFor returns the sensors of an asset", () => {
  const ont = createOntology(generateWorks(7));
  const t = createTelemetry({ ont, seed: 7, start: "2026-10-01T00:00:00Z" });
  const hlpb = ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
  assert.equal(t.sensorsFor(hlpb.id).length, 4);
});
