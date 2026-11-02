// The Riverbend physical layer as Timebase Atlas REST bodies (shapes proven by the Atlas spike), and the load plan
// that makes the loader idempotent. Only the twelve allowlisted types leave WaterOS; people, chat and work never do.
import { CLEARANCES, rank } from "../ontology.mjs";
import { graphFrom } from "../functions.mjs";
import { currentPlantModel } from "../plant.mjs";

export const ATLAS_TYPES = ["Site", "Zone", "ProcessUnit", "Structure", "Position", "Asset", "Part", "Sensor", "Line", "Valve", "SamplePoint", "Document"];
export const slug = (id) => String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-");

const XSD = "http://www.w3.org/2001/XMLSchema#", TVQ = "urn:atlas:ontology:atlas-common:TVQ";
const S = XSD + "string", D = XSD + "double", B = XSD + "boolean";
const RANGE = {
  wosId: S, zone: S, minClearance: S, geometry: S, tag: S, kks: S, name: S, stage: S, positionTag: S, assetClass: S, make: S, model: S,
  criticality: S, state: S, kind: S, historianTag: S, unit: S, lineNumber: S, service: S, clearance: S, title: S, revision: S,
  group: S, material: S, lineId: S, mode: S, baseLevel: D, height: D, w: D, l: D, diameter: D, twl: D, rangeLo: D, rangeHi: D,
  alarmHi: D, dn: D, length: D, share: D, causal: B, recycle: B, pumped: B, Value: TVQ
};
const BASE = ["wosId", "zone", "minClearance"];
const OWN = {
  Position: ["tag", "kks", "name", "stage", "geometry"],
  Asset: ["positionTag", "assetClass", "make", "model", "criticality", "state"],
  Structure: ["tag", "kind", "baseLevel", "height", "w", "l", "diameter", "twl", "geometry"],
  Sensor: ["tag", "historianTag", "unit", "rangeLo", "rangeHi", "alarmHi", "Value"],
  Line: ["lineNumber", "service", "dn", "length", "causal", "recycle"],
  Zone: ["name", "clearance"],
  Document: ["title", "kind", "revision"],
  Part: ["name", "group", "material"]
};
const FEEDS = ["share", "recycle", "lineId", "mode", "length", "pumped", "kind"];
const RELS = { HAS_ZONE: "hasZone", CONTAINS: "contains", HAS_POSITION: "hasPosition", INSTALLED_AT: "installedAt", HAS_PART: "hasPart", MEASURES: "measures", AT: "at", GOVERNS: "governs" };

