// Worker profiles, and the people relevant to a plant object or line, each with the reasons. Built from WaterOS records
// (Person, Competency via HOLDS, Presence, WorkOrder, Project via WORKS_ON/TARGETS, Shift). People data stays in
// WaterOS: nothing here is ever sent to Atlas (POPIA), and every read goes through the viewer's ont.view.
import { rank, CLEARANCES } from "./ontology.mjs";
import { currentPlantModel } from "./plant.mjs";

// What each competency lets a person work on, matched against a target's asset classes and structure kinds.
// shortcut: a trade-to-class table, not a skills matrix; replace with the HR skills matrix when one is connected.
export const NEEDS = [
  { comp: "trade:millwright", what: "mechanical", fits: /pump|blower|scraper|generator|filter/i },
  { comp: "trade:fitter", what: "mechanical and pipework", fits: /pump|blower|scraper|generator|filter|\bline\b/i },
  { comp: "trade:electrician", what: "electrical", fits: /pump|blower|scraper|generator|chlorinator|\bmcc\b/i },
  { comp: "trade:instrumentation", what: "instruments and analysers", fits: /sample|chlorinator|filter|dosing/i },
  { comp: "gas-safety:chlorine", what: "chlorine handling", fits: /chlorinator|chlorine/i },
  { comp: "confined-space", what: "confined-space entry", fits: /reservoir|contact_tank|sump|_tank|clarifier|thickener|filter_bed/i }
];
const SCORE = { assigned: 4, project: 3, here: 2, competent: 1 };
const OPEN = new Set(["open", "in_progress", "scheduled", "planned"]);
const day = (iso) => String(iso || "").slice(0, 10);

// On shift now: a crew is on when a Shift for it covers now; day workers 06:00-18:00 by the plant clock. null when unknown.
export function onShift(ont, person, now) {
  if (!person.shift) return null;
  const t = Date.parse(now);
  if (person.shift === "DAY") { const h = new Date(t).getUTCHours(); return h >= 6 && h < 18; }
  const covering = ont.list("Shift", (s) => Date.parse(s.start) <= t && t < Date.parse(s.end));
  return covering.length ? covering.some((s) => s.crew === person.shift) : null;
}

const competenciesOf = (ont, personId) => ont.links(personId, { rel: "HOLDS", dir: "out" }).map((l) => ont.get(l.to)).filter(Boolean);
const validAt = (c, now) => (!c.validFrom || c.validFrom <= day(now)) && (!c.validTo || day(now) <= c.validTo);
const statusOf = (c, now) => {
  if (!validAt(c, now)) return c.validTo && c.validTo < day(now) ? "expired" : "not yet valid";
  return c.validTo && (new Date(c.validTo) - new Date(now)) / 864e5 <= 90 ? "expiring" : "valid";
};

// Self or supervisor and above see the whole profile; anyone else sees who the person is, their trade and where they are.
const fullFor = (viewer, personId) => viewer?.id === personId || rank(viewer?.clearance) >= rank("supervisor");

export function profileOf(ont, viewer, personId, now) {
  const view = ont.view(viewer), p = view.get(personId);
  if (!p || p.type !== "Person") return null;
  const here = view.list("Presence", (x) => x.personId === p.id).sort((a, b) => (b.since || "").localeCompare(a.since || ""))[0];
  const zone = here && view.get(here.zoneId);
  const basic = {
    id: p.id, name: p.name, role: p.role, trade: p.trade || null, employer: p.employer || null, shift: p.shift || null,
    onShift: onShift(ont, p, now), onSite: here ? { zoneId: here.zoneId, zone: zone?.name || here.zoneId, since: here.since, cite: here.id } : null, full: false
  };
  if (!fullFor(viewer, p.id)) return basic;
  const sup = p.supervisorId && view.get(p.supervisorId);
  const workOrders = view.list("WorkOrder", (w) => w.assigneeId === p.id && OPEN.has(w.state)).map((w) => ({ id: w.id, title: w.title, state: w.state, priority: w.priority, assetId: w.assetId }));
  const projects = ont.links(p.id, { rel: "WORKS_ON", dir: "out" }).filter((l) => view.get(l.to)).map((l) => { const pr = view.get(l.to); return { id: pr.id, name: pr.name || pr.title || pr.id, role: l.props?.role || null }; });
  return {
    ...basic, full: true, clearance: p.clearance, supervisor: sup ? { id: sup.id, name: sup.name } : null,
    competencies: competenciesOf(ont, p.id).filter((c) => view.get(c.id)).map((c) => ({ id: c.id, competency: c.competency, level: c.level ?? null, validTo: c.validTo || null, status: statusOf(c, now) })),
    workOrders, projects
  };
}

export function profiles(ont, viewer, now) {
  const list = ont.view(viewer).list("Person").map((p) => profileOf(ont, viewer, p.id, now)).filter(Boolean);
  // on site first, by zone, then everyone else by name
  return list.sort((a, b) => (!!b.onSite - !!a.onSite) || String(a.onSite?.zoneId || "").localeCompare(String(b.onSite?.zoneId || "")) || a.name.localeCompare(b.name));
}

