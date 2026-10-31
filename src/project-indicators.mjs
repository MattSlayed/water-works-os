// The four project dashboard indicators, rated at the plant clock for one viewer. The one place the rules live; the UI only renders.
// Items carry roles, counts and object ids, never a person's id or name (POPIA).
import { projectStatus } from "./functions.mjs";
import { spendAt } from "./regionview.mjs";

const DAY = 86400000, RANK = { none: 0, green: 1, amber: 2, red: 3 };
export const worst = (statuses) => statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "none");

const area = (items, ok) => {
  const bad = items.filter((i) => i.status !== "green").length;
  return { status: worst(items.map((i) => i.status)), summary: !items.length ? "No data" : bad ? `${bad} of ${items.length} checks need attention` : ok, items };
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function projectIndicators(ont, tel, viewer, projectId) {
  const view = ont.view(viewer), project = view.get(projectId);
  if (!project || project.type !== "Project") return null;
  const now = tel.now(), today = now.slice(0, 10), soon = new Date(Date.parse(now) + 14 * DAY).toISOString().slice(0, 10);
  const zones = project.zoneIds || [], targets = view.links(projectId, { rel: "TARGETS", dir: "out" }).map((l) => l.to);
  const permits = view.list("Permit", (p) => p.projectId === projectId);
  const isExpired = (p) => p.expires && p.expires < now;
  const verified = (p) => p.isolations.length > 0 && p.isolations.every((i) => i.verifiedBy);
  const openPermits = permits.filter((p) => p.state === "open" && !isExpired(p));

  // Project Executions are people data, hidden by audience from supervisors and technicians, yet only their step counts are used here.
  // They count when the viewer can see the execution's zone (else the project's).
  const zoneSeen = (z) => !z || !!view.get(z);
  const execs = ont.list("Execution", (e) => e.projectId === projectId);
  const seenExecs = execs.filter((e) => zoneSeen(e.zoneId ?? zones[0]));
  const workActive = seenExecs.some((e) => e.steps.some((s) => s.state !== "todo" && s.at && Date.parse(s.at) > Date.parse(now) - DAY));

  // People: the crew by role, against the competence the project requires. The crew links and Competency are read
  // through `ont`, not the view: they are people data hidden from lower clearances, yet only roles and counts leave here (as with Executions).
  const people = [];
  const crew = ont.links(projectId, { rel: "WORKS_ON", dir: "in" }).filter((l) => l.props?.planned);
  if (crew.length) {
    const present = zones.every((z) => view.get(z)) ? view.list("Presence", (p) => zones.includes(p.zoneId)).map((p) => p.personId) : null; // null: a zone the viewer cannot see
    people.push({ status: "green", text: `${crew.length} planned on the crew${present ? `, ${crew.filter((l) => present.includes(l.from)).length} on site` : ""}`, cite: projectId });
    for (const l of crew) {
      const held = ont.links(l.from, { rel: "HOLDS", dir: "out" }).map((h) => ont.get(h.to));
      for (const key of project.requiredCompetence || []) {
        const c = held.filter((x) => x.competency === key).sort((a, b) => (a.validTo < b.validTo ? 1 : -1))[0];
        const role = cap(l.props.role);
        if (!c) people.push({ status: present?.includes(l.from) ? "red" : "amber", text: `${role}: ${key} not held`, cite: projectId });
        else if (c.validTo < today) people.push({ status: present?.includes(l.from) ? "red" : "amber", text: `${role}: ${key} expired ${c.validTo}`, cite: projectId });
        else if (c.validTo <= soon) people.push({ status: "amber", text: `${role}: ${key} expires ${c.validTo}`, cite: projectId });
      }
    }
  }

  // Plant & Process: what is out of service, what alarms on the targeted assets, and whether their sensors are in band.
  const plant = [];
  if ((project.takesOutOfService || []).some((t) => t.from <= today && today <= t.to)) {
    plant.push({ status: project.capacityImpact?.stage ? "amber" : "green", text: project.capacityImpact?.text || "Plant out of service", cite: projectId });
  }
  for (const a of view.list("Alert", (x) => x.state === "active" && (targets.includes(x.assetId) || zones.includes(x.zoneId)))) {
    plant.push({ status: a.severity === "high" ? "red" : a.severity === "medium" ? "amber" : "green", text: `Active ${a.severity} alert: ${a.title}`, cite: a.id });
  }
  const banded = view.list("Sensor", (s) => targets.includes(s.assetId) && (s.alarmLo != null || s.alarmHi != null));
  let inBand = 0;
  for (const s of banded) {
    const v = tel.latest(s.id)?.value;
    if (v == null) continue;
    if ((s.alarmLo != null && v < s.alarmLo) || (s.alarmHi != null && v > s.alarmHi)) plant.push({ status: "red", text: `${s.name} at ${v} ${s.unit || ""} is outside its alarm band`.replace("  ", " "), cite: s.id });
    else inBand++;
  }
  if (inBand) plant.push({ status: "green", text: `${inBand} sensors on the targeted assets within their alarm bands`, cite: projectId });

  // Procedures: steps done, and whether each step that needs a permit or isolation had one open and verified.
  const procedures = [], next = (project.milestones || []).find((m) => !m.confirmedAt), late = next && next.due < today;
  for (const l of view.links(projectId, { rel: "USES", dir: "out" })) {
    const proc = view.get(l.to), mine = seenExecs.filter((e) => e.procedureId === l.to);
    if (!proc || (execs.some((e) => e.procedureId === l.to) && !mine.length)) continue;
    const doneN = new Set(mine.flatMap((e) => e.steps.filter((s) => s.state === "done").map((s) => s.step)));
    // a done step is judged at its own time (a permit that has since expired still covered it); one in progress against now
    const covered = (x, iso) => (x.state === "done" && x.at
      ? permits.filter((p) => p.opened <= x.at && (!p.expires || p.expires >= x.at) && (p.state === "open" || p.closed >= x.at))
      : openPermits).some((p) => !iso || verified(p));
    const gaps = proc.steps.filter((s) => {
      const iso = s.requiresIsolation || s.requires?.isolation;
      return (iso || s.requiresPermit || s.requires?.permit) && mine.some((e) => e.steps.some((x) => x.step === s.step && x.state !== "todo" && !covered(x, iso)));
    });
    const left = proc.steps.length - doneN.size;
    const status = gaps.length ? "red" : left && late ? "amber" : "green";
    const why = gaps.length ? `; step ${gaps[0].step} ("${gaps[0].text}") started without ${(gaps[0].requiresIsolation || gaps[0].requires?.isolation) ? "a verified isolation" : "an open permit"}` : left && late ? `; ${left} outstanding past milestone ${next.id}` : "";
    procedures.push({ status, text: `${proc.title}: ${doneN.size} of ${proc.steps.length} steps done${why}`, cite: proc.id });
  }

  // Compliance: each requirement against its evidence, then the project's permits.
  const compliance = [];
  for (const l of view.links(projectId, { rel: "REQUIRES", dir: "out" })) {
    const r = view.get(l.to);
    if (!r) continue;
    const valid = view.links(r.id, { rel: "EVIDENCES", dir: "in" }).map((e) => view.get(e.from)).filter((d) => d && d.validTo >= today).map((d) => d.validTo).sort().pop();
    if (valid) compliance.push({ status: valid <= soon ? "amber" : "green", text: `${r.criterion}: evidence ${valid <= soon ? "expires" : "valid to"} ${valid}`, cite: r.id });
    else compliance.push({ status: r.dueBy && r.dueBy < today ? "red" : "amber", text: `${r.criterion}: no valid evidence${r.dueBy ? `, due ${r.dueBy}` : ""}`, cite: r.id });
  }
  for (const p of permits.filter((x) => x.state === "open")) {
    const unverified = p.isolations.some((i) => !i.verifiedBy);
    if (isExpired(p)) compliance.push({ status: workActive ? "red" : "amber", text: `The ${p.kind} permit expired ${p.expires.slice(0, 10)} and is still open${workActive ? " while work continues" : ""}`, cite: p.id });
    else compliance.push({ status: unverified ? "amber" : "green", text: unverified ? `The ${p.kind} permit has an isolation applied but not verified` : `The ${p.kind} permit is open to ${(p.expires || "").slice(0, 10) || "further notice"} with its isolations verified`, cite: p.id });
  }

  const reports = view.links(projectId, { rel: "ABOUT", dir: "in" }).map((l) => view.get(l.from)).filter((d) => d?.kind === "progress-report");
  const lastReportAt = reports.map((d) => d.at).sort().pop() || null;
  const st = projectStatus(project, ont.list("ProgressClaim"), view.list("Issue"), now);
  return {
    id: projectId, title: project.title, at: now,
    header: {
      milestones: { ...st.milestones, overdue: st.overdue }, spendZar: spendAt(project, now), budgetZar: project.budgetZar,
      lastReportAt, daysSinceReport: lastReportAt ? Math.floor((Date.parse(now) - Date.parse(lastReportAt)) / DAY) : null
    },
    areas: {
      people: area(people, "Crew competence is current"), plant: area(plant, "Nothing alarming on the targeted plant"),
      procedures: area(procedures, "Procedure steps are on track"), compliance: area(compliance, "Evidence and permits are in order")
    }
  };
}
