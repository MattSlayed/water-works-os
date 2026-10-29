// Synthetic Riverbend drawing set, generated from the layout (design §4.1). Real, text-based formats:
// DXF R2000 ASCII (GA, hydraulic profile), a DEXPI 1.3 subset (PFD, P&IDs) and CSV lists. Deterministic: no PRNG.
// Seeded disagreements a reviewer must catch: 17BBB01 on the GA only; RB-L-210 DN400 (LL) vs DN450 (PID-05);
// instrument 15CQ13 matching no sensor; and in rev B the old washwater outlet RB-L-421X on the GA only.
import { STRUCTURES, MACHINES, GEOREF, CAPACITY_MLD, siteBounds } from "../layout.mjs";

const S = Object.fromEntries(STRUCTURES.map((s) => [s.tag, s]));
const pad = (n) => String(n).padStart(2, "0");
const FILTERS = Array.from({ length: 8 }, (_, i) => pad(i + 1));
const BAY = (f) => (Number(f) <= 4 ? "01" : "02"); // F01–F04 sit in filter building 1 over contact tank 1, F05–F08 in 2
const Q = (CAPACITY_MLD * 1000) / 24; // m3/h

// [line, service, conveyance, dn | [width, depth], from, to, share, mode, causal, recycle, injectionAt]
const L = (line, service, conveyance, size, from, to, share = 1, extra = {}) => ({ line, service, conveyance, ...(conveyance === "pipe" ? { dn: size } : { width: size[0], depth: size[1] }), from, to, share, mode: "continuous", causal: true, recycle: false, injectionAt: null, ...extra });
export const LINES = [
  L("RB-L-001", "raw", "pipe", 1000, "10UPA01", "10UBA01", 0.5, { pumped: true }),
  L("RB-L-002", "raw", "channel", [2.0, 1.2], "10UBA01", "11UGA01", 0.5),
  L("RB-L-003", "raw", "pipe", 1000, "10UPA01", "10UBA02", 0.5, { pumped: true }),
  L("RB-L-004", "raw", "channel", [2.0, 1.2], "10UBA02", "11UGA01", 0.5),
  L("RB-L-005", "coagulated", "channel", [2.4, 1.4], "11UGA01", "13UGD01"),
  ...[1, 2, 3, 4].map((n) => L(`RB-L-01${n}`, "flocculated", "pipe", 600, "13UGD01", `14UGE0${n}`, 0.25)),
  // every clarifier feeds the inlet channels of both filter buildings
  ...["01", "02"].flatMap((b, k) => [1, 2, 3, 4].map((n) => L(`RB-L-02${n + 4 * k}`, "settled", "channel", [1.2, 1.0], `14UGE0${n}`, `15UFB${b}`, 0.125))),
  ...FILTERS.map((f) => L(`RB-L-1${f}`, "settled", "pipe", 450, `15UFB${BAY(f)}`, `15HFA${f}`, 1 / 8)),
  ...FILTERS.map((f) => L(`RB-L-2${f}`, "filtered", "pipe", 450, `15HFA${f}`, `16UGH${BAY(f)}`, 1 / 8)),
  L("RB-L-210", "filtered", "pipe", 400, "16UGH01", "16UGH02", 0, { causal: false }), // contact-tank balancing pipe; seeded DN400 vs the PID-05 typical's DN450
  // both contact tanks discharge into a common clear-water main that fills both reservoirs
  L("RB-L-301", "chlorinated", "pipe", 900, "16UGH01", "20UBA01", 0.25),
  L("RB-L-302", "chlorinated", "pipe", 900, "16UGH02", "20UBA02", 0.25),
  L("RB-L-303", "chlorinated", "pipe", 900, "16UGH01", "20UBA02", 0.25),
  L("RB-L-304", "chlorinated", "pipe", 900, "16UGH02", "20UBA01", 0.25),
  L("RB-L-311", "final", "pipe", 900, "20UBA01", "20UMC01", 0.5),
  L("RB-L-312", "final", "pipe", 900, "20UBA02", "20UMC01", 0.5),
  L("RB-L-401", "backwash supply", "pipe", 600, "20UBA01", "15UMB01", 0.1, { mode: "intermittent", pumped: true }),
  ...["01", "02"].flatMap((b, k) => [
    L(`RB-L-40${2 + k}`, "backwash supply", "pipe", 600, "15UMB01", `15UFB${b}`, 0.05, { mode: "intermittent", pumped: true }),
    L(`RB-L-41${1 + k}`, "air scour", "pipe", 350, "15UMB01", `15UFB${b}`, 0, { causal: false, mode: "intermittent" }),
    L(`RB-L-42${1 + k}`, "dirty washwater", "channel", [1.0, 0.8], `15UFB${b}`, "17UGW01", 0.015, { mode: "intermittent" })]),
  L("RB-L-431", "supernatant return", "pipe", 250, "17UGW01", "11UGA01", 0.05, { recycle: true }),
  ...[1, 2, 3, 4].map((n) => L(`RB-L-44${n}`, "sludge", "pipe", 150, `14UGE0${n}`, "17UGT01", 0.005, { causal: false })),
  L("RB-L-501", "coagulant", "pipe", 25, "13UHA01", "11UGA01", 0, { injectionAt: "11UGA01" }),
  L("RB-L-502", "polymer", "pipe", 25, "12UHB01", "13UGD01", 0, { injectionAt: "13UGD01" }),
  L("RB-L-503", "lime", "pipe", 50, "12UHB01", "11UGA01", 0, { injectionAt: "11UGA01" }),
  L("RB-L-511", "chlorine (vacuum)", "pipe", 40, "16UHC01", "16UGH01", 0, { injectionAt: "16UGH01" }),
  L("RB-L-512", "chlorine (vacuum)", "pipe", 40, "16UHC01", "16UGH02", 0, { injectionAt: "16UGH02" })
];
// Rev B: filter media replacement on F01–F04 adds filter-to-waste lines and moves the washwater outlet.
const FTW = ["01", "02", "03", "04"].map((f) => L(`RB-L-6${f}`, "filter-to-waste", "pipe", 300, `15HFA${f}`, "17UGW01", 0, { mode: "intermittent" }));

