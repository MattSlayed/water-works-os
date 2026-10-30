// Riverbend Atlas, Task 3: the heading chunker and the generated Riverbend Design Basis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSystem } from "../src/system.mjs";
import { chunkByHeading } from "../src/kg/chunks.mjs";
import { designBasis } from "../src/kg/design-basis.mjs";
import { seedKg } from "../src/kg/seed.mjs";

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

test("chunks split per heading", () => {
  const md = "# Title\n\nintro\n\n## Alpha\n\nfirst\n\n## Beta two\n\nsecond\n\n## Gamma\n\nthird\n";
  const cs = chunkByHeading("DOC-X", md);
  assert.deepEqual(cs.map((c) => [c.id, c.order, c.heading, c.text]), [["DOC-X#c01", 1, "Alpha", "first"], ["DOC-X#c02", 2, "Beta two", "second"], ["DOC-X#c03", 3, "Gamma", "third"]]);
  assert.deepEqual({ type: cs[0].type, documentId: cs[0].documentId }, { type: "Chunk", documentId: "DOC-X" });
  const big = "## Long\n\n" + Array.from({ length: 13 }, () => words(100)).join("\n\n") + "\n\n## Short\n\nend\n";
  const split = chunkByHeading("DOC-Y", big);
  assert.deepEqual(split.map((c) => c.id), ["DOC-Y#c01a", "DOC-Y#c01b", "DOC-Y#c01c", "DOC-Y#c02"]);
  assert.ok(split.slice(0, 3).every((c) => c.heading === "Long" && c.order === 1 && c.text.split(/\s+/).length <= 600));
});

test("design basis matches the layout", () => {
  const md = designBasis();
  assert.equal(md, readFileSync(new URL("../data/riverbend/design-basis.md", import.meta.url), "utf8"));
  assert.ok(!md.includes("\r"));
  assert.ok(md.includes("100 ML/d") && md.includes("90 ML/d"));
  const cs = chunkByHeading("DOC-DESIGN-BASIS", md);
  assert.deepEqual(cs.map((c) => c.id), Array.from({ length: 8 }, (_, i) => `DOC-DESIGN-BASIS#c0${i + 1}`));
  const filt = cs[4];
  assert.equal(filt.heading, "Filtration");
  for (let i = 1; i <= 8; i++) assert.ok(filt.text.includes(`F0${i}`), `F0${i}`);
  assert.ok(!/\bF(09|[1-9]\d)\b/.test(filt.text));
  const { ont } = createSystem();
  for (const c of cs) for (const l of ont.links(c.id, { rel: "ABOUT", dir: "out" })) assert.ok(ont.get(l.to), l.to);
});

test("seeded", () => {
  const { ont } = createSystem();
  const d = ont.get("DOC-DESIGN-BASIS");
  assert.equal(d.kind, "design-basis");
  assert.equal(d.revision, "A");
  assert.ok(ont.links(d.id, { rel: "HAS_CHUNK", dir: "out" }).length >= 8);
  const about = (id) => ont.links(id, { rel: "ABOUT", dir: "out" }).map((l) => ont.get(l.to).tag);
  assert.ok(["CL-1", "CL-4"].every((t) => about("DOC-DESIGN-BASIS#c04").includes(t)));
  assert.ok(["F01", "F08"].every((t) => about("DOC-DESIGN-BASIS#c05").includes(t)));
  const again = ont.links(d.id, { rel: "HAS_CHUNK", dir: "out" }).length;
  seedKg(ont);
  assert.equal(ont.links(d.id, { rel: "HAS_CHUNK", dir: "out" }).length, again);
});
