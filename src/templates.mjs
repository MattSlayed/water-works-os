// The run logic behind each studio template (agents design §6.3). A studio agent is a decision statement plus one
// of these; the logic only uses its context (reads through its builder's view and the connectors its contract
// lists, and typed actions), so the harness governs it exactly like a default agent.
import { digestDoc, isInvoiceDoc } from "./digest.mjs";

// The documents a digester's source holds since a time: mail attachments, chat photos, or files dropped in a folder.
function sourceDocs(ctx, source, since) {
  if (source.kind === "m365.mail") return ctx.connector("m365.mail").list(source.mailbox, { since }).flatMap((m) => m.attachments.map((att) => ({ att, messageId: m.id, at: m.receivedDateTime })));
  if (source.kind === "chat") return ctx.list("Message", (m) => m.channelId === source.channelId && m.at >= since && (m.media || []).length)
    .flatMap((m) => m.media.map((id) => ({ att: ctx.attachment(id), messageId: m.id, at: m.at }))).filter((d) => d.att);
  if (source.kind === "m365.files") return ctx.connector("m365.files").moves().filter((x) => (x.path === source.path || x.path.startsWith(`${source.path}/`)) && x.at >= since)
    .map((x) => ({ att: ctx.attachment(x.sourceId), messageId: null, at: x.at })).filter((d) => d.att);
  throw new Error(`unknown source ${source.kind}`);
}

