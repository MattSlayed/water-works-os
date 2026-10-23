// Plant model revisions (design §4.3–4.5). A PlantModel holds the graded cells of one drawing-set revision.
// A release (four eyes, named content hash; see release_plant_model in actions.mjs) writes revision-scoped
// plant objects `PM-RB-<rev>:<KIND>-<tag>`. Earlier revisions' objects and existing records are never rewritten:
// readers ask for the current released model and use only objects carrying its modelId.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extractPlant } from "./ingest/extract.mjs";
import { GEOREF, ZONES } from "./layout.mjs";
import { DRAWING_META } from "./drawings/make.mjs";

const DIR = new URL("../data/drawings/", import.meta.url);
const read = (file) => readFileSync(new URL(file, DIR), "utf8");
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const sha = (s) => createHash("sha256").update(s).digest("hex");

// Content hash over what was drawn and reviewed: sources, items and cells, not status, governs or release.
export const packageHash = (m) => sha(canon({ sources: m.sources, items: m.items, cells: m.cells }));

export function plantModelFrom(x, { rev, id = `PM-RB-${rev}` }) {
  const m = { id, type: "PlantModel", name: `Plant model rev ${rev}`, rev, status: "draft", governs: null, sources: x.sources, items: x.items, cells: x.cells, bindings: x.bindings, reviews: [], release: null, georef: GEOREF };
  return { ...m, packageHash: packageHash(m) };
}

export const currentPlantModel = (ont) => ont.list("PlantModel", (m) => m.status === "released")[0] || null;

const KIND = { structure: "STR", machine: "MCH", line: "LIN", valve: "VLV", samplepoint: "SPT" };
export const plantId = (modelId, kind, tag) => `${modelId}:${KIND[kind]}-${tag}`;
const zoneAt = ([x, y]) => ZONES.find(([, , zx, zy, w, h]) => x >= zx && x <= zx + w && y >= zy && y <= zy + h)?.[0];
// shortcut: samples each segment every 0.5 m; zones are at least 50 m across, so none is skipped. Clip exactly if zones get thin.
const zonesOn = (path) => {
  const out = new Set();
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]], steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
    for (let k = 0; k <= steps; k++) { const z = zoneAt([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]); if (z) out.add(z); }
  }
  return [...out].sort();
};

// The objects a model release writes. Machine placements and filter structures name their Position; sample points their Sensor.
export function materialise(model) {
  const mid = model.id, items = new Map(model.items.map((i) => [i.tag, i]));
  // the reviewed binding cell, not the extractor's guess: a reviewer's correction is what gets linked
  const bound = (tag) => { const b = items.get(tag)?.fields.binding; return b && b !== "unbound" ? b : null; };
  const out = [];
  for (const { kind, tag, fields } of model.items) {
    if (fields.presence === "excluded") continue; // a reviewer resolved a drawing-only item as not on site
    const { binding, ...f } = fields, label = String(f.kind || f.service || kind).replace(/_/g, " ");
    const base = { id: plantId(mid, kind, tag), modelId: mid, tag, name: `${tag} · ${label} (rev ${model.rev})` };
    if (kind === "structure") out.push({ ...base, type: "Structure", ...f, positionId: bound(tag) });
    else if (kind === "machine") out.push({ ...base, type: "MachinePlacement", positionId: bound(tag), structureId: plantId(mid, "structure", f.structure), offset: f.offset, rotDeg: 0, zoneId: f.zoneId });
    else if (kind === "line") out.push({ ...base, type: "Line", lineNumber: tag, ...f, fromId: f.from && plantId(mid, "structure", f.from), toId: f.to && plantId(mid, "structure", f.to), zones: f.path ? zonesOn(f.path) : [] });
    else if (kind === "valve") out.push({ ...base, type: "Valve", ...f, lineId: f.lineId ? plantId(mid, "line", f.lineId) : null, zoneId: items.get(f.filter)?.fields.zoneId ?? null });
    else if (kind === "samplepoint") {
      const onLine = items.get(f.at)?.kind === "line", where = items.get(f.at)?.fields ?? {};
      out.push({ ...base, type: "SamplePoint", position: f.position, lagMin: f.lagMin, instrument: f.instrument, sensorId: bound(f.instrument),
        // an analyser draws its sample where its line starts (the outlet of the structure upstream), so it takes that zone
        ...(onLine ? { lineId: plantId(mid, "line", f.at), zoneId: where.path ? zoneAt(where.path[0]) ?? null : null } : { structureId: plantId(mid, "structure", f.at), zoneId: where.zoneId ?? null }) });
    }
  }
  return out;
}

// Upsert a released model's objects and their links to existing records (which are only linked to, never changed).
export function writePlant(ont, model) {
  const objs = materialise(model);
  for (const o of objs) ont.upsert(o);
  for (const o of objs) {
    if (o.type === "MachinePlacement" && o.positionId && ont.get(o.structureId) && ont.get(o.positionId)) ont.link(o.structureId, "CONTAINS", o.positionId);
    if (o.type === "Structure" && o.positionId && ont.get(o.positionId)) ont.link(o.id, "CONTAINS", o.positionId);
    if (o.type === "SamplePoint" && o.sensorId && ont.get(o.sensorId)) ont.link(o.sensorId, "AT", o.id);
  }
  return objs;
}