// Instruments: [tag, historianTag, measuredAt, samplePosition, lagMin]
export const INSTRUMENTS = [
  ["10CQ01", "PROC.RAW-turb", "RB-L-001", "raw", 4], ["11CF01", "PROC.RAW-flow", "11UGA01", "inline", 0],
  ["15CQ00", "PROC.FW-turb", "16UGH01", "before dose", 5], ["16CQ01", "PROC.FIN-cl", "RB-L-301", "after dose", 6],
  ["16CQ02", "PROC.FIN-ph", "RB-L-301", "after dose", 6], ["20CL01", "PROC.RES-1-level", "20UBA01", "inline", 0],
  ["20CL02", "PROC.RES-2-level", "20UBA02", "inline", 0], ["20CF01", "PROC.OUT-flow", "20UMC01", "inline", 0],
  ...FILTERS.flatMap((f) => [[`15CQ${f}`, `15HFA${f}.TURB`, `RB-L-2${f}`, "outlet", 3], [`15CP${f}`, `15HFA${f}.HEADLOSS`, `15HFA${f}`, "inline", 0]]),
  ["15CQ13", "15HFA13.TURB", "RB-L-213", "outlet", 3]
];

const SHEETS = {
  "01": { title: "Raw water intake and inlet works", tags: ["10UPA01", "10UBA01", "10UBA02", "11UGA01"] },
  "02": { title: "Coagulant, polymer and lime dosing", tags: ["13UHA01", "12UHB01", "12UHB02", "12UHB03", "12UHB04"] },
  "03": { title: "Flash mix, flocculation and splitter", tags: ["13UGD01"] },
  "04": { title: "Typical clarifier and sludge draw", tags: ["14UGE01", "14UGE02", "14UGE03", "14UGE04", "17UGT01"] },
  "05": { title: "Typical rapid gravity filter (F01–F08)", tags: ["15UFB01", "15UFB02"] },
  "06": { title: "Backwash pumps, air-scour blowers, washwater recovery", tags: ["15UMB01", "17UGW01"] },
  "07": { title: "Gas chlorination, contact tank, clear-water reservoirs", tags: ["16UHC01", "16UGH01", "16UGH02", "20UBA01", "20UBA02"] },
  "08": { title: "High-lift pumping, surge vessel, outgoing main", tags: ["20UMC01"] }
};
export const sheetOf = (tag) => (/^15HFA/.test(tag) ? "05" : Object.keys(SHEETS).find((k) => SHEETS[k].tags.includes(tag)));

