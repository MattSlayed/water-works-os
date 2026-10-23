import { test } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createTrackers, pingState } from "../src/trackers.mjs";
import { within } from "../src/functions.mjs";

const sys = createSystem();
const cur = sys.tel.cursor();
const DAY = 1440;

test("trackers: twelve, none bound to a person", () => {
  const t = sys.ont.list("Tracker");
  assert.equal(t.length, 12);
  for (const x of t) assert.notEqual((sys.ont.get(x.boundTo) || {}).type, "Person", x.id);
  assert.equal(sys.ont.get("TRK-COAG").boundTo, "CHEM-COAG");
});

test("trackers: a moving tracker pings every minute, a parked one every five", () => {
  const moving = sys.trackers.history("TRK-COAG", 5, 13 * DAY + 400); // the coagulant delivery is on the road at 06:40
  for (let i = 1; i < moving.length; i++) assert.equal(Date.parse(moving[i].at) - Date.parse(moving[i - 1].at), 60000);
  assert.ok(moving.every((p) => p.speedKmh > 0));
  const parked = sys.trackers.history("TRK-PP1", 5, cur);
  for (let i = 1; i < parked.length; i++) assert.equal(Date.parse(parked[i].at) - Date.parse(parked[i - 1].at), 300000);
  assert.ok(parked.every((p) => p.speedKmh === 0 && Number.isFinite(p.runHours) && Number.isFinite(p.fuelPct) && p.state));
});

test("trackers: age states at the boundaries, frozen once the clock passes the data", () => {
  const T = "2026-10-14T06:00:00Z", end = "2026-10-15T00:00:00Z", at = (ms) => new Date(Date.parse(T) - ms).toISOString();
  assert.equal(pingState(at(15 * 60000), T, end), "live");
  assert.equal(pingState(at(15 * 60000 + 1000), T, end), "stale");
  assert.equal(pingState(at(24 * 3600000), T, end), "lost");
  assert.equal(pingState(end, "2026-10-18T00:00:00Z", end), "live");
});

test("trackers: PP-2 left the raw-water main works overnight on day 13 and is outside it now", () => {
  const ev = sys.ont.list("GeofenceEvent", (e) => e.trackerId === "TRK-PP2" && e.kind === "left");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].regionId, "PRJ-RWM");
  assert.equal(ev[0].at.slice(0, 10), "2026-10-14");
  const pp2 = sys.ont.get("TRK-PP2");
  assert.ok(!within([pp2.lon, pp2.lat], sys.ont.get("PRJ-RWM").footprint));
});

test("trackers: the RES-2 contractor is on site at the clock; the genset sits in the PS-2 MCC room (Z15)", () => {
  const con = sys.ont.get("TRK-CON1");
  assert.ok(within([con.lon, con.lat], sys.ont.get("PRJ-RES2").footprint));
  assert.equal(sys.trackers.latest("TRK-GEN", cur).zoneId, "Z15");
  assert.equal(sys.ont.get("TRK-GEN").zoneId, "Z15");
});

test("trackers: a bakkie that went quiet is stale at the clock; pings are deterministic per seed", () => {
  const b = sys.trackers.latest("TRK-BAK2", cur);
  assert.equal(pingState(b.at, sys.tel.now(), new Date(Date.parse("2026-10-01T00:00:00Z") + sys.trackers.dataEndMin * 60000).toISOString()), "stale");
  const a7 = createTrackers({ ont: sys.ont, seed: 7, start: "2026-10-01T00:00:00Z", minutes: 14 * DAY });
  const b7 = createTrackers({ ont: sys.ont, seed: 7, start: "2026-10-01T00:00:00Z", minutes: 14 * DAY });
  const b8 = createTrackers({ ont: sys.ont, seed: 8, start: "2026-10-01T00:00:00Z", minutes: 14 * DAY });
  assert.deepEqual(a7.history("TRK-BAK1", 20, 12 * DAY + 400), b7.history("TRK-BAK1", 20, 12 * DAY + 400));
  assert.notDeepEqual(a7.history("TRK-BAK1", 20, 12 * DAY + 400), b8.history("TRK-BAK1", 20, 12 * DAY + 400));
});
