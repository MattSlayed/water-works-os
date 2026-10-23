import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { GEOREF, STRUCTURES, toLonLat, toLocal } from "../src/layout.mjs";
import { REGION } from "../src/region.mjs";
import { within, distanceM, nearestAlong, objectsIn } from "../src/functions.mjs";
import { createServer } from "../src/server.mjs";

const sys = createSystem();
const geo = (id) => REGION.find((r) => r.id === id).geometry;
const ring = (id) => geo(id).coordinates[0];
const km2 = (coords) => {
  const p = coords.map(toLocal);
  let a = 0;
  for (let i = 0; i < p.length - 1; i++) a += p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1];
  return Math.abs(a) / 2 / 1e6;
};
const points = (g) => (g.type === "Point" ? [g.coordinates] : g.type === "LineString" ? g.coordinates : g.coordinates.flat());

test("region: toLocal round-trips toLonLat to a centimetre", () => {
  for (const xy of [[0, 0], [760, 180], [-4000, -5000], [11500, 500]]) {
    const back = toLocal(toLonLat(xy));
    assert.ok(Math.hypot(back[0] - xy[0], back[1] - xy[1]) < 0.01, `${xy} -> ${back}`);
  }
});

test("region: every geometry lies in a 25 km x 20 km box on the plant origin", () => {
  for (const r of REGION) for (const p of points(r.geometry)) {
    const [x, y] = toLocal(p);
    assert.ok(Math.abs(x) <= 12500 && Math.abs(y) <= 10000, `${r.id} ${x},${y}`);
  }
  assert.deepEqual(toLocal([GEOREF.origin[1], GEOREF.origin[0]]).map(Math.round), [0, 0]);
});

test("region: catchment 150-210 km2, dam 4-8 km2, areas of interest inside the dam", () => {
  const c = km2(ring("CAT-RB")), d = km2(ring("WB-RB"));
  assert.ok(c >= 150 && c <= 210, `catchment ${c}`);
  assert.ok(d >= 4 && d <= 8, `dam ${d}`);
  for (const a of ["AOI-INFLOW", "AOI-INTAKE", "AOI-DAM"]) for (const p of ring(a)) assert.ok(within(p, geo("WB-RB")), `${a} vertex ${p}`);
});

test("region: the intake is on the dam shore and the raw-water main ends at the intake pump house", () => {
  const intake = geo("INT-RB").coordinates, shore = nearestAlong(ring("WB-RB"), intake);
  assert.ok(shore.distanceM <= 50, `intake ${shore.distanceM} m from the shore`);
  const s = STRUCTURES.find((x) => x.tag === "10UPA01"), main = geo("RWM-RB").coordinates;
  assert.ok(distanceM(main[main.length - 1], toLonLat(s.centre)) <= 30);
});

test("region: within counts edges and vertices; distance is metric; unknown areas are empty", () => {
  const sq = { type: "Polygon", coordinates: [[[28.6, -25.8], [28.61, -25.8], [28.61, -25.81], [28.6, -25.81], [28.6, -25.8]]] };
  assert.ok(within([28.6, -25.8], sq));
  assert.ok(within([28.605, -25.8], sq));
  assert.ok(within([28.605, -25.805], sq));
  assert.ok(!within([28.62, -25.805], sq));
  const o = [GEOREF.origin[1], GEOREF.origin[0]];
  assert.ok(Math.abs(distanceM(o, [o[0], o[1] + 0.01]) - 1113) <= 2);
  assert.deepEqual(objectsIn(sys.ont, "AOI-NOPE"), []);
  assert.deepEqual(objectsIn(sys.ont, "AOI-DAM", []), []);
});

test("region: Region objects are seeded; 15 zones, remote ones with rects and no rect, Z15 supervisor", () => {
  for (const r of REGION) assert.equal(sys.ont.get(r.id).type, "Region");
  const zones = sys.ont.list("Zone");
  assert.equal(zones.length, 15);
  for (const id of ["Z13", "Z14", "Z15"]) {
    const z = sys.ont.get(id);
    assert.ok(z.remote && Array.isArray(z.rects) && z.rects.length && !z.rect, id);
  }
  assert.equal(sys.ont.get("Z15").clearance, "supervisor");
});

test("region: the schematic site map still shows the 12 plant zones only", async () => {
  const srv = createServer(sys);
  await new Promise((r) => srv.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/map`, { headers: { "x-acting-user": "P-001" } });
    const m = await res.json();
    assert.equal(m.zones.length, 12);
  } finally { srv.close(); }
});

// ---------- Task 2: remote sites ----------
test("remote sites: seven, on the bulk line, PS-2's yard in Z14 with its MCC sensor in Z15", () => {
  const sites = sys.ont.list("RemoteSite");
  assert.equal(sites.length, 7);
  for (const s of sites) assert.ok(nearestAlong(geo("BLK-RB").coordinates, [s.lon, s.lat]).distanceM <= 300, s.id);
  assert.equal(sys.ont.get("RS-PS2").zoneId, "Z14");
  assert.equal(sys.ont.get("SEN-PS2-state").zoneId, "Z15");
});

test("remote sites: 18 sensors, each with a live reading", () => {
  const ids = ["PS1", "PS2"].flatMap((k) => ["flow", "press", "state"].map((m) => `SEN-${k}-${m}`))
    .concat(["RES1", "RES2"].flatMap((k) => ["level", "in", "out"].map((m) => `SEN-${k}-${m}`)))
    .concat(["VC1", "VC2", "VC3"].flatMap((k) => ["press", "pos"].map((m) => `SEN-${k}-${m}`)));
  assert.equal(ids.length, 18);
  for (const id of ids) {
    assert.equal(sys.ont.get(id).type, "Sensor", id);
    assert.ok(sys.tel.latest(id) && Number.isFinite(sys.tel.latest(id).value), id);
  }
});

test("remote sites: RES-2 holds 8 to 10 hours at today's outflow with cell B out of service", () => {
  const res2 = sys.ont.get("RS-RES2"), level = sys.tel.latest("SEN-RES2-level").value, out = sys.tel.latest("SEN-RES2-out").value;
  const hours = ((level / 100) * (res2.capacityMl / 2)) / out * 24; // PRJ-RES2 takes cell B (half) out
  assert.ok(hours >= 8 && hours <= 10, `${hours} h`);
});
