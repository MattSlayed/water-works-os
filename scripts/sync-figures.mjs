// Copy the built anatomy figures into web/figures/. Run after rebuilding a figure: node scripts/sync-figures.mjs
import { fileURLToPath } from "node:url";
import { createSystem } from "../src/system.mjs";
import { syncFigures } from "../src/figures.mjs";

const from = fileURLToPath(new URL("../../riverbend-anatomy", import.meta.url));
const { index, skipped } = syncFigures({ from, ont: createSystem({ seed: 7 }).ont });
for (const f of Object.values(index)) console.log(`${f.positionTag}: ${Object.keys(f.parts).length} drawn parts tied to ${Object.keys(f.lights).length} KG parts`);
for (const s of skipped) console.log(`skipped ${s}`);
