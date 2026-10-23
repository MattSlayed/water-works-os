// Physical layout of the synthetic Riverbend works, sized for 120 ML/d (design §4.2). Site metres: x east, y south.
// The drawing generators (src/drawings/make.mjs) draw from these constants; the released plant model is then the source.
// Levels are metres above datum; top water level (twl) falls by gravity from the inlet works to the clear-water reservoir.

export const GEOREF = { crs: "EPSG:4326", origin: [-25.86, 28.62], rotationDeg: 0 };

// [id, name, x, y, w, h, clearance, hazard]
export const ZONES = [
  ["Z01", "Raw water intake and pump station", 0, 40, 70, 60, "technician", "none"],
  ["Z02", "Inlet works", 80, 40, 60, 60, "technician", "none"],
  ["Z03", "Coagulation and flocculation", 150, 30, 90, 80, "technician", "chemical"],
  ["Z04", "Clarification", 250, 0, 110, 110, "technician", "none"],
  ["Z05", "Filtration", 370, 0, 90, 110, "technician", "none"],
  ["Z06", "Disinfection", 470, 0, 80, 70, "supervisor", "chlorine"],
  ["Z07", "Clear water and high-lift", 560, 0, 200, 120, "technician", "none"],
  ["Z08", "Sludge handling", 250, 120, 110, 60, "technician", "confined-space"],
  ["Z09", "Chemical store", 150, 120, 90, 50, "operator", "chemical"],
  ["Z10", "MCC and electrical", 370, 120, 70, 50, "supervisor", "electrical"],
  ["Z11", "Laboratory", 450, 120, 50, 50, "technician", "none"],
  ["Z12", "Admin and control room", 510, 130, 90, 50, "technician", "none"]
];

const rect = (tag, kind, zoneId, cx, cy, w, l, extra = {}) => ({ tag, kind, zoneId, centre: [cx, cy], w, l, ...extra });
const round = (tag, kind, zoneId, cx, cy, d, extra = {}) => ({ tag, kind, zoneId, centre: [cx, cy], diameter: d, ...extra });

const filters = Array.from({ length: 12 }, (_, i) => {
  const row = i < 6 ? 0 : 1, col = i % 6;
  return rect(`15HFA${String(i + 1).padStart(2, "0")}`, "filter_bed", "Z05", 389 + col * 8, row ? 44.5 : 25.5, 7, 11, { baseLevel: 1456.4, height: 4.6, twl: 1460.4, volumeM3: 308 });
});

