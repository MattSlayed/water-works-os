import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RENAMES, RETIRED } from "../src/crosswalk.mjs";
import { generateWorks } from "../src/generate.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? (n === "vendor" ? [] : walk(p)) : [p];
});
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("no retired id survives", () => {
  const files = [...walk(join(ROOT, "src")).filter((f) => !f.endsWith("crosswalk.mjs")), ...walk(join(ROOT, "web")), ...walk(join(ROOT, "data", "drawings")), join(ROOT, "README.md")];
  const olds = [...new Set([...RENAMES.map(([o]) => o), ...RETIRED])];
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const id of olds) if (new RegExp(`\\b${esc(id)}\\b`).test(text)) hits.push(`${relative(ROOT, f)}: ${id}`);
  }
  assert.deepEqual(hits, []);
});

test("CL-4 is out, CL-3 runs", () => {
  const objs = generateWorks().objects, a = (tag) => objs.find((x) => x.type === "Asset" && x.positionTag === tag);
  assert.equal(a("CL-4")?.state, "out of service");
  assert.equal(a("CL-3")?.state, "running");
});
