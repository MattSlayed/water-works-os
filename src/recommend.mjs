// The Recommender's signals (agents design §9): patterns in one person's own work that an agent could take on.
// It reads only what that person can see, and the connectors their role may read. It never reads what anyone
// viewed, opened or searched for; none of that is recorded. People are never ranked or compared.
import { catalogueAllows } from "./actions.mjs";
import { draftSpec } from "./studio.mjs";

const DAY = 86400000;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const words = (action) => action.replace(/_/g, " ");
const group = (items, keyOf) => { const m = new Map(); for (const x of items) { const k = keyOf(x); if (k != null) m.set(k, [...(m.get(k) || []), x]); } return m; };
const SENSOR_WORDS = [[/temp/i, /temp/i], [/vib/i, /vib/i], [/current/i, /current/i], [/flow/i, /flow/i], [/press/i, /press/i], [/level/i, /level/i]];
// minutes a week, at about 3 minutes of handling per item, with the basis said in words
const weekly = (n) => n / 30 * 7;
const saved = (n) => Math.max(1, Math.round(weekly(n) * 3));

export function signalsFor(ont, connectors, personId, nowIso) {
  const me = ont.get(personId);
  if (!me || me.type !== "Person") return [];
  const view = ont.view(me), now = Date.parse(nowIso), since = now - 30 * DAY;
  const recent = (t) => { const x = Date.parse(t); return x >= since && x <= now; };
  const may = (kind) => !!connectors && catalogueAllows(ont, { kind, op: "read", role: me.role }).ok;
  const draft = (template, params) => draftSpec(template, { params, trigger: null, builder: me, ont });
  const out = [];

  // repeated-action: documents filed by hand into folders
  if (may("m365.files")) {
    const moves = connectors.m365.files.moves().filter((m) => m.by === personId && recent(m.at));
    if (moves.length >= 10) {
      const arrived = may("m365.mail") ? new Map(connectors.m365.mail.list("accounts@riverbend.example").flatMap((m) => m.attachments.map((a) => [a.id, m.receivedDateTime]))) : new Map();
      const waits = moves.filter((m) => arrived.has(m.sourceId)).map((m) => (Date.parse(m.at) - Date.parse(arrived.get(m.sourceId))) / 60000);
      out.push({ signal: "repeated-action", key: "repeated-action:file-invoices", title: `You filed ${moves.length} invoices into supplier folders by hand in the last 30 days: a document digester could draft these.`,
        evidence: moves.map((m) => m.itemId), statement: draft("digester", { source: { kind: "m365.mail", mailbox: "accounts@riverbend.example" }, tolerancePct: 2 }), savedMinPerWeek: saved(moves.length),
        basis: `${weekly(moves.length).toFixed(1)} filings a week at about 3 minutes each${waits.length ? `; each waited a median ${Math.round(median(waits))} min between arriving and being filed` : ""}.` });
    }
  }

  // repeated-check: the same reading taken by hand on many days
  for (const [k, rs] of group(view.list("Reading", (r) => r.by === personId && recent(r.at)), (r) => `${r.targetId}|${r.measure}`)) {
    const days = new Set(rs.map((r) => r.at.slice(0, 10))).size;
    if (days < 5) continue;
    const asset = view.get(rs[0].targetId), kind = SENSOR_WORDS.find(([say]) => say.test(rs[0].measure));
    const sensor = asset && kind && view.list("Sensor", (s) => s.assetId === (asset.assetId || asset.id) && kind[1].test(`${s.key} ${s.name}`))[0];
    if (!sensor) continue;
    const above = sensor.alarmHi ?? Math.round(Math.max(...rs.map((r) => Number(r.value) || 0)) * 1.1);
    const tag = asset.positionTag || asset.name;
    out.push({ signal: "repeated-check", key: `repeated-check:${k}`, title: `You check ${tag} ${rs[0].measure} by hand most mornings (${days} days in the last 30): a watch agent could tell you when it goes above ${above}.`,
      evidence: rs.map((r) => r.id), statement: draft("watch", { sensorId: sensor.id, label: `${tag} ${sensor.name.toLowerCase()}`, above }), savedMinPerWeek: saved(rs.length),
      basis: `${weekly(rs.length).toFixed(1)} readings a week at about 3 minutes each, on ${days} different days.` });
  }

  // slow-decision: proposals this person approves wait long for them
  for (const [action, ps] of group(view.list("Proposal", (p) => p.resolvedBy === personId && ["approved", "edited"].includes(p.state) && p.created && p.resolvedAt && recent(p.resolvedAt)), (p) => p.action)) {
    const wait = median(ps.map((p) => (Date.parse(p.resolvedAt) - Date.parse(p.created)) / 60000));
    if (ps.length < 3 || wait <= 120) continue;
    const night = ps.filter((p) => { const h = new Date(p.created).getUTCHours(); return h >= 18 || h < 6; }).length > ps.length / 2;
    out.push({ signal: "slow-decision", key: `slow-decision:${action}`, title: `${words(action).replace(/^./, (c) => c.toUpperCase())} proposals wait a median ${(wait / 60).toFixed(1)} h for your approval${night ? " on night shift" : ""}: add a backup approver so they do not wait.`,
      evidence: ps.map((p) => p.id), statement: null, savedMinPerWeek: saved(ps.length), basis: `${ps.length} in the last 30 days, a median ${Math.round(wait)} min from proposal to approval.`,
      audience: [personId, me.supervisorId].filter(Boolean) });
  }

  // repeated-override: the same reason given again and again when rejecting an agent
  const fb = view.list("Feedback", (f) => f.authorId === personId && ["reject", "edit"].includes(f.verdict) && f.comment && recent(f.at));
  for (const [k, fs] of group(fb, (f) => { const p = view.get(f.targetId); return p ? `${p.actorId}|${f.comment.trim().toLowerCase()}` : null; })) {
    if (fs.length < 3) continue;
    const agent = k.split("|")[0], reason = fs[0].comment.trim();
    out.push({ signal: "repeated-override", key: `repeated-override:${k}`, title: `You rejected ${agent}'s proposal ${fs.length} times for "${reason}": add that to ${agent}'s evidence so it stops proposing it.`,
      evidence: [...fs.map((f) => f.id), ...fs.map((f) => f.targetId)], statement: null, savedMinPerWeek: saved(fs.length), basis: `${fs.length} rejections with the same reason in the last 30 days.` });
  }

  // long-step: Procedure Steward pointed this person at steps that run long
  for (const d of view.list("Decision", (x) => x.actorId === "Procedure Steward" && x.action === "notify" && [].concat(x.params.to || []).includes(personId) && recent(x.at))) {
    const proc = d.params.aboutId && view.get(d.params.aboutId);
    if (!proc) continue;
    out.push({ signal: "long-step", key: `long-step:${proc.id}`, title: `Procedure Steward flagged steps in ${proc.title || proc.id} that run long: a pre-job check could catch them before the job starts.`,
      evidence: [...d.objects, proc.id], statement: null, savedMinPerWeek: saved(1), basis: "From Procedure Steward's note on step times against the procedure." });
  }

  // exceptions-to-one: several open issues of one kind wait on this person
  for (const [kind, is] of group(view.list("Issue", (i) => i.assigneeId === personId && ["open", "triaged"].includes(i.state)), (i) => (i.title.includes(":") ? i.title.split(":")[0].trim() : null))) {
    if (is.length < 3) continue;
    out.push({ signal: "exceptions-to-one", key: `exceptions-to-one:${kind.toLowerCase()}`, title: `${is.length} open "${kind}" issues are waiting on you: a chaser could remind people about them.`,
      evidence: is.map((i) => i.id), statement: draft("chaser", { olderThanDays: 5, match: kind.toLowerCase() }), savedMinPerWeek: saved(is.length),
      basis: `${is.length} open now; a reminder takes about 3 minutes each.` });
  }
  return out;
}
