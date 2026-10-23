import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";
import { toLocal } from "../src/layout.mjs";

let sys, srv, base;
before(async () => {
  sys = createSystem();
  srv = createServer(sys);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

const call = async (path, { as = "P-001", method = "GET", body } = {}) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(as ? { "x-acting-user": as } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, bytes: text.length };
};
const techId = () => sys.ont.list("Person", (p) => p.clearance === "technician")[0].id;
const first = (role) => sys.ont.list("Person", (p) => p.role === role).sort((a, b) => a.id.localeCompare(b.id))[0];
const inZ15 = ([lon, lat]) => sys.ont.get("Z15").rects.some(([x, y, w, h]) => { const [px, py] = toLocal([lon, lat]); return px >= x && px <= x + w && py >= y && py <= y + h; });

test("J17: since you left lists the plume, PP-2 off its site and the slipped raw-water main milestone", async () => {
  const r = await call("/api/region/since");
  assert.equal(r.status, 200);
  const items = r.json.items;
  assert.ok(items.length <= 8);
  const det = items.find((i) => i.kind === "detection");
  assert.ok(det && det.stillOpen);
  assert.ok(items.some((i) => i.kind === "geofence" && i.trackerId === "TRK-PP2"));
  assert.ok(items.some((i) => i.kind === "project" && i.id === "PRJ-RWM" && /slipped|overdue/i.test(i.text)));
});

test("J17: today's supply risks — raised raw water, 30 ML/d out, RES-2 at about 9 hours", async () => {
  const r = (await call("/api/region/risks")).json;
  assert.equal(r.capacity.outOfServiceMlD, 30);
  assert.ok(["raised", "high"].includes(r.rawWater.band), r.rawWater.band);
  assert.ok(r.rawWater.inputs.length && r.capacity.inputs.length && r.storage.inputs.length);
  const res2 = r.storage.sites.find((s) => s.id === "RS-RES2");
  assert.ok(res2.storageHours >= 8 && res2.storageHours <= 10 && res2.flagged, JSON.stringify(res2));
});

test("J19: the RES-2 panel — contractor on site, R1.9m of R2.4m, storage halved, an issue with its log entry", async () => {
  const p = (await call("/api/projects/PRJ-RES2/panel", { as: "P-004" })).json;
  assert.deepEqual([p.progress.spendZar, p.progress.budgetZar], [1900000, 2400000]);
  assert.ok(p.footprint.trackers.some((t) => t.id === "TRK-CON1"));
  assert.match(p.impact.text, /RES-2 storage/);
  assert.ok(p.issues.some((i) => Number.isInteger(i.auditId)), JSON.stringify(p.issues));
  assert.equal((await call("/api/projects/PRJ-NOPE/panel")).status, 404);
});

test("mark seen: afterwards only what is still open comes back", async () => {
  assert.equal((await call("/api/region/since", { method: "POST", as: "P-002" })).status, 200);
  const items = (await call("/api/region/since", { as: "P-002" })).json.items;
  assert.ok(items.length > 0 && items.every((i) => i.stillOpen), JSON.stringify(items));
});

test("focus: the plume response takes in the boat, the coagulant truck, the intake, the round and F07's alert", async () => {
  const det = sys.ont.list("GeoDetection")[0], sup = first("shift_supervisor");
  const prp = sys.ont.list("Proposal", (p) => p.action === "start_sampling_round" && p.state === "open")[0];
  sys.actions.resolve(prp.id, { verdict: "approve", by: { kind: "person", id: sup.id, clearance: sup.clearance } });
  sys.runtime.run("Process Watch", { actingUser: { id: "SYSTEM", kind: "person", clearance: "manager" }, chain: false });
  const f07 = sys.ont.list("Alert", (a) => a.state === "active" && /^F07/.test(a.title))[0];
  assert.ok(f07, "Process Watch alerts on F07");
  const wo = sys.ont.list("WorkOrder", (w) => w.source === det.id)[0];
  const r = (await call(`/api/region/focus/detection/${det.id}`)).json;
  for (const id of ["TRK-BOAT", "TRK-COAG", "INT-RB", det.aoiId, wo.id, f07.id]) assert.ok([...r.ids, ...r.trackerIds].includes(id), id);
  assert.ok(!r.ids.some((id) => id.startsWith("RS-")));
  assert.equal((await call("/api/region/focus/detection/GEO-NOPE")).status, 404);
});

test("J21: a technician gets nothing from the PS-2 MCC room, in the payload, the focus, the panel or the stream", async () => {
  const t = techId();
  const reg = (await call("/api/region", { as: t })).json;
  assert.ok(!reg.trackers.some((x) => x.id === "TRK-GEN"));
  for (const x of reg.trackers) assert.ok(!inZ15([x.lon, x.lat]), x.id);
  for (const p of reg.projects) for (const v of p.footprint.coordinates[0]) assert.ok(!inZ15(v), p.id);
  assert.ok(!reg.zones.some((z) => z.id === "Z15"));
  const f = (await call("/api/region/focus/project/PRJ-PS2", { as: t })).json;
  assert.ok(!f.trackerIds.includes("TRK-GEN") && !f.zoneIds.includes("Z15"));
  const panel = (await call("/api/projects/PRJ-PS2/panel", { as: t })).json;
  assert.ok(!panel.footprint.trackers.some((x) => x.id === "TRK-GEN"));
  const manager = (await call("/api/region/focus/project/PRJ-PS2")).json;
  assert.ok(manager.trackerIds.includes("TRK-GEN"), "the manager sees the genset");

  const ctl = new AbortController(), res = await fetch(`${base}/api/events?as=${t}`, { signal: ctl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let text = "";
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } } catch {} })();
  await new Promise((r) => setTimeout(r, 50));
  sys.ont.upsert({ id: "TRK-GEN", type: "Tracker", fuelPct: 51 });
  sys.ont.upsert({ id: "TRK-BAK1", type: "Tracker", batteryPct: 99 });
  await new Promise((r) => setTimeout(r, 100));
  ctl.abort();
  await pump;
  assert.ok(text.includes("TRK-BAK1"));
  assert.ok(!text.includes("TRK-GEN"));
});

test("payload size and grids: under 300 KB; grids are banded; history scenes have none", async () => {
  const r = await call("/api/region");
  assert.ok(r.bytes < 300000, `${r.bytes} bytes`);
  assert.equal(r.json.live, null, "live mode is off");
  assert.ok(r.json.scenes.some((s) => s.id === "S2-20261012") && r.json.scenes.every((s) => !s.stats));
  const g = await call("/api/region/scenes/S2-20261012/grid?index=ndti");
  assert.equal(g.status, 200);
  assert.ok(g.json.bands.every((b) => ["normal", "raised", "high", "unknown"].includes(b)));
  assert.equal(g.json.note, "index, not calibrated");
  const oldest = sys.ont.list("Scene").sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt))[0];
  assert.equal((await call(`/api/region/scenes/${oldest.id}/grid?index=ndti`)).status, 404);
});
