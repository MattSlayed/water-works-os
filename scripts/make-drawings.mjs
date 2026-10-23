// Writes the synthetic Riverbend drawing set (rev A and rev B) to data/drawings/. Run: node scripts/make-drawings.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drawingSet } from "../src/drawings/make.mjs";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "drawings");
fs.mkdirSync(DIR, { recursive: true });
let n = 0;
for (const rev of ["A", "B"]) for (const [name, text] of Object.entries(drawingSet(rev))) { fs.writeFileSync(path.join(DIR, name), text); n++; }
console.log(`wrote ${n} files (${fs.readdirSync(DIR).filter((f) => !f.endsWith(".md")).length} distinct) to data/drawings`);