export const DRAWING_META = {
  "RB-GA-001": { kind: "ga", title: "Site general arrangement", revs: ["A", "B"] },
  "RB-HP-001": { kind: "hp", title: "Hydraulic profile", revs: ["A"] },
  "RB-PFD-001": { kind: "pfd", title: "Process flow diagram and mass balance", revs: ["A"] },
  "RB-LL-001": { kind: "ll", title: "Line list", revs: ["A", "B"] },
  "RB-EL-001": { kind: "el", title: "Equipment list", revs: ["A"] },
  "RB-IL-001": { kind: "il", title: "Instrument list", revs: ["A"] },
  ...Object.fromEntries(Object.entries(SHEETS).map(([n, s]) => [`RB-PID-${n}`, { kind: "pid", title: s.title, revs: n === "05" ? ["A", "B"] : ["A"] }]))
};

// ---------- geometry helpers ----------
const centre = (tag) => S[tag].centre;
const levelOf = (tag) => S[tag].twl ?? S[tag].baseLevel;
export const pathOf = (line) => {
  const [x1, y1] = centre(line.from), [x2, y2] = centre(line.to);
  const z = Math.round(Math.min(levelOf(line.from), levelOf(line.to)) * 10) / 10 - (line.conveyance === "pipe" ? 1 : 0);
  return [[x1, y1, z], [x2, y1, z], [x2, y2, z]];
};
const num = (v) => String(Math.round(v * 1000) / 1000);

// ---------- DXF ----------
const pairs = (list) => list.map(([c, v]) => `${c}\n${v}`).join("\n");
const insert = (block, layer, [x, y], attribs) => pairs([[0, "INSERT"], [8, layer], [2, block], [10, num(x)], [20, num(y)], [30, "0"], [66, "1"],
  ...Object.entries(attribs).flatMap(([k, v]) => [[0, "ATTRIB"], [8, layer], [10, num(x)], [20, num(y)], [2, k], [1, v]]), [0, "SEQEND"]]);
const poly = (layer, pts, { closed = false, elev = 0, tag } = {}) => pairs([[0, "LWPOLYLINE"], [8, layer], [90, pts.length], [70, closed ? 1 : 0], [38, num(elev)],
  ...pts.flatMap(([x, y]) => [[10, num(x)], [20, num(y)]]), ...(tag ? [[1001, "RBTAG"], [1000, tag]] : [])]);
const circle = (layer, [x, y], r) => pairs([[0, "CIRCLE"], [8, layer], [10, num(x)], [20, num(y)], [40, num(r)]]);
const dxfDoc = (number, rev, title, entities) => [
  pairs([[0, "SECTION"], [2, "HEADER"], [9, "$ACADVER"], [1, "AC1015"], [9, "$INSUNITS"], [70, "6"], [0, "ENDSEC"]]),
  pairs([[0, "SECTION"], [2, "TABLES"], [0, "TABLE"], [2, "LAYER"], ...["EQUIP", "BUILDING", "PIPE", "CHANNEL", "ROAD", "FENCE", "TITLE"].flatMap((n) => [[0, "LAYER"], [2, n], [70, "0"]]), [0, "ENDTAB"], [0, "ENDSEC"]]),
  pairs([[0, "SECTION"], [2, "ENTITIES"]]),
  insert("TITLE", "TITLE", [siteBounds()[0], siteBounds()[3] + 15], { DWGNO: number, REV: rev, TITLE: title, CRS: GEOREF.crs, ORIGIN: GEOREF.origin.join(","), ROT: String(GEOREF.rotationDeg) }),
  ...entities,
  pairs([[0, "ENDSEC"], [0, "EOF"]])
].join("\n") + "\n";

