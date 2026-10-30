// The agents' read-only knowledge-graph tools, over a memory or an Atlas backend. WaterOS is the clearance authority:
// Atlas answers every zone to any token, so every item passes ont.view(viewer).get(item.id) or is dropped.
// Events, documents, geometry and people are WaterOS-only data and are read through ont.view(viewer), never the backend.
import { rank } from "../ontology.mjs";
import { graphFrom, upstreamOf, downstreamOf, processPaths, travelWindow } from "../functions.mjs";
import { currentPlantModel } from "../plant.mjs";
import { lintCypher } from "./cypher-lint.mjs";

const EVENT_KINDS = ["Alert", "WorkOrder", "Sample"];
// POPIA: people data is reachable only through the people tool; no other tool returns these types or names their ids
export const PEOPLE = new Set(["Person", "Competency", "Presence", "Participant", "Channel", "Message", "Execution", "Feedback"]);
const sees = (view, id) => { const o = typeof id === "string" && view.get(id); return !!o && !PEOPLE.has(o.type); };
const kept = (view, items) => items.filter((i) => sees(view, i.id));
// a PlantModel's cells describe every zone, so like the generic routes the tools give its summary only
const strip = ({ prov, ...o }) => (o.type === "PlantModel" ? (({ items, cells, sources, ...s }) => s)(o) : o);
const str = { type: "string" };
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const toolsFor = (tools, viewer) => tools.filter((t) => !t.minClearance || rank(viewer?.clearance) >= rank(t.minClearance));

const MIN = 60e3, RAW_CAP = 500;
// shortcut: a value unchanged for more than a day before `from` reads as no data until its next change; widen if that bites
const LOOKBACK = 86400e3;
// The value held at each minute of [from, to]. Historian stores changes only, so a row holds until the next one;
// a quality-0 row starts a gap (it is not held over); a 0001-01-01 row is an empty TVQ with no time, so it places nothing.
function minuteGrid(rows, fromMs, toMs) {
  const ev = rows.filter((p) => !String(p.t).startsWith("0001-01-01")).map((p) => ({ t: Date.parse(p.t), v: p.q === 0 ? null : p.v })).sort((a, b) => a.t - b.t);
  const out = [];
  let i = 0, cur = null;
  for (let m = Math.ceil(fromMs / MIN) * MIN; m <= toMs; m += MIN) {
    while (i < ev.length && ev[i].t <= m) cur = ev[i++].v;
    if (cur !== null) out.push({ t: new Date(m).toISOString(), v: cur });
  }
  return out;
}
// over the minute grid, so a held value counts for every minute it holds; slope is least squares, per hour
function summary(pts, alarmHi) {
  const n = pts.length, vs = pts.map((p) => p.v), h = pts.map((p) => (Date.parse(p.t) - Date.parse(pts[0].t)) / 3.6e6), r = (x) => Math.round(x * 1e4) / 1e4;
  const sum = (xs) => xs.reduce((a, b) => a + b, 0), hm = sum(h) / n, vm = sum(vs) / n;
  const sxx = sum(h.map((x) => (x - hm) ** 2)), sxy = sum(h.map((x, i) => (x - hm) * (vs[i] - vm)));
  return {
    n, min: vs.reduce((a, b) => Math.min(a, b)), max: vs.reduce((a, b) => Math.max(a, b)), mean: r(vm), first: vs[0], last: vs[n - 1],
    slopePerH: sxx ? r(sxy / sxx) : 0, firstAboveAlarmAt: alarmHi == null ? null : pts.find((p) => p.v > alarmHi)?.t ?? null
  };
}

