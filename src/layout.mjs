// Physical layout of the synthetic Riverbend works at a nominal 100 ML/d, built from the 3D scene (data/riverbend/scene-meta.json).
// Site metres: x east, y south; levels are metres above datum. The drawing generators (src/drawings/make.mjs) draw from these
// constants; the released plant model is then the source.
import { readFileSync } from "node:fs";

export const GEOREF = { crs: "EPSG:4326", origin: [-25.86, 28.62], rotationDeg: 0 };
export const CAPACITY_MLD = 100;

// [id, name, x, y, w, h, clearance, hazard], hand-drawn around the scene footprints. Only centres are guaranteed inside.
export const ZONES = [
  ["Z01", "Raw water intake and pump station", 820, 205, 65, 45, "technician", "none"],
  ["Z02", "Inlet works", 815, 520, 15, 15, "technician", "none"],
  ["Z03", "Coagulation and flocculation", 800, 535, 30, 15, "technician", "chemical"],
  ["Z04", "Clarification", 788, 470, 70, 50, "technician", "none"],
  ["Z05", "Filtration", 788, 425, 70, 45, "technician", "none"],
  ["Z06", "Disinfection", 765, 400, 23, 45, "supervisor", "chlorine"],
  ["Z07", "Clear water and high-lift", 765, 290, 71, 110, "technician", "none"],
  ["Z08", "Sludge handling", 820, 400, 90, 25, "technician", "confined-space"],
  ["Z09", "Chemical store", 800, 550, 30, 10, "operator", "chemical"],
  ["Z10", "MCC and electrical", 836, 290, 50, 40, "supervisor", "electrical"],
  ["Z11", "Laboratory", 778.6, 520, 21.4, 21, "technician", "none"], // the northern half of ADM-1's east third
  ["Z12", "Admin and control room", 730, 541, 70, 90, "technician", "none"]
];

// 3D asset id -> WaterOS structure. `from` takes one scene object instead of the union of the asset's objects.
// Three rows moved from the plan's zones because the scene's footprints made non-overlapping axis-aligned zones impossible
// otherwise: RWR-1/2 lie 370 m from RWP-1 (Z12, not Z01); DB-1 sits between the four clarifiers (Z04, not Z03); WKS-1 sits
// beside ELB-1 (Z10, not Z12).
const n2 = (n) => String(n).padStart(2, "0");
export const PLAN = {
  "RWP-1": { tag: "10UPA01", kind: "pump_house", zoneId: "Z01" },
  "RWR-1": { tag: "10UBA01", kind: "reservoir_covered", zoneId: "Z12", round: true },
  "RWR-2": { tag: "10UBA02", kind: "reservoir_covered", zoneId: "Z12", round: true },
  MIX: { tag: "11UGA01", kind: "inlet_works", zoneId: "Z02" },
  "DB-1": { tag: "13UGD01", kind: "splitter", zoneId: "Z04" },
  "DOS-1": { tag: "13UHA01", kind: "dosing_house", zoneId: "Z03" },
  ...Object.fromEntries([1, 2, 3, 4].map((i) => [`T-20${i}`, { tag: `12UHB0${i}`, kind: "chemical_tank", zoneId: "Z09", round: true }])),
  ...Object.fromEntries([1, 2, 3, 4].map((i) => [`CL-${i}`, { tag: `14UGE0${i}`, kind: "clarifier_circular", zoneId: "Z04", round: true }])),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((i) => [`F${n2(i)}`, { tag: `15HFA${n2(i)}`, kind: "filter_bed", zoneId: "Z05", from: `F${n2(i)}_Water` }])),
  "FB-1": { tag: "15UFB01", kind: "filter_building", zoneId: "Z05" },
  "FB-2": { tag: "15UFB02", kind: "filter_building", zoneId: "Z05" },
  // the contact tanks are the slabs under the filter buildings
  "CCT-1": { tag: "16UGH01", kind: "contact_tank", zoneId: "Z05" },
  "CCT-2": { tag: "16UGH02", kind: "contact_tank", zoneId: "Z05" },
  "FPR-1": { tag: "15UMB01", kind: "pump_house", zoneId: "Z05" },
  "CLB-1": { tag: "16UHC01", kind: "chlorine_house", zoneId: "Z06" },
  "RES-1": { tag: "20UBA01", kind: "reservoir_covered", zoneId: "Z07", round: true },
  "RES-2": { tag: "20UBA02", kind: "reservoir_covered", zoneId: "Z07", round: true },
  "HLP-H": { tag: "20UMC01", kind: "pump_house", zoneId: "Z07" },
  "BWR-1": { tag: "17UGW01", kind: "washwater_tank", zoneId: "Z08" },
  "SLD-1": { tag: "17UGT01", kind: "thickener", zoneId: "Z08", round: true },
  "ELB-1": { tag: "30UBE01", kind: "mcc", zoneId: "Z10" },
  "ADM-1": { tag: "40UYA01", kind: "admin", zoneId: "Z12" },
  "WKS-1": { tag: "40UYW01", kind: "workshop", zoneId: "Z10" }
};
// A filter building is its pipe gallery, the contact-tank slab it stands on and its four filter beds.
const WITH = { "FB-1": ["CCT-1", "F01", "F02", "F03", "F04"], "FB-2": ["CCT-2", "F05", "F06", "F07", "F08"] };

