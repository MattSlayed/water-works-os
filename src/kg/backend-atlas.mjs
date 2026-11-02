// The Atlas backend behind the KG tools: Timebase Atlas through its MCP ExecuteCypherQuery, readings through
// Historian MCP. MCP only, never REST. Atlas has no clearance: it answers every zone, and the tools prune.
import { HISTORIAN_READ } from "../timebase/historian-read.mjs";
import { sameRel, createMemoryBackend } from "./backend-memory.mjs";

const short = (s) => String(s).split(":").pop(); // urn:atlas:ontology:riverbend:Structure -> Structure

export const ATLAS_QUERIES = {
  // the far end of a traversal carries no label (Atlas ignores it); type tests go in WHERE
  search: "MATCH (n) WHERE n.wosId IS NOT NULL AND (toLower(n.wosId) CONTAINS $q OR toLower(n.Label) CONTAINS $q OR toLower(n.name) CONTAINS $q OR toLower(n.kind) CONTAINS $q OR toLower(n.title) CONTAINS $q) RETURN n.wosId AS id, labels(n) AS type, n.Label AS label",
  get: "MATCH (n) WHERE n.wosId = $id RETURN n.wosId AS id, labels(n) AS type, n.Label AS label, properties(n) AS props",
  neighbors: "MATCH (n)-[r]->(m) WHERE n.wosId = $id RETURN type(r) AS rel, 'out' AS dir, m.wosId AS id UNION MATCH (n)<-[r]-(m) WHERE n.wosId = $id RETURN type(r) AS rel, 'in' AS dir, m.wosId AS id",
  flowEdges: "MATCH (a)-[r:feeds]->(b) RETURN a.wosId AS src, b.wosId AS dst, r.kind AS kind, r.lineId AS lineId, r.share AS split, r.mode AS mode, r.recycle AS recycle, r.length AS len, r.pumped AS pumped"
};

// One cell of Atlas's text table: null, a boolean, a number, a [list], a {map} or text. Keys look like urn:atlas:...:name or @entity:Name.
function cell(s) {
  if (s === "null") return null;
  if (s === "true" || s === "false") return s === "true";
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^\[.*\]$/.test(s) && s.startsWith("[urn:")) return s.slice(1, -1).split(", ");
  if (/^\{.*\}$/.test(s)) return Object.fromEntries(s.slice(1, -1).split(/, (?=@entity:|urn:atlas:)/).filter(Boolean).map((kv) => {
    const at = kv.indexOf(": ");
    return at < 0 ? [kv, null] : [kv.slice(0, at), cell(kv.slice(at + 2))];
  }));
  return s;
}

// ExecuteCypherQuery answers with a JSON string holding a text table: "a | b\n--+--\n1 | 2\n\n(1 rows)". A row that doesn't fit the header is an error, never a guess.
export function parseCypherReply(r) {
  let text = r?.content?.find((c) => c.type === "text")?.text ?? "";
  try { text = JSON.parse(text); } catch { /* already plain text */ }
  if (typeof text !== "string" || /^ERROR:/.test(text)) throw new Error(`Atlas ExecuteCypherQuery: ${String(text).slice(0, 200)}`);
  const [head, rule, ...rest] = text.split("\n");
  if (head === undefined || !/^-+(\+-+)*$/.test(rule ?? "")) throw new Error("Atlas ExecuteCypherQuery: unrecognised reply");
  const columns = head.split(" | ");
  const lines = rest.filter((l) => l !== "" && !/^\(\d+ rows?\)$/.test(l));
  const rows = lines.map((l) => {
    const cells = l.split(" | ");
    if (cells.length !== columns.length) throw new Error(`Atlas ExecuteCypherQuery: a row has ${cells.length} cells for ${columns.length} columns`);
    return cells.map(cell);
  });
  return { columns, rows };
}

const historianReadings = (historian) => (sensor, fromIso, toIso) => HISTORIAN_READ.read((tool, args) => historian.callTool(tool, args), sensor.tag, fromIso, toIso);

// Hybrid: the graph from memory, the readings from Historian, so agents read real Historian data while Atlas cannot compile.
export const createHybridBackend = ({ ont, tel, historian }) => ({ ...createMemoryBackend({ ont, tel }), readings: historianReadings(historian) });

// atlas, historian: connected MCP clients (connectMcp from src/timebase/mcp.mjs) or anything with callTool(name, args)
export function createAtlasBackend({ atlas, historian, domain = "riverbend", branch = "riverbend" }) {
  async function cypher(query, parameters = {}) {
    return parseCypherReply(await atlas.callTool("ExecuteCypherQuery", { domain, branch, cypher: query, parameters }));
  }
  const objects = async (query, params) => {
    const { columns, rows } = await cypher(query, params);
    return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
  };
  const typeOf = (t) => short(Array.isArray(t) ? t[0] : t);

  return {
    async search(q, types, limit = 20) {
      const s = String(q ?? "").trim().toLowerCase();
      if (!s) return [];
      const hits = (await objects(ATLAS_QUERIES.search, { q: s })).map((h) => ({
        id: h.id, type: typeOf(h.type), label: h.label, score: [h.id, h.label].some((x) => x && String(x).toLowerCase() === s) ? 1 : 0.5
      }));
      return hits.filter((h) => !types?.length || types.includes(h.type)).sort((a, b) => b.score - a.score).slice(0, limit);
    },
    async get(id) {
      const [h] = await objects(ATLAS_QUERIES.get, { id });
      return h ? { ...Object.fromEntries(Object.entries(h.props || {}).map(([k, v]) => [short(k), v])), id: h.id, type: typeOf(h.type), label: h.label } : null;
    },
    async neighbors(id, rel) {
      return (await objects(ATLAS_QUERIES.neighbors, { id })).map((n) => ({ ...n, rel: short(n.rel) })).filter((n) => !rel || sameRel(n.rel, rel));
    },
    async flowEdges() {
      return (await objects(ATLAS_QUERIES.flowEdges)).map((e) => ({
        from: e.src, to: e.dst, kind: e.kind, lineId: e.lineId, split: e.split ?? null, mode: e.mode, recycle: !!e.recycle, length: e.len || 0, pumped: !!e.pumped
      }));
    },
    // Historian's window is [from, to) and it stores changes only; the tools treat a missing minute as the value held
    readings: historianReadings(historian),
    cypher
  };
}
