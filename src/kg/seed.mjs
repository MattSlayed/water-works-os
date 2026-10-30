// Seeds the knowledge-graph layer on top of the plant: the 3D scene's GeometryRefs and sensor anchors.
// Later tasks add their own seeders here; every step must be safe to run twice.
import { readFileSync } from "node:fs";
import { geometryRefs } from "./geometry.mjs";

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/riverbend/${f}`, import.meta.url), "utf8"));
const prov = { source: "SYNTH-3D", source_uri: "data/riverbend/scene-meta.json", source_version: "v1", extracted_at: "2026-10-15T00:00:00Z", confidence: 1 };

export function seedKg(ont) {
  const g = geometryRefs(load("scene-meta.json"), ont, load("contract.json"));
  for (const r of g.refs) ont.upsert({ ...r, prov });
  for (const [from, rel, to] of g.links) if (!ont.links(from, { rel, dir: "out" }).some((l) => l.to === to)) ont.link(from, rel, to, undefined, prov);
  for (const [id, anchor] of g.anchors) ont.upsert({ id, type: "Sensor", anchor });
  return g;
}
