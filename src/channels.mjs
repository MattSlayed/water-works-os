// The works number (design §5, §8): inbound chat becomes a stored Message and a Chat Intake run as the sender; the
// Copilot answers questions; replies go out through the send_message action like any other write.
// shortcut: a stub transport (POST /api/channels/:id/inbound); a WhatsApp Business adapter calls inbound() the same way.
import { parseMessage } from "./parse.mjs";

let seq = 0;

export function createChannels({ ont, tel, actions, runtime, copilot, audit }) {
  const listeners = [];
  const emit = (e) => listeners.forEach((fn) => fn(e));
  const sessions = new Map(); // sender|asset|part -> Copilot session id

  async function inbound(channelId, senderId, { text, media } = {}) {
    const ch = ont.get(channelId);
    if (!ch || ch.type !== "Channel") throw new Error("channel not found");
    if (!(ch.members || []).includes(senderId)) throw new Error("not a member of this channel");
    const sender = ont.get(senderId);
    // a contractor's number acts at the lowest clearance, and only as itself
    const user = sender.type === "Person" ? { id: sender.id, kind: "person", clearance: sender.clearance } : { id: sender.id, kind: "person", clearance: "technician", participant: true };
    const thread = ont.list("Message", (m) => m.channelId === ch.id);
    const last = thread[thread.length - 1];
    const awaiting = last && last.direction === "out" && last.awaiting ? last.awaiting : null;
    const execution = sender.type === "Person" ? ont.list("Execution", (e) => e.personId === sender.id && e.state === "running")[0] || null : null;
    const parsed = parseMessage({ text }, { group: !!ch.groupName, awaiting, execution });
    const id = `MSG-I${String(++seq).padStart(5, "0")}`;
    if (parsed.kind === "offtopic" || (ch.groupName && !["progress", "issue"].includes(parsed.kind))) {
      audit.append({ actor: senderId, actorKind: "channel", action: "message", outcome: "dropped", ref: id });
      return { message: null, outcome: "dropped", replies: [], runId: null };
    }
    const at = tel.now();
    ont.upsert({
      id, type: "Message", channelId: ch.id, direction: "in", from: senderId, at, text: String(text), media: Array.isArray(media) ? media.slice(0, 10).map(String) : [],
      parsed, replyTo: awaiting ? last.id : null, outcome: null, audience: ch.audience || null,
      prov: { source: "CHANNEL-STUB", source_uri: `stub://${ch.id}/${id}`, source_version: "v1", extracted_at: at, confidence: parsed.confidence }
    });
    ont.link(id, "IN", ch.id);
    const before = new Set(ont.list("Message", (m) => m.channelId === ch.id && m.direction === "out").map((m) => m.id));
    const run = runtime.run("Chat Intake", { actingUser: user, scope: { messageId: id }, audience: ch.audience || null, trigger: { kind: "message", messageId: id } });
    const reply = (by, params) => actions.invoke({ action: "send_message", params: { channelId: ch.id, inReplyTo: id, ...params }, actor: { kind: "agent", id: by, clearance: user.clearance, onBehalfOf: user.id }, autonomy: "act" });

    for (const q of run.outputs.filter((o) => o.kind === "question")) {
      const key = `${user.id}|${q.assetId}|${q.partId || ""}`;
      let s = sessions.has(key) ? copilot.get(sessions.get(key)) : null;
      try {
        if (!s) { s = copilot.get(copilot.open({ assetId: q.assetId, partId: q.partId || undefined, workOrderId: q.workOrderId || undefined, step: q.step, user }).id); sessions.set(key, s.id); }
        s.step = q.step || null;
        const res = await copilot.ask(s.id, q.text);
        const cites = [...new Set((res.citations || []).map((c) => c.id).filter(Boolean))];
        reply("Technician Copilot", {
          text: `${res.answer}${cites.length ? `\nSources: ${cites.join(", ")}` : ""}${q.offerIssue ? "\n\nRaise an issue? (yes/no)" : ""}`,
          ...(q.offerIssue ? { awaiting: { kind: "issue", ...q.offerIssue } } : {})
        });
      } catch (e) {
        reply("Technician Copilot", { text: `I could not open that asset for you: ${e.message}.` });
      }
    }
    for (const s of run.outputs.filter((o) => o.kind === "submit")) {
      const r = actions.invoke({ action: "submit_document", params: { documentId: s.draftId, onBehalfOf: user.id }, actor: user });
      reply("Chat Intake", { text: r.status === "done" ? `Submitted ${s.draftId} under your name.` : `Could not submit ${s.draftId}: ${r.reason}` });
    }

    const outcome = (run.outputs.find((o) => o.kind === "outcome") || {}).outcome || (run.status === "failed" ? "failed" : "recorded");
    ont.upsert({ id, type: "Message", outcome, runId: run.id });
    const fresh = ont.list("Message", (m) => m.channelId === ch.id && m.direction === "out" && !before.has(m.id));
    const replies = fresh.filter((m) => m.inReplyTo === id), followUps = fresh.filter((m) => m.inReplyTo !== id);
    emit({ kind: "message", channelId: ch.id, id });
    for (const r of fresh) emit({ kind: "message", channelId: ch.id, id: r.id });
    return { message: ont.get(id), outcome, replies, followUps, runId: run.id };
  }

  return { inbound, on: (fn) => listeners.push(fn) };
}