export function createKgTools({ backend, ont, tel, crosswalk = {} }) {
  const renamed = new Map((crosswalk.renames || []).filter(([, n]) => n));
  const oldOf = new Map((crosswalk.assets || []).map((a) => [a.canonical, a.old]));
  const exact = (view, s) => s && view.search(s, 50).find((o) => !PEOPLE.has(o.type) && [o.id, o.tag, o.positionTag, o.kks].some((x) => x && x.toLowerCase() === s.toLowerCase()));
  // an id, a renamed id, a tag or KKS, or a crosswalk canonical name, resolved only among what the viewer sees (never a person)
  const resolve = (view, id) => {
    const s = String(id ?? "").trim();
    const o = view.get(s) || view.get(renamed.get(s)) || exact(view, s) || exact(view, oldOf.get(s));
    return o && !PEOPLE.has(o.type) ? o.id : null;
  };
  // a string naming an ontology object the viewer may not see, or a person, is dropped at any depth (array entries too)
  const hidden = (view, v) => typeof v === "string" && !!ont.get(v) && !sees(view, v);
  const scrub = (view, v) => Array.isArray(v) ? v.filter((x) => !hidden(view, x)).map((x) => scrub(view, x))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => !hidden(view, x)).map(([k, x]) => [k, scrub(view, x)])) : v;

  // nodes, aliases and machine-in-structure edges from the viewer's released model, process edges from the backend:
  // pruned before the walk, so a hidden node is never walked through (the same graph as /api/plant/graph for that viewer)
  async function graphFor(view) {
    const m = currentPlantModel(ont);
    const g = graphFrom(view.list(null, (o) => m && o.modelId === m.id && (o.type === "Structure" || o.type === "MachinePlacement")));
    for (const e of await backend.flowEdges()) {
      if (!g.nodes.has(e.from) || !g.nodes.has(e.to) || (e.lineId && !view.get(e.lineId))) continue;
      (g.out.get(e.from) || g.out.set(e.from, []).get(e.from)).push(e);
      (g.in.get(e.to) || g.in.set(e.to, []).get(e.to)).push(e);
    }
    return g;
  }
  const walkTool = (name, walk) => ({
    name,
    description: `What is ${name} of a plant object along the process flow, with each item's share of the water and its travel window (onset, mean, tail hours). Backwash lines are walked only in mode "backwash"; recycle items are marked and not crossed.`,
    inputSchema: schema({ id: str, mode: { enum: ["normal", "backwash"] }, flowMlD: { type: "number" } }, ["id"]),
    async run({ id, mode = "normal", flowMlD }, viewer) {
      const view = ont.view(viewer), g = await graphFor(view), rid = resolve(view, id), start = rid && (g.alias.get(rid) || rid);
      if (!g.nodes.has(start)) return { found: false, items: [] };
      const opts = flowMlD ? { flowMlD } : {};
      const items = walk(start, g, { mode }).map((x) => {
        const path = processPaths(name === "upstream" ? x.id : start, name === "upstream" ? start : x.id, g, { limit: 1, mode })[0];
        const { basis, ...window } = path ? travelWindow(path, g, opts) : {};
        return { ...x, window: path ? window : null, cite: x.id };
      });
      return { id: start, mode, items: kept(view, items), basis: travelWindow([], g, opts).basis };
    }
  });

  const tools = [
    {
      name: "search",
      description: "Find plant objects by id, tag, name or kind. Returns {id, type, label, score}.",
      inputSchema: schema({ q: str, types: { type: "array", items: str }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["q"]),
      async run({ q, types, limit = 20 }, viewer) {
        // shortcut: over-fetches 10x and then prunes, so a viewer behind many hidden hits can get fewer than limit; page if that bites
        const hits = await backend.search(q, types, limit * 10);
        return { items: kept(ont.view(viewer), hits).slice(0, limit).map((h) => ({ ...h, cite: h.id })) };
      }
    },
    {
      name: "get",
      description: "One object by id, tag, KKS or canonical name. Retired ids say so, with the crosswalk entry.",
      inputSchema: schema({ id: str }, ["id"]),
      async run({ id }, viewer) {
        const view = ont.view(viewer), o = await backend.get(resolve(view, id) || id);
        if (o && sees(view, o.id)) return { found: true, item: { ...strip(o), cite: o.id } };
        const ids = (crosswalk.retired || []).filter((r) => r === id || r === `POS-${id}`);
        if (!ids.length) return { found: false };
        const canonical = (crosswalk.assets || []).find((a) => a.canonical === id || a.old === id);
        return { found: false, retired: true, ids, ...(canonical ? { canonical } : {}) };
      }
    },
    {
      name: "neighbors",
      description: "The objects linked to an object, with the relationship and its direction.",
      inputSchema: schema({ id: str, rel: str }, ["id"]),
      async run({ id, rel }, viewer) {
        const view = ont.view(viewer), rid = resolve(view, id);
        if (!rid) return { found: false, items: [] };
        return { items: kept(view, await backend.neighbors(rid, rel)).map((n) => ({ ...n, cite: n.id })) };
      }
    },
    walkTool("upstream", upstreamOf),
    walkTool("downstream", downstreamOf),
    {
      name: "readings",
      description: `A sensor's value at each minute of [from, to] (to is clamped to the plant clock): a summary {n, min, max, mean, first, last, slopePerH, firstAboveAlarmAt} or the raw minute points (at most ${RAW_CAP}, evenly spaced, with truncated and count when cut). Stored values hold until they change; no-data minutes are left out, never read as zero. Defaults to the last 24 h of plant time.`,
      inputSchema: schema({ sensorId: str, from: str, to: str, agg: { enum: ["summary", "raw"] } }, ["sensorId"]),
      async run({ sensorId, from, to, agg = "summary" }, viewer) {
        const view = ont.view(viewer), s = view.get(resolve(view, sensorId));
        if (s?.type !== "Sensor") return { found: false };
        const now = tel.now(), iso = (ms) => new Date(ms).toISOString();
        if (!to || Date.parse(to) > Date.parse(now)) to = now; // never read past the plant clock, whichever backend answers
        from = from || iso(Date.parse(to) - 86400e3);
        const cite = `${s.id}@${from}..${to}`, fromMs = Date.parse(from), toMs = Date.parse(to);
        if (!(fromMs <= toMs)) return { id: s.id, points: [], note: `empty window: from must be on or before to and the plant clock (${now})`, cite };
        // look back so the value held at `from` is known, then read every minute on the grid
        const grid = minuteGrid(await backend.readings(s, iso(fromMs - LOOKBACK), iso(toMs)), fromMs, toMs);
        if (!grid.length) return { id: s.id, points: [], note: "no data", cite };
        if (agg !== "raw") return { id: s.id, unit: s.unit, ...summary(grid, s.alarmHi), cite };
        if (grid.length <= RAW_CAP) return { id: s.id, unit: s.unit, points: grid, cite };
        const points = Array.from({ length: RAW_CAP }, (_, i) => grid[Math.round((i * (grid.length - 1)) / (RAW_CAP - 1))]);
        return { id: s.id, unit: s.unit, points, truncated: true, count: grid.length, cite };
      }
    },
    {
      name: "events",
      description: `Alerts, work orders and samples, optionally for one object or zone and a time window. kinds: ${EVENT_KINDS.join(", ")}.`,
      inputSchema: schema({ scope: str, from: str, to: str, kinds: { type: "array", items: { enum: EVENT_KINDS } } }),
      async run({ scope, from, to, kinds = EVENT_KINDS }, viewer) {
        const view = ont.view(viewer), sid = scope ? resolve(view, scope) : null;
        if (scope && !sid) return { found: false, items: [] };
        const when = (o) => o.at || o.takenAt || o.planned || o.closed || null;
        const inTime = (o) => { const t = Date.parse(when(o)); return (!from || t >= Date.parse(from)) && (!to || t <= Date.parse(to)); };
        const inScope = (o) => !sid || [o.zoneId, o.assetId, o.targetId, o.processUnitId, o.positionId].includes(sid) || view.zoneOf(o.id) === sid;
        const items = kinds.filter((k) => EVENT_KINDS.includes(k)).flatMap((k) => view.list(k, (o) => inScope(o) && inTime(o)))
          .map((o) => ({ ...strip(o), at: when(o), cite: o.id })).sort((a, b) => String(a.at).localeCompare(String(b.at)));
        return { items: kept(view, items) };
      }
    },
    {
      name: "documents",
      description: "Document passages about an object and/or matching text, each cited by chunk id. Documents without chunks are searched through their procedure steps, cited <procedureId>#<stepId>.",
      inputSchema: schema({ aboutId: str, q: str }),
      async run({ aboutId, q }, viewer) {
        const view = ont.view(viewer), about = aboutId ? resolve(view, aboutId) : null, s = String(q ?? "").toLowerCase();
        if (aboutId && !about) return { items: [] };
        const near = new Set([about, view.get(about)?.positionId].filter(Boolean));
        const isAbout = (c) => !about || c.documentId === about || view.links(c.id, { rel: "ABOUT", dir: "out" }).some((l) => near.has(l.to));
        const all = view.list("Chunk"), chunked = new Set(all.map((c) => c.documentId)), heads = (c) => c.heading.toLowerCase().includes(s);
        const chunks = all.filter((c) => isAbout(c) && (!s || `${c.heading}\n${c.text}`.toLowerCase().includes(s)))
          .sort((a, b) => (s ? heads(b) - heads(a) : 0) || a.order - b.order)
          .map((c) => ({ id: c.id, type: "Chunk", documentId: c.documentId, heading: c.heading, snippet: c.text.slice(0, 240), cite: c.id }));
        const steps = view.list("Procedure", (p) => !chunked.has(p.documentId) && (!about || about === p.id || about === p.documentId)).flatMap((p) =>
          (p.steps || []).filter((st) => !s || `${p.title}\n${st.text}`.toLowerCase().includes(s))
            .map((st) => ({ id: p.id, type: "ProcedureStep", documentId: p.documentId, step: st.step, snippet: st.text, cite: `${p.id}#${st.id}` })));
        return { items: kept(view, [...chunks, ...steps]) };
      }
    },
    {
      name: "read",
      description: "One passage in full: a chunk id, or a <procedureId>#<stepId> citation.",
      inputSchema: schema({ chunkId: str }, ["chunkId"]),
      async run({ chunkId }, viewer) {
        const view = ont.view(viewer), c = view.get(chunkId);
        if (c?.type === "Chunk") return { found: true, id: c.id, documentId: c.documentId, heading: c.heading, text: c.text, cite: c.id };
        const [pid, sid] = String(chunkId).split("#"), p = view.get(pid), st = p?.type === "Procedure" && (p.steps || []).find((x) => x.id === sid);
        return st ? { found: true, id: p.id, documentId: p.documentId, step: st.step, text: st.text, cite: chunkId } : { found: false };
      }
    },
    {
      name: "locate",
      description: "Where an object is in the 3D scene: its GeometryRefs (file, node, centroid, bbox), else its position's, else a sensor's anchor.",
      inputSchema: schema({ id: str }, ["id"]),
      async run({ id }, viewer) {
        const view = ont.view(viewer), o = view.get(resolve(view, id));
        if (!o) return { items: [] };
        const geo = (x) => view.links(x, { rel: "HAS_GEOMETRY", dir: "out" }).map((l) => l.to);
        const holders = [o.positionId, ...view.links(o.id, { dir: "out" }).filter((l) => l.rel === "INSTALLED_AT" || l.rel === "CONTAINS").map((l) => l.to)].filter(Boolean);
        let ids = geo(o.id);
        if (!ids.length) ids = holders.flatMap(geo);
        if (!ids.length && o.anchor) ids = [o.anchor.geometryId];
        return { items: [...new Set(ids)].map((g) => view.get(g)).filter(Boolean).map((g) => ({ ...strip(g), cite: g.id })) };
      }
    },
    {
      name: "people",
      description: "People {id, name, role} and where they are checked in {personId, zoneId, since}. WaterOS only; never sent to Atlas.",
      inputSchema: schema({ q: str, zoneId: str }),
      async run({ q, zoneId } = {}, viewer) {
        const view = ont.view(viewer), s = String(q ?? "").toLowerCase();
        const people = view.list("Person", (p) => !s || [p.id, p.name, p.role].some((x) => x && x.toLowerCase().includes(s))).map((p) => ({ id: p.id, name: p.name, role: p.role, cite: p.id }));
        const who = new Set(people.map((p) => p.id));
        const presence = view.list("Presence", (x) => (!zoneId || x.zoneId === zoneId) && (!s || who.has(x.personId)))
          .map((x) => ({ id: x.id, personId: x.personId, zoneId: x.zoneId, since: x.since, cite: x.id }));
        return { people, presence };
      }
    }
  ];
  // every tool but people (the one door to people data) is scrubbed; cypher drops whole rows instead, below
  for (const t of tools) if (t.name !== "people") {
    const run = t.run;
    t.run = async (input = {}, viewer) => scrub(ont.view(viewer), await run(input, viewer));
  }

  if (process.env.WWOS_KG_CYPHER === "1") tools.push({
    name: "cypher",
    description: "Read-only openCypher against the Atlas riverbend domain. Linted first: no writes, type tests in WHERE (never a label on a traversal's far end), no inline property maps.",
    minClearance: "manager",
    inputSchema: schema({ query: str, params: { type: "object" } }, ["query"]),
    async run({ query, params }, viewer) {
      if (rank(viewer?.clearance) < rank("manager")) return { ok: false, errors: ["cypher is manager only"] };
      const lint = lintCypher(query);
      if (!lint.ok) return lint;
      const view = ont.view(viewer), r = await backend.cypher(query, params || {});
      // a row naming a WaterOS object the viewer may not see (or a person) is dropped whole, so columns stay aligned;
      // rows are tables, so the query is the citation
      const bad = (v) => (Array.isArray(v) ? v.some(bad) : hidden(view, v));
      return { ok: true, columns: r.columns, rows: r.rows.filter((row) => !row.some(bad)), cite: `cypher:${query}` };
    }
  });
  return tools;
}
