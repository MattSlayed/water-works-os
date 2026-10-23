// Eval suites per agent (FR-AGT-008). Each case builds a fresh system, optionally prepares it, runs the agent and
// grades the result. Graders: "rule" (a predicate over run and system) and "exact" (a value equals an expected value).
// shortcut: no LLM-as-judge grader yet; add one in src/llm.mjs when agent outputs become free text from a model.

import { parseMessage } from "./parse.mjs";

const mgr = { id: "P-001", clearance: "manager" };
// An inbound message as the channel stub would store it, for Chat Intake cases.
const inbound = (s, channelId, from, text, ctx = {}) => {
  s.ont.upsert({ id: "MSG-EVAL", type: "Message", channelId, direction: "in", from, at: s.tel.now(), text, media: [], parsed: parseMessage({ text }, { group: !!s.ont.get(channelId).groupName, ...ctx }), audience: s.ont.get(channelId).audience });
  const p = s.ont.get(from);
  return { scope: { messageId: "MSG-EVAL" }, actingUser: p.type === "Person" ? { id: p.id, clearance: p.clearance } : { id: p.id, clearance: "technician" } };
};
const outbound = (s, channelId) => s.ont.list("Message", (m) => m.channelId === channelId && m.direction === "out" && m.inReplyTo === "MSG-EVAL");
const tech = { id: "P-023", clearance: "technician" };
const drafts = (sys, kind) => sys.ont.list("Draft", (d) => d.kind === kind);
const assetByTag = (sys, tag) => sys.ont.list("Asset", (a) => a.positionTag === tag)[0];
// alerts on plant assets (Geo Watch's satellite detections raise alerts on no asset)
const assetAlerts = (s) => s.ont.list("Alert", (a) => a.assetId);
// what an agent under test raised, leaving out what Geo Watch raised about the satellite plume at system start
const plantAlerts = (s) => s.ont.list("Alert", (a) => !String(a.targetId || "").startsWith("GEO-"));
const plantNotes = (s) => s.ont.list("Notification", (n) => !String(n.aboutId || "").startsWith("GEO-"));
const raiseAlertOn = (sys, tag) => sys.actions.invoke({ action: "raise_alert", params: { targetId: assetByTag(sys, tag).id, title: `${tag} test alert`, score: 0.9 }, actor: { kind: "person", id: "P-001", clearance: "manager" } }).decision.objects[0];
const newWo = (sys, tag) => sys.actions.invoke({ action: "create_work_order", params: { assetId: assetByTag(sys, tag).id, title: "eval", kind: "CM", priority: "P2" }, actor: { kind: "person", id: "P-001", clearance: "manager" } }).decision.objects[0];

const roundProposal = (s) => s.ont.list("Proposal", (p) => p.action === "start_sampling_round" && p.state === "open")[0];
const firstOf = (s, role) => s.ont.list("Person", (p) => p.role === role).sort((a, b) => a.id.localeCompare(b.id))[0];

