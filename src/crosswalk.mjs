// Old-id -> new-id crosswalk and ISA-style sensor tags for the Riverbend canonical plant.

const LETTERS = {
  turb: "AIT", cl: "AIT", ph: "AIT", flow: "FIT", in: "FIT", out: "FIT", headloss: "PDT", level: "LIT", press: "PIT",
  temp_de: "TT", temp: "TT", temp_dis: "TT", vib_de: "VT", vib: "VT", current: "IT", torque: "WT", stroke: "ZT", pos: "ZT", state: "YS"
};
const OVERRIDES = {
  "SEN-RAW-turb": "AIT-101", "SEN-RAW-flow": "FIT-102", "SEN-DP-2-flow": "FIT-201", "SEN-CLR-turb": "AIT-301",
  "SEN-F07-turb": "AIT-157", "SEN-F07-headloss": "PDT-157", "SEN-FIN-cl": "AIT-401", "SEN-RES-2-level": "LIT-501", "SEN-HLP-B-temp_de": "TT-612"
};
const AREA = { Z01: 1, Z02: 2, Z03: 2, Z04: 3, Z06: 4, Z08: 7, Z09: 2, Z10: 6 };

// Old ids in today's generateWorks()/region data, expanded from the spec's wildcard families.
const FILTERS_GONE = ["09", "10", "11", "12"].flatMap((n) => [`POS-F${n}`, `AST-FLT-F${n}`, `SEN-F${n}-turb`, `SEN-F${n}-headloss`]);
const CR = [1, 2].flatMap((n) => [[`RS-RES${n}`, `RS-CR${n}`], ...["level", "in", "out"].map((k) => [`SEN-RES${n}-${k}`, `SEN-CR${n}-${k}`])]);
export const RENAMES = [
  ...FILTERS_GONE.map((id) => [id, null]),
  ["RES-CWR1", "AST-RES-1"], ["RES-CWR2", "AST-RES-2"],
  ["SEN-CWR1-level", "SEN-RES-1-level"], ["SEN-CWR2-level", "SEN-RES-2-level"],
  ...CR,
  ["PRJ-CL3", "PRJ-CL4"], ["CHN-GRP-CL3", "CHN-GRP-CL4"]
];
export const RETIRED = RENAMES.filter(([, n]) => n === null).map(([o]) => o);

const NEW_ID = new Map(RENAMES.filter(([, n]) => n));
const isFilter = (s) => /^SEN-F\d\d-/.test(s.id);
const canon = (s) => NEW_ID.get(s.id) ?? s.id;

// First tag number for a sensor. Z05 filtration owns the 15x block (bays 151-158); other Z05 sensors number from 160.
function firstNumber(s) {
  const z = /^Z(\d\d)$/.exec(s.zoneId ?? "");
  // remote = no zone, or a zone outside the on-site Z01-Z12 (bulk-line sites are Z13-Z15)
  if (!z || +z[1] > 12) return 801;
  if (s.zoneId === "Z05") return 160;
  if (s.zoneId === "Z07") return /^SEN-(HLP-|OUT-)/.test(s.id) || s.processUnitId === "PU-pumping" ? 601 : 501;
  if (!AREA[s.zoneId]) throw new Error(`No area digit for zone ${s.zoneId} (sensor ${s.id})`);
  return AREA[s.zoneId] * 100 + 1;
}

export function isaTag(s, used) {
  const letters = LETTERS[s.key];
  if (!letters) throw new Error(`Sensor ${s.id}: no ISA letters for key "${s.key}"`);
  let tag = OVERRIDES[canon(s)];
  if (!tag && isFilter(s)) {
    const bay = +/^SEN-F(\d\d)-/.exec(s.id)[1];
    if (bay > 9) throw new Error(`Filter bay ${bay} does not fit the 15<bay> rule (sensor ${s.id})`);
    tag = `${letters}-15${bay}`;
  }
  if (!tag) {
    for (let n = firstNumber(s); used.has((tag = `${letters}-${n}`)); n++);
  }
  used.add(tag);
  return tag;
}

// Overrides first, then filters, then area numbering in sorted id order. Retired sensors get no tag.
export function assignTags(sensors) {
  const rank = (s) => (OVERRIDES[canon(s)] ? 0 : isFilter(s) ? 1 : 2);
  const order = sensors.filter((s) => !RETIRED.includes(s.id)).sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
  const used = new Set();
  return new Map(order.map((s) => [s.id, isaTag(s, used)]));
}
