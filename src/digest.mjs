// The document digester (agents design §8): graded cells read from a document's text layer, the three-way match of
// invoice, PO and goods receipt, duplicate and bank-change checks, and the filing folder learnt from past filings.
// Pure functions over what the connectors return; nothing here touches the ontology.
// shortcut: reads the text layer only; with ANTHROPIC_API_KEY the digest action is given Claude's cells for an image.

export const FIELDS = ["supplier", "invoiceNo", "date", "poNo", "lines", "vat", "total", "bank"];
const PATTERNS = {
  supplier: /^Supplier: (.+)$/, invoiceNo: /^Invoice No: (.+)$/, date: /^Date: (.+)$/, poNo: /^PO: (.+)$/,
  vat: /^VAT: R (.+)$/, total: /^Total: R (.+)$/, bank: /^Bank: (.+)$/
};
const cell = (key, value, grade, line, reasoning) => ({ key, value, grade, region: line ? { line } : null, reasoning, reviewed: null });
const num = (s) => (/^\d+(\.\d+)?$/.test(String(s).trim()) ? Number(s) : null);
const pct = (a, b) => ((a - b) / b) * 100;

// An invoice, or a document the digester cannot tell (no text layer) and so sends to review; delivery notes are not.
export const isInvoiceDoc = (att) => !!att && (!att.textLayer || /^TAX INVOICE/.test(att.textLayer));

// POs from the supplier with no invoice captured against them before `at`.
const openPos = (erp, supplierId, at) => {
  const used = new Set(erp.invoices().filter((i) => !at || i.receivedAt < at).map((i) => i.poId));
  return erp.purchaseOrders().filter((p) => p.supplierId === supplierId && !used.has(p.id));
};

