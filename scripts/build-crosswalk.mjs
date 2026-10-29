// Builds data/crosswalk.json from the generated works. Run: node scripts/build-crosswalk.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assignTags, RENAMES, RETIRED } from "../src/crosswalk.mjs";
import { generateWorks } from "../src/generate.mjs";
import { PLAN } from "../src/layout.mjs";

export function buildCrosswalk(works) {
  const tags = assignTags(works.objects.filter((o) => o.type === "Sensor"));
  return {
    assets: Object.entries(PLAN).map(([canonical, p]) => ({ canonical, old: p.tag, note: p.kind })).sort((a, b) => (a.canonical < b.canonical ? -1 : 1)),
    renames: RENAMES,
    retired: RETIRED,
    sensors: Object.fromEntries([...tags].sort(([a], [b]) => (a < b ? -1 : 1)))
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "crosswalk.json");
  fs.writeFileSync(out, JSON.stringify(buildCrosswalk(generateWorks()), null, 2) + "\n");
  console.log("wrote", out);
}