const BUILDINGS = new Set(["pump_house", "dosing_house", "chlorine_house", "chemical_store", "mcc", "lab", "admin", "gen_set", "workshop", "filter_building"]);
const outline = (s) => {
  const [x, y] = s.centre, w = s.w / 2, l = s.l / 2;
  return [[x - w, y - l], [x + w, y - l], [x + w, y + l], [x - w, y + l]];
};
function ga(rev) {
  const lines = rev === "B" ? [...LINES, ...FTW] : LINES;
  const ents = [];
  for (const s of STRUCTURES) {
    const layer = BUILDINGS.has(s.kind) ? "BUILDING" : "EQUIP";
    ents.push(s.diameter ? circle(layer, s.centre, s.diameter / 2) : poly(layer, outline(s), { closed: true, elev: s.baseLevel }));
    ents.push(insert("STRUCT", layer, s.centre, { TAG: s.tag, KIND: s.kind, BASE: num(s.baseLevel), HEIGHT: num(s.height), ...(s.diameter ? { DIA: num(s.diameter) } : { W: num(s.w), L: num(s.l) }), ...(s.twl != null ? { TWL: num(s.twl) } : {}), ...(s.volumeM3 ? { VOL: num(s.volumeM3) } : {}) }));
  }
  for (const m of MACHINES) ents.push(insert("MACHINE", "EQUIP", centre(m.structureTag), { TAG: m.positionTag, STRUCT: m.structureTag, OX: num(m.offset[0]), OY: num(m.offset[1]), OZ: num(m.offset[2]) }));
  const bw = S["17UGW01"];
  ents.push(insert("STRUCT", "EQUIP", [bw.centre[0] + 15, bw.centre[1]], { TAG: "17BBB01", KIND: "sump", BASE: num(bw.baseLevel - 2), HEIGHT: "2", W: "3", L: "3" }));
  for (const l of lines) {
    let p = pathOf(l);
    // rev B moves the washwater outlet onto the other elbow; the old route stays on the GA as RB-L-421X
    if (rev === "B" && l.line === "RB-L-421") p = [p[0], [p[0][0], p[2][1], p[0][2]], p[2]];
    ents.push(poly(l.conveyance === "pipe" ? "PIPE" : "CHANNEL", p.map(([x, y]) => [x, y]), { elev: p[0][2], tag: l.line }));
  }
  if (rev === "B") { const p = pathOf(LINES.find((l) => l.line === "RB-L-421")); ents.push(poly("PIPE", p.map(([x, y]) => [x, y]), { elev: p[0][2], tag: "RB-L-421X" })); }
  const ring = (m) => { const [x0, y0, x1, y1] = siteBounds(); return [[x0 - m, y0 - m], [x1 + m, y0 - m], [x1 + m, y1 + m], [x0 - m, y1 + m]]; };
  ents.push(poly("ROAD", ring(5), { closed: true }), poly("FENCE", ring(10), { closed: true }));
  return dxfDoc("RB-GA-001", rev, DRAWING_META["RB-GA-001"].title, ents);
}
function hp() {
  const ents = STRUCTURES.filter((s) => s.twl != null).map((s) => insert("LEVEL", "EQUIP", s.centre, { TAG: s.tag, TWL: num(s.twl), FLOOR: num(s.baseLevel) }));
  return dxfDoc("RB-HP-001", "A", DRAWING_META["RB-HP-001"].title, ents);
}

// ---------- DEXPI subset ----------
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const attrs = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
const header = (number, rev, title) => `<?xml version="1.0" encoding="UTF-8"?>\n<PlantModel${attrs({ SchemaVersion: "DEXPI-1.3-subset", Number: number, Revision: rev, Title: title })}>\n`;
const ga_ = (name, value) => `<GenericAttribute${attrs({ Name: name, Value: value })}/>`;
const segment = (l, extra = "") => `  <PipingNetworkSegment${attrs({ ID: `SEG-${l.line}`, LineNumber: l.line })}><GenericAttributes>${ga_("Service", l.service)}${ga_("NominalDiameter", l.dn ?? "")}${extra}</GenericAttributes><Connection${attrs({ FromID: `EQ-${l.from}`, ToID: `EQ-${l.to}` })}/></PipingNetworkSegment>\n`;
const VALVES = [["inlet", "ButterflyValve"], ["outlet", "ControlValve"], ["drain", "GateValve"], ["backwash", "ButterflyValve"], ["air", "ButterflyValve"], ["waste", "GateValve"]];