const SCENE = JSON.parse(readFileSync(new URL("../data/riverbend/scene-meta.json", import.meta.url), "utf8")).objects;
const r2 = (v) => Math.round(v * 100) / 100;
const objectsOf = (assets) => Object.entries(SCENE).filter(([, o]) => assets.includes(o.asset)).map(([name, o]) => ({ name, asset: o.asset, ...o.site }));

function structure(asset, p) {
  const objs = p.from ? [{ name: p.from, asset, ...SCENE[p.from]?.site }] : objectsOf([asset, ...(WITH[asset] ?? [])]);
  if (!objs.length || objs.some((o) => o.cx == null)) throw new Error(`scene-meta has no objects for ${asset}`);
  const lo = (k, d) => Math.min(...objs.map((o) => o[k] - o[d] / 2)), hi = (k, d) => Math.max(...objs.map((o) => o[k] + o[d] / 2));
  const [x0, x1, y0, y1] = [lo("cx", "w"), hi("cx", "w"), lo("cy", "l"), hi("cy", "l")];
  const zMin = Math.min(...objs.map((o) => o.zMin)), zMax = Math.max(...objs.map((o) => o.zMax));
  const s = { tag: p.tag, kind: p.kind, zoneId: p.zoneId, centre: [r2((x0 + x1) / 2), r2((y0 + y1) / 2)] };
  if (p.round) s.diameter = r2(Math.max(x1 - x0, y1 - y0));
  else Object.assign(s, { w: r2(x1 - x0), l: r2(y1 - y0) });
  Object.assign(s, { baseLevel: r2(zMin), height: r2(zMax - zMin) });
  // RES-1/2 are roofed and have no water mesh: their twl is the wall top. CL-4 is drained for refurbishment, so it has no twl.
  const own = objs.filter((o) => o.asset === asset), water = own.find((o) => o.name.endsWith("_Water")) ?? (p.kind === "reservoir_covered" ? own.find((o) => o.name.endsWith("_Wall")) : null);
  if (water) {
    const area = p.round ? (Math.PI * water.w * water.w) / 4 : water.w * water.l;
    Object.assign(s, { twl: r2(water.zMax), volumeM3: Math.round(area * (water.zMax - s.baseLevel)) });
  }
  return s;
}
export const STRUCTURES = Object.entries(PLAN).map(([asset, p]) => structure(asset, p));
const S = Object.fromEntries(STRUCTURES.map((s) => [s.tag, s]));

// Machine positions placed inside structures: offset from the structure centre [x, y, z above base].
const row = (tags, structureTag, dx, y, z = 0.5) => tags.map((t, i) => ({ positionTag: t, structureTag, offset: [-((tags.length - 1) * dx) / 2 + i * dx, y, z], rotDeg: 0 }));
export const MACHINES = [
  ...row(["RWP-A", "RWP-B", "RWP-C"], "10UPA01", 5, 0),
  ...row(["DP-1", "DP-2"], "13UHA01", 3, 0),
  ...[1, 2, 3, 4].map((i) => ({ positionTag: `CL-${i}`, structureTag: `14UGE0${i}`, offset: [0, 0, S[`14UGE0${i}`].height], rotDeg: 0 })),
  ...row(["BWP-A", "BWP-B"], "15UMB01", 4, -2.5),
  ...row(["BLW-A", "BLW-B"], "15UMB01", 4, 2.5),
  ...row(["CHL-A", "CHL-B"], "16UHC01", 4, 0, 0.8),
  ...["A", "B", "C", "D", "E"].map((k, i) => ({ positionTag: `HLP-${k}`, structureTag: "20UMC01", offset: [[-11.2, -6.72, -2.24, 2.24, 6.72][i], -0.3, 0.3], rotDeg: 0 })),
  { positionTag: "SLP-A", structureTag: "17UGT01", offset: [S["17UGT01"].diameter / 2 + 1.5, 0, 0], rotDeg: 0 },
  ...row(["GEN-1"], "30UBE01", 0, 0)
];

// Scene assets that are neither a structure nor a machine position (the river, the delivery header, the gatehouse ...).
export const LAYOUT_SKIPPED = [...new Set(Object.values(SCENE).map((o) => o.asset))].filter((a) => !(a in PLAN) && !MACHINES.some((m) => m.positionTag === a)).sort();

export function siteBounds() {
  const xs = ZONES.flatMap(([, , x, , w]) => [x, x + w]), ys = ZONES.flatMap(([, , , y, , h]) => [y, y + h]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Local flat-earth projection from site metres to WGS84 (good to centimetres over a 1 km site).
export function toLonLat([x, y]) {
  const [lat0, lon0] = GEOREF.origin;
  return [lon0 + x / (111320 * Math.cos((lat0 * Math.PI) / 180)), lat0 - y / 111320];
}

// The inverse of toLonLat: WGS84 [lon, lat] to site metres. Region-scale geometry (tens of km) stays within metres.
export function toLocal([lon, lat]) {
  const [lat0, lon0] = GEOREF.origin;
  return [(lon - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180), (lat0 - lat) * 111320];
}
