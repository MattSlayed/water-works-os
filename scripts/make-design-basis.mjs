// Writes the generated Riverbend Design Basis to data/riverbend/design-basis.md. Run: node scripts/make-design-basis.mjs
import fs from "node:fs";
import { designBasis } from "../src/kg/design-basis.mjs";

const out = new URL("../data/riverbend/design-basis.md", import.meta.url);
fs.writeFileSync(out, designBasis());
console.log(`wrote data/riverbend/design-basis.md (${fs.statSync(out).size} bytes)`);