export const TEMPLATES = {
  // Read each new document, match it, and file only what is clean; posting is always a proposal; a bank change goes to a person.
  digester: {
    label: "Invoice digester", purpose: "Read supplier invoices, check them against the PO and goods receipt, and file them in the supplier's folder",
    trigger: { kind: "schedule", every: "weekdays at 07:00" }, reads: ["connector:m365.mail", "connector:m365.files", "connector:erp"],
    tools: { digest_document: "act", file_document: "act", post_invoice_match: "propose", raise_issue: "act" },
    run(ctx) {
      const p = ctx.params, st = ctx.statement, tol = Number(p.tolerancePct) || 2;
      const erp = ctx.connector("erp"), moves = ctx.connector("m365.files").moves();
      const since = ctx.scope.since || st.createdAt || ctx.now;
      const only = ctx.scope.messageIds ? new Set(ctx.scope.messageIds) : null;
      // what it has already digested, or (in shadow) already said it would
      const done = new Set([...ctx.list("DocumentIntake", (d) => d.builderId === st.builderId && d.state !== "withdrawn").map((d) => d.attachmentId),
        ...ctx.list("ShadowAction", (x) => x.agent === st.name && x.action === "digest_document").map((x) => x.params.attachmentId)]);
      const seen = [];
      for (const doc of sourceDocs(ctx, p.source, since)) {
        if ((only && !only.has(doc.messageId)) || done.has(doc.att.id) || !isInvoiceDoc(doc.att)) continue;
        const r = digestDoc(doc.att, { erp, moves, seen, at: doc.at, tolerancePct: tol });
        seen.push({ supplierId: r.fields.supplierId, number: r.fields.invoiceNo, total: r.fields.total, sourceId: doc.att.id, receivedAt: doc.at });
        ctx.think(`${doc.att.name}: ${r.verdict}${r.match.issues.length ? ` (${r.match.issues.map((i) => i.detail).join("; ")})` : ""}`);
        const dg = ctx.act("digest_document", { attachmentId: doc.att.id, source: p.source, fromMessage: doc.messageId, receivedAt: doc.at, tolerancePct: tol });
        const intakeId = dg.status === "done" ? dg.objects[0] : undefined, evidence = intakeId ? { evidence: [intakeId] } : {};
        if (r.verdict === "file") {
          ctx.act("file_document", { attachmentId: doc.att.id, path: r.destination.path, intakeId }, evidence);
          if (r.match.po) ctx.act("post_invoice_match", { attachmentId: doc.att.id, poId: r.match.po, intakeId }, evidence);
        }
        if (r.verdict === "person") ctx.act("raise_issue", { title: "Supplier query: bank details changed", attachmentId: doc.att.id, evidence: [intakeId || doc.att.id, ...r.match.issues.map((i) => i.detail)],
          assigneeId: typeof st.approver === "string" ? st.approver : undefined, audience: [st.builderId, st.approver].filter((x) => typeof x === "string") });
      }
    }
  },
  // A reading past a threshold tells the builder (once an hour at most).
  watch: {
    label: "Watch", purpose: "Tell the builder when a reading crosses a threshold",
    trigger: { kind: "schedule", every: "every 15 min" }, reads: ["telemetry"], tools: { notify: "act" },
    run(ctx) {
      const p = ctx.params, v = ctx.latest(p.sensorId), st = ctx.statement;
      if (!v) return ctx.think(`${p.sensorId} has no reading in view.`);
      const crossed = (p.above != null && v.value > p.above) || (p.below != null && v.value < p.below);
      if (!crossed) return ctx.think(`${p.sensorId} reads ${v.value}: inside the threshold.`);
      const hour = Date.parse(ctx.now) - 3600000;
      if (ctx.list("Notification", (n) => n.aboutId === p.sensorId && n.to.includes(st.builderId) && Date.parse(n.at) > hour).length) return ctx.think("Already told within the hour.");
      ctx.act("notify", { to: [st.builderId], message: `${p.label || p.sensorId} reads ${Number(v.value).toFixed(1)}, ${p.above != null ? `above ${p.above}` : `below ${p.below}`}.`, aboutId: p.sensorId }, { evidence: [p.sensorId] });
    }
  },
  // Counts from the builder's view for the week, drafted, then sent to the builder's own chat.
  "weekly-report": {
    label: "Weekly report", purpose: "Count what happened this week and send the builder a short report",
    trigger: { kind: "schedule", every: "fridays at 15:00" }, reads: ["objects"], tools: { draft_document: "act", send_message: "notify" },
    run(ctx) {
      const p = ctx.params, st = ctx.statement, since = Date.parse(ctx.now) - 7 * 86400000;
      const when = (o) => Date.parse(o.at || o.requested || o.created || 0);
      const rows = (p.types || ["Issue", "WorkOrder"]).map((t) => [t, ctx.list(t, (o) => when(o) >= since).length, ctx.list(t, (o) => ["open", "requested", "active", "in_work"].includes(o.state)).length]);
      const body = rows.map(([t, n, open]) => `${t}: ${n} new this week, ${open} open`).join("\n");
      ctx.act("draft_document", { kind: "report", title: `Weekly report for ${st.builderId}`, body, audience: [st.builderId] });
      ctx.act("send_message", { channelId: `CHN-${st.builderId}`, text: `Your weekly report:\n${body}` });
    }
  },
  // Open issues past an age: a reminder to whoever holds each one.
  chaser: {
    label: "Chaser", purpose: "Remind people about open items older than a number of days",
    trigger: { kind: "schedule", every: "weekdays at 08:00" }, reads: ["objects"], tools: { send_message: "act" },
    run(ctx) {
      const p = ctx.params, st = ctx.statement, cutoff = Date.parse(ctx.now) - (p.olderThanDays || 5) * 86400000;
      const like = p.match ? new RegExp(p.match, "i") : null;
      for (const i of ctx.list("Issue", (x) => ["open", "triaged"].includes(x.state) && Date.parse(x.at) < cutoff && (!like || like.test(x.title)) && [x.raisedBy, x.assigneeId].includes(st.builderId))) {
        const to = i.assigneeId || i.raisedBy, ch = ctx.get(`CHN-${to}`);
        if (ch) ctx.act("send_message", { channelId: ch.id, text: `Reminder: "${i.title}" (${i.id}) has been open since ${i.at.slice(0, 10)}.`, issueId: i.id });
      }
    }
  },
  // Supplier records that are the same company written two ways.
  "data-tidy": {
    label: "Supplier tidy-up", purpose: "List supplier records in the ERP that look like the same company",
    trigger: { kind: "schedule", every: "daily at 06:00" }, reads: ["connector:erp"], tools: { draft_document: "act" },
    run(ctx) {
      const norm = (n) => n.toLowerCase().replace(/\(pty\)|\bltd\b|\bcc\b|&|\band\b|[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
      const groups = new Map();
      for (const sup of ctx.connector("erp").suppliers()) groups.set(norm(sup.name), [...(groups.get(norm(sup.name)) || []), sup]);
      const pairs = [...groups.values()].filter((g) => g.length > 1);
      ctx.act("draft_document", { kind: "report", title: "Supplier records that look the same", body: pairs.length ? pairs.map((g) => g.map((x) => `${x.id} ${x.name}`).join(" = ")).join("\n") : "No two supplier records look like the same company.", audience: [ctx.statement.builderId] });
    }
  }
};
