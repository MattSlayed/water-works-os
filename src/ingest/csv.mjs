// RFC 4180 CSV reader: the first row is the header; quoted fields may hold commas, doubled quotes and newlines.
export function parseCsv(text) {
  const rows = [], s = String(text).replace(/\r\n/g, "\n");
  let row = [], field = "", quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (quoted) throw new Error("malformed CSV: unclosed quote");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r, n) => {
    if (r.length !== head.length) throw new Error(`malformed CSV: row ${n + 2} has ${r.length} fields, header has ${head.length}`);
    return Object.fromEntries(head.map((h, k) => [h, r[k]]));
  });
}
