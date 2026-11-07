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

  // two ids with one slug would be one Atlas instance, and the load would overwrite one with the other without a word
  const bySlug = new Map();
  for (const o of objs) {
    const s = slug(o.id), was = bySlug.get(s);
    if (was && was !== o.id) throw new Error(`Atlas slug collision: ${was} and ${o.id} both become ${s}`);
    bySlug.set(s, o.id);
  }

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
  // Types are counted across every branch (100 in all), so slim declares only what it holds
  return {
    ...model,
    properties: model.properties.filter((p) => ["wosId", "kind"].includes(p.name)),
    entityTypes: model.entityTypes.filter((t) => ["WosObject", "Structure"].includes(t.name)).map((t) => ({ ...t, properties: t.name === "WosObject" ? ["wosId"] : ["kind"] })),
    relationshipTypes: model.relationshipTypes.filter((r) => r.name === "feeds").map((r) => ({ ...r, properties: ["kind"] })),
    instances, edges
  };
}

// The free licence (2026-11-07) raised Instances from 500 to 1,000. Atlas counts one per node and edge plus one per
// property its type DECLARES (parent types included), set or not, plus 102 on this branch: that formula gives exactly
// the 6,241 Atlas reported for the full model and the 2,402 for core before core's types were trimmed.
export const ATLAS_INSTANCE_LIMIT = 1000;
export const ATLAS_OVERHEAD = 102;
export function atlasCost(model) {
  const types = new Map([...model.entityTypes, ...model.relationshipTypes].map((t) => [t.name, t]));
  const declared = (name) => { const t = types.get(name); return t ? (t.properties || []).length + (t.parentType ? declared(t.parentType) : 0) : 0; };
  return ATLAS_OVERHEAD + [...model.instances, ...model.edges].reduce((n, x) => n + 1 + declared(String(x.type).split(":").pop()), 0);
}

// The process core: the plant's places, machines and lines, with the flow between structures. Each type declares only
// wosId (Atlas's Label carries the tag) and feeds only kind and lineId; WaterOS supplies the rest by id, and Parts,
// Sensors, Valves, SamplePoints and Documents stay in WaterOS. About 733 of the 1,000, leaving room to grow.
// shortcut: sized for the free licence; load atlasModel itself once a tier covers about 6,300 instances.
export const CORE_TYPES = ["Site", "Zone", "ProcessUnit", "Structure", "Position", "Asset", "Line"];
export function coreModel(model, { domain = "riverbend" } = {}) {
  const O = (n) => `urn:atlas:ontology:${domain}:${n}`;
  const only = (x, names) => ({ ...x, properties: Object.fromEntries(names.filter((n) => x.properties?.[O(n)]).map((n) => [O(n), x.properties[O(n)]])) });
  const kept = new Set(CORE_TYPES.map(O));
  const instances = model.instances.filter((x) => kept.has(x.type)).map((x) => only(x, ["wosId"]));
  const ids = new Set(instances.map((x) => x.instanceId));
  const edges = model.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => only(e, e.type === O("feeds") ? ["kind", "lineId"] : []));
  const rels = new Set(edges.map((e) => e.type));
  return {
    ...model,
    properties: model.properties.filter((p) => ["wosId", "kind", "lineId"].includes(p.name)),
    entityTypes: model.entityTypes.filter((t) => t.name === "WosObject" || CORE_TYPES.includes(t.name)).map((t) => ({ ...t, properties: t.name === "WosObject" ? ["wosId"] : [] })),
    relationshipTypes: model.relationshipTypes.filter((r) => rels.has(O(r.name))).map((r) => (r.name === "feeds" ? { ...r, properties: ["kind", "lineId"] } : r)),
    instances, edges
  };
}

// What to POST, PATCH (the full property set; atlas-sync clears first when the instance holds more) and DELETE to make existing match desired.
export function planLoad(desired, existing) {
  const have = new Map(existing.map((x) => [x.id, x])), want = new Set(desired.map((x) => x.id));
  const create = [], update = [];
  for (const d of desired) {
    const e = have.get(d.id);
    if (!e) create.push(d);
    else if (canon(e.properties || {}) !== canon(d.properties || {}) || (d.label != null && e.label !== d.label)) update.push(d);
  }
  return { create, update, remove: existing.filter((x) => !want.has(x.id)) };
}
