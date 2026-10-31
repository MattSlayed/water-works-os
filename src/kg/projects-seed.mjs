// Seeds what the project dashboard reads: where each active project works, its crew, progress reports, procedures in use,
// permits and compliance evidence. The content is data/riverbend/projects.json; ids, links and zone stamps are made here.
// Safe to run twice: every id is derived from the order in the file.
import { readFileSync } from "node:fs";
import { chunkByHeading } from "./chunks.mjs";

const data = JSON.parse(readFileSync(new URL("../../data/riverbend/projects.json", import.meta.url), "utf8"));
const prov = { source: "SYNTH-PROJ", source_uri: "data/riverbend/projects.json", source_version: "v1", extracted_at: "2026-10-15T00:00:00Z", confidence: 1 };

const linkOnce = (ont, from, rel, to, props) => { if (!ont.links(from, { rel, dir: "out" }).some((l) => l.to === to)) ont.link(from, rel, to, props, prov); };
const counter = (prefix) => { let n = 0; return () => `${prefix}-${++n}`; };

// A role in the file means whoever on the crew holds it, else the first person with that role (a supervisor who verifies an isolation).
const who = (ont, role, crew) => {
  const id = crew.find((c) => ont.get(c.personId).role === role)?.personId ?? ont.list("Person", (p) => p.role === role)[0]?.id;
  if (!id) throw new Error(`projects.json: nobody has the role ${role}`);
  return id;
};

// A document, its chunks (stamped with the document's zone) and what each is about.
function addDocument(ont, doc, projectId) {
  ont.upsert({ ...doc, type: "Document", aboutId: projectId, prov });
  linkOnce(ont, doc.id, "ABOUT", projectId);
  for (const c of chunkByHeading(doc.id, doc.body)) {
    ont.upsert({ ...c, zoneId: doc.zoneId, prov });
    linkOnce(ont, doc.id, "HAS_CHUNK", c.id);
    linkOnce(ont, c.id, "ABOUT", projectId);
  }
}

// The new steps keep `requires` too, which the job brief and the step lock already read.
function seedProcedures(ont) {
  for (const p of data.procedures) {
    const steps = p.steps.map((s, i) => ({
      id: `${p.id}-S${String(i + 1).padStart(2, "0")}`, step: i + 1, text: s.text, intrusive: s.intrusive, partNames: [], hazard: s.hazard, documentId: null,
      requires: { permit: s.requiresPermit, isolation: s.requiresIsolation, reading: null }, requiresPermit: s.requiresPermit, requiresIsolation: s.requiresIsolation, expectedMinutes: s.expectedMinutes
    }));
    ont.upsert({ id: p.id, type: "Procedure", template: p.template, documentId: null, title: p.title, version: 1, state: "released", releasedBy: "P-001", releasedAt: "2026-10-01T00:00:00Z", reason: "Project work (dashboard design)", steps, prov });
  }
}

export function seedProjects(ont) {
  seedProcedures(ont);
  const cmpId = counter("CMP-PRJ"), prsId = counter("PRS-PRJ"), exeId = counter("EXE-PRJ"), ptwId = counter("PTW-PRJ"), reqId = counter("REQ-PRJ"), evId = counter("DOC-EV");
  for (const [pid, d] of Object.entries(data.projects)) {
    const project = ont.get(pid), zone = d.zoneIds[0]; // the first zone is where the work happens; everything zone-bound below is stamped with it
    ont.upsert({ id: pid, type: "Project", requiredCompetence: d.requiredCompetence, zoneIds: d.zoneIds });
    for (const z of d.zoneIds) linkOnce(ont, pid, "LOCATED_IN", z);
    for (const a of [...(project.assetIds || []), ...project.takesOutOfService.map((t) => t.id)]) if (ont.get(a)?.type === "Asset") linkOnce(ont, pid, "TARGETS", a);
    for (const u of d.uses) linkOnce(ont, pid, "USES", u);

    for (const c of d.crew) {
      linkOnce(ont, c.personId, "WORKS_ON", pid, { role: c.role, planned: true });
      for (const h of c.holds || []) {
        const id = cmpId();
        ont.upsert({ id, type: "Competency", personId: c.personId, competency: h.competency, level: 1, validFrom: "2025-01-01", validTo: h.validTo, prov });
        linkOnce(ont, c.personId, "HOLDS", id);
      }
      if (c.onSite) ont.upsert({ id: prsId(), type: "Presence", personId: c.personId, zoneId: zone, since: "2026-10-14T05:30:00Z", source: "badge", prov });
    }

    for (const r of d.reports) {
      const body = [["Summary", r.summary], ["Progress", r.progress], ["Safety", r.safety], ["Next week", r.next]].map(([h, t]) => `## ${h}\n${t}`).join("\n\n");
      addDocument(ont, { id: `DOC-PR-${pid}-${r.date.replaceAll("-", "")}`, kind: "progress-report", at: `${r.date}T15:00:00Z`, title: r.title, zoneId: zone, body }, pid);
    }

    // zone-bound, with no assetId: an asset permit would cap agent writes on that asset (permit-holder) and lock its job steps
    for (const p of d.permits) {
      ont.upsert({ id: ptwId(), type: "Permit", projectId: pid, kind: p.kind, state: p.state, zoneId: zone, holderId: who(ont, p.holder, d.crew), opened: p.opened, expires: p.expires,
        isolations: p.isolations.map((i) => ({ point: i.point, state: "applied", appliedBy: who(ont, i.appliedBy, d.crew), verifiedBy: i.verifiedBy && who(ont, i.verifiedBy, d.crew) })), prov });
    }

    // an execution lists every step of its procedure: the first `done` are done, the rest are todo, 40 minutes apart ending at `at`.
    // It is people data, so only the person and the project owner see it, as with past jobs.
    for (const e of d.executions) {
      const n = ont.get(e.procedureId).steps.length;
      const steps = Array.from({ length: n }, (_, i) => i < e.done ? { step: i + 1, state: "done", at: new Date(Date.parse(e.at) - (e.done - 1 - i) * 40 * 60000).toISOString() } : { step: i + 1, state: "todo", at: null });
      const personId = who(ont, e.by, d.crew);
      ont.upsert({ id: exeId(), type: "Execution", projectId: pid, procedureId: e.procedureId, personId, state: e.state, steps, audience: [personId, project.ownerId], prov });
    }

    for (const q of d.requirements) {
      const id = reqId();
      ont.upsert({ id, type: "Requirement", framework: q.framework, criterion: q.criterion, projectId: pid, zoneId: zone, dueBy: q.dueBy, prov });
      linkOnce(ont, pid, "REQUIRES", id);
      if (!q.evidence) continue;
      const ev = q.evidence, docId = evId();
      addDocument(ont, { id: docId, kind: ev.kind, title: ev.title, zoneId: zone, validTo: ev.validTo, body: `## Evidence\n${ev.text}` }, pid);
      linkOnce(ont, docId, "EVIDENCES", id);
    }
  }
}
