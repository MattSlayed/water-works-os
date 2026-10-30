// The memory backend behind the KG tools (CI, the offline export): the in-memory ontology and synthetic telemetry.
// Like Atlas it answers every zone; the tools prune every result to the viewer.
import { graphFrom } from "../functions.mjs";
import { currentPlantModel } from "../plant.mjs";

export const sameRel = (a, b) => String(a).toLowerCase().replace(/_/g, "") === String(b).toLowerCase().replace(/_/g, "");
export const labelOf = (o) => String(o.tag ?? o.name ?? o.title ?? o.id);

export function createMemoryBackend({ ont, tel }) {
  return {
    search(q, types, limit = 20) {
      const s = String(q ?? "").trim().toLowerCase();
      return ont.search(s, Infinity).filter((o) => !types?.length || types.includes(o.type)).slice(0, limit).map((o) => ({
        id: o.id, type: o.type, label: labelOf(o), score: [o.id, o.tag, o.positionTag].some((x) => x && x.toLowerCase() === s) ? 1 : 0.5
      }));
    },
    get: (id) => ont.get(id) || null,
    neighbors: (id, rel) => ont.links(id).filter((l) => !rel || sameRel(l.rel, rel)).map((l) => ({ rel: l.rel, dir: l.from === id ? "out" : "in", id: l.from === id ? l.to : l.from })),
    // the process edges of the released model, as Atlas holds them (feeds); machine-in-structure edges come from the ontology
    flowEdges() {
      const m = currentPlantModel(ont);
      return [...graphFrom(ont.list(null, (o) => m && o.modelId === m.id)).out.values()].flat().filter((e) => e.kind !== "contains");
    },
    readings: (sensor, fromIso, toIso) => tel.series(sensor.id, fromIso, toIso).map((p) => ({ ...p, q: 192 })),
    cypher() { throw new Error("cypher runs on the Atlas backend only"); }
  };
}
