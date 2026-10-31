// Site Agent in the 3D plant twin: asked about an incident, it reads live data and documents through the KG tools,
// briefs the operator, and names the place so the camera can fly there. With Claude it runs a tool loop over the
// asker's tools; without it (or when the call fails) it briefs from the best-matching active alert.
// Inference is cross-border and disclosed under POPIA s72 (NVT-PROJ-BBR-ARC-001 §4); the people tool is never offered.
import { MODEL, llmEnabled } from "./llm.mjs";
import { toolsFor } from "./kg/tools.mjs";
import { currentPlantModel } from "./plant.mjs";
import { projectIndicators } from "./project-indicators.mjs";
import { projectsAsked } from "./agents.mjs";
import { writeSnapshot } from "./project-snapshot.mjs";

const MAX_TURNS = 8;
const SEVERITY = { high: 3, medium: 2, low: 1 };
const ITEM_TYPES = new Set(["Structure", "MachinePlacement", "Valve"]);

// Plant-model item ids (what the 3D view frames) for any mix of item, asset, position, sensor, geometry or zone ids and
// tags, keeping only items the viewer may see. A thing with no item of its own falls back to its zone's structures.
export function plantFocus(ont, viewer, ids = []) {
  const view = ont.view(viewer), m = currentPlantModel(ont);
  if (!m) return [];
  const items = ont.list(null, (o) => o.modelId === m.id && ITEM_TYPES.has(o.type) && view.get(o.id));
  const out = new Set();
  for (const raw of ids) {
    const id = String(raw).split(/[@#]/)[0];
    const o = view.get(id) || view.list("Asset", (a) => a.positionTag === id)[0] || items.find((i) => i.tag === id);
    if (!o) continue;
    const asset = o.type === "Asset" ? o : o.assetId && view.get(o.assetId);
    const pos = asset ? asset.positionId : o.type === "Position" ? o.id : null;
    const hit = items.find((i) => i.id === o.id || (pos && i.positionId === pos));
    if (hit) { out.add(hit.id); continue; }
    const zone = o.type === "Zone" ? o.id : o.zoneId || asset?.zoneId || (o.anchor && view.get(o.anchor.geometryId)?.zoneId);
    for (const i of items) if (zone && i.type === "Structure" && i.zoneId === zone) out.add(i.id);
  }
  return [...out];
}

// [cite] ids in the answer that resolve for the viewer, labelled for the UI
function citationsIn(view, text) {
  const ids = [...new Set([...String(text).matchAll(/\[([^\]\s]+)\]/g)].map((x) => x[1]))];
  return ids.filter((c) => view.get(c.split(/[@#]/)[0])).map((c) => { const o = view.get(c.split(/[@#]/)[0]); return { id: c, label: o.title || o.name || o.heading || o.type }; });
}

// The deterministic brief: the active alert the question best matches (else the most severe, said as such), its live
// readings, its place.
function alertBrief(ont, tel, viewer, question) {
  const view = ont.view(viewer), words = String(question).toLowerCase().match(/[a-z0-9-]{4,}/g) || [];
  const score = (a) => words.filter((w) => a.title.toLowerCase().includes(w)).length;
  const alerts = view.list("Alert", (a) => a.state === "active").sort((x, y) => score(y) - score(x) || (SEVERITY[y.severity] || 0) - (SEVERITY[x.severity] || 0));
  const a = alerts[0];
  if (!a) return { answer: "No active alerts you can see on the works right now.", citations: [], focus: [], model: false };
  const matched = score(a) > 0;
  const target = view.get(a.targetId);
  // a catchment detection reaches the works at the intake, so it is read against raw-water turbidity there
  const sensors = target?.type === "GeoDetection" ? ["SEN-RAW-turb"] : (a.evidence || []).concat(a.targetId || []).filter((id) => view.get(id)?.type === "Sensor");
  const lines = [`${matched ? "" : "No active alert you can see matches that. The most severe one is: "}${a.title} [${a.id}], ${a.severity} severity, raised ${String(a.at).slice(0, 16).replace("T", " ")}.`];
  for (const id of sensors) {
    const s = view.get(id), l = tel.latest(id);
    if (!s || !l) continue;
    const band = s.alarmHi != null && l.value > s.alarmHi ? `above its ${s.alarmHi} ${s.unit} alarm` : s.alarmLo != null && l.value < s.alarmLo ? `below its ${s.alarmLo} ${s.unit} alarm` : "inside its alarm band";
    const zone = view.get(s.zoneId);
    lines.push(`${s.name} (${s.tag || s.id}) reads ${l.value} ${s.unit} at ${l.at.slice(11, 16)}, ${band}${zone ? `, in ${zone.name}` : ""} [${id}].`);
  }
  const answer = lines.join("\n");
  return { answer, citations: citationsIn(view, answer), focus: plantFocus(ont, viewer, [a.assetId, ...sensors].filter(Boolean)), model: false };
}

const AREAS = { people: "People", plant: "Plant and process", procedures: "Procedures", compliance: "Compliance" };

// What the 3D view frames for a project: its targeted assets, its zones and what it takes out of service.
function projectFocus(ont, viewer, p) {
  const proj = ont.view(viewer).get(p.id);
  return plantFocus(ont, viewer, [...ont.view(viewer).links(p.id, { rel: "TARGETS", dir: "out" }).map((l) => l.to), ...(proj?.zoneIds || []), ...(proj?.takesOutOfService || []).map((t) => t.id)]);
}

// The deterministic project brief: the header line, then one line per area that is not green.
function projectBrief(ont, tel, viewer, question) {
  const found = projectsAsked(ont.view(viewer), question).sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const ind = found[0] && projectIndicators(ont, tel, viewer, found[0].id);
  if (!ind) return null;
  const { milestones: m, spendZar, budgetZar, daysSinceReport } = ind.header, overdue = Array.isArray(m.overdue) ? m.overdue.length : m.overdue;
  const lines = [`${ind.title}: ${m.confirmed} confirmed of ${m.total} milestones, ${overdue} overdue; R ${spendZar} of R ${budgetZar}; last report ${daysSinceReport == null ? "none" : `${daysSinceReport} days ago`} [${ind.id}]`];
  for (const [k, a] of Object.entries(ind.areas)) {
    if (a.status === "green") continue;
    const cite = (a.items.find((i) => i.status !== "green") || a.items[0])?.cite;
    lines.push(`${AREAS[k]}: ${a.summary}${cite ? ` [${cite}]` : ""}`);
  }
  if (found.length > 1) lines.push(`Also matching: ${found.slice(1).map((p) => p.title).join(", ")}.`);
  const answer = lines.join("\n"), { id, title, header, areas } = ind;
  return { answer, citations: citationsIn(ont.view(viewer), answer), focus: projectFocus(ont, viewer, ind), model: false, project: { id, title, header, areas } };
}

export function createSiteAgent({ ont, tel, tools, client = null }) {
  const system = () => `You are the Site Agent in the 3D twin of the Riverbend water treatment works. The plant clock is ${tel.now()}: "now" means that time.
Investigate the operator's question with the tools: find the alert or reading it concerns, check the live data around it, and read the relevant documents.
Call show_on_map once with the ids of the place it concerns (assets, positions, sensors or zones), so the 3D view flies there.
Then brief the operator: what happened, where, what the readings show, and what to check first. At most six short sentences.
For a question about a maintenance project: call project_status and read its latest progress report with documents (aboutId = the project), call show_on_map with the project's assets or zones, then brief: progress against milestones, each area that is not green, and what to check first. At most eight sentences.
Cite every fact in square brackets with the cite field of the tool item it came from, for example [SEN-RAW-turb]. Cite only what the tools returned.
If a few searches find nothing, stop and say you cannot find it among what you can see; do not guess.`;

  async function claudeBrief(question, viewer) {
    let Anthropic;
    try { ({ default: Anthropic } = await import("@anthropic-ai/sdk")); } catch { return null; }
    client ??= new Anthropic();
    const mine = toolsFor(tools, viewer).filter((t) => t.name !== "people" && t.name !== "cypher");
    let shown = [], project = null;
    const defs = [...mine.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })),
      { name: "show_on_map", description: "Fly the 3D view to these objects: ids of assets, positions, sensors, zones or plant items.", input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"], additionalProperties: false } }];
    const messages = [{ role: "user", content: question }];
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // the last turn must answer with what it has, never end on a tool call
      const last = turn === MAX_TURNS - 1;
      if (last) messages.at(-1).content.push({ type: "text", text: "No more tool calls are allowed. Write the brief now from what you have." });
      const r = await client.beta.messages.create({ model: MODEL, max_tokens: 8000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", output_config: { effort: "low" }, system: system(), tools: defs, messages, ...(last ? { tool_choice: { type: "none" } } : {}) });
      if (r.stop_reason === "refusal") return null;
      messages.push({ role: "assistant", content: r.content });
      if (r.stop_reason !== "tool_use") {
        const answer = r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (!answer) return null;
        return { answer, citations: citationsIn(ont.view(viewer), answer), focus: shown.length || !project ? shown : projectFocus(ont, viewer, project), model: true, ...(project && { project }) };
      }
      const results = await Promise.all(r.content.filter((b) => b.type === "tool_use").map(async (b) => {
        if (b.name === "show_on_map") {
          shown = plantFocus(ont, viewer, Array.isArray(b.input?.ids) ? b.input.ids : []);
          return { type: "tool_result", tool_use_id: b.id, content: shown.length ? `Showing: ${shown.map((id) => ont.get(id).name).join("; ")}.` : "None of those are on the plant map; try an asset, sensor or zone id.", is_error: !shown.length };
        }
        const t = mine.find((x) => x.name === b.name);
        if (!t) return { type: "tool_result", tool_use_id: b.id, content: `Unknown tool: ${b.name}`, is_error: true };
        try {
          const out = await t.run(b.input, viewer);
          if (b.name === "project_status" && out?.found) project = { id: out.id, title: out.title, header: out.header, areas: out.areas };
          return { type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) };
        }
        catch (e) { return { type: "tool_result", tool_use_id: b.id, content: `${b.name} failed: ${String(e?.message).slice(0, 200)}`, is_error: true }; }
      }));
      messages.push({ role: "user", content: results });
    }
    return null;
  }

  async function ask({ question, viewer }) {
    let r = null;
    if (client || llmEnabled()) {
      try { r = await claudeBrief(question, viewer); }
      catch (e) { console.warn(`[site-agent] ${e?.status ? `API error ${e.status}` : e?.message}; using the fallback brief`); }
    }
    r ??= projectBrief(ont, tel, viewer, question) || alertBrief(ont, tel, viewer, question);
    if (r.project) r.changed = writeSnapshot(ont, viewer, r.project, { brief: r.answer, citations: r.citations, model: r.model, at: tel.now() }).changed;
    return r;
  }

  return { ask };
}
