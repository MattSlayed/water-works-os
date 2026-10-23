// Reader for the DXF R2000 ASCII subset the drawing set uses (design §4.1): HEADER variables, LAYER table,
// INSERT with ATTRIB/SEQEND, LWPOLYLINE (with RBTAG XDATA) and CIRCLE. Anything else is kept as {type, layer}.
const bad = (why) => { throw new Error(`malformed DXF: ${why}`); };

export function parseDxf(text) {
  const raw = String(text).replace(/\r\n/g, "\n").split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  if (raw.length % 2) bad("odd number of lines (truncated group)");
  const g = [];
  for (let i = 0; i < raw.length; i += 2) {
    const code = Number(raw[i].trim());
    if (raw[i].trim() === "" || !Number.isInteger(code)) bad(`group code "${raw[i]}" at line ${i + 1}`);
    g.push([code, raw[i + 1].trim()]);
  }
  if (!g.length || g[g.length - 1][0] !== 0 || g[g.length - 1][1] !== "EOF") bad("no EOF");

  const header = {}, layers = [], entities = [], inserts = [];
  let section = null, i = 0;
  const next = () => g[i++];
  // The groups of one record: from after its (0, TYPE) up to the next code 0.
  const record = () => { const out = []; while (i < g.length && g[i][0] !== 0) out.push(next()); return out; };
  const val = (rec, code) => rec.find(([c]) => c === code)?.[1];
  const numOf = (rec, code) => (val(rec, code) == null ? undefined : Number(val(rec, code)));

  while (i < g.length) {
    const [code, value] = next();
    if (code !== 0) bad(`expected record start, got code ${code}`);
    if (value === "EOF") break;
    if (value === "SECTION") {
      const rec = record();
      section = val(rec, 2);
      // HEADER variables have no record start of their own: (9, $NAME) then the value group.
      if (section === "HEADER") for (let k = 0; k < rec.length - 1; k++) if (rec[k][0] === 9) header[rec[k][1]] = rec[k + 1][1];
      continue;
    }
    if (value === "ENDSEC") { if (!section) bad("ENDSEC outside a section"); section = null; continue; }
    if (!section) bad(`${value} outside a section`);
    const rec = record();
    if (section === "HEADER") continue;
    if (section === "TABLES") { if (value === "LAYER") layers.push(val(rec, 2)); continue; }
    if (section !== "ENTITIES") continue;
    const layer = val(rec, 8);
    if (value === "INSERT") {
      const ins = { block: val(rec, 2), layer, at: [numOf(rec, 10), numOf(rec, 20)], attribs: {} };
      while (i < g.length && g[i][0] === 0 && g[i][1] === "ATTRIB") { next(); const a = record(); ins.attribs[val(a, 2)] = val(a, 1) ?? ""; }
      if (val(rec, 66) === "1") { const [c, v] = next() ?? []; if (c !== 0 || v !== "SEQEND") bad(`INSERT ${ins.block} without SEQEND`); record(); }
      inserts.push(ins);
    } else if (value === "LWPOLYLINE") {
      const xs = rec.filter(([c]) => c === 10).map(([, v]) => Number(v)), ys = rec.filter(([c]) => c === 20).map(([, v]) => Number(v));
      if (xs.length !== ys.length || xs.length !== numOf(rec, 90)) bad("LWPOLYLINE vertex count");
      const x = rec.findIndex(([c, v]) => c === 1001 && v === "RBTAG");
      entities.push({ type: value, layer, points: xs.map((v, k) => [v, ys[k]]), closed: (numOf(rec, 70) & 1) === 1, elevation: numOf(rec, 38) ?? 0, ...(x >= 0 ? { tag: rec[x + 1]?.[1] } : {}) });
    } else if (value === "CIRCLE") entities.push({ type: value, layer, centre: [numOf(rec, 10), numOf(rec, 20)], radius: numOf(rec, 40) });
    else entities.push({ type: value, layer });
  }
  if (section) bad(`section ${section} not closed`);
  return { header, layers, entities, inserts };
}
