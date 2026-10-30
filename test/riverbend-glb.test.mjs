// Riverbend glTF export: the glb carries exactly the scene-meta objects, tagged with asset extras.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dir = new URL("../data/riverbend/", import.meta.url);
const meta = JSON.parse(readFileSync(new URL("scene-meta.json", dir), "utf8"));
const buf = readFileSync(new URL("riverbend.glb", dir));

// GLB: 12-byte header (magic, version, length), then the first chunk is JSON.
assert.equal(buf.readUInt32LE(0), 0x46546c67, "glTF magic");
assert.equal(buf.readUInt32LE(16), 0x4e4f534a, "first chunk is JSON");
const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));

const tagged = json.nodes.filter((n) => n.extras?.asset !== undefined);

test("glb holds exactly the scene-meta objects", () => {
  assert.deepEqual(tagged.map((n) => n.name).sort(), Object.keys(meta.objects).sort());
  for (const n of tagged) assert.equal(n.extras.asset, meta.objects[n.name].asset, n.name);
});

test("glb carries no images and no untagged nodes", () => {
  assert.equal((json.images ?? []).length, 0);
  assert.ok(json.nodes.filter((n) => n.mesh !== undefined).every((n) => n.extras?.asset !== undefined));
  assert.ok(buf.length < 15 * 1024 * 1024, `size ${buf.length}`);
});