export const EVALS = {
  "Geo Watch": [
    { name: "one suggested plume detection on the day-11 scene", grader: "rule", check: (r, s) => { const d = s.ont.list("GeoDetection"); return d.length === 1 && d[0].sceneId === "S2-20261012" && d[0].kind === "plume" && d[0].status === "suggested"; } },
    { name: "no detection on a cloudy scene", grader: "exact", value: (r, s) => s.ont.list("GeoDetection", (d) => d.sceneId === "S2-20261007").length, expect: 0 },
    { name: "an approved sampling round reaches the analyst", grader: "rule", check: (r, s) => {
      const sup = firstOf(s, "shift_supervisor"), lab = firstOf(s, "lab_analyst");
      s.actions.resolve(roundProposal(s).id, { verdict: "approve", by: { kind: "person", id: sup.id, clearance: sup.clearance } });
      return s.ont.list("Message", (m) => m.channelId === `CHN-${lab.id}` && m.direction === "out" && /NTU/.test(m.text)).length === 1;
    } },
    { name: "refuses to confirm its own detection", grader: "rule", check: (r, s) => s.actions.invoke({ action: "review_detection", params: { detectionId: s.ont.list("GeoDetection")[0].id, verdict: "confirmed" }, actor: { kind: "agent", id: "Geo Watch", clearance: "manager", onBehalfOf: "P-001" } }).status === "refused" }
  ],
  "Shift Handover": [
    { name: "drafts one handover", grader: "exact", value: (r, s) => drafts(s, "handover").length, expect: 1 },
    { name: "names the filter at risk", grader: "rule", check: (r, s) => /F07/.test(drafts(s, "handover")[0].body) },
    { name: "lists chemicals below reorder", grader: "rule", check: (r, s) => /Polymer/.test(drafts(s, "handover")[0].body) },
    { name: "mentions the isolated raw-water pump", grader: "rule", check: (r, s) => /RWP-C is isolated/.test(drafts(s, "handover")[0].body) }
  ],
  "Process Watch": [
    { name: "alerts on F07", grader: "rule", check: (r, s) => s.ont.list("Alert").some((a) => a.title.startsWith("F07")) },
    { name: "does not alert on F03", grader: "rule", check: (r, s) => !s.ont.list("Alert").some((a) => a.title.startsWith("F03")) },
    { name: "backwash is a proposal, not an action", grader: "rule", check: (r, s) => s.ont.list("Proposal", (p) => p.action === "request_setpoint_change").length === 1 && s.ont.list("SetpointRequest").length === 0 },
    { name: "flags DP-2 dose loss", prep: (s) => s.tel.tick(1e9), grader: "rule", check: (r, s) => s.ont.list("Alert").some((a) => a.title.startsWith("DP-2")) }
  ],
  "Asset Watch": [
    { name: "alerts on HLP-B", grader: "rule", check: (r, s) => assetAlerts(s).some((a) => s.ont.get(a.assetId).positionTag === "HLP-B") },
    { name: "no alert on healthy HLP-A", grader: "rule", check: (r, s) => !assetAlerts(s).some((a) => s.ont.get(a.assetId).positionTag === "HLP-A") },
    { name: "skips standby HLP-D", grader: "rule", check: (r, s) => !assetAlerts(s).some((a) => s.ont.get(a.assetId).positionTag === "HLP-D") },
    { name: "no duplicate alert when one is active", prep: (s) => raiseAlertOn(s, "HLP-B"), grader: "exact", value: (r, s) => assetAlerts(s).length, expect: 1 }
  ],
  "Maintenance Triage": [
    { name: "ranks the HLP-B alert", prep: (s) => ({ scope: { alertId: raiseAlertOn(s, "HLP-B") } }), grader: "rule", check: (r, s) => !!assetAlerts(s)[0].priority },
    { name: "counts the standby unit", prep: (s) => ({ scope: { alertId: raiseAlertOn(s, "HLP-B") } }), grader: "exact", value: (r, s) => assetAlerts(s)[0].consequence.redundancy, expect: 1 },
    { name: "missing alert completes without action", prep: () => ({ scope: { alertId: "ALT-NOPE" } }), grader: "rule", check: (r) => r.status === "completed" && r.outputs.length === 0 }
  ],
  "Work Pack": [
    { name: "requests a work order and drafts a pack", prep: (s) => ({ scope: { alertId: raiseAlertOn(s, "HLP-B") } }), grader: "rule", check: (r, s) => drafts(s, "work-pack").length === 1 && s.ont.list("WorkOrder", (w) => w.state === "requested").length === 1 },
    { name: "pack cites the soft-foot finding", prep: (s) => ({ scope: { alertId: raiseAlertOn(s, "HLP-B") } }), grader: "rule", check: (r, s) => /FND-001/.test(drafts(s, "work-pack")[0].body) },
    { name: "pack flags intrusive steps", prep: (s) => ({ scope: { alertId: raiseAlertOn(s, "HLP-B") } }), grader: "rule", check: (r, s) => /needs permit and isolation/.test(drafts(s, "work-pack")[0].body) },
    { name: "reuses an open corrective order (DP-2)", prep: (s) => ({ scope: { alertId: raiseAlertOn(s, "DP-2") } }), grader: "exact", value: (r, s) => s.ont.list("WorkOrder", (w) => w.state === "requested").length, expect: 0 }
  ],
  "Parts Readiness": [
    { name: "reserves bearings for a pump order", prep: (s) => ({ scope: { workOrderId: newWo(s, "HLP-B") } }), grader: "rule", check: (r, s) => s.ont.list("Reservation").length >= 1 },
    { name: "requisitions polymer when unscoped", grader: "rule", check: (r, s) => s.ont.list("Proposal", (p) => p.action === "raise_purchase_requisition" && p.params.itemId === "CHEM-POLY").length === 1 },
    { name: "out-of-stock part becomes a requisition proposal", prep: (s) => { for (const p of s.ont.list("Part", (x) => x.assetId === assetByTag(s, "HLP-C").id)) s.ont.upsert({ id: p.id, type: "Part", stock: 0 }); return { scope: { workOrderId: newWo(s, "HLP-C") } }; }, grader: "rule", check: (r, s) => s.ont.list("Proposal", (p) => p.action === "raise_purchase_requisition").length >= 1 && s.ont.list("Reservation").length === 0 }
  ],
  Scheduler: [
    { name: "proposes a millwright for a pump", prep: (s) => ({ scope: { workOrderId: newWo(s, "HLP-B") } }), grader: "rule", check: (r, s) => s.ont.get(s.ont.list("Proposal", (p) => p.action === "schedule_work")[0].params.assigneeId).trade === "millwright" },
    { name: "never proposes the lapsed millwright", prep: (s) => ({ scope: { workOrderId: newWo(s, "HLP-B") } }), grader: "rule", check: (r, s) => { const lapsed = s.ont.list("Competency", (c) => c.competency === "trade:millwright" && c.validTo < "2026-10-14").map((c) => c.personId); return !lapsed.includes(s.ont.list("Proposal", (p) => p.action === "schedule_work")[0].params.assigneeId); } },
    { name: "proposes a fitter for a dosing pump", prep: (s) => ({ scope: { workOrderId: newWo(s, "DP-1") } }), grader: "rule", check: (r, s) => s.ont.get(s.ont.list("Proposal", (p) => p.action === "schedule_work")[0].params.assigneeId).trade === "fitter" },
    { name: "scheduling is never applied directly", prep: (s) => ({ scope: { workOrderId: newWo(s, "HLP-B") } }), grader: "exact", value: (r, s) => s.ont.list("WorkOrder", (w) => w.state === "scheduled").length, expect: 0 }
  ],
  "Technician Copilot": [
    { name: "insight on HLP-B part", prep: (s) => ({ scope: { assetId: assetByTag(s, "HLP-B").id, partId: "PRT-HLP-B-05" } }), grader: "rule", check: (r) => r.outputs[0] && r.outputs[0].kind === "insight" },
    { name: "includes sibling soft-foot finding", prep: (s) => ({ scope: { assetId: assetByTag(s, "HLP-B").id } }), grader: "rule", check: (r) => r.outputs[0].findings.includes("FND-001") },
    { name: "technician cannot see chlorinator", prep: (s) => ({ scope: { assetId: assetByTag(s, "CHL-A").id }, actingUser: tech }), grader: "rule", check: (r) => r.outputs.length === 0 }
  ],
  Debrief: [
    { name: "drafts questions", prep: (s) => ({ scope: { workOrderId: newWo(s, "HLP-B") } }), grader: "exact", value: (r, s) => drafts(s, "debrief").length, expect: 1 },
    { name: "asks about fault-tree causes", prep: (s) => ({ scope: { workOrderId: newWo(s, "HLP-B") } }), grader: "rule", check: (r, s) => /soft foot/i.test(drafts(s, "debrief")[0].body) },
    { name: "missing work order completes quietly", prep: () => ({ scope: { workOrderId: "WO-NOPE" } }), grader: "rule", check: (r, s) => r.status === "completed" && drafts(s, "debrief").length === 0 }
  ],
  "Shift Cover": [
    { name: "drafts a cover check", grader: "exact", value: (r, s) => drafts(s, "cover").length, expect: 1 },
    { name: "flags a gap when all controllers lapse", prep: (s) => { for (const c of s.ont.list("Competency", (x) => x.competency === "reg3630:process-controller")) s.ont.upsert({ id: c.id, type: "Competency", validTo: "2026-01-01" }); }, grader: "rule", check: (r, s) => drafts(s, "cover")[0].data.gap === true && plantNotes(s).length === 1 },
    { name: "no notification when covered", grader: "rule", check: (r, s) => drafts(s, "cover")[0].data.gap || plantNotes(s).length === 0 }
  ],
  "Permit Guard": [
    { name: "alerts on contractor in Z06", grader: "rule", check: (r, s) => s.ont.list("Alert", (a) => a.zoneId === "Z06").length === 1 },
    { name: "notifies supervisors", grader: "rule", check: (r, s) => plantNotes(s).length === 1 },
    { name: "quiet when the contractor leaves", prep: (s) => { for (const p of s.ont.list("Presence", (x) => x.zoneId === "Z06")) s.ont.upsert({ id: p.id, type: "Presence", zoneId: "Z12" }); }, grader: "exact", value: (r, s) => plantAlerts(s).length, expect: 0 }
  ],
  "Drop Pack": [
    { name: "calibration gap found", grader: "rule", check: (r, s) => drafts(s, "drop-pack")[0].data.items.find((i) => i.requirementId === "REQ-BD-CAL").status === "gap" },
    { name: "response gap found", grader: "rule", check: (r, s) => drafts(s, "drop-pack")[0].data.items.find((i) => i.requirementId === "REQ-BD-INC").status === "gap" },
    { name: "response gap closes when answered", prep: (s) => { for (const x of s.ont.list("Sample", (y) => !y.compliant)) s.ont.upsert({ id: x.id, type: "Sample", response: "Resampled; filter F07 backwashed" }); }, grader: "rule", check: (r, s) => drafts(s, "drop-pack")[0].data.items.find((i) => i.requirementId === "REQ-BD-INC").status === "met" },
    { name: "covers all five requirements", grader: "exact", value: (r, s) => drafts(s, "drop-pack")[0].data.items.length, expect: 5 }
  ],
  Ask: [
    { name: "answers about HLP-B", prep: () => ({ mission: "How is HLP-B doing?" }), grader: "rule", check: (r) => /HLP-B/.test(r.outputs[0].text) },
    { name: "answers about F07", prep: () => ({ mission: "Status of F07?" }), grader: "rule", check: (r) => /F07/.test(r.outputs[0].text) },
    { name: "says so when nothing matches", prep: () => ({ mission: "how are things" }), grader: "rule", check: (r) => /could not find/.test(r.outputs[0].text) },
    { name: "is read-only", prep: () => ({ mission: "HLP-B" }), grader: "exact", value: (r, s) => s.ont.list("Decision", (d) => d.runId === r.id).length, expect: 0 }
  ],
  "Chat Intake": [
    { name: "start begins the assigned job and replies with step 1 and its lock", prep: (s) => inbound(s, "CHN-P-028", "P-028", "start"), grader: "rule", check: (r, s) => s.ont.list("Execution", (e) => e.personId === "P-028" && e.state === "running").length === 1 && outbound(s, "CHN-P-028").length === 1 && /Step 1\/11.*Locked/.test(outbound(s, "CHN-P-028")[0].text) },
    { name: "done without a job asks once and writes nothing else", prep: (s) => inbound(s, "CHN-P-030", "P-030", "done"), grader: "rule", check: (r, s) => outbound(s, "CHN-P-030").length === 1 && r.outputs.filter((o) => o.action && o.action !== "send_message").length === 0 },
    { name: "a contractor's progress is a claim, never a confirmation", prep: (s) => inbound(s, "CHN-GRP-CL3", "PAR-001", "Bearings out and slewing ring replaced"), grader: "rule", check: (r, s) => s.ont.list("ProgressClaim", (c) => c.milestoneId === "M3" && c.by === "PAR-001").length === 1 && !s.ont.get("PRJ-CL3").milestones.find((m) => m.id === "M3").confirmedAt && outbound(s, "CHN-GRP-CL3").length === 0 }
  ],
  "Scribe": [
    { name: "drafts a job card for a finished job", prep: () => ({ scope: { executionId: "EXE-H01" } }), grader: "exact", value: (r, s) => drafts(s, "job-card").length, expect: 1 },
    { name: "never submits for someone who has not consented", prep: (s) => { s.ont.upsert({ id: "EXE-H01", type: "Execution", personId: "P-028" }); return { scope: { executionId: "EXE-H01" } }; }, grader: "exact", value: (r, s) => drafts(s, "job-card")[0].state, expect: "draft" },
    { name: "an issue close-out stays a draft", prep: () => ({ scope: { issueId: "ISS-H06" } }), grader: "exact", value: (r, s) => drafts(s, "issue-closeout")[0].state, expect: "draft" }
  ],
  "Project Watch": [
    { name: "tells the owner about a quiet project", grader: "rule", check: (r, s) => s.ont.list("Notification", (n) => n.aboutId === "PRJ-CL3" && n.to.includes("P-004")).length === 1 },
    { name: "does not post to the group mid-week", grader: "exact", value: (r, s) => s.ont.list("Message", (m) => m.channelId === "CHN-GRP-CL3" && m.direction === "out").length, expect: 0 },
    { name: "posts the weekly status on Friday afternoon", prep: (s) => s.tel.tick(57 * 60), grader: "exact", value: (r, s) => s.ont.list("Message", (m) => m.channelId === "CHN-GRP-CL3" && m.direction === "out").length, expect: 1 }
  ],
  "Procedure Steward": [
    { name: "flags the pump procedure", grader: "rule", check: (r, s) => s.ont.list("Notification", (n) => n.aboutId === "PRC-CENTRIFUGAL_PUMP-v3").length === 1 },
    { name: "names steps, never people", grader: "rule", check: (r, s) => plantNotes(s).every((n) => !/P-0\d\d/.test(n.message)) },
    { name: "is quiet when nothing needs revising", prep: (s) => { for (const t of ["Execution", "Issue", "KnowledgeNote"]) for (const o of s.ont.list(t)) s.ont.remove(o.id); }, grader: "exact", value: (r, s) => plantNotes(s).length, expect: 0 }
  ],
  "Tag Matcher": [
    { name: "no unmatched tags in the synthetic works", grader: "exact", value: (r, s) => drafts(s, "tag-match")[0].data.unmatched.length, expect: 0 },
    { name: "finds a broken tag", prep: (s) => s.ont.upsert({ id: "SEN-HLP-B-vib_de", type: "Sensor", historianTag: "99XXX.VIB" }), grader: "rule", check: (r, s) => drafts(s, "tag-match")[0].data.unmatched.includes("SEN-HLP-B-vib_de") },
    { name: "drafts a report", grader: "exact", value: (r, s) => drafts(s, "tag-match").length, expect: 1 }
  ]
};

export async function runEvals(factory, name) {
  const suite = EVALS[name] || [];
  const cases = [];
  for (const c of suite) {
    const sys = factory();
    let pass = false, error = null;
    try {
      const extra = (c.prep && c.prep(sys)) || {};
      const opts = extra && typeof extra === "object" && !Array.isArray(extra) ? extra : {};
      const run = sys.runtime.run(name, { actingUser: opts.actingUser || mgr, scope: opts.scope, mission: opts.mission, chain: false, trigger: { kind: "eval" } });
      pass = c.grader === "exact" ? c.value(run, sys) === c.expect : !!c.check(run, sys);
    } catch (e) {
      error = e.message;
    }
    cases.push({ name: c.name, grader: c.grader, pass, ...(error ? { error } : {}) });
  }
  return { agent: name, passed: cases.filter((c) => c.pass).length, total: cases.length, cases };
}
