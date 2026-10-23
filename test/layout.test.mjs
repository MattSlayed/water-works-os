import { test } from "node:test";
import assert from "node:assert/strict";
import { ZONES, STRUCTURES, MACHINES, GEOREF, siteBounds, toLonLat } from "../src/layout.mjs";
import { generateWorks } from "../src/generate.mjs";

const zone = (id) => ZONES.find((z) => z[0] === id);
const inside = ([x, y], [, , zx, zy, w, h]) => x >= zx && x <= zx + w && y >= zy && y <= zy + h;
const pointsOf = (s) => (s.outline ? s.outline : s.diameter ? [[s.centre[0] - s.diameter / 2, s.centre[1] - s.diameter / 2], [s.centre[0] + s.diameter / 2, s.centre[1] + s.diameter / 2]] : [[s.centre[0] - s.w / 2, s.centre[1] - s.l / 2], [s.centre[0] + s.w / 2, s.centre[1] + s.l / 2]]);

test("every structure lies inside its zone and zones do not overlap", () => {
  for (const s of STRUCTURES) for (const p of pointsOf(s)) assert.ok(inside(p, zone(s.zoneId)), `${s.tag} outside ${s.zoneId}`);
  for (const a of ZONES) for (const b of ZONES) {
    if (a === b) continue;
    const [, , ax, ay, aw, ah] = a, [, , bx, by, bw, bh] = b;
    assert.ok(ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay, `${a[0]} overlaps ${b[0]}`);
  }
});

test("sized for 120 ML/d: clarifiers, filters, contact tank, reservoirs", () => {
  const of = (k) => STRUCTURES.filter((s) => s.kind === k);
  assert.equal(of("clarifier_circular").length, 4);
  assert.ok(of("clarifier_circular").every((s) => s.diameter >= 30 && s.diameter <= 34));
  assert.equal(new Set(of("clarifier_circular").map((s) => s.centre[0])).size, 2);
  assert.equal(new Set(of("clarifier_circular").map((s) => s.centre[1])).size, 2);
  const f = of("filter_bed");
  assert.equal(f.length, 12);
  assert.ok(f.every((s) => s.w === 7 && s.l === 11));
  assert.equal(new Set(f.map((s) => s.centre[1])).size, 2);
  const ct = of("contact_tank");
  assert.equal(ct.length, 1);
  assert.ok(ct[0].volumeM3 >= 2500 && ct[0].volumeM3 <= 5000);
  assert.deepEqual(of("reservoir_covered").map((s) => s.volumeM3), [20000, 20000]);
});

test("top water level falls along the train by 5–7 m", () => {
  const order = ["inlet_works", "flash_mix", "flocculator", "clarifier_circular", "filter_bed", "contact_tank", "reservoir_covered"];
  const twl = order.map((k) => STRUCTURES.find((s) => s.kind === k).twl);
  for (let i = 1; i < twl.length; i++) assert.ok(twl[i] < twl[i - 1], `${order[i]} not below ${order[i - 1]}`);
  const fall = twl[0] - twl[twl.length - 1];
  assert.ok(fall >= 5 && fall <= 7, `fall ${fall}`);
});

test("every hero position sits in a structure; georeference", () => {
  for (const t of ["RWP-A", "RWP-B", "RWP-C", "DP-1", "DP-2", "CL-1", "CL-2", "CL-3", "CL-4", "BWP-A", "BWP-B", "BLW-A", "BLW-B", "CHL-A", "CHL-B", "HLP-A", "HLP-B", "HLP-C", "HLP-D", "SLP-A", "GEN-1"]) {
    const m = MACHINES.find((x) => x.positionTag === t);
    assert.ok(m, t);
    assert.ok(STRUCTURES.some((s) => s.tag === m.structureTag), `${t} in ${m.structureTag}`);
  }
  assert.deepEqual(GEOREF, { crs: "EPSG:4326", origin: [-25.86, 28.62], rotationDeg: 0 });
  assert.deepEqual(toLonLat([0, 0]), [28.62, -25.86]);
  const [minX, minY, maxX, maxY] = siteBounds();
  assert.ok(minX <= 0 && minY <= 0 && maxX >= 700 && maxY >= 150);
});

test("generated works: two-digit filter KKS, chlorinators, split-case pumps, c-model", () => {
  const { objects } = generateWorks(7);
  const get = (id) => objects.find((o) => o.id === id);
  assert.equal(get("POS-F07").kks, "15HFA07");
  assert.equal(get("SEN-F07-turb").historianTag, "15HFA07.TURB");
  const asset = (tag) => objects.find((o) => o.type === "Asset" && o.positionTag === tag);
  assert.equal(asset("CHL-A").assetClass, "Chlorinator");
  assert.match(asset("HLP-A").assetClass, /split-case/i);
  for (const p of ["P-001", "P-003"]) assert.ok(objects.some((o) => o.type === "Competency" && o.personId === p && o.competency === "c-model" && o.validTo > "2027"), p);
});
