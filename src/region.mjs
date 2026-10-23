// The region around the synthetic Riverbend works (Region design §4): catchment, dam, river, raw-water main, bulk line,
// roads, areas of interest and the remote zones. Laid out in site metres (x east, y south) and converted to WGS84.
// Synthetic works: none of this is a real place.
import { toLonLat } from "./layout.mjs";

const DIR = [Math.SQRT1_2, Math.SQRT1_2]; // the dam's long axis, NW → SE
const ACROSS = [-Math.SQRT1_2, Math.SQRT1_2];
const DAM = { c: [-2500, -3000], a: 2400, b: 850 };
const at = (u, v, c = DAM.c) => [c[0] + u * DIR[0] + v * ACROSS[0], c[1] + u * DIR[1] + v * ACROSS[1]];
// an ellipse along the dam axis, centred u0 along it: ring in site metres
const ellipse = (u0, a, b, n = 32) => Array.from({ length: n + 1 }, (_, i) => { const t = (2 * Math.PI * (i % n)) / n; return at(u0 + a * Math.cos(t), b * Math.sin(t)); });
const ll = (pts) => pts.map(toLonLat);
const poly = (pts) => ({ type: "Polygon", coordinates: [ll(pts)] });
const line = (pts) => ({ type: "LineString", coordinates: ll(pts) });

export const INTAKE_XY = at(DAM.a, 0); // the SE tip of the dam, by the wall
export const SLIPWAY_XY = at(0, DAM.b);
export const BULK_LINE = [[760, 90], [3000, 300], [6000, 200], [9000, 600], [11500, 500]];
export const SITE_XY = { "RS-PS1": [3000, 300], "RS-RES1": [6000, 200], "RS-PS2": [8000, 466.7], "RS-RES2": [11500, 500], "RS-VC1": [1800, 187.5], "RS-VC2": [4500, 250], "RS-VC3": [10200, 552] };

export const REGION = [
  { id: "CAT-RB", kind: "catchment", name: "Riverbend catchment (synthetic)", geometry: poly([[-12300, -9400], [-11800, -9900], [-500, -9900], [0, -9400], [0, 2100], [-500, 2600], [-11800, 2600], [-12300, 2100], [-12300, -9400]]) },
  { id: "WB-RB", kind: "waterbody", name: "Riverbend Dam (synthetic)", geometry: poly(ellipse(0, DAM.a, DAM.b, 48)) },
  { id: "RIV-RB", kind: "river", name: "Riverbend River", geometry: line([[-10500, -9000], [-8000, -7800], [-6500, -6900], [-5200, -5600], at(-DAM.a, 0)]) },
  { id: "INT-RB", kind: "intake", name: "Raw-water intake tower", geometry: { type: "Point", coordinates: toLonLat(INTAKE_XY) } },
  { id: "RWM-RB", kind: "main", name: "Raw-water main", geometry: line([INTAKE_XY, [-400, -600], [35, 70]]) },
  { id: "BLK-RB", kind: "pipeline", name: "Bulk treated-water line", geometry: line(BULK_LINE) },
  { id: "RD-1", kind: "road", name: "Bulk-line service road", geometry: line([[600, 190], [600, 1200], [11000, 1200], [11500, 620]]) },
  { id: "RD-2", kind: "road", name: "Dam wall road", geometry: line([[0, 100], [-500, -700], [-900, -1350]]) },
  { id: "RD-3", kind: "road", name: "Slipway road", geometry: line([[-900, -1350], [-1800, -1600], SLIPWAY_XY]) },
  { id: "AOI-INFLOW", kind: "aoi", name: "Dam inflow arm", geometry: poly(ellipse(-1500, 450, 300)) },
  { id: "AOI-INTAKE", kind: "aoi", name: "Intake approach", geometry: poly(ellipse(1900, 250, 150)) },
  { id: "AOI-DAM", kind: "aoi", name: "Whole dam", geometry: poly(ellipse(0, DAM.a * 0.95, DAM.b * 0.95, 48)) }
];

// [id, name, clearance, hazard, rects (site metres)]: a remote zone covers several yards, so it has rects, not one rect.
export const REMOTE_ZONES = [
  ["Z13", "Bulk line and valve chambers", "technician", "none", [[760, -100, 2240, 500], [3000, -100, 3000, 500], [6000, 0, 3000, 800], [9000, 200, 2500, 600]]],
  ["Z14", "Pump station and reservoir yards", "technician", "none", [[2940, 240, 120, 120], [5900, 100, 200, 200], [7920, 390, 160, 160], [11380, 380, 240, 240]]],
  ["Z15", "PS-2 MCC room", "supervisor", "electrical", [[8030, 400, 20, 15]]]
];

