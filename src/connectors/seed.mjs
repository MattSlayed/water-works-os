// The seeded accounts history behind the synthetic connectors (plan 3b Task 1). Every name and number is invented.
// The last 14 days hold 25 invoices the clerk filed (a duplicate, a smudged photo and one with no PO among them);
// days 15-30 hold 13 more: 12 filed (one 6% over its PO) and one with changed bank details, queried instead.
import { rng } from "../generate.mjs";

export const MAILBOX = "accounts@riverbend.example";
export const CLERK = "P-043";
const DAY = 86400000;
const SUPPLIERS = [
  ["Vaal Pump & Valve (Pty) Ltd", "Vaal Pump and Valve", "vaalpump"], ["Highveld Chemicals CC", "Highveld Chemicals", "highveldchem"],
  ["Riverside Electrical Supplies", "Riverside Electrical", "riversideelec"], ["Gauteng Lab Consumables (Pty) Ltd", "Gauteng Lab Consumables", "gautenglab"],
  ["Bronkhorst Engineering Works", "Bronkhorst Engineering", "bronkhorsteng"], ["Sedibeng Safety Gear", "Sedibeng Safety", "sedibengsafety"],
  ["Magalies Fleet Services", "Magalies Fleet", "magaliesfleet"], ["Tswaing Industrial Hardware", "Tswaing Hardware", "tswainghw"]
];
const ITEMS = ["Mechanical seal kit", "Bearing 6312-2RS", "Polyaluminium chloride 1 t", "Contactor 32 A", "Turbidity standard 4000 NTU", "Gate valve DN150",
  "Safety boots size 9", "Coupling insert", "Vehicle service", "Cable gland M25", "Reagent pack DPD", "Hydrated lime 25 kg", "Hard hats (10)", "Pressure gauge 0-10 bar"];
export const folderPath = (folder, date) => `Accounts/Supplier invoices/${folder}/${date.slice(0, 7)}`;
const money = (n) => n.toFixed(2);
const cents = (n) => Math.round(n * 100) / 100;

// The text layer a document carries, one field per line (the digester reads it line by line).
export const invoiceText = (supplier, f) => [
  "TAX INVOICE", `Supplier: ${supplier}`, `Invoice No: ${f.number}`, `Date: ${f.date}`, ...(f.po ? [`PO: ${f.po}`] : []),
  ...f.lines.map((l) => `Item: ${l.desc} | ${l.qty} | ${money(l.price)}`), `VAT: R ${money(f.vat)}`,
  `Total: R ${f.smudge ? money(f.total).replace(/\d/g, "?") : money(f.total)}`, `Bank: ${f.bank.account} / ${f.bank.branch}`
].join("\n");

