// Ground terraces for the 3D plant. Pure geometry (no three.js) so node tests can check it. Rects are [x0, y0, x1, y1].
export const BUILDING = new Set(["pump_house", "dosing_house", "chlorine_house", "chemical_store", "mcc", "lab", "admin", "gen_set", "pipe_gallery", "filter_building", "workshop"]);

// footprint; a covered reservoir's embankment toe reaches 1.6 m out per metre of height
const foot = (s, toe) => { const m = toe && s.kind === "reservoir_covered" ? 1.6 * s.height : 0, hw = (s.diameter ?? s.w) / 2 + m, hl = (s.diameter ?? s.l) / 2 + m; return [s.centre[0] - hw, s.centre[1] - hl, s.centre[0] + hw, s.centre[1] + hl]; };
const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
const within = (a, r) => a[0] >= r[0] - 0.01 && a[1] >= r[1] - 0.01 && a[2] <= r[2] + 0.01 && a[3] <= r[3] + 0.01;
const overlaps = (a, r) => Math.min(a[2], r[2]) - Math.max(a[0], r[0]) > 0.01 && Math.min(a[3], r[3]) - Math.max(a[1], r[1]) > 0.01;
// what a cut removed: keep shares three edges with r
const rest = (r, k) => (k[0] > r[0] ? [r[0], r[1], k[0], r[3]] : k[2] < r[2] ? [k[2], r[1], r[2], r[3]] : k[1] > r[1] ? [r[0], r[1], r[2], k[1]] : [r[0], k[3], r[2], r[3]]);

// Terraces follow the hydraulic profile: each zone at its buildings' floor, else 2 m above its lowest base.
// Returns the grade per zone and the slabs to draw ({ zoneId, grade, rect }).
export function terraces(zones, structures) {
  const own = (id) => structures.filter((s) => s.zoneId === id);
  const grade = new Map(zones.map((z) => {
    const ss = own(z.id), b = ss.filter((s) => BUILDING.has(s.kind) && s.kind !== "pipe_gallery");
    return [z.id, b.length ? Math.min(...b.map((s) => s.baseLevel)) : ss.length ? Math.min(...ss.map((s) => s.baseLevel)) + 2 : null];
  }));
  // Z11 (the laboratory) holds no structure of its own: it is the north half of ADM-1's east third, so it takes Z12's grade.
  for (const z of zones) if (grade.get(z.id) == null) grade.set(z.id, grade.get("Z12") ?? 1452);
  const pieces = [];
  for (const z of zones) {
    const g = grade.get(z.id), mine = own(z.id).map((s) => foot(s, true));
    // the zone rect grown to its structures' footprints (zone rects are hand-drawn; only centres are guaranteed inside)
    let r = mine.reduce((a, f) => [Math.min(a[0], f[0]), Math.min(a[1], f[1]), Math.max(a[2], f[2]), Math.max(a[3], f[3])], [z.rect[0], z.rect[1], z.rect[0] + z.rect[2], z.rect[1] + z.rect[3]]);
    // A structure's own zone wins: a higher terrace gives up the strip holding it, refilled at that zone's grade so no pit opens.
    // Bodies only: a reservoir embankment meeting higher ground is how it would be built.
    for (const s of structures) {
      const f = foot(s, false), fg = grade.get(s.zoneId);
      if (s.zoneId === z.id || fg == null || fg + 0.05 >= g || !overlaps(f, r)) continue;
      const cuts = [[r[0], r[1], f[0], r[3]], [f[2], r[1], r[2], r[3]], [r[0], r[1], r[2], f[1]], [r[0], f[3], r[2], r[3]]]
        .filter((c) => c[2] > c[0] && c[3] > c[1] && mine.every((m) => within(m, c)));
      if (!cuts.length) continue;
      const keep = cuts.reduce((a, c) => (area(c) > area(a) ? c : a));
      pieces.push({ zoneId: s.zoneId, grade: fg, rect: rest(r, keep) });
      r = keep;
    }
    pieces.push({ zoneId: z.id, grade: g, rect: r });
  }
  return { grade, pieces };
}
