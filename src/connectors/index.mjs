// Synthetic connectors (agents design §7, plan 3b Task 1): Microsoft 365, Google Workspace and an ERP, in the real
// APIs' resource shapes (Graph messages and driveItems, Gmail messages, Drive files, Sheets value ranges), seeded
// deterministically and in memory. The CMMS is the ontology itself. Nothing here touches the network.
// shortcut: in-memory stores; a real tenant swaps each store for its API client behind the same functions.
import { seedAccounts } from "./seed.mjs";
import { seedEngineering, WORKS_MAILBOX } from "./engineering.mjs";

export const CONNECTOR_KINDS = ["m365.mail", "m365.files", "m365.teams", "google.mail", "google.drive", "google.sheets", "erp", "cmms"];
const copy = (x) => structuredClone(x);

export function createConnectors({ seed = 7, nowIso = () => new Date().toISOString() } = {}) {
  const now = typeof nowIso === "function" ? nowIso : () => nowIso;
  const s = seedAccounts(seed, now());
  const eng = seedEngineering();
  const files = [...s.files, ...eng.files], moves = s.moves, invoices = s.invoices, teams = [];
  let fileSeq = s.files.length, invSeq = invoices.length;
  const under = (item, path) => item.parentReference.path === `/drive/root:/${path}` || item.parentReference.path.startsWith(`/drive/root:/${path}/`);

  return {
    m365: {
      mail: { list: (mailbox, { since } = {}) => (mailbox === "accounts@riverbend.example" ? s.messages : mailbox === WORKS_MAILBOX ? eng.messages : []).filter((m) => !since || m.receivedDateTime >= since).map(copy) },
      files: {
        list: (path = "") => files.filter((f) => !path || under(f, path)).map(copy),
        copy(attachmentId, path, { by, at = now() } = {}) {
          const att = s.attachments.get(attachmentId);
          if (!att) throw new Error(`no attachment ${attachmentId}`);
          const item = { id: `DRV-${String(++fileSeq).padStart(4, "0")}`, name: att.name, parentReference: { path: `/drive/root:/${path}` }, createdBy: { user: { id: by } }, createdDateTime: at, file: { mimeType: att.contentType } };
          files.push(item);
          moves.push({ itemId: item.id, path, by, at, sourceId: attachmentId, supplierId: null });
          return copy(item);
        },
        remove(itemId) {
          const i = files.findIndex((f) => f.id === itemId);
          if (i >= 0) files.splice(i, 1);
          const j = moves.findIndex((m) => m.itemId === itemId);
          if (j >= 0) moves.splice(j, 1);
        },
        moves: () => moves.map(copy)
      },
      teams: { post: (channel, text) => { const m = { id: `TMS-${teams.length + 1}`, channelIdentity: { channelId: channel }, body: { contentType: "text", content: String(text) }, createdDateTime: now() }; teams.push(m); return copy(m); }, messages: () => teams.map(copy) }
    },
    google: {
      mail: { list: () => [] }, // Gmail users.messages: { id, threadId, snippet, payload: { headers } }; nothing seeded
      drive: { list: () => [] }, // Drive files: { id, name, mimeType, parents }; nothing seeded
      sheets: { values: (range) => ({ range, majorDimension: "ROWS", values: copy(eng.sheets[range] || []) }) }
    },
    erp: {
      suppliers: () => s.suppliers.map(copy),
      purchaseOrders: () => s.pos.map(copy),
      goodsReceipts: () => s.receipts.map(copy),
      invoices: () => invoices.map(copy),
      postMatch({ invoice, poId, by, at = now() }) {
        const inv = { id: `SINV-${String(++invSeq).padStart(4, "0")}`, supplierId: invoice.supplierId || null, number: invoice.invoiceNo || invoice.number, total: invoice.total, poId, sourceId: invoice.sourceId || null, receivedAt: invoice.receivedAt || at, postedAt: at, postedBy: by };
        invoices.push(inv);
        return copy(inv);
      },
      unpost(id) { const i = invoices.findIndex((x) => x.id === id); if (i >= 0) invoices.splice(i, 1); }
    },
    attachment: (id) => { const a = s.attachments.get(id) || eng.attachments.get(id); return a ? copy(a) : null; },
    traps: { ...s.traps },
    chatPhoto: { ...s.chatPhoto }
  };
}
