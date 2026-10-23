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
  ["Z15", "PS-2 MCC room", "supervisor", "electrical", [[7990, 460, 20, 15]]]
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