export const STRUCTURES = [
  rect("10UPA01", "pump_house", "Z01", 35, 70, 20, 14, { baseLevel: 1452, height: 7 }),
  rect("11UGA01", "inlet_works", "Z02", 100, 70, 10, 20, { baseLevel: 1460, height: 2.5, twl: 1462.0, volumeM3: 400 }),
  rect("11GAB01", "parshall_flume", "Z02", 122, 70, 4, 20, { baseLevel: 1460.2, height: 1.8, twl: 1461.8 }),
  rect("13UGB01", "flash_mix", "Z03", 162, 70, 3, 3, { baseLevel: 1458.6, height: 3.4, twl: 1461.6, volumeM3: 27 }),
  rect("13UGC01", "flocculator", "Z03", 200, 70, 50, 13, { baseLevel: 1457.2, height: 4.4, twl: 1461.2, volumeM3: 2600 }),
  rect("13UGD01", "splitter", "Z03", 232, 50, 8, 8, { baseLevel: 1457.5, height: 4, twl: 1461.0 }),
  rect("13UHA01", "dosing_house", "Z03", 168, 45, 10, 8, { baseLevel: 1460, height: 4 }),
  round("14UGE01", "clarifier_circular", "Z04", 280, 28, 32, { baseLevel: 1456.3, height: 4.8, twl: 1460.8, volumeM3: 3619 }),
  round("14UGE02", "clarifier_circular", "Z04", 330, 28, 32, { baseLevel: 1456.3, height: 4.8, twl: 1460.8, volumeM3: 3619 }),
  round("14UGE03", "clarifier_circular", "Z04", 280, 78, 32, { baseLevel: 1456.3, height: 4.8, twl: 1460.8, volumeM3: 3619 }),
  round("14UGE04", "clarifier_circular", "Z04", 330, 78, 32, { baseLevel: 1456.3, height: 4.8, twl: 1460.8, volumeM3: 3619 }),
  ...filters,
  rect("15UGS01", "channel", "Z05", 380, 60, 4, 40, { baseLevel: 1458.6, height: 2.4, twl: 1460.6 }),
  rect("15UGG01", "pipe_gallery", "Z05", 409, 35, 48, 8, { baseLevel: 1455.5, height: 4 }),
  rect("15UMB01", "pump_house", "Z05", 446, 70, 18, 12, { baseLevel: 1456, height: 6 }),
  rect("16UHC01", "chlorine_house", "Z06", 488, 14, 16, 12, { baseLevel: 1457, height: 5 }),
  rect("16UGH01", "contact_tank", "Z06", 507, 46, 35, 22, { baseLevel: 1452.1, height: 4.8, twl: 1456.6, volumeM3: 3465 }),
  rect("20UBA01", "reservoir_covered", "Z07", 605, 45, 60, 60, { baseLevel: 1450.6, height: 6, twl: 1456.1, volumeM3: 20000 }),
  rect("20UBA02", "reservoir_covered", "Z07", 695, 45, 60, 60, { baseLevel: 1450.6, height: 6, twl: 1456.1, volumeM3: 20000 }),
  rect("20UMC01", "pump_house", "Z07", 640, 102, 30, 14, { baseLevel: 1449, height: 8 }),
  round("20UMD01", "surge_vessel", "Z07", 672, 102, 4, { baseLevel: 1449, height: 9 }),
  rect("17UGW01", "washwater_tank", "Z08", 280, 150, 30, 20, { baseLevel: 1455, height: 3.5, volumeM3: 1500 }),
  round("17UGT01", "thickener", "Z08", 330, 150, 18, { baseLevel: 1454, height: 4, volumeM3: 1000 }),
  rect("17UMD01", "pump_house", "Z08", 305, 170, 8, 6, { baseLevel: 1454, height: 4 }),
  rect("12UHB01", "chemical_store", "Z09", 195, 145, 30, 18, { baseLevel: 1460, height: 7 }),
  rect("30UBE01", "mcc", "Z10", 395, 140, 24, 12, { baseLevel: 1458, height: 5 }),
  rect("30UBG01", "gen_set", "Z10", 425, 158, 12, 4, { baseLevel: 1458, height: 3 }),
  rect("40UYL01", "lab", "Z11", 475, 145, 20, 14, { baseLevel: 1458, height: 4.5 }),
  rect("40UYA01", "admin", "Z12", 555, 155, 30, 16, { baseLevel: 1458, height: 7 })
];

// Machine positions placed inside structures: offset from the structure centre [x, y, z above base].
const row = (tags, structureTag, dx, y, z = 0.5) => tags.map((t, i) => ({ positionTag: t, structureTag, offset: [-((tags.length - 1) * dx) / 2 + i * dx, y, z], rotDeg: 0 }));
export const MACHINES = [
  ...row(["RWP-A", "RWP-B", "RWP-C"], "10UPA01", 5, 0),
  ...row(["DP-1", "DP-2"], "13UHA01", 3, 0),
  { positionTag: "CL-1", structureTag: "14UGE01", offset: [0, 0, 4.8], rotDeg: 0 },
  { positionTag: "CL-2", structureTag: "14UGE02", offset: [0, 0, 4.8], rotDeg: 0 },
  { positionTag: "CL-3", structureTag: "14UGE03", offset: [0, 0, 4.8], rotDeg: 0 },
  { positionTag: "CL-4", structureTag: "14UGE04", offset: [0, 0, 4.8], rotDeg: 0 },
  ...row(["BWP-A", "BWP-B"], "15UMB01", 4, -2.5),
  ...row(["BLW-A", "BLW-B"], "15UMB01", 4, 2.5),
  ...row(["CHL-A", "CHL-B"], "16UHC01", 4, 0, 0.8),
  ...row(["HLP-A", "HLP-B", "HLP-C", "HLP-D"], "20UMC01", 6, 0),
  ...row(["SLP-A"], "17UMD01", 0, 0),
  ...row(["GEN-1"], "30UBG01", 0, 0)
];

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