// What a plant object (or line) stands for when matching people: its zones, the assets in it, and the kinds of thing it is.
function targetOf(ont, view, o) {
  const assetsAt = (posId) => ont.links(posId, { rel: "INSTALLED_AT", dir: "in" }).map((l) => l.from);
  const posOfStructure = (sid) => ont.links(sid, { rel: "CONTAINS", dir: "out" }).map((l) => l.to);
  let zones = [], assets = [], kinds = [];
  if (o.type === "Line") { zones = o.zones?.length ? o.zones : [o.zoneId].filter(Boolean); kinds = ["line", o.service || ""]; }
  else if (o.type === "Zone") zones = [o.id];
  else if (o.type === "Site") zones = view.list("Zone").map((z) => z.id);
  else if (o.type === "Asset") { assets = [o.id]; zones = [o.zoneId || ont.zoneOf(o.id)]; }
  else if (o.type === "Position") { assets = assetsAt(o.id); zones = [o.zoneId || ont.zoneOf(o.id)]; }
  else if (o.type === "MachinePlacement") { assets = o.positionId ? assetsAt(o.positionId) : []; zones = [o.zoneId || ont.zoneOf(o.id)]; }
  else if (o.type === "Structure") { assets = posOfStructure(o.id).flatMap(assetsAt); zones = [o.zoneId || ont.zoneOf(o.id)]; kinds = [o.kind || ""]; }
  else if (o.type === "ProcessUnit") {
    const pos = ont.links(o.id, { rel: "HAS_POSITION", dir: "out" }).map((l) => l.to);
    assets = pos.flatMap(assetsAt); zones = [...new Set(pos.map((x) => ont.get(x)?.zoneId).filter(Boolean))];
  } else zones = [ont.zoneOf(o.id)];
  assets = [...new Set(assets)].filter((a) => view.get(a));
  kinds = [...kinds, ...assets.map((a) => ont.get(a)?.assetClass || "")].filter(Boolean);
  return { zones: [...new Set(zones.filter(Boolean))], assets, kinds: kinds.join(" | ") };
}

// The people relevant to these plant objects (a node, or both ends of an edge, or a line), most relevant first. Each
// person carries every reason, with the record that backs it. A person is offered as competent only if their clearance
// reaches the zone, and only with a competency valid today.
export function peopleFor(ont, viewer, ids, now) {
  const view = ont.view(viewer), objs = [].concat(ids).map((id) => view.get(id)).filter(Boolean);
  if (!objs.length) return null;
  const t = objs.map((o) => targetOf(ont, view, o));
  const zones = [...new Set(t.flatMap((x) => x.zones))], assets = new Set(t.flatMap((x) => x.assets)), kinds = t.map((x) => x.kinds).join(" | ");
  const zoneNeed = zones.map((z) => ont.get(z)?.clearance).filter(Boolean).reduce((a, c) => (rank(c) > rank(a) ? c : a), CLEARANCES[0]);
  const by = new Map();
  const add = (personId, kind, text, cite) => {
    const p = view.get(personId);
    if (!p || p.type !== "Person") return;
    const e = by.get(p.id) || by.set(p.id, { id: p.id, name: p.name, role: p.role, trade: p.trade || null, onShift: onShift(ont, p, now), score: 0, reasons: [] }).get(p.id);
    if (e.reasons.some((r) => r.kind === kind && r.cite === cite)) return;
    e.reasons.push({ kind, text, cite });
    e.score = Math.max(e.score, SCORE[kind]) + e.reasons.length / 100;
  };
  for (const w of view.list("WorkOrder", (w) => assets.has(w.assetId) && OPEN.has(w.state) && w.assigneeId))
    add(w.assigneeId, "assigned", `${w.id} ${w.state.replace("_", " ")}: ${w.title}`, w.id);
  for (const pr of view.list("Project", (pr) => ont.links(pr.id, { rel: "TARGETS", dir: "out" }).some((l) => assets.has(l.to))))
    for (const l of ont.links(pr.id, { rel: "WORKS_ON", dir: "in" })) add(l.from, "project", `${pr.name || pr.title || pr.id}${l.props?.role ? ` as ${l.props.role}` : ""}`, pr.id);
  for (const x of view.list("Presence", (x) => zones.includes(x.zoneId)))
    add(x.personId, "here", `checked in at ${view.get(x.zoneId)?.name || x.zoneId} since ${String(x.since).slice(0, 16).replace("T", " ")}`, x.id);
  for (const need of NEEDS.filter((n) => n.fits.test(kinds))) {
    for (const c of view.list("Competency", (c) => c.competency === need.comp && validAt(c, now))) {
      const p = view.get(c.personId);
      if (!p || rank(p.clearance) < rank(zoneNeed)) continue;
      add(p.id, "competent", `${need.what}: ${c.competency.split(":").pop()}${c.validTo ? ` (valid to ${c.validTo})` : ""}`, c.id);
    }
  }
  const list = [...by.values()].map((e) => ({ ...e, score: Math.round(e.score * 100) / 100 }))
    .sort((a, b) => b.score - a.score || (b.onShift === true) - (a.onShift === true) || a.name.localeCompare(b.name));
  return { ids: objs.map((o) => o.id), zones, assets: [...assets], people: list };
}

// A tag, KKS, line number or id among what the viewer sees, on the current released plant model.
export function resolvePlant(ont, viewer, s) {
  const view = ont.view(viewer), q = String(s ?? "").trim();
  if (!q) return null;
  if (view.get(q)) return q;
  const mid = currentPlantModel(ont)?.id;
  const hit = view.search(q, 50).find((o) => (!o.modelId || o.modelId === mid) && [o.id, o.tag, o.positionTag, o.kks, o.lineNumber].some((x) => x && String(x).toLowerCase() === q.toLowerCase()));
  return hit?.id ?? null;
}