export function extractFields(att, { erp, at = null, tolerancePct = 2 } = {}) {
  if (!att || !att.textLayer) {
    const cells = FIELDS.map((k) => cell(k, null, "AMBIGUOUS", null, "no text layer"));
    return { cells, fields: Object.fromEntries([...FIELDS, "supplierId"].map((k) => [k, null])) };
  }
  const rows = att.textLayer.split("\n"), found = {}, lines = [];
  rows.forEach((row, i) => {
    const item = row.match(/^Item: (.+?) \| (.+?) \| (.+)$/);
    if (item) return lines.push({ desc: item[1], qty: num(item[2]), price: num(item[3]), line: i + 1 });
    for (const [k, re] of Object.entries(PATTERNS)) { const m = row.match(re); if (m && !found[k]) found[k] = { raw: m[1].trim(), line: i + 1 }; }
  });
  const cells = [], fields = { supplierId: null };
  const put = (key, value, grade, line, reasoning) => { cells.push(cell(key, value, grade, line, reasoning)); fields[key] = grade === "AMBIGUOUS" ? null : value; };
  const unreadable = (f) => /\?/.test(f.raw);
  const plain = (key, read = (s) => s, check = (v) => v != null) => {
    const f = found[key];
    if (!f) return put(key, null, "AMBIGUOUS", null, "not on the document");
    if (unreadable(f)) return put(key, f.raw, "AMBIGUOUS", f.line, `unreadable: "${rows[f.line - 1]}"`);
    const v = read(f.raw);
    return check(v) ? put(key, v, "EXTRACTED", f.line, `read from line ${f.line}`) : put(key, f.raw, "AMBIGUOUS", f.line, `could not read "${f.raw}"`);
  };

  const sup = found.supplier && erp.suppliers().find((s) => s.name === found.supplier.raw);
  if (sup) { put("supplier", sup.name, "EXTRACTED", found.supplier.line, `read from line ${found.supplier.line}; ${sup.id} in the ERP`); fields.supplierId = sup.id; }
  else if (found.supplier) put("supplier", found.supplier.raw, "AMBIGUOUS", found.supplier.line, "supplier not in the ERP");
  else put("supplier", null, "AMBIGUOUS", null, "not on the document");
  plain("invoiceNo");
  plain("date", (s) => s, (v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
  plain("total", num);
  if (found.poNo) plain("poNo", (s) => s, (v) => /^PO-\d{4}-\d{4}$/.test(v));
  else {
    // a missing PO is worked out from the supplier and amount, only when exactly one open PO fits within tolerance
    const cands = fields.supplierId && fields.total != null ? openPos(erp, fields.supplierId, at).filter((p) => Math.abs(pct(fields.total, p.total)) <= tolerancePct) : [];
    if (cands.length === 1) put("poNo", cands[0].id, "INFERRED", null, `no PO on the document; ${cands[0].id} is the only open PO from ${fields.supplier} within ${tolerancePct}% of R ${fields.total.toFixed(2)}`);
    else put("poNo", null, "AMBIGUOUS", null, cands.length ? `no PO on the document; candidate POs: ${cands.map((p) => p.id).join(", ")}` : "no PO on the document and no open PO from this supplier matches the amount");
  }
  const lineOk = lines.length && lines.every((l) => l.qty != null && l.price != null);
  put("lines", lines.map(({ desc, qty, price }) => ({ desc, qty, price })), lineOk ? "EXTRACTED" : "AMBIGUOUS", lines.length ? lines[0].line : null, lineOk ? `${lines.length} line(s) read` : lines.length ? "a quantity or price is unreadable" : "no lines on the document");
  plain("vat", num);
  plain("bank", (s) => { const m = s.match(/^(\d+) \/ (\d+)$/); return m ? { account: m[1], branch: m[2] } : null; });
  // the lines tell the reviewer what an unreadable total should be, but never fill it in
  const t = cells.find((x) => x.key === "total");
  if (t.grade === "AMBIGUOUS" && lineOk) t.reasoning += `; the lines add up to R ${(lines.reduce((s, l) => s + l.qty * l.price, 0) * 1.15).toFixed(2)} with VAT`;
  cells.sort((a, b) => FIELDS.indexOf(a.key) - FIELDS.indexOf(b.key));
  return { cells, fields };
}

// The three-way match (invoice, PO, goods receipt), the duplicate check and the bank-detail check.
// A duplicate is an earlier document (received before `at`, another attachment) with the same supplier, number and total.
export function matchInvoice(fields, { erp, tolerancePct = 2, seen = [], at = null, sourceId = null } = {}) {
  const issues = [], f = fields || {};
  const po = f.poNo ? erp.purchaseOrders().find((p) => p.id === f.poNo) : null;
  if (!po) issues.push({ kind: "no-po", detail: f.poNo ? `${f.poNo} is not in the ERP` : "no PO to match against" });
  if (po && f.total != null) {
    const d = pct(f.total, po.total);
    if (Math.abs(d) > tolerancePct) issues.push({ kind: "over-tolerance", detail: `R ${f.total.toFixed(2)} is ${Math.abs(d).toFixed(1)}% ${d > 0 ? "over" : "under"} ${po.id} (R ${po.total.toFixed(2)}); tolerance ${tolerancePct}%` });
  }
  const receipt = po ? erp.goodsReceipts().find((g) => g.poId === po.id) : null;
  if (po && !receipt) issues.push({ kind: "no-receipt", detail: `no goods receipt for ${po.id}` });
  if (f.supplierId && f.invoiceNo && f.total != null) {
    const same = (x) => x.supplierId === f.supplierId && (x.number || x.invoiceNo) === f.invoiceNo && Math.abs(x.total - f.total) < 0.005 && x.sourceId !== sourceId && (!at || !x.receivedAt || x.receivedAt < at);
    const dup = [...seen, ...erp.invoices()].find(same);
    if (dup) issues.push({ kind: "duplicate", detail: `same supplier, number ${f.invoiceNo} and total as ${dup.id || dup.sourceId}` });
  }
  const sup = f.supplierId && erp.suppliers().find((s) => s.id === f.supplierId);
  if (sup && f.bank && (f.bank.account !== sup.bank.account || f.bank.branch !== sup.bank.branch))
    issues.push({ kind: "bank-change", detail: `bank account ${f.bank.account} / ${f.bank.branch} differs from ${sup.name}'s ${sup.bank.account} / ${sup.bank.branch} in the ERP` });
  return { po: po ? po.id : null, receipt: receipt ? receipt.id : null, ok: !issues.length, issues };
}

// Where the clerk would file it: the supplier's usual folder (the most common parent of earlier filings), by month.
export function destinationFor(fields, history = []) {
  const month = (fields.date || "undated").slice(0, 7);
  const mine = history.filter((h) => h.supplierId && h.supplierId === fields.supplierId);
  if (!mine.length) return { path: `Accounts/Supplier invoices/${fields.supplier}/${month}`, basis: "pattern" };
  const counts = new Map();
  for (const h of mine) { const folder = h.path.split("/").slice(0, -1).join("/"); counts.set(folder, [...(counts.get(folder) || []), h]); }
  const [folder, items] = [...counts].sort((a, b) => b[1].length - a[1].length || b[1].at(-1).at.localeCompare(a[1].at(-1).at))[0];
  return { path: `${folder}/${month}`, basis: items.map((h) => h.itemId) };
}

// file: everything read and matched; review: something unsure, a duplicate, outside tolerance, or no receipt;
// person: changed bank details, which never go further without someone checking with the supplier.
export function digestVerdict({ cells, match }) {
  if (match.issues.some((i) => i.kind === "bank-change")) return "person";
  if (cells.some((c) => c.grade === "AMBIGUOUS" && !c.reviewed) || match.issues.length) return "review";
  return "file";
}
