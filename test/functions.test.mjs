import { test } from "node:test";
import assert from "node:assert/strict";
import { failureRisk, anomaly, breakthroughRisk, storageHours, consequence, competenceCheck } from "../src/functions.mjs";

const flat = (v, n = 200) => Array.from({ length: n }, (_, i) => v + (i % 2 ? 0.02 : -0.02));
const ramp = (a, b, n = 200) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

test("rising vibration and temperature score higher than flat", () => {
  const hi = failureRisk({ vib: ramp(2.2, 6.5), temp: ramp(58, 78) });
  const lo = failureRisk({ vib: flat(2.2), temp: flat(58) });
  assert.ok(hi.score > lo.score + 0.3, `${hi.score} vs ${lo.score}`);
  assert.ok(hi.score <= 1 && lo.score >= 0);
  assert.ok(hi.drivers.length > 0);
  assert.ok(hi.horizonDays > 0);
});

test("empty input gives zero risk, not a crash", () => {
  assert.equal(failureRisk({ vib: [], temp: [] }).score, 0);
});

test("anomaly flags a step change and not a flat series", () => {
  assert.equal(anomaly(flat(5)).flagged, false);
  const step = [...flat(5, 180), ...flat(9, 20)];
  assert.equal(anomaly(step).flagged, true);
});

test("breakthrough risk rises with turbidity and head loss", () => {
  const bad = breakthroughRisk({ turbidity: ramp(0.15, 0.7), headloss: ramp(1.6, 2.6) });
  const ok = breakthroughRisk({ turbidity: flat(0.12), headloss: flat(1.0) });
  assert.ok(bad.score > ok.score);
  assert.ok(bad.hoursToLimit !== null);
});

test("storage hours", () => {
  assert.equal(storageHours({ levelPct: 50, capacityMl: 40, demandMlPerH: 5 }), 4);
  assert.equal(storageHours({ levelPct: 50, capacityMl: 40, demandMlPerH: 0 }), Infinity);
});

test("consequence is higher with no redundancy and little storage", () => {
  const bad = consequence({ redundancy: 0, storageHours: 3, compliance: true });
  const ok = consequence({ redundancy: 2, storageHours: 20, compliance: false });
  assert.ok(bad.score > ok.score);
  assert.ok(["high", "medium", "low"].includes(bad.label));
});

test("competence check: valid, lapsed, level too low, missing", () => {
  const comps = [
    { personId: "P1", competency: "trade:millwright", level: 3, validTo: "2028-01-01" },
    { personId: "P2", competency: "trade:millwright", level: 3, validTo: "2026-09-30" },
    { personId: "P3", competency: "trade:millwright", level: 1, validTo: "2028-01-01" }
  ];
  const req = { type: "trade:millwright", level: 2 };
  assert.deepEqual(competenceCheck({ id: "P1" }, comps, req, "2026-10-15"), { ok: true, reasons: [] });
  assert.match(competenceCheck({ id: "P2" }, comps, req, "2026-10-15").reasons[0], /lapsed/);
  assert.match(competenceCheck({ id: "P3" }, comps, req, "2026-10-15").reasons[0], /level/);
  assert.match(competenceCheck({ id: "P4" }, comps, req, "2026-10-15").reasons[0], /no /);
});
