// Drawing → cells → binding (design §4.3 steps 2–3). Every value becomes a graded cell:
// EXTRACTED (attribute, element, list row), INFERRED (computed from geometry or placement),
// AMBIGUOUS (sheets disagree, or a tag binds to no record or to several). Existing records are only read.
import { createHash } from "node:crypto";
import { parseDxf } from "./dxf.mjs";
import { parseDexpi } from "./dexpi.mjs";
import { parseCsv } from "./csv.mjs";

const NON_PROCESS = new Set(["mcc", "gen_set", "lab", "admin"]); // not expected on a P&ID
const VALVE_STATE = { inlet: "open", outlet: "open" }; // all other filter valves rest closed
const n = (v) => (v === undefined || v === "" ? undefined : Number(v));
const tokens = (s) => new Set(String(s).toLowerCase().match(/\p{L}+|[0-9]+/gu) ?? []);
const jaccard = (a, b) => { const A = tokens(a), B = tokens(b); let i = 0; for (const t of A) if (B.has(t)) i++; return i / (A.size + B.size - i || 1); };
const pathLength = (pts) => Math.round(pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0) * 10) / 10;

export function extractPlant(files, ont) {
  const sources = [], sheets = {};
  for (const [file, text] of Object.entries(files)) {
    const m = /^(RB-([A-Z]+)-\d+)_([A-Z])\.(dxf|xml|csv)$/.exec(file);
    if (!m) throw new Error(`unrecognised drawing file name: ${file}`);
    const [, number, code, rev, ext] = m;
    sources.push({ number, rev, kind: code.toLowerCase(), sha256: createHash("sha256").update(text).digest("hex"), file });
    sheets[number] = ext === "dxf" ? parseDxf(text) : ext === "xml" ? parseDexpi(text) : parseCsv(text);
  }
  const GA = "RB-GA-001", HP = "RB-HP-001", PFD = "RB-PFD-001", LL = "RB-LL-001", EL = "RB-EL-001", IL = "RB-IL-001", TYP = "RB-PID-05";
  const ga = sheets[GA], pids = Object.keys(sheets).filter((k) => k.startsWith("RB-PID-")).sort();

  const items = new Map(), cells = [], bindings = {};
  const put = (kind, tag, field, value, sheet, region, reasoning, grade = "EXTRACTED") => {
    if (value === undefined || value === null) return;
    if (!items.has(tag)) items.set(tag, { kind, tag, fields: {} });
    items.get(tag).fields[field] = value;
    cells.push({ key: `${tag}|${field}`, sheet, field, value, grade, region, reasoning, reviewed: null });
  };
  const cellOf = (key) => cells.find((c) => c.key === key);
  const bind = (kind, tag, key, candidates, sheet, region) => {
    const exact = candidates.filter((c) => c.key === key);
    let b, why;
    if (exact.length === 1) [b, why] = [{ id: exact[0].id, grade: "EXTRACTED" }, `${key} equals the tag on ${exact[0].id}`];
    else if (exact.length > 1) [b, why] = [{ id: null, grade: "AMBIGUOUS" }, `${key} matches ${exact.length} records: ${exact.map((c) => c.id).join(", ")}`];
    else {
      const scored = candidates.map((c) => ({ ...c, score: Math.round(jaccard(key, c.key) * 100) / 100 })).sort((a, z) => z.score - a.score);
      const top = scored.filter((c) => c.score === scored[0]?.score);
      if (top.length === 1 && top[0].score >= 0.6) [b, why] = [{ id: top[0].id, grade: "INFERRED", score: top[0].score }, `${key} nearest to ${top[0].key} (${top[0].id}), token overlap ${top[0].score}`];
      else [b, why] = [{ id: null, grade: "AMBIGUOUS" }, top.length > 1 && top[0].score > 0 ? `${key} on ${sheet} matches no record; ${top.length} records tie at token overlap ${top[0].score} (${top.slice(0, 3).map((c) => c.id).join(", ")}…)` : `${key} on ${sheet} matches no record`];
    }
    bindings[tag] = b;
    put(kind, tag, "binding", b.id ?? "unbound", sheet, region, why, b.grade);
    return b.id ? ont.get(b.id) : null;
  };
  // A bound record whose zone disagrees with the drawing makes the zone cell AMBIGUOUS, citing both.
  const checkZone = (tag, record) => {
    const c = cellOf(`${tag}|zoneId`);
    if (record?.zoneId && c && record.zoneId !== c.value) Object.assign(c, { grade: "AMBIGUOUS", reasoning: `${c.sheet} places ${tag} in ${c.value}; record ${record.id} says ${record.zoneId}` });
  };

  const elRow = new Map(sheets[EL].map((r, i) => [r.Tag, { ...r, row: i + 2 }]));
  const zones = ont.list("Zone");
  const zoneAt = ([x, y]) => zones.find((z) => x >= z.rect[0] && x <= z.rect[0] + z.rect[2] && y >= z.rect[1] && y <= z.rect[1] + z.rect[3]);
  const putZone = (kind, tag, at) => {
    const r = elRow.get(tag);
    if (r) return put(kind, tag, "zoneId", r.Zone, EL, { row: r.row }, `equipment list row for ${tag}`);
    const z = zoneAt(at);
    if (z) put(kind, tag, "zoneId", z.id, GA, { at }, `not on ${EL}; its insertion point on ${GA} lies inside ${z.id}`, "INFERRED");
    else put(kind, tag, "zoneId", "none", GA, { at }, `not on ${EL} and outside every zone`, "AMBIGUOUS");
  };

  // ---- structures (GA STRUCT inserts, HP levels, P&ID presence) ----
  const onPid = new Map();
  for (const p of pids) for (const t of [...sheets[p].equipment.map((e) => e.tag), ...Object.values(sheets[p].tagTable).map((r) => r.kks)]) onPid.set(t, [...(onPid.get(t) ?? []), p]);
  const hpLevel = new Map((sheets[HP]?.inserts ?? []).filter((i) => i.block === "LEVEL").map((i) => [i.attribs.TAG, i.attribs]));
  const positions = ont.list("Position");
  for (const ins of ga.inserts.filter((i) => i.block === "STRUCT")) {
    const a = ins.attribs, tag = a.TAG, region = { entity: "INSERT STRUCT", at: ins.at }, from = `ATTRIB on ${GA}`;
    put("structure", tag, "kind", a.KIND, GA, region, from);
    put("structure", tag, "centre", ins.at, GA, region, `insertion point on ${GA}`);
    put("structure", tag, "baseLevel", n(a.BASE), GA, region, from);
    put("structure", tag, "height", n(a.HEIGHT), GA, region, from);
    if (a.DIA) put("structure", tag, "diameter", n(a.DIA), GA, region, from);
    else if (a.W) { put("structure", tag, "w", n(a.W), GA, region, from); put("structure", tag, "l", n(a.L), GA, region, from); }
    else {
      const c = ga.entities.find((e) => e.type === "CIRCLE" && e.centre[0] === ins.at[0] && e.centre[1] === ins.at[1]);
      if (c) put("structure", tag, "diameter", c.radius * 2, GA, { entity: "CIRCLE", at: c.centre }, `no DIA attribute; twice the CIRCLE radius at the insertion point on ${GA}`, "INFERRED");
    }
    if (a.TWL) {
      const hp = hpLevel.get(tag);
      if (hp && n(hp.TWL) !== n(a.TWL)) put("structure", tag, "twl", n(a.TWL), GA, region, `${GA} gives TWL ${a.TWL}; ${HP} gives ${hp.TWL}`, "AMBIGUOUS");
      else put("structure", tag, "twl", n(a.TWL), GA, region, hp ? `${from}; ${HP} agrees` : from);
    }
    put("structure", tag, "volumeM3", n(a.VOL), GA, region, from);
    putZone("structure", tag, ins.at);
    if (!NON_PROCESS.has(a.KIND)) {
      const on = onPid.get(tag);
      if (on) put("structure", tag, "presence", [GA, ...on].join(", "), GA, region, `on ${GA} and ${on.join(", ")}`);
      else put("structure", tag, "presence", `${GA} only`, GA, region, `${tag} is on ${GA} but on no P&ID (${pids[0]}…${pids[pids.length - 1]}); retired item or missing from the P&IDs?`, "AMBIGUOUS");
    }
    if (a.KIND === "filter_bed") checkZone(tag, bind("structure", tag, tag, positions.map((p) => ({ id: p.id, key: p.kks })), GA, region));
  }

  // ---- machine placements (GA MACHINE inserts) ----
  for (const ins of ga.inserts.filter((i) => i.block === "MACHINE")) {
    const a = ins.attribs, tag = a.TAG, region = { entity: "INSERT MACHINE", at: ins.at };
    put("machine", tag, "structure", a.STRUCT, GA, region, `ATTRIB STRUCT on ${GA}`);
    put("machine", tag, "offset", [n(a.OX), n(a.OY), n(a.OZ)], GA, region, `ATTRIB OX/OY/OZ on ${GA}`);
    putZone("machine", tag, ins.at);
    checkZone(tag, bind("machine", tag, tag, positions.map((p) => ({ id: p.id, key: p.tag })), GA, region));
  }

  // ---- lines (LL rows, PFD streams, GA polylines, P&ID diameters) ----
  const stream = new Map((sheets[PFD]?.streams ?? []).map((s) => [s.id, s]));
  const pidSeg = new Map(pids.flatMap((p) => sheets[p].segments.map((s) => [s.line, { ...s, sheet: p }])));
  const polys = new Map(ga.entities.filter((e) => e.type === "LWPOLYLINE" && e.tag).map((e) => [e.tag, e]));
  const yes = (v) => v === "yes";
  sheets[LL].forEach((r, i) => {
    const tag = r.Line, region = { row: i + 2 }, why = `line list row for ${tag}`;
    for (const [field, value] of [["service", r.Service], ["conveyance", r.Conveyance], ["width", n(r.Width)], ["depth", n(r.Depth)], ["from", r.From], ["to", r.To],
      ["normalDirection", `${r.From}→${r.To}`], ["mode", r.Mode], ["causal", yes(r.Causal)], ["recycle", yes(r.Recycle)], ["injectionAt", r.InjectionAt || undefined], ["pumped", yes(r.Pumped)]]) put("line", tag, field, value, LL, region, why);
    if (r.DN) {
      const typ = /^RB-L-([126])\d\d$/.exec(tag), seg = pidSeg.get(tag) ?? (typ && pidSeg.get(`RB-L-${typ[1]}##`));
      if (seg?.dn && seg.dn !== n(r.DN)) put("line", tag, "dn", n(r.DN), LL, region, `${LL} says DN${r.DN}; ${seg.sheet} (segment ${seg.line}) says DN${seg.dn}`, "AMBIGUOUS");
      else put("line", tag, "dn", n(r.DN), LL, region, seg?.dn ? `${why}; ${seg.sheet} agrees` : why);
    }
    const s = stream.get(tag);
    if (s) { put("line", tag, "designFlow", s.flow, PFD, { element: `Stream ${tag}` }, `PFD stream ${tag}`); put("line", tag, "splitFraction", s.split, PFD, { element: `Stream ${tag}` }, `PFD stream ${tag}`); }
  });
  for (const [tag, e] of polys) {
    const region = { entity: "LWPOLYLINE", layer: e.layer, at: e.points[0] };
    if (!items.has(tag)) put("line", tag, "presence", `${GA} only`, GA, region, `polyline ${tag} on ${GA} has no row on ${LL}; superseded route or missing row?`, "AMBIGUOUS");
    put("line", tag, "path", e.points.map(([x, y]) => [x, y, e.elevation]), GA, region, `polyline vertices and elevation on ${GA}`);
    put("line", tag, "length", pathLength(e.points), GA, region, `plan length of the ${GA} polyline`, "INFERRED");
  }

  // ---- valves (the PID-05 typical's tag table) ----
  const typ = sheets[TYP];
  if (typ) for (const [filter, row] of Object.entries(typ.tagTable)) for (const v of row.valves) {
    const role = v.split("-").pop(), region = { element: `TagRow ${filter}` }, why = `${TYP} tag table row ${filter} with the typical ${v.replace(/\d\d-/, "##-")}`;
    put("valve", v, "kind", typ.components.find((c) => c.tag === `15AA##-${role}`)?.cls, TYP, region, why);
    put("valve", v, "filter", row.kks, TYP, region, why);
    put("valve", v, "lineId", { inlet: row.inlet, outlet: row.outlet }[role], TYP, region, why);
    put("valve", v, "actuated", true, TYP, region, why);
    put("valve", v, "normalState", VALVE_STATE[role] ?? "closed", TYP, region, `not drawn; ${role} valves on a filter in service are normally ${VALVE_STATE[role] ?? "closed"}`, "INFERRED");
  }

  // ---- instruments and sample points (IL rows) ----
  const sensors = ont.list("Sensor").map((s) => ({ id: s.id, key: s.historianTag }));
  sheets[IL].forEach((r, i) => {
    const tag = r.Tag, region = { row: i + 2 }, why = `instrument list row for ${tag}`;
    put("instrument", tag, "historianTag", r.HistorianTag, IL, region, why);
    put("instrument", tag, "measuredAt", r.MeasuredAt, IL, region, why);
    put("instrument", tag, "samplePosition", r.SamplePosition, IL, region, why);
    bind("instrument", tag, r.HistorianTag, sensors, IL, region);
    if (r.SamplePosition !== "inline") {
      const sp = `SP-${tag}`;
      put("samplepoint", sp, "at", r.MeasuredAt, IL, region, why);
      put("samplepoint", sp, "position", r.SamplePosition, IL, region, why);
      put("samplepoint", sp, "lagMin", n(r.LagMin), IL, region, why);
      put("samplepoint", sp, "instrument", tag, IL, region, why);
    }
  });

  return { sources, items: [...items.values()], cells, bindings };
}