export function atlasModel(ont, { domain = "riverbend" } = {}) {
  const O = (n) => `urn:atlas:ontology:${domain}:${n}`, I = (id) => `urn:atlas:instance:${domain}:${slug(id)}`;
  // Atlas reads "[836,..." in a static string as a [Name, format] placeholder and silently drops the whole instance
  // (there is no escape); a space after the bracket keeps JSON valid and is not a placeholder
  const unplaceholder = (v) => (typeof v === "string" ? v.replace(/\[(?=\w)/g, "[ ") : v);
  const props = (entries) => Object.fromEntries(entries.filter(([, v]) => v != null).map(([k, v]) => [O(k), [{ type: "StaticStrategy", value: unplaceholder(v) }]]));
  const mid = currentPlantModel(ont)?.id;
  // plant objects of older or draft model revisions would duplicate the released ones
  const objs = ATLAS_TYPES.flatMap((t) => ont.list(t, (o) => (!o.modelId || o.modelId === mid) && (o.type !== "Document" || !o.projectId)));
  // project paperwork (progress reports, evidence) stays in WaterOS; only plant documents are loaded (a projectId on any other type is not paperwork)
  const loaded = new Set(objs.map((o) => o.id));

  // the least clearance that sees the object, as ont.view decides it: its own floor, its zone, every zone a line crosses
  const minClearance = (o) => [o.minClearance, ...[ont.zoneOf(o.id), ...(o.zones || [])].map((z) => ont.get(z)?.clearance)]
    .filter(Boolean).reduce((a, c) => (rank(c) > rank(a) ? c : a), CLEARANCES[0]);
  // GeometryRefs hang off the Position when one exists; a Structure also reaches them through CONTAINS -> Position
  const refs = (id) => ont.links(id, { rel: "HAS_GEOMETRY", dir: "out" }).map((l) => ont.get(l.to));
  const geometry = (o) => {
    const own = [o.id, ...(o.type === "Structure" ? ont.links(o.id, { rel: "CONTAINS", dir: "out" }).map((l) => l.to) : [])];
    const gs = [...new Map(own.flatMap(refs).map(({ type, prov, ...g }) => [g.id, g])).values()];
    return gs.length ? JSON.stringify(gs) : null;
  };
  const field = (o, k) => k === "wosId" ? o.id : k === "zone" ? ont.zoneOf(o.id) : k === "minClearance" ? minClearance(o)
    : k === "geometry" ? geometry(o) : k === "rangeLo" ? o.range?.[0] : k === "rangeHi" ? o.range?.[1] : o[k];

  const instances = objs.map((o) => {
    const p = props([...BASE, ...(OWN[o.type] || [])].filter((k) => k !== "Value").map((k) => [k, field(o, k)]));
    if (o.type === "Sensor") p[O("Value")] = [{ type: "BoundStrategy", bindingPath: `historian-rb/Riverbend/${o.tag}` }];
    return { id: slug(o.id), name: o.id, type: O(o.type), instanceId: I(o.id), label: String(o.tag ?? o.name ?? o.title ?? o.id), properties: p };
  });

  const edges = new Map();
  const edge = (rel, from, to, id = `e--${rel.toLowerCase()}--${slug(from)}--${slug(to)}`, properties) => {
    if (loaded.has(from) && loaded.has(to)) edges.set(id, { id, name: `${from} ${rel} ${to}`, type: O(rel), instanceId: I(id), source: I(from), target: I(to), ...(properties ? { properties } : {}) });
  };
  for (const o of objs) for (const l of ont.links(o.id, { dir: "out" })) if (RELS[l.rel]) edge(RELS[l.rel], l.from, l.to);
  // a Document is about what its chunks are about; the chunks stay in WaterOS
  for (const d of objs) if (d.type === "Document")
    for (const c of ont.links(d.id, { rel: "HAS_CHUNK", dir: "out" })) for (const a of ont.links(c.to, { rel: "ABOUT", dir: "out" })) edge("about", d.id, a.to);
  const g = graphFrom(ont.list(null, (o) => mid && o.modelId === mid));
  for (const e of [...g.out.values()].flat()) if (e.kind !== "contains")
    edge("feeds", e.from, e.to, `e--feeds--${slug(e.lineId)}`, props([["share", e.split], ["recycle", e.recycle], ["lineId", e.lineId], ["mode", e.mode], ["length", e.length], ["pumped", e.pumped], ["kind", e.kind]]));

  const comment = (n) => `WaterOS ${n}`;
  return {
    properties: Object.entries(RANGE).map(([name, range]) => ({ name, label: name, comment: comment(name), range, attachToTypes: [] })),
    entityTypes: [
      { name: "WosObject", label: "WosObject", comment: "A WaterOS physical-layer object", isAbstract: true, properties: BASE },
      ...ATLAS_TYPES.map((t) => ({ name: t, label: t, comment: comment(t), parentType: "WosObject", properties: (OWN[t] || []) }))
    ],
    relationshipTypes: [...Object.values(RELS), "about", "feeds"].map((name) => ({
      name, label: name, comment: comment(name), sourceNodeType: "WosObject", targetNodeType: "WosObject", ...(name === "feeds" ? { properties: FEEDS } : {})
    })),
    instances,
    edges: [...edges.values()]
  };
}

// Stable JSON: sorted keys, null and undefined members dropped (a stored definition may echo them).
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter((k) => v[k] != null).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  : JSON.stringify(v);

// What to POST, PATCH (always the full property set; the vendor PATCH merges, so a dropped property is not cleared) and DELETE to make existing match desired.
// shortcut: dropped properties are not cleared; send clear:["properties"] — verify on the first licensed run
// Atlas counts well beyond nodes and edges against its Instances entitlement (500 unlicensed; Types is limited to 100)
// (556 with all 37 structures, whatever properties they kept). This keeps the structures that have flow
// and the flow between them, with only what the backend's queries read, so the Atlas route can be proven without a licence.
// shortcut: flow only, no assets or sensors; delete once the install is licensed and the full model compiles.
export function slimModel(model, { domain = "riverbend" } = {}) {
  const O = (n) => `urn:atlas:ontology:${domain}:${n}`;
  const only = (x, names) => ({ ...x, properties: Object.fromEntries(names.filter((n) => x.properties?.[O(n)]).map((n) => [O(n), x.properties[O(n)]])) });
  const feeds = model.edges.filter((e) => e.type === O("feeds"));
  const keep = new Set(feeds.flatMap((e) => [e.source, e.target]));
  const instances = model.instances.filter((x) => x.type === O("Structure") && keep.has(x.instanceId)).map((x) => only(x, ["wosId", "kind"]));
  const edges = feeds.map((e) => only(e, ["kind"]));
  return { ...model, relationshipTypes: model.relationshipTypes.filter((r) => r.name === "feeds"), instances, edges };
}

export function planLoad(desired, existing) {
  const have = new Map(existing.map((x) => [x.id, x])), want = new Set(desired.map((x) => x.id));
  const create = [], update = [];
  for (const d of desired) {
    const e = have.get(d.id);
    if (!e) create.push(d);
    else if (canon(e.properties || {}) !== canon(d.properties || {})) update.push(d);
  }
  return { create, update, remove: existing.filter((x) => !want.has(x.id)) };
}
