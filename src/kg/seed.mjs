// Seeds the knowledge-graph layer on top of the plant: the 3D scene's GeometryRefs and sensor anchors.
// Later tasks add their own seeders here; every step must be safe to run twice.
import { readFileSync } from "node:fs";
import { PLAN } from "../layout.mjs";
import { geometryRefs, ownerResolver } from "./geometry.mjs";
import { chunkByHeading } from "./chunks.mjs";
import { designBasis } from "./design-basis.mjs";

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/riverbend/${f}`, import.meta.url), "utf8"));
const prov = { source: "SYNTH-3D", source_uri: "data/riverbend/scene-meta.json", source_version: "v1", extracted_at: "2026-10-15T00:00:00Z", confidence: 1 };

const docProv = { source: "SYNTH-DOC", source_uri: "data/riverbend/design-basis.md", source_version: "v1", extracted_at: "2026-10-15T00:00:00Z", confidence: 1 };
const linkOnce = (ont, from, rel, to, p) => { if (!ont.links(from, { rel, dir: "out" }).some((l) => l.to === to)) ont.link(from, rel, to, undefined, p); };

// The design basis document, its chunks, and what each chunk is ABOUT: every structure or position whose key or tag the text names.
function seedDesignBasis(ont) {
  const id = "DOC-DESIGN-BASIS", ownerOf = ownerResolver(ont);
  ont.upsert({ id, type: "Document", kind: "design-basis", title: "Riverbend Design Basis", revision: "A", body: designBasis(), prov: docProv });
  const keys = [...new Set([...Object.keys(PLAN), ...ont.list("Position").map((p) => p.tag)])];
  const tagOf = (k) => [k, PLAN[k]?.tag].filter(Boolean);
  for (const c of chunkByHeading(id, ont.get(id).body)) {
    ont.upsert({ ...c, prov: docProv });
    linkOnce(ont, id, "HAS_CHUNK", c.id, docProv);
    const text = `${c.heading} ${c.text}`;
    // tags are letters, digits and hyphens only, so no regex escaping is needed
    const names = (t) => new RegExp(`(?<![\\w-])${t}(?![\\w-])`).test(text);
    for (const k of keys) { const to = tagOf(k).some(names) && ownerOf(k); if (to) linkOnce(ont, c.id, "ABOUT", to, docProv); }
  }
}

export function seedKg(ont) {
  const g = geometryRefs(load("scene-meta.json"), ont, load("contract.json"));
  for (const r of g.refs) ont.upsert({ ...r, prov });
  for (const [from, rel, to] of g.links) if (!ont.links(from, { rel, dir: "out" }).some((l) => l.to === to)) ont.link(from, rel, to, undefined, prov);
  for (const [id, anchor] of g.anchors) ont.upsert({ id, type: "Sensor", anchor });
  seedDesignBasis(ont);
  return g;
}
