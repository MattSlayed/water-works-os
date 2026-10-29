import { test } from "node:test";
import assert from "node:assert/strict";
import { ZONES, STRUCTURES, MACHINES, GEOREF, PLAN, LAYOUT_SKIPPED, CAPACITY_MLD, siteBounds, toLonLat } from "../src/layout.mjs";
import { generateWorks } from "../src/generate.mjs";

const zone = (id) => ZONES.find((z) => z[0] === id);
const inside = ([x, y], [, , zx, zy, w, h]) => x >= zx && x <= zx + w && y >= zy && y <= zy + h;
const of = (k) => STRUCTURES.filter((s) => s.kind === k);

// Centres only: rotated units pack tighter than axis-aligned zones, so whole footprints may cross a zone edge.
test("every structure centre lies inside its zone and zones do not overlap", () => {
  for (const s of STRUCTURES) assert.ok(inside(s.centre, zone(s.zoneId)), `${s.tag} centre outside ${s.zoneId}`);
  for (const a of ZONES) for (const b of ZONES) {
    if (a === b) continue;
    const [, , ax, ay, aw, ah] = a, [, , bx, by, bw, bh] = b;
    assert.ok(ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay, `${a[0]} overlaps ${b[0]}`);
  }
});

test("every structure has a finite size: a diameter, or a width and a length", () => {
  const ok = (v) => Number.isFinite(v) && v > 0;
  for (const s of STRUCTURES) assert.ok(ok(s.diameter) || (ok(s.w) && ok(s.l)), `${s.tag} has no usable diameter or w/l`);
});

test("every structure footprint lies inside siteBounds(), so the GA road and fence clear it", () => {
  const [minX, minY, maxX, maxY] = siteBounds();
  for (const s of STRUCTURES) {
    const [hw, hl] = s.diameter ? [s.diameter / 2, s.diameter / 2] : [s.w / 2, s.l / 2], [x, y] = s.centre;
    assert.ok(x - hw >= minX && x + hw <= maxX && y - hl >= minY && y + hl <= maxY, `${s.tag} crosses the site bounds`);
  }
});

test("canonical counts", () => {
  assert.equal(of("clarifier_circular").length, 4);
  assert.equal(of("filter_bed").length, 8);
  assert.equal(of("reservoir_covered").filter((s) => s.zoneId === "Z07").length, 2);
  const hlp = MACHINES.filter((m) => /^HLP-/.test(m.positionTag));
  assert.deepEqual(hlp.map((m) => m.positionTag), ["HLP-A", "HLP-B", "HLP-C", "HLP-D", "HLP-E"]);
  assert.ok(hlp.every((m) => m.structureTag === "20UMC01"));
  assert.equal(CAPACITY_MLD, 100);
});

test("top water level falls from clarifiers to filters to reservoirs", () => {
  const top = (xs) => Math.max(...xs.map((s) => s.twl).filter((v) => v != null));
  const cl = top(of("clarifier_circular")), f = top(of("filter_bed")), res = top(of("reservoir_covered").filter((s) => s.zoneId === "Z07"));
  assert.ok([cl, f, res].every(Number.isFinite), `${cl} ${f} ${res}`);
  assert.ok(cl > f && f > res, `${cl} > ${f} > ${res}`);
});

test("unknown scene assets are skipped, not fatal", () => {
  assert.ok(Array.isArray(LAYOUT_SKIPPED));
  for (const a of LAYOUT_SKIPPED) assert.ok(!(a in PLAN), a);
});

test("chlorination stays supervisor-only", () => {
  assert.equal(STRUCTURES.find((s) => s.tag === "16UHC01").zoneId, "Z06");
  assert.equal(zone("Z06")[6], "supervisor");
});

test("every hero position sits in a structure; georeference", () => {
  for (const t of ["RWP-A", "RWP-B", "RWP-C", "DP-1", "DP-2", "CL-1", "CL-2", "CL-3", "CL-4", "BWP-A", "BWP-B", "BLW-A", "BLW-B", "CHL-A", "CHL-B", "HLP-A", "HLP-B", "HLP-C", "HLP-D", "HLP-E", "SLP-A", "GEN-1"]) {
    const m = MACHINES.find((x) => x.positionTag === t);
    assert.ok(m, t);
    assert.ok(STRUCTURES.some((s) => s.tag === m.structureTag), `${t} in ${m.structureTag}`);
  }
  assert.deepEqual(GEOREF, { crs: "EPSG:4326", origin: [-25.86, 28.62], rotationDeg: 0 });
  assert.deepEqual(toLonLat([0, 0]), [28.62, -25.86]);
  const [minX, minY, maxX, maxY] = siteBounds();
  assert.ok(minX <= 740 && minY <= 230 && maxX >= 895 && maxY >= 600);
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