const RIGHTS = { owner: "Riverbend Water Board (synthetic)", licence: "internal", hostable: true, derive: true, transmit_offregion: false };
const drawingRecord = (file, status) => {
  const [, number, rev, format] = /^(.+)_([A-Z])\.(\w+)$/.exec(file), text = read(file), title = DRAWING_META[number]?.title ?? number;
  return { id: `DWG-${number}-${rev}`, type: "Drawing", name: `${number} rev ${rev}: ${title}`, number, rev, kind: number.split("-")[1].toLowerCase(), format, sha256: sha(text), titleBlock: { number, rev, title }, rights: RIGHTS, sourceRef: { system: "synthetic-edms", path: `data/drawings/${file}`, file }, status };
};

// Seed history: rev A reviewed by P-002 and released by P-001 (spec §4.3, J13). Extracted once per process and cloned per system;
// the Position and Sensor ids it binds to are the same for every seed.
let seedA = null;
function seededModelA(ont) {
  if (!seedA) {
    const files = Object.fromEntries(readdirSync(DIR).filter((f) => /_A\.(dxf|xml|csv)$/.test(f)).map((f) => [f, read(f)]));
    const m = plantModelFrom(extractPlant(files, ont), { rev: "A" });
    const mark = { by: "P-002", at: "2025-01-30T00:00:00Z" };
    for (const c of m.cells) c.reviewed = mark;
    m.reviews = [{ ...mark, cells: m.cells.length }];
    m.packageHash = packageHash(m);
    Object.assign(m, { status: "released", governs: { from: "2025-02-01T00:00:00Z", to: null }, release: { by: "P-001", at: "2025-02-01T00:00:00Z", hash: m.packageHash } });
    seedA = m;
  }
  return structuredClone(seedA);
}

export function seedPlant(ont) {
  for (const f of readdirSync(DIR).filter((x) => /_[A-Z]\.(dxf|xml|csv)$/.test(x))) ont.upsert(drawingRecord(f, f.includes("_A.") ? "ingested" : "received"));
  const m = ont.upsert(seededModelA(ont));
  writePlant(ont, m);
  return m;
}

export function createPlantService({ ont, tel, audit }) {
  // A new draft from the released set with the given newer sheets swapped in. Unchanged cells keep their review marks.
  function ingest(drawingIds, by) {
    const cur = currentPlantModel(ont);
    if (!cur) throw new Error("no released plant model to revise");
    const given = [].concat(drawingIds).map((id) => ont.get(id));
    const missing = [].concat(drawingIds).filter((id, i) => !given[i] || given[i].type !== "Drawing");
    if (missing.length || !given.length) throw new Error(`not drawings: ${missing.join(", ") || "none given"}`);
    const open = ont.list("PlantModel", (m) => m.status === "draft" || m.status === "in_review");
    for (const d of given) {
      const have = cur.sources.find((s) => s.number === d.number);
      if (have && d.rev === have.rev) throw new Error(`${d.number} rev ${d.rev} is already in the released model ${cur.id}`);
      if (have && d.rev < have.rev) throw new Error(`${d.number} rev ${d.rev} is older than the released rev ${have.rev}`);
      const draft = open.find((m) => m.sources.some((s) => s.number === d.number && s.rev === d.rev));
      if (draft) throw new Error(`${d.number} rev ${d.rev} is already in ${draft.status} model ${draft.id}`);
    }
    const files = Object.fromEntries(cur.sources.filter((s) => !given.some((d) => d.number === s.number)).map((s) => [s.file, read(s.file)]));
    for (const d of given) {
      const text = read(d.sourceRef.file);
      if (sha(text) !== d.sha256) throw new Error(`${d.id}: file does not match its registered sha256`);
      files[d.sourceRef.file] = text;
    }
    const rev = given.map((d) => d.rev).sort().pop();
    const m = plantModelFrom(extractPlant(files, ont), { rev });
    if (ont.get(m.id)) throw new Error(`${m.id} already exists`);
    const prev = new Map(cur.cells.map((c) => [c.key, c]));
    for (const c of m.cells) {
      const p = prev.get(c.key);
      if (p?.reviewed && p.grade === c.grade && canon(p.value) === canon(c.value)) c.reviewed = p.reviewed;
    }
    m.packageHash = packageHash(m);
    ont.upsert({ ...m, ingestedBy: by.id, ingestedAt: tel.now() });
    for (const d of given) ont.upsert({ id: d.id, type: "Drawing", status: "ingested" });
    if (audit) audit.append({ actor: by.id, actorKind: by.kind, action: "ingest_drawings", outcome: "done", ref: m.id, objects: given.map((d) => d.id) });
    return ont.get(m.id);
  }
  return { ingest };
}
