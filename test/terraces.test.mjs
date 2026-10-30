import { test } from "node:test";
import assert from "node:assert/strict";
import { ZONES, STRUCTURES } from "../src/layout.mjs";
import { terraces } from "../web/terraces.js";

const zones = ZONES.map(([id, , x, y, w, h]) => ({ id, rect: [x, y, w, h] }));
const { grade, pieces } = terraces(zones, STRUCTURES);
const body = (s) => { const hw = (s.diameter ?? s.w) / 2, hl = (s.diameter ?? s.l) / 2; return [s.centre[0] - hw, s.centre[1] - hl, s.centre[0] + hw, s.centre[1] + hl]; };
const overlap = (a, r) => Math.min(a[2], r[2]) - Math.max(a[0], r[0]) > 0.05 && Math.min(a[3], r[3]) - Math.max(a[1], r[1]) > 0.05;
const inside = ([x, y], r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

test("terraces: no slab buries a structure below its own zone's grade", () => {
  for (const s of STRUCTURES) for (const p of pieces) {
    if (p.grade > grade.get(s.zoneId) + 0.05) assert.ok(!overlap(body(s), p.rect), `${p.zoneId} slab at ${p.grade} buries ${s.tag}`);
  }
});

test("terraces: every structure stands on its own zone's slab", () => {
  for (const s of STRUCTURES) {
    const b = body(s), mine = pieces.filter((p) => p.zoneId === s.zoneId && p.grade === grade.get(s.zoneId));
    for (const c of [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]]) assert.ok(mine.some((p) => inside(c, p.rect)), `${s.tag} corner ${c} off its terrace`);
  }
});

test("terraces: cutting a slab opens no pit inside any zone", () => {
  for (const z of zones) {
    const [x, y, w, h] = z.rect;
    for (let i = 0.5; i < w; i += 1) for (let j = 0.5; j < h; j += 1) assert.ok(pieces.some((p) => inside([x + i, y + j], p.rect)), `${z.id} pit at ${x + i},${y + j}`);
  }
});