export function seedAccounts(seed, endIso) {
  const r = rng((seed * 7919 + 3301) >>> 0), end = Date.parse(endIso);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
  const e = new Date(end), dayStart = Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate());
  const at = (daysAgo, hour) => dayStart - daysAgo * DAY + hour * 3600000 + int(0, 59) * 60000;

  const suppliers = SUPPLIERS.map(([name, folder, dom], i) => ({ id: `SUP-${String(i + 1).padStart(2, "0")}`, name, folder, email: `accounts@${dom}.example`,
    bank: { account: String(62000000000 + int(1000000, 9999999)), branch: String(250000 + int(100, 999)) } }));
  // 40 POs, no two of one supplier within 3% of each other, so a PO is identifiable by supplier and amount
  const pos = [];
  for (let i = 0; i < 40; i++) {
    const sup = suppliers[i % 8];
    let lines, sub;
    do {
      lines = Array.from({ length: int(1, 3) }, () => ({ desc: ITEMS[int(0, ITEMS.length - 1)], qty: int(1, 12), price: int(300, 18000) + int(0, 99) / 100 }));
      sub = cents(lines.reduce((s, l) => s + l.qty * l.price, 0));
    } while (pos.some((p) => p.supplierId === sup.id && Math.abs(p.subtotal - sub) / p.subtotal < 0.03));
    pos.push({ id: `PO-2026-${String(301 + i).padStart(4, "0")}`, supplierId: sup.id, lines, subtotal: sub, total: cents(sub * 1.15), raisedAt: iso(at(int(32, 45), 9)), state: "open" });
  }
  // POs 38-40 have no invoice; with the bank-change invoice's PO they are the four without a goods receipt
  const usable = pos.slice(0, 37);

  // 38 invoices as [daysAgo, kind]: 25 in the 14-day window (days 1-13 before the clock), 13 in days 15-28
  const kinds = [...Array.from({ length: 25 }, (_, i) => [13 - Math.floor((i * 13) / 25), "clean"]), ...Array.from({ length: 13 }, (_, k) => [15 + Math.floor((k * 14) / 13), "clean"])];
  const ORIGINAL = 2; // the filed invoice the duplicate repeats
  kinds[4][1] = "noPo"; kinds[11][1] = "smudged"; kinds[19][1] = "duplicate"; kinds[27][1] = "overPo"; kinds[33][1] = "bankChange";
  const messages = [], attachments = new Map(), files = [], moves = [], invoices = [], receipts = new Map(), traps = {}, docs = [];
  const invNo = () => `INV-${int(10000, 99999)}`;
  const file = (name, mimeType, path, filedAt, sourceId, supplierId) => {
    const item = { id: `DRV-${String(files.length + 1).padStart(4, "0")}`, name, parentReference: { path: `/drive/root:/${path}` }, createdBy: { user: { id: CLERK } }, createdDateTime: iso(filedAt), file: { mimeType } };
    files.push(item);
    moves.push({ itemId: item.id, path, by: CLERK, at: iso(filedAt), sourceId, supplierId });
  };
  let next = 0;
  kinds.forEach(([daysAgo, kind], i) => {
    const orig = kind === "duplicate" ? docs[ORIGINAL] : null;
    const po = orig ? pos.find((p) => p.id === orig.poId) : usable[next++];
    const sup = suppliers.find((s) => s.id === po.supplierId);
    const lines = po.lines.map((l) => ({ ...l, price: kind === "overPo" ? cents(l.price * 1.06) : l.price }));
    const sub = cents(lines.reduce((s, l) => s + l.qty * l.price, 0));
    const received = at(daysAgo, int(6, 13));
    const f = { number: orig ? orig.number : invNo(), date: orig ? orig.date : iso(received - int(0, 2) * DAY).slice(0, 10), po: kind === "noPo" ? null : po.id, lines,
      vat: cents(sub * 0.15), total: orig ? orig.total : cents(sub * 1.15), smudge: kind === "smudged",
      bank: kind === "bankChange" ? { account: String(Number(sup.bank.account) + 4441017), branch: sup.bank.branch } : sup.bank };
    const photo = kind === "smudged" || i % 5 === 2;
    const att = { id: `ATT-${String(i + 1).padStart(4, "0")}`, name: photo ? `IMG_${2000 + i}.jpg` : `${f.number}.pdf`, contentType: photo ? "image/jpeg" : "application/pdf",
      size: int(40000, 900000), textLayer: invoiceText(sup.name, f), quality: kind === "smudged" ? "smudged" : photo ? "photo" : "clean" };
    attachments.set(att.id, att);
    const id = `M365-MSG-${String(i + 1).padStart(3, "0")}`;
    messages.push({ id, subject: orig ? `RE: Invoice ${f.number} (resend)` : `Invoice ${f.number}`, from: { emailAddress: { address: sup.email, name: sup.name } },
      receivedDateTime: iso(received), hasAttachments: true, attachments: [att] });
    docs.push({ number: f.number, date: f.date, total: f.total, poId: po.id });
    if (kind !== "clean") traps[kind] = id;
    if (kind === "bankChange") return; // queried, not filed: the open supplier query Issue is seeded with the people
    if (!receipts.has(po.id)) receipts.set(po.id, { id: `GRN-${po.id.slice(-4)}`, poId: po.id, receivedAt: iso(Date.parse(po.raisedAt) + int(2, 6) * DAY) });
    const filedAt = received + int(20, 170) * 60000;
    file(att.name, att.contentType, folderPath(sup.folder, f.date), filedAt, att.id, sup.id);
    invoices.push({ id: `SINV-${String(invoices.length + 1).padStart(4, "0")}`, supplierId: sup.id, number: f.number, total: f.total, poId: po.id, sourceId: att.id, receivedAt: iso(received), postedAt: iso(filedAt + 5 * 60000), postedBy: CLERK });
  });

  // 20 September filings from before the mailbox's 30 days: the history the clerk's folder habits are learnt from
  for (let k = 0; k < 20; k++) {
    const sup = suppliers[k % 8], filed = at(31 + Math.floor(k / 2), int(7, 14));
    file(`INV-${int(10000, 99999)}.pdf`, "application/pdf", folderPath(sup.folder, iso(filed)), filed, `ATT-ARCH-${String(k + 1).padStart(2, "0")}`, sup.id);
  }

  // 6 delivery notes and 4 messages with nothing to digest
  for (let k = 0; k < 6; k++) {
    const po = pos[k * 5], sup = suppliers.find((s) => s.id === po.supplierId);
    const att = { id: `ATT-${String(39 + k).padStart(4, "0")}`, name: `DN-${int(1000, 9999)}.pdf`, contentType: "application/pdf", size: int(20000, 200000), quality: "clean",
      textLayer: ["DELIVERY NOTE", `Supplier: ${sup.name}`, `Delivery No: DN-${int(1000, 9999)}`, `PO: ${po.id}`, ...po.lines.map((l) => `Item: ${l.desc} | ${l.qty}`)].join("\n") };
    attachments.set(att.id, att);
    messages.push({ id: `M365-MSG-${String(39 + k).padStart(3, "0")}`, subject: `Delivery note for ${po.id}`, from: { emailAddress: { address: sup.email, name: sup.name } }, receivedDateTime: iso(at(int(1, 28), int(6, 13))), hasAttachments: true, attachments: [att] });
  }
  ["Staff year-end function", "Password expiry notice", "Out of office: Thandi Mokoena", "Supplier newsletter: October specials"].forEach((subject, k) =>
    messages.push({ id: `M365-MSG-${String(45 + k).padStart(3, "0")}`, subject, from: { emailAddress: { address: k === 2 ? "thandi.mokoena@riverbend.example" : "noreply@riverbend.example", name: k === 2 ? "Thandi Mokoena" : "Riverbend Works" } },
      receivedDateTime: iso(at(int(1, 28), int(6, 13))), hasAttachments: false, attachments: [] }));

  // a paper invoice the clerk photographed and sent on the works chat two days before the clock (its PO has no receipt yet)
  const chatPo = pos[37], chatSup = suppliers.find((s) => s.id === chatPo.supplierId), chatAt = at(2, 10);
  const chatAtt = { id: "ATT-CHAT-0001", name: "IMG_3107.jpg", contentType: "image/jpeg", size: 512000, quality: "photo",
    textLayer: invoiceText(chatSup.name, { number: invNo(), date: iso(chatAt).slice(0, 10), po: chatPo.id, lines: chatPo.lines, vat: cents(chatPo.subtotal * 0.15), total: chatPo.total, bank: chatSup.bank }) };
  attachments.set(chatAtt.id, chatAtt);

  messages.sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime) || a.id.localeCompare(b.id));
  return { suppliers, pos, receipts: [...receipts.values()], invoices, messages, attachments, files, moves, traps, chatPhoto: { attachmentId: chatAtt.id, channelId: `CHN-${CLERK}`, at: iso(chatAt) } };
}
