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
    tools: ["digest_document", "file_document", "post_invoice_match", "raise_issue"],
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
  }
};