const corners = ([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
export const zoneGeo = (rects) => rects.map((r) => ll(corners(r)));

// The zone a site-metre point falls in: the smallest remote zone first (Z15 sits inside Z14), then the plant zones.
export function zoneAtLocal([x, y], plantZones) {
  const inR = ([zx, zy, w, h]) => x >= zx && x <= zx + w && y >= zy && y <= zy + h;
  for (const [id, , , , rects] of [...REMOTE_ZONES].reverse()) if (rects.some(inR)) return id;
  const z = plantZones.find(([, , zx, zy, w, h]) => inR([zx, zy, w, h]));
  return z ? z[0] : null;
}

// Remote fixed sites on the bulk line (Region design §4.2): [id, kind, name, capacityMl, sensors [key, name, unit, alarmLo, alarmHi, zoneId?]].
const PS = (n) => [["flow", "Discharge flow", "ML/d", null, null], ["press", "Discharge pressure", "bar", 3, 8], ["state", "Duty pump running", "on/off", null, null, n === 2 ? "Z15" : null]];
const VC = [["press", "Line pressure", "bar", 3, 8], ["pos", "Valve position", "%", null, null]];
const RES = [["level", "Level", "%", 30, null], ["in", "Inflow", "ML/d", null, null], ["out", "Outflow", "ML/d", null, null]];
export const REMOTE_SITES = [
  ["RS-PS1", "pump_station", "PS-1 booster pump station", null, PS(1)],
  ["RS-PS2", "pump_station", "PS-2 booster pump station", null, PS(2)],
  ["RS-RES1", "reservoir", "RES-1 command reservoir", 40, RES],
  ["RS-RES2", "reservoir", "RES-2 town reservoir (two cells)", 30, RES],
  ["RS-VC1", "valve_chamber", "VC-1 valve chamber", null, VC],
  ["RS-VC2", "valve_chamber", "VC-2 valve chamber", null, VC],
  ["RS-VC3", "valve_chamber", "VC-3 valve chamber", null, VC]
];

// ---------- Projects (Region design §4.4): footprints, money, what they take out of service ----------
export const STAGE_CAPACITY = { intake: 130, main: 130, clar: 120, filt: 120 }; // ML/d per treatment stage, in series
export const DESIGN_ML_D = 120;
const rectXY = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
// a strip either side of a pipe segment, from fraction f0 to f1 along it
const strip = ([a, b], f0, f1, half) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), nx = (-dy / L) * half, ny = (dx / L) * half;
  const p = (f) => [a[0] + dx * f, a[1] + dy * f];
  const [s, e] = [p(f0), p(f1)];
  return [[s[0] + nx, s[1] + ny], [e[0] + nx, e[1] + ny], [e[0] - nx, e[1] - ny], [s[0] - nx, s[1] - ny], [s[0] + nx, s[1] + ny]];
};
const ms = (id, title, due, extra = {}) => ({ id, title, due, keywords: title.toLowerCase().split(/\W+/).filter((w) => w.length > 4).slice(0, 2), claimedAt: null, confirmedAt: null, confirmedBy: null, ...extra });
const done = (at, by = "P-004") => ({ claimedAt: `${at}T15:00:00Z`, confirmedAt: `${at}T16:00:00Z`, confirmedBy: by });