function pid(n, rev) {
  const number = `RB-PID-${n}`, sheet = SHEETS[n];
  let x = header(number, rev, sheet.title);
  for (const tag of sheet.tags) {
    const s = S[tag];
    x += `  <Equipment${attrs({ ID: `EQ-${tag}`, TagName: tag, ComponentClass: s.kind })}><GenericAttributes>${ga_("KKS", tag)}</GenericAttributes><Nozzle ID="N-${tag}-1"/></Equipment>\n`;
    for (const m of MACHINES.filter((mm) => mm.structureTag === tag)) x += `  <Equipment${attrs({ ID: `EQ-${m.positionTag}`, TagName: m.positionTag, ComponentClass: "machine" })}><GenericAttributes>${ga_("InStructure", tag)}</GenericAttributes></Equipment>\n`;
  }
  if (n === "05") {
    x += `  <Equipment${attrs({ ID: "EQ-15HFA##", TagName: "15HFA##", ComponentClass: "filter_bed", Typical: "yes" })}><Nozzle ID="N-15HFA##-1"/></Equipment>\n`;
    x += segment({ line: "RB-L-1##", service: "settled", dn: 450, from: "15UFB01", to: "15HFA##" }) + segment({ line: "RB-L-2##", service: "filtered", dn: 450, from: "15HFA##", to: "16UGH01" });
    for (const [k, cls] of VALVES) x += `  <PipingComponent${attrs({ ComponentClass: cls, TagName: `15AA##-${k}`, Typical: "yes" })}/>\n`;
    if (rev === "B") x += segment({ line: "RB-L-6##", service: "filter-to-waste", dn: 300, from: "15HFA##", to: "17UGW01" }, ga_("Mode", "intermittent")) + `  <PipingComponent${attrs({ ComponentClass: "NozzleLateralUnderdrain", TagName: "15UD##", Typical: "yes" })}/>\n`;
    x += "  <TagTable>\n" + FILTERS.map((f) => `    <TagRow${attrs({ Filter: `F${f}`, Tag: `15HFA${f}`, Inlet: `RB-L-1${f}`, Outlet: `RB-L-2${f}`, FilterToWaste: rev === "B" && Number(f) <= 4 ? "yes" : "no" })}/>\n`).join("") + "  </TagTable>\n";
  }
  for (const l of LINES.filter((ll) => sheetOf(ll.from) === n && !/^RB-L-[12]\d\d$/.test(ll.line))) x += segment(l);
  for (const [tag, , at] of INSTRUMENTS.filter(([, , at]) => sheetOf(at) === n || sheetOf((LINES.find((l) => l.line === at) || {}).from) === n)) {
    if (/^15C[QP]\d\d$/.test(tag) && tag !== "15CQ00") continue; // filter instruments are on the typical's tag table
    x += `  <ProcessInstrumentationFunction${attrs({ TagName: tag })}><GenericAttributes>${ga_("KKS", tag)}${ga_("MeasuredAt", at)}</GenericAttributes></ProcessInstrumentationFunction>\n`;
  }
  return x + "</PlantModel>\n";
}
function pfd() {
  let x = header("RB-PFD-001", "A", DRAWING_META["RB-PFD-001"].title);
  for (const l of LINES.filter((ll) => ll.causal && !ll.injectionAt)) x += `  <Stream${attrs({ ID: l.line, From: l.from, To: l.to, DesignFlowM3h: num(l.share * Q), SplitFraction: num(l.share), Recycle: l.recycle ? "yes" : "no", Mode: l.mode })}/>\n`;
  return x + "</PlantModel>\n";
}

// ---------- CSV lists ----------
const csv = (head, rows) => [head, ...rows].map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";
const ll = (rev) => csv(["Line", "Service", "Conveyance", "DN", "Width", "Depth", "From", "To", "Mode", "Causal", "Recycle", "InjectionAt", "Pumped"],
  (rev === "B" ? [...LINES, ...FTW] : LINES).map((l) => [l.line, l.service, l.conveyance, l.dn ?? "", l.width ?? "", l.depth ?? "", l.from, l.to, l.mode, l.causal ? "yes" : "no", l.recycle ? "yes" : "no", l.injectionAt ?? "", l.pumped ? "yes" : "no"]));
const el = () => csv(["Tag", "Kind", "Zone", "Structure", "Description"], [
  ...STRUCTURES.map((s) => [s.tag, s.kind, s.zoneId, "", s.kind.replace(/_/g, " ")]),
  ...MACHINES.map((m) => [m.positionTag, "machine", S[m.structureTag].zoneId, m.structureTag, "installed position"])]);
const il = () => csv(["Tag", "HistorianTag", "MeasuredAt", "SamplePosition", "LagMin"], INSTRUMENTS);

export function drawingSet(rev = "A") {
  const r = (n) => (DRAWING_META[n].revs.includes(rev) ? rev : "A");
  return {
    [`RB-GA-001_${r("RB-GA-001")}.dxf`]: ga(r("RB-GA-001")),
    "RB-HP-001_A.dxf": hp(),
    "RB-PFD-001_A.xml": pfd(),
    [`RB-LL-001_${r("RB-LL-001")}.csv`]: ll(r("RB-LL-001")),
    "RB-EL-001_A.csv": el(),
    "RB-IL-001_A.csv": il(),
    ...Object.fromEntries(Object.keys(SHEETS).map((n) => [`RB-PID-${n}_${r(`RB-PID-${n}`)}.xml`, pid(n, r(`RB-PID-${n}`))]))
  };
}
