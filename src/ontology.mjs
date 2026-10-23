// In-memory ontology store. The interface mirrors the production graph service (graph-mcp over Neo4j),
// so an adapter can replace this file without touching callers.
// shortcut: in-memory, single process; upgrade to the Neo4j/Graphiti adapter for a real tenant.

export const CLEARANCES = ["technician", "operator", "supervisor", "engineer", "manager"];
export const rank = (c) => CLEARANCES.indexOf(c);

const nowIso = () => new Date().toISOString();
const appProv = (id) => ({ source: "APP", source_uri: `app://${id}`, source_version: "v1", extracted_at: nowIso(), confidence: 1 });

export function createOntology({ objects = [], links = [] } = {}) {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const out = new Map(); // id -> links from id
  const inc = new Map(); // id -> links to id
  const listeners = [];
  const index = (l) => {
    (out.get(l.from) || out.set(l.from, []).get(l.from)).push(l);
    (inc.get(l.to) || inc.set(l.to, []).get(l.to)).push(l);
  };
  links.forEach(index);
  const emit = (e) => listeners.forEach((fn) => fn(e));

  // The zone an object belongs to, for pruning: its own zone, or the zone of what it is about.
  const zoneOf = (o) => {
    if (!o) return null;
    if (o.type === "Zone") return o.id;
    if (o.zoneId) return o.zoneId;
    for (const k of ["assetId", "processUnitId", "positionId", "partId"]) {
      if (o[k] && byId.has(o[k]) && o[k] !== o.id) return zoneOf(byId.get(o[k]));
    }
    return null;
  };

  const matches = (o, q) => {
    const hay = [o.id, o.name, o.tag, o.positionTag, o.title, o.text, o.kks, o.serial].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  };

  function makeReader(visible) {
    const get = (id) => {
      const o = byId.get(id);
      return o && visible(o) ? o : null;
    };
    const list = (type, pred) => {
      const res = [];
      for (const o of byId.values()) if ((!type || o.type === type) && visible(o) && (!pred || pred(o))) res.push(o);
      return res;
    };
    const search = (q, limit = 20) => {
      const s = String(q || "").trim().toLowerCase();
      if (!s) return [];
      const hits = list(null, (o) => matches(o, s));
      const exact = (o) => [o.id, o.tag, o.positionTag].some((x) => x && x.toLowerCase() === s) ? 0 : 1;
      return hits.sort((a, b) => exact(a) - exact(b)).slice(0, limit);
    };
    const linksOf = (id, { rel, dir = "both" } = {}) => {
      if (!get(id)) return [];
      const ls = [...(dir !== "in" ? out.get(id) || [] : []), ...(dir !== "out" ? inc.get(id) || [] : [])];
      return ls.filter((l) => (!rel || l.rel === rel) && get(l.from) && get(l.to));
    };
    const neighbors = (id, rel) => linksOf(id, { rel }).map((l) => get(l.from === id ? l.to : l.from));
    return { get, list, search, links: linksOf, neighbors, zoneOf: (id) => zoneOf(byId.get(id)) };
  }

  const all = makeReader(() => true);

  const upsert = (obj) => {
    if (!obj || !obj.id || !obj.type) throw new Error("upsert needs id and type");
    const prev = byId.get(obj.id);
    const next = { ...(prev || {}), ...obj, prov: obj.prov || (prev && prev.prov) || appProv(obj.id) };
    byId.set(obj.id, next);
    emit({ kind: "upsert", id: obj.id, type: next.type, at: nowIso() });
    return next;
  };
  const link = (from, rel, to, props, prov) => {
    if (!byId.has(from) || !byId.has(to)) throw new Error(`link endpoint missing: ${from} -${rel}-> ${to}`);
    const l = { from, rel, to, ...(props ? { props } : {}), prov: prov || appProv(`${from}/${rel}/${to}`) };
    index(l);
    emit({ kind: "link", id: from, rel, to, at: nowIso() });
    return l;
  };
  const remove = (id) => {
    byId.delete(id);
    emit({ kind: "remove", id, at: nowIso() });
  };

  // A viewer sees an object unless it sits in a zone above the viewer's clearance.
  const view = (viewer) => {
    const r = rank(viewer && viewer.clearance);
    const visible = (o) => {
      if (o.minClearance && rank(o.minClearance) > r) return false;
      const z = zoneOf(o);
      if (!z) return true;
      const zone = byId.get(z);
      return !zone || rank(zone.clearance) <= r;
    };
    return Object.freeze(makeReader(visible));
  };

  return { ...all, upsert, link, remove, view, on: (fn) => listeners.push(fn) };
}