// [id, fields]; footprints in site metres. PRJ-CL3 already exists (Phase 2): it gains the region fields only.
export const PROJECTS = [
  ["PRJ-CL3", { footprint: rectXY(260, 58, 40, 40), budgetZar: 1200000, spend: [{ at: "2026-09-28", zar: 300000 }, { at: "2026-10-09", zar: 550000 }],
    takesOutOfService: [{ id: "CL-3", from: "2026-09-28", to: "2026-11-06" }], capacityImpact: { stage: "clar", capacityMlD: 90, text: "Clarifier 3 out of service: clarification limited to 90 ML/d" } }],
  ["PRJ-RWM", { title: "Raw-water main section replacement", kind: "contract", ownerId: "P-002", start: "2026-09-14", end: "2026-11-20", footprint: strip([INTAKE_XY, [-400, -600]], 0.3, 0.7, 15),
    budgetZar: 6800000, spend: [{ at: "2026-09-14", zar: 1500000 }, { at: "2026-10-05", zar: 3100000 }], takesOutOfService: [{ id: "RWM-RB", from: "2026-09-21", to: "2026-11-13" }],
    capacityImpact: { stage: "main", capacityMlD: 100, text: "Raw-water main on its bypass barrel: intake limited to 100 ML/d" },
    milestones: [ms("M1", "Bypass barrel commissioned", "2026-09-25", done("2026-09-24")), ms("M2", "Section 1 pipe replaced and tested", "2026-10-09"), ms("M3", "Section 2 pipe replaced and tested", "2026-10-30"), ms("M4", "Main back in service", "2026-11-13")] }],
  ["PRJ-RES2", { title: "Reservoir RES-2 relining (cell B)", kind: "contract", ownerId: "P-004", start: "2026-09-07", end: "2026-11-14", footprint: rectXY(11380, 380, 240, 240),
    budgetZar: 2400000, spend: [{ at: "2026-09-15", zar: 600000 }, { at: "2026-09-30", zar: 1300000 }, { at: "2026-10-12", zar: 1900000 }], takesOutOfService: [{ id: "RS-RES2", from: "2026-09-07", to: "2026-11-14" }],
    capacityImpact: { stage: "storage", storagePct: -50, text: "RES-2 storage −50% until 14 Nov (cell B drained)" },
    milestones: [ms("M1", "Cell B drained and cleaned", "2026-09-14", done("2026-09-13")), ms("M2", "Old lining stripped", "2026-10-02", done("2026-10-02")), ms("M3", "New liner installed", "2026-10-30"), ms("M4", "Cell B disinfected and back in service", "2026-11-14")] }],
  ["PRJ-FMR", { title: "Filter media replacement F09–F12", kind: "contract", ownerId: "P-002", start: "2026-10-05", end: "2026-11-30", footprint: rectXY(398, 36, 38, 17),
    budgetZar: 1600000, spend: [{ at: "2026-10-05", zar: 400000 }], takesOutOfService: [{ id: "AST-FLT-F09", from: "2026-10-05", to: "2026-10-19" }],
    capacityImpact: { stage: "filt", capacityMlD: 110, text: "One filter at a time out for new media: filtration limited to 110 ML/d" },
    milestones: [ms("M1", "F09 media replaced", "2026-10-19"), ms("M2", "F10 media replaced", "2026-11-02"), ms("M3", "F11 media replaced", "2026-11-16"), ms("M4", "F12 media replaced", "2026-11-30")] }],
  ["PRJ-INT", { title: "Intake screen upgrade", kind: "contract", ownerId: "P-004", start: "2026-11-02", end: "2026-12-11", footprint: rectXY(INTAKE_XY[0] - 40, INTAKE_XY[1] - 40, 80, 80),
    budgetZar: 950000, spend: [], takesOutOfService: [{ id: "INT-RB", from: "2026-11-02", to: "2026-12-11" }],
    capacityImpact: { stage: "intake", capacityMlD: 110, text: "One of two intake screens out: intake limited to 110 ML/d" },
    milestones: [ms("M1", "Screen 1 replaced", "2026-11-13"), ms("M2", "Screen 2 replaced", "2026-11-27"), ms("M3", "Handover", "2026-12-11")] }],
  ["PRJ-SLG", { title: "Sludge lagoon desludging", kind: "contract", ownerId: "P-004", start: "2026-10-01", end: "2026-10-30", footprint: rectXY(260, 190, 120, 80),
    budgetZar: 700000, spend: [{ at: "2026-10-01", zar: 250000 }], takesOutOfService: [],
    capacityImpact: { stage: null, text: "No capacity effect; sludge tanker trips through the works" },
    milestones: [ms("M1", "Lagoon 1 desludged", "2026-10-10", done("2026-10-09")), ms("M2", "Lagoon 2 desludged", "2026-10-20"), ms("M3", "Haul-off certificates filed", "2026-10-30")] }],
  ["PRJ-PS2", { title: "PS-2 MCC upgrade", kind: "contract", ownerId: "P-004", start: "2026-10-12", end: "2026-10-30", footprint: rectXY(7920, 390, 160, 160),
    budgetZar: 1100000, spend: [{ at: "2026-10-12", zar: 350000 }], takesOutOfService: [{ id: "RS-PS2", from: "2026-10-12", to: "2026-10-30" }],
    capacityImpact: { stage: "supply", text: "PS-2 on its standby pump only: no spare pumping until 30 Oct" },
    milestones: [ms("M1", "Temporary supply to the standby pump", "2026-10-13", done("2026-10-13")), ms("M2", "New MCC installed", "2026-10-23"), ms("M3", "Duty pump back on the new MCC", "2026-10-30")] }]
].map(([id, f]) => [id, { ...f, footprint: { type: "Polygon", coordinates: [f.footprint.map(toLonLat)] } }]);
