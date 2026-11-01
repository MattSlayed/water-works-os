// The records an answer rests on, for the Ask page: each citation's status (from the project indicators the viewer can
// see), what it says, and its dates for the timeline. Read through ont.view, so a record the viewer cannot see never shows.
import { projectIndicators } from "./project-indicators.mjs";
import { rank } from "./ontology.mjs";

const RANK = { red: 3, amber: 2, green: 1, none: 0 };
const SEVERITY = { high: "red", medium: "amber", low: "green" };
const worst = (xs) => xs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "none");
const day = (t) => (t ? String(t).slice(0, 10) : null);

function titleOf(o) {
  if (o.type === "Permit") return `${o.kind ? o.kind[0].toUpperCase() + o.kind.slice(1) : "Work"} permit`;
  return o.title || o.name || o.criterion || o.heading || o.type;
}

function datesOf(view, o, now) {
  const today = day(now);
  const out = [];
  const add = (at, label, done, status) => { if (day(at)) out.push({ at: day(at), label, done: !!done, ...(status && { status }) }); };
  // a milestone is rated on its own (confirmed, overdue, to come), not by the project's worst area
  if (o.type === "Project") for (const m of o.milestones || []) add(m.due, `${m.id} ${m.title}`, m.confirmedAt, m.confirmedAt ? "green" : m.due < today ? "amber" : "none");
  if (o.type === "Permit") { add(o.opened, "Opened", true); const gone = o.expires && o.expires < now; add(o.expires, gone ? "Expired" : "Expires", gone); }
  if (o.type === "Requirement") {
    // a met requirement's date is when its evidence lapses; an unmet one's is when it falls due
    const valid = view.links(o.id, { rel: "EVIDENCES", dir: "in" }).map((l) => view.get(l.from)?.validTo).filter((v) => v && v >= today).sort().pop();
    if (valid) add(valid, "Evidence lapses", false); else add(o.dueBy, day(o.dueBy) < today ? "Overdue" : "Due", false);
  }
  if (o.type === "Alert") add(o.at, "Raised", true);
  if (o.type === "Document") { add(o.at, o.kind === "progress-report" ? "Report" : "Dated", true); add(o.validTo, o.validTo < today ? "Lapsed" : "Valid to", o.validTo < today); }
  if (o.type === "Chunk") add(view.get(o.documentId)?.at, "Report", true);
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function answerEvidence(ont, tel, viewer, citations = []) {
  if (!citations.length) return [];
  const view = ont.view(viewer), now = tel.now();
  // cite -> the indicator items resting on it, across every live project the viewer can see
  const byCite = new Map(), projects = new Map();
  for (const p of view.list("Project", (x) => x.state !== "closed")) {
    const ind = projectIndicators(ont, tel, viewer, p.id);
    if (!ind) continue;
    projects.set(p.id, ind);
    for (const [area, a] of Object.entries(ind.areas)) for (const i of a.items) {
      if (i.cite === p.id) continue; // people and capacity items cite the project; it is rated as a whole below
      byCite.set(i.cite, [...(byCite.get(i.cite) || []), { ...i, area }]);
    }
  }
  return citations.map((c, k) => {
    const id = String(c.id).split(/[@#]/)[0], o = view.get(id);
    const base = { n: k + 1, id: c.id, type: o?.type || "Record", title: o ? titleOf(o) : c.label || c.id, status: "none", note: "", area: null, dates: o ? datesOf(view, o, now) : [] };
    if (!o) return base;
    const ind = projects.get(id);
    if (ind) {
      const m = ind.header.milestones;
      return { ...base, status: worst(Object.values(ind.areas).map((a) => a.status)), note: `${m.confirmed} of ${m.total} milestones confirmed${m.overdue.length ? `, ${m.overdue.length} overdue` : ""}` };
    }
    const items = byCite.get(id) || [];
    if (items.length) {
      const top = items.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
      return { ...base, status: top.status, note: top.text, area: top.area };
    }
    if (o.type === "Alert") return { ...base, status: SEVERITY[o.severity] || "none", note: `${o.severity} alert, ${o.state}` };
    return base;
  });
}

// Every answer goes back into the KG, linked to what it cites. It stores a clearance, never the asker or the question
// (a question can name a person): ont.view then hides it from anyone below. Records with an audience (an Issue, a Draft)
// are hidden from peers below manager, so an answer that may quote one (any Claude answer, which reads through the
// asker's tools, or one citing such a record) is kept at manager or above.
export function writeAnswer(ont, viewer, { answer, citations, model }, at) {
  const ids = [...new Set(citations.map((c) => String(c.id).split(/[@#]/)[0]))].filter((id) => ont.get(id));
  const quotesPrivate = !!model || ids.some((id) => ont.get(id).audience);
  const minClearance = quotesPrivate && rank(viewer.clearance) < rank("manager") ? "manager" : viewer.clearance;
  // ids never reuse a number, even after an answer is removed
  const n = Math.max(0, ...ont.list("Answer").map((x) => Number(x.id.slice(4)) || 0)) + 1;
  const a = ont.upsert({ id: `ANS-${n}`, type: "Answer", at, minClearance, by: "Site Agent", model, answer, citations });
  for (const id of ids) ont.link(a.id, "CITES", id);
  return a;
}
