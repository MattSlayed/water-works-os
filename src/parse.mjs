// Rule parser for inbound chat (design §6.3–6.4). Deterministic stand-in for a model: each rule is checked in order and
// the first match wins. Context decides the rest: an awaited reply, a running job, a group chat.
// shortcut: English keyword rules over the synthetic chats; upgrade to a Claude classifier behind the same signature.

const UNIT = String.raw`(mm\/s|mm|°C|kPa|bar|A|h|%)`;
const WORK = /\b(off|out|removed|fitted|installed|welded|painted|tested|complete|completed|done|delivered|started|starting|tomorrow|today)\b/i;
const MILESTONE = /scraper|bearing|weld|gearbox|paint|commission/i;

const COMMAND = /^(start\b|(step\s*\d+\s*)?done\b|issue[:\s])/i;
const NUM = String.raw`\d+(?:[.,]\d+)?`;

const hit = (kind, confidence, fields = {}) => ({ kind, confidence, fields });
const reading = (num, unit) => ({ value: num == null ? null : Number(String(num).replace(",", ".")), unit: unit || null });

export function parseMessage({ text } = {}, { group = false, awaiting = null, execution = null } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return hit("offtopic", 0.3);
  // only a bare yes is consent; a reply to the note question is the note unless it is a command or a plain no
  if (awaiting && /^(yes|y|ok|okay|sure|submit)[.!]?$/i.test(t)) return hit("yes", 0.9);
  if (awaiting && awaiting.kind === "note" && !COMMAND.test(t)) return /^(no|nope|nothing|n\/a)\b[^?]{0,40}$/i.test(t) ? hit("no", 0.9) : hit("note", 0.9, { text: t });
  if (awaiting && /^(no|n|nope)[.!]?$/i.test(t)) return hit("no", 0.9);
  if (/^start\b/i.test(t)) return hit("start", 0.9, { workOrderId: (t.match(/\bWO-[\w-]+/i) || [null])[0] });
  const done = t.match(new RegExp(String.raw`^(?:step\s*(\d+)\s*)?done\b\s*(?:(-?${NUM})\s*${UNIT}?)?`, "i"));
  if (done) return hit("done", 0.9, { step: done[1] ? Number(done[1]) : null, ...reading(done[2], done[3]) });
  const bare = t.match(new RegExp(String.raw`^(${NUM})\s*${UNIT}?$`, "i"));
  if (bare) return execution ? hit("done", 0.9, { step: null, ...reading(bare[1], bare[2]) }) : hit("ask", 0.9, { question: "Which job is that reading for? Reply *start* first." });
  // a field reading quoted in a sentence ("raw 88 NTU at intake jetty") while a job is running
  const ntu = execution && t.match(new RegExp(String.raw`(${NUM})\s*NTU\b`, "i"));
  if (ntu) return hit("done", 0.85, { step: null, ...reading(ntu[1], "NTU") });
  const issue = t.match(/^issue[:\s]+(.+)$/i);
  if (issue) return hit("issue", 0.9, { title: issue[1].trim() });
  if (/\?\s*$/.test(t) || /^(what|how|why|where|which|when|who|can|should)\b/i.test(t)) return hit("question", 0.7, { text: t });
  if (/\b(worn|scored|broken|leak\w*|crack\w*|wrong|missing|seized)\b/i.test(t)) return hit("observation", 0.7, { text: t });
  if (group && WORK.test(t)) return hit("progress", 0.7, { text: t, milestoneHint: ((t.match(MILESTONE) || [null])[0] || "").toLowerCase() || null });
  return hit("offtopic", 0.3);
}
