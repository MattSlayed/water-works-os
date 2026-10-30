// The agents' read-only knowledge-graph tools, over a memory or an Atlas backend. WaterOS is the clearance authority:
// Atlas answers every zone to any token, so every item passes ont.view(viewer).get(item.id) or is dropped.
// Events, documents, geometry and people are WaterOS-only data and are read through ont.view(viewer), never the backend.
import { rank } from "../ontology.mjs";
import { graphFrom, upstreamOf, downstreamOf, processPaths, travelWindow } from "../functions.mjs";
import { currentPlantModel } from "../plant.mjs";
import { lintCypher } from "./cypher-lint.mjs";

const EVENT_KINDS = ["Alert", "WorkOrder", "Sample"];
const kept = (view, items) => items.filter((i) => view.get(i.id));
// a PlantModel's cells describe every zone, so like the generic routes the tools give its summary only
const strip = ({ prov, ...o }) => (o.type === "PlantModel" ? (({ items, cells, sources, ...s }) => s)(o) : o);
const str = { type: "string" };
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const toolsFor = (tools, viewer) => tools.filter((t) => !t.minClearance || rank(viewer?.clearance) >= rank(t.minClearance));

// least-squares slope per hour; mean weighted by held time, since Historian stores changes only (a dense series weighs 1 min each)
function summary(pts, toIso, alarmHi) {
  const ts = pts.map((p) => Date.parse(p.t)), vs = pts.map((p) => p.v), n = pts.length, r = (x) => Math.round(x * 1e4) / 1e4;
  const w = ts.map((t, i) => (i + 1 < n ? ts[i + 1] : Math.max(Date.parse(toIso), t + 60e3)) - t);
  const W = w.reduce((a, b) => a + b, 0), h = ts.map((t) => (t - ts[0]) / 3.6e6);
  const hm = h.reduce((a, b) => a + b, 0) / n, vm = vs.reduce((a, b) => a + b, 0) / n;
  const sxx = h.reduce((s, x) => s + (x - hm) ** 2, 0), sxy = h.reduce((s, x, i) => s + (x - hm) * (vs[i] - vm), 0);
  return {
    n, min: Math.min(...vs), max: Math.max(...vs), mean: r(vs.reduce((s, v, i) => s + v * w[i], 0) / W), first: vs[0], last: vs[n - 1],
    slopePerH: sxx ? r(sxy / sxx) : 0, firstAboveAlarmAt: alarmHi == null ? null : pts.find((p) => p.v > alarmHi)?.t ?? null
  };
}

export function createKgTools({ backend, ont, tel, crosswalk = {} }) {
  const renamed = new Map((crosswalk.renames || []).filter(([, n]) => n));
  const oldOf = new Map((crosswalk.assets || []).map((a) => [a.canonical, a.old]));
  const exact = (view, s) => s && view.search(s, 50).find((o) => [o.id, o.tag, o.positionTag, o.kks].some((x) => x && x.toLowerCase() === s.toLowerCase()));
  // an id, a renamed id, a tag or KKS, or a crosswalk canonical name, resolved only among what the viewer sees
  const resolve = (view, id) => {
    const s = String(id ?? "").trim();
    return (view.get(s) || view.get(renamed.get(s)) || exact(view, s) || exact(view, oldOf.get(s)))?.id ?? null;
  };

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
        if (o && view.get(o.id)) return { found: true, item: { ...strip(o), cite: o.id } };
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
      description: "A sensor's readings over [from, to]: a summary {n, min, max, mean, first, last, slopePerH, firstAboveAlarmAt} or the raw points. No-data points are dropped, never read as zero. Defaults to the last 24 h of plant time.",
      inputSchema: schema({ sensorId: str, from: str, to: str, agg: { enum: ["summary", "raw"] } }, ["sensorId"]),
      async run({ sensorId, from, to, agg = "summary" }, viewer) {
        const view = ont.view(viewer), s = view.get(resolve(view, sensorId));
        if (s?.type !== "Sensor") return { found: false };
        to = to || tel.now();
        from = from || new Date(Date.parse(to) - 86400e3).toISOString();
        const cite = `${s.id}@${from}..${to}`;
        // Historian no-data rows (time 0001-01-01 or quality 0) are absent readings, never zeros
        const points = (await backend.readings(s, from, to)).filter((p) => !String(p.t).startsWith("0001-01-01") && p.q !== 0);
        if (!points.length) return { id: s.id, points: [], note: "no data", cite };
        return agg === "raw" ? { id: s.id, unit: s.unit, points, cite } : { id: s.id, unit: s.unit, ...summary(points, to, s.alarmHi), cite };
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
        return { people: kept(view, people), presence: kept(view, presence) };
      }
    }
  ];

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
      // a row naming a WaterOS object the viewer may not see is dropped (rows are tables, so the query is the citation)
      const hidden = (v) => (Array.isArray(v) ? v.some(hidden) : typeof v === "string" && !!ont.get(v) && !view.get(v));
      return { ok: true, columns: r.columns, rows: r.rows.filter((row) => !row.some(hidden)), cite: `cypher:${query}` };
    }
  });
  return tools;
}
