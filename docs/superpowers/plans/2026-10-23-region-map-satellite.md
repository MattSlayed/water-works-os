# Region Map and Satellite Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Region view: the site manager's daily map with synthetic geography, remote sites, tagged vehicles and portable plant, seven projects, synthetic Sentinel scenes, the plume story, the Geo Watch agent and an optional live Planetary Computer mode.

**Architecture:**
- **Data modules.** Region data and logic live in small pure modules:
  - `src/region.mjs`: geography, remote sites, trackers and projects data;
  - `src/trackers.mjs`: ping series;
  - `src/scenes.mjs`: scenes, indices, grids and live-mode parsing;
  - `src/regionview.mjs`: the server-side read models for since, risks, focus and the project panel.

  Spatial functions go in `src/functions.mjs`.
- **Wiring.** `generate.mjs` seeds the new objects. `telemetry.mjs` gains remote-site profiles and the plume. `system.mjs` wires trackers and scenes. `server.mjs` adds the `/api/region*` routes with clearance pruning.
- **Browser.** `web/region.js` mounts a vendored Leaflet map, and `web/app.js` adds the `views.region` route.

**Tech Stack:** Node 22, zero runtime dependencies, `node:test`, vanilla ES modules, Leaflet 1.9.4 (vendored), three.js 0.160.0 (already vendored).

**Spec:** `docs/superpowers/specs/2026-10-23-region-map-satellite-design.md`

## Global Constraints

- Zero runtime dependencies. Leaflet 1.9.4 is vendored under `web/vendor/leaflet@1.9.4/` with its LICENSE, from the npm tarball, and recorded with its sha256. It is not a package dependency.
- Tests never touch the network. Live mode (`GEO_LIVE=1`) is never on in tests.
- Everything is labelled "synthetic works". Index values are always labelled "index, not calibrated", never NTU or µg/L.
- People are never positioned: no person dots, no person tracks. Pings carry no personal data.
- Clearance pruning happens on the server, for routes and SSE alike. Nothing in a zone above the viewer's clearance is sent.
- The region payload stays under 300 KB as JSON. No more than about 400 features are drawn at the default zoom; clustering applies above that.
- The project 1 timing test in `test/graph.test.mjs` passes unchanged.
- Python patch scripts write with `newline=''`. The server stays on localhost. Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01W6GcpDnBbSN7KtDkCEEoNC
  ```

## Plan-level rulings (from reading the code)

- **R1. Remote zones carry `rects` in plant-local metres.**
  - Z13 to Z15 carry `rects: [[x, y, w, h], ...]` in plant-local metres, plus `geo` polygons for display, plus `remote: true`. They have no single `rect`.
  - `hiddenZones(v)` in `src/server.mjs` becomes `flatMap((z) => z.rects || [z.rect])`, so `clipPath` works unchanged.
  - `mapPayload` skips zones with `remote: true`.
  - **Why:** clipping needs rectangles in the local frame (spec §3), and a zone has several separate yards.
- **R2. A ping is an ontology update of its Tracker.**
  - Each tick mirrors the latest ping onto the Tracker (`lat`, `lon`, `zoneId`, `pingAt`, ...). The existing ontology broadcast carries it, already pruned per viewer.
  - No new SSE kind is needed. GeofenceEvents are ontology objects upserted as the clock passes them.
- **R3. A ping's age is measured against `min(now, dataEnd)`.**
  - `dataEnd` is the end of the telemetry window, so the demo clock running on never makes trackers stale (spec §4.3).
- **R4. The sampling round uses a seeded Asset.**
  - `AST-SMP-RAW` is the raw-water sample point at the intake jetty: template `raw_sampling`, zone Z01.
  - Its released Procedure `PRC-RAW_SAMPLING-v1` has one step requiring the reading `turbidity` in `NTU`.
  - So `start_execution` and `complete_step` work unchanged. `complete_step` additionally writes a `Sample` when the execution's work order has `source` starting `GEO-`.
- **R5. Geo Watch is idempotent over scenes.**
  - It examines every scene with `acquiredAt + 3 h <= now` that has no `watchedAt`, and stamps `watchedAt` on each.
  - `createSystem` runs it once at start as the system user, so the day-11 detection exists at 07:00. The server's `tick` runs it again whenever a scene becomes due.
- **R6. Healthy filters are not given an extra carry-over term.**
  - The spec's "absorbed within noise" is modelled as no change. Only `SEN-RAW-turb` gets the plume.
  - **Why:** the existing allowance (fewer than two other filters with an onset) has no margin today.

## Review Focus

1. **Ping age at the boundaries.**
   - At exactly 15 min and 24 h, and after the clock passes `dataEnd`: 15 min is still live, at 24 h it is lost, and after `dataEnd` the state is frozen.
   - Pinned in Task 4.
2. **Polygon edges.**
   - A point exactly on an edge or vertex, an area id with no polygon, and `objectsIn` over an empty type list. A point on the edge counts as inside; an unknown area returns `[]`, not a throw.
   - Pinned in Task 1.
3. **A baseline with too little history.**
   - An area with fewer than 3 usable scenes in the 90-day window, a 60%-cloud scene exactly at the threshold, and σ = 0.
   - Expected: band `"unknown"` and no detection. 60% counts as usable; above 60% does not.
   - Pinned in Task 5.
4. **A technician's stream and routes.**
   - A Tracker in Z15, a GeofenceEvent in Z15, the focus route for a footprint in Z15, and a project panel listing a Z15 tracker.
   - None of them is sent, and focus omits the hidden ids.
   - Pinned in Task 8.
5. **Live-mode failure.**
   - A fetch that rejects, times out (10 s) or returns malformed JSON.
   - Expected: `{ ok: false, reason }`, the Region view shows "live data unavailable", and the synthetic data is unaffected.
   - Pinned in Task 7.

---

### Task 1: Region geography, remote zones and spatial functions

**Files:**
- Create: `src/region.mjs`
- Modify: `src/layout.mjs`, `src/generate.mjs`, `src/functions.mjs`, `src/server.mjs` (`hiddenZones`, `mapPayload`)
- Test: `test/region.test.mjs` (new), `test/generate.test.mjs` (Zone count 12 → 15)

**Interfaces:**
- Produces, from `src/layout.mjs`:
  - `toLocal([lon, lat]) -> [x, y]`, the inverse of `toLonLat`.
- Produces, from `src/region.mjs`:
  - `REGION`: an array of `{ id, kind, name, geometry: { type: "Polygon" | "LineString" | "Point", coordinates } }`. Ids:
    - `CAT-RB` (catchment);
    - `WB-RB` (waterbody);
    - `RIV-RB` (river);
    - `INT-RB` (intake, a point);
    - `RWM-RB` (main);
    - `BLK-RB` (pipeline);
    - `RD-1`… (roads);
    - `AOI-INFLOW`, `AOI-INTAKE`, `AOI-DAM` (areas of interest).
  - `REMOTE_ZONES`: `[id, name, clearance, hazard, rects[], geo]`.
- Produces, from `src/functions.mjs`:
  - `within([lon, lat], polygon) -> boolean` (an edge counts as inside);
  - `distanceM(a, b) -> number`;
  - `nearestAlong(lineCoords, point) -> { distanceM, alongM, index }`;
  - `objectsIn(ont, areaId, types?) -> object[]`, for objects with `lat`/`lon`, or `geometry`, or plant objects through `toLonLat` of their centre.

- [ ] **Step 1: Write the failing tests** in `test/region.test.mjs`:
  - `toLocal(toLonLat([x, y]))` round-trips within 0.01 m.
  - Every REGION geometry lies inside a 25 km × 20 km box centred on `GEOREF.origin`.
  - Areas by the shoelace formula on local metres:
    - `CAT-RB` is between 150 and 210 km²;
    - `WB-RB` is between 4 and 8 km².
  - Containment:
    - `AOI-INFLOW`, `AOI-INTAKE` and `AOI-DAM` are each inside `WB-RB` (every vertex `within`);
    - `INT-RB` is within 50 m of the `WB-RB` boundary;
    - `RWM-RB` ends within 30 m of `toLonLat` of structure `10UPA01`'s centre.
  - Spatial functions:
    - `within` is true for a vertex and for an edge midpoint;
    - `distanceM` from origin to origin + 0.01° latitude is 1113 ± 2 m;
    - `objectsIn(ont, "AOI-NOPE")` returns `[]`.
  - Zones:
    - the ontology has 15 Zones;
    - Z15 has clearance `supervisor`;
    - remote zones have `rects` and no `rect`;
    - `mapPayload` for P-001 lists exactly 12 zones.
  - The existing `test/server.test.mjs` map tests stay green.
- [ ] **Step 2:** Run `node --test test/region.test.mjs test/generate.test.mjs`. Expected: FAIL (missing exports).
- [ ] **Step 3: Implement.**
  - **Geography:** coordinates are left to the builder (spec §12) within the tests' bounds. Lay the dam out NW of the works and the bulk pipeline running roughly east, so Z13's rects stay narrow.
  - **Seeding:** `generateWorks` adds `Region` objects (one per REGION entry) and the Zones Z13 to Z15 from `REMOTE_ZONES`.
  - **Server:** apply rulings R1 (`hiddenZones` flatMap) and the `mapPayload` filter.
- [ ] **Step 4:** Run `npm test`. Expected: all pass, with generate's count updated to 15.
- [ ] **Step 5:** Commit: `feat(region): synthetic WGS84 geography, remote zones, spatial functions`.

### Task 2: Remote sites and their telemetry

**Files:**
- Modify: `src/region.mjs` (`REMOTE_SITES`), `src/generate.mjs`, `src/telemetry.mjs` (`PROFILE`)
- Test: `test/region.test.mjs`

**Interfaces:**
- Produces: seven `RemoteSite` objects with `{ id, kind: "pump_station" | "reservoir" | "valve_chamber", name, lat, lon, zoneId }`:
  - `RS-PS1`, `RS-PS2`, `RS-RES1`, `RS-RES2`, `RS-VC1`, `RS-VC2`, `RS-VC3`.
- Produces these sensors, with `processUnitId` = the site id:
  - pump stations: `SEN-PS1-flow` (ML/d), `SEN-PS1-press` (bar), `SEN-PS1-state` (0/1), and the same for PS2;
  - reservoirs: `SEN-RES1-level` (%), `-in`, `-out` (ML/d), and the same for RES2;
  - valve chambers: `SEN-VC1-press` (bar), `SEN-VC1-pos` (%), and the same for VC2 and VC3.
- Produces: RemoteSites with a `capacityMl` field: RES1 = 40 and RES2 = 30. RES2 runs at half capacity while `PRJ-RES2` is active.

- [ ] **Step 1: Write the failing tests:**
  - 7 RemoteSites exist; PS2's is in Z14 (its yard) and its MCC sensor `SEN-PS2-state` is in Z15.
  - Each of the 17 sensors has a non-null `tel.latest`.
  - Every remote site is within 300 m of `BLK-RB`, by `nearestAlong`.
  - `SEN-RES2-level` at `tel.now()` corresponds to 8–10 h of storage at the current `SEN-RES2-out` flow (J17's "about 9 h").
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `PROFILE` keys `PS1-flow`, … in the existing `[base, noise, diurnal]` shape. Calibrate the RES2 level so the storage test holds at the clock start.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(region): remote pump stations, reservoirs and valve chambers with telemetry`.

### Task 3: Projects, capacity and the treatment bottleneck

**Files:**
- Modify: `src/region.mjs` (`PROJECTS`, `STAGE_CAPACITY`), `src/generate.mjs`
- Create: `src/regionview.mjs`
- Test: `test/projects-region.test.mjs` (new)

**Interfaces:**
- Produces, from `src/region.mjs`:
  - `STAGE_CAPACITY = { intake: 130, main: 130, clar: 120, filt: 120 }` (ML/d);
  - `DESIGN_ML_D = 120`.
- Produces: seven Projects. `PRJ-CL3` gains the new fields; the six others are new: `PRJ-RWM`, `PRJ-RES2`, `PRJ-FMR`, `PRJ-INT`, `PRJ-SLG`, `PRJ-PS2`. New fields:
  - `footprint` (Polygon coordinates);
  - `budgetZar`;
  - `spend: [{ at, zar }]`;
  - `takesOutOfService: [{ id, from, to }]`;
  - `capacityImpact: { stage, capacityMlD? | storagePct?, text }`;
  - each also gets milestones, a `channelId` and an owner, in the PRJ-CL3 style.
- Produces, from `src/regionview.mjs`:
  - `treatmentCapacity(ont, isoDay) -> { capacityMlD, byStage, limiting, outOfServiceMlD }`;
  - `supplyImpacts(ont, isoDay) -> [{ projectId, text, storagePct? }]`.

- [ ] **Step 1: Write the failing tests:**
  - On `2026-10-14`, `treatmentCapacity` returns `capacityMlD` 90, `limiting` `"clar"` and `outOfServiceMlD` 30.
    - CL-3 caps `clar` at 90; RWM caps `main` at 100; FMR caps `filt` at 110.
  - On `2026-12-01`, after the projects end, it returns 120 and 0.
  - `PRJ-RES2` spend at the clock is R 1.9 m against `budgetZar` R 2.4 m.
  - `PRJ-RWM` has a milestone overdue and unclaimed at the clock (the "slipped" item in J17).
  - Every footprint polygon is valid: closed ring, at least 4 points.
  - `PRJ-PS2` counts in `supplyImpacts`, not in `treatmentCapacity`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** Capacity is the minimum over stages, where each stage takes the smallest `capacityMlD` among active impacts and otherwise its design value.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Existing project tests (`test/projects.test.mjs`) are still green.
- [ ] **Step 5:** Commit: `feat(region): seven projects with footprints, money and capacity impact`.

### Task 4: Trackers, pings and geofences

**Files:**
- Create: `src/trackers.mjs`
- Modify: `src/region.mjs` (`TRACKERS`), `src/generate.mjs`, `src/system.mjs`
- Test: `test/trackers.test.mjs` (new)

**Interfaces:**
- Produces, from `src/region.mjs`: `TRACKERS`, 12 entries `{ id, kind: "vehicle" | "portable", name, boundTo, projectId?, geofences: [regionOrFootprintId], route }`. Ids:
  - vehicles: `TRK-BAK1`, `TRK-BAK2`, `TRK-COAG`, `TRK-CL2`, `TRK-SLUDGE`, `TRK-CON1`, `TRK-CON2`, `TRK-BOAT`;
  - portable plant: `TRK-PP1`, `TRK-PP2`, `TRK-GEN`, `TRK-KIT`.
- Produces, from `src/trackers.mjs`:
  - `createTrackers({ ont, seed, start, minutes }) -> { latest(id, cursorMin), history(id, n, cursorMin), geofenceEvents(fromMin, toMin), dataEndMin }`;
  - a ping is `{ trackerId, at, lat, lon, speedKmh, headingDeg, batteryPct, source: "synthetic", zoneId, runHours?, fuelPct?, state? }`;
  - `pingState(pingAtIso, nowIso, dataEndIso) -> "live" | "stale" | "lost"`.
- Produces: `sys.trackers`. The `Tracker` objects carry the latest-ping fields (R2), and `GeofenceEvent` objects are `{ id, trackerId, at, regionId, kind: "left" | "entered", zoneId }`.

- [ ] **Step 1: Write the failing tests:**
  - 12 Trackers exist; no Tracker has `boundTo` a Person.
  - A tracker moving pings every minute; a parked one every 5 minutes.
  - **Age states** (Review Focus 1). With `now = T`:
    - a ping at T − 15 min → `"live"`;
    - T − 15 min − 1 s → `"stale"`;
    - T − 24 h → `"lost"`;
    - with now 3 days past `dataEnd`, a ping at `dataEnd` → `"live"`.
  - `TRK-PP2` has a `left` GeofenceEvent on day 13, and its latest ping is outside the `PRJ-RWM` footprint.
  - `TRK-CON1` (`PRJ-RES2`) is inside the `PRJ-RES2` footprint at the clock (J19).
  - A ping whose position falls in a Z15 rect has `zoneId` `"Z15"`.
  - The same seed gives identical series, and a different seed gives different ones.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Movement follows each tracker's route polyline at a scheduled speed.
  - `zoneId` comes from `toLocal` plus the rect test over all zones (a shared `zoneAtLocal` in `src/region.mjs`, which plant.mjs's `zoneAt` may reuse).
  - **Startup:** `createSystem` upserts GeofenceEvents up to `tel.now()`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(region): synthetic trackers with pings, age states and geofence events`.

### Task 5: Scenes, indices, grids and the plume

**Files:**
- Create: `src/scenes.mjs`
- Modify: `src/telemetry.mjs` (plume on `SEN-RAW-turb`), `src/system.mjs`, `src/generate.mjs` (Scene objects)
- Test: `test/scenes.test.mjs` (new), `test/graph.test.mjs` (add one test; the existing tests unchanged)

**Interfaces:**
- Produces, from `src/scenes.mjs`:
  - `makeScenes({ seed, historyFrom: "2025-10-01", windowStart, windowEnd }) -> Scene[]`.
    - Sentinel-2 scenes on window days ≡ 1 (mod 5) at 08:00Z, and every 5 days back through the history. Sentinel-1 scenes every 6 days at 16:30Z.
    - Scene: `{ id: "S2-YYYYMMDD" | "S1-YYYYMMDD", type: "Scene", mission, acquiredAt, cloudPct, usable: {aoiId: bool}, stats: {aoiId: {ndti, ndwi, mndwi, ndci, vv?}}, inWindow }`.
    - Each stat is `{ min, max, mean, std, count, median, valid_percent, percentile_2, percentile_98 }`, the Planetary Computer statistics shape.
  - `baseline(scenes, aoiId, index, atIso) -> { mean, std, n } | null`: null when `n < 3` usable scenes fall in the prior 90 days.
  - `bandOf(value, base) -> "normal" | "raised" | "high" | "unknown"`:
    - `"raised"` beyond +2σ;
    - `"high"` beyond +3σ;
    - `"unknown"` if `base` is null or `std === 0`.
  - `sceneGrid(scene, index, cellM = 60) -> { cells: [[lon, lat, value]], band: string[] }`, for in-window scenes only (deterministic, computed on demand).
  - `PLUME = { stormDay: 10, sceneDay: 11, intakeOnsetDay: 11.88 }` (window days from 2026-10-01).

- [ ] **Step 1: Write the failing tests** (`test/scenes.test.mjs`):
  - **Usability.**
    - Scene `S2-20261012` is usable for `AOI-INFLOW` with `cloudPct` 31.
    - `S2-20261007` has `cloudPct` 72 and is unusable.
    - A synthetic scene at exactly 60% is usable; at 60.1% it is not (Review Focus 3).
  - **Baselines and bands.**
    - The NDTI z-score of `S2-20261012` at `AOI-INFLOW` is between 2.4 and 2.8; the band is `"raised"`.
    - `bandOf(x, null)` is `"unknown"`, and so is `bandOf(x, {mean: 1, std: 0, n: 5})`.
    - The first historical scene's baseline is `null`.
  - **History.** About 70 S2 and about 60 S1 history scenes (± 3), with summer-mean NDTI above winter-mean NDTI.
  - **Grid.** `sceneGrid` for the day-11 scene has between 1,500 and 2,500 cells, and the plume cells sit in `AOI-INFLOW`.
  - **Shared parser.** The stats objects have exactly the keys of `test/fixtures/pc-stats.json`'s first expression, so live and synthetic share the parser. The fixture is captured in Task 7, so add a placeholder with those keys now.
- [ ] **Step 2: Add the plume timing test** to `test/graph.test.mjs` (the existing tests stay untouched). Name it `"plume: raw-water turbidity onset falls inside the intake→F07 travel window; F07 stays local"`. Using the existing `hist`, `opts` and `processPaths(S("10UPA01"), S("15HFA07"))`:
  - `raw = onsetMinute(hist("SEN-RAW-turb"), { baseline: 2 * day, period: 1440 })`;
  - `f07 = onsetMinute(hist("SEN-F07-headloss"), opts)`;
  - assert `raw` is between `1.8 * day` and `1.95 * day` from the day-10 slice;
  - assert `w.onsetH * 60 <= f07 - raw` and `f07 - raw <= w.tailH * 60`.
- [ ] **Step 3:** Run `node --test test/scenes.test.mjs test/graph.test.mjs`. Expected: the new tests FAIL; the existing graph tests PASS.
- [ ] **Step 4: Implement.**
  - **The plume in `telemetry.mjs`:** for `SEN-RAW-turb`, when `d >= 11.88`, add `65 * min(1, (d - 11.88) / 0.6)`, decaying by `exp(-(d - 13) / 2)` after day 13. No change to the filters (R6).
  - **Scene stats** in `AOI-INFLOW` carry the plume from day 10.5. `AOI-INTAKE` carries it from 11.88.
  - **Wiring:** `createSystem` adds the Scene objects (stats only; grids on demand). The cloud model is otherwise the builder's choice.
- [ ] **Step 5:** Run `npm test`. Expected: all PASS, **including every existing `test/graph.test.mjs` test unchanged**.
- [ ] **Step 6:** Commit: `feat(region): synthetic Sentinel scenes, index baselines, bands, grids and the storm plume`.

### Task 6: Geo Watch, detections and the sampling round

**Files:**
- Modify: `src/agents.mjs` (spec and behaviour), `src/actions.mjs` (four actions, `TARGET_TYPES`), `src/generate.mjs` (`AST-SMP-RAW` and `PRC-RAW_SAMPLING-v1`), `src/evals.mjs`, `src/system.mjs`, `src/server.mjs` (`tick`)
- Test: `test/geowatch.test.mjs` (new), `test/agents.test.mjs` (18 → 19)

**Interfaces:**
- Consumes: `baseline`, `bandOf`, Scenes (Task 5); `createTrackers` (Task 4).
- Produces: the `AGENT_SPECS` entry:

  ```js
  v({ name: "Geo Watch",
      purpose: "Watch the dam and catchment in each new scene; raise and triage index anomalies and extent changes; ask for a raw-water sample",
      trigger: { kind: "event", on: "Scene ingested" },
      tools: ["raise_alert", "propose_dose_change", "start_sampling_round", "notify"],
      autonomy: { raise_alert: "act", propose_dose_change: "propose", start_sampling_round: "propose", notify: "act" } })
  ```
- Produces these actions:
  - `record_detection` (agent `act`): creates `GeoDetection { id: "GEO-…", sceneId, aoiId, kind, index, z, confidence, status: "suggested", zoneId, sampleIds: [] }`.
  - `propose_dose_change`: needs `act`, ceiling `propose`; params `chemicalId`, `change`, `reason`.
  - `start_sampling_round`: needs `act`, ceiling `propose`; params `detectionId`. On apply it:
    1. creates a WorkOrder on `AST-SMP-RAW` with `kind: "sampling"` and `source: <detectionId>`;
    2. schedules it to the lab analyst on shift;
    3. starts its Execution;
    4. sends the step by chat with the existing `send_message`.
  - `review_detection`: ceiling `"human"`; params `detectionId` and `verdict` (`confirmed` or `rejected`). It refuses if the actor is an agent, and refuses when no Sample is attached and the verdict is `confirmed`.
- Produces: `complete_step` also creates a `Sample { point: "Raw water", detectionId, analyte: "turbidity", value, unit: "NTU", takenAt }` when the execution's work order `source` starts `GEO-` (R4), and appends the sample to `detection.sampleIds`.

- [ ] **Step 1: Write the failing tests** (`test/geowatch.test.mjs`):
  - After `createSystem`, exactly one GeoDetection exists, with `status` `"suggested"`, `sceneId` `S2-20261012`, `aoiId` `AOI-INFLOW`, `kind` `"plume"` and an Alert linking to it. This is R5.
  - No detection is made for `S2-20261007`, the cloudy scene.
  - Running Geo Watch again creates no duplicate.
  - **Approve, sample, confirm:** approving the `start_sampling_round` proposal as a shift supervisor:
    1. a running Execution exists for the lab analyst on shift;
    2. that person's channel receives one outbound message;
    3. an inbound reply "raw 88 NTU at intake jetty", through `sys.channels` the same way `test/channels.test.mjs` does it, records `Sample.value` 88 with the `detectionId`;
    4. `review_detection` by the analyst with `confirmed` sets the status to `"confirmed"` and `reviewedBy`.
  - `review_detection` invoked by an agent actor is refused. `confirmed` with no sample is refused.
  - `AGENT_SPECS.length` is 19. Update the agents test to name `"Geo Watch"` in the catalogue list, and to say "4 workforce agents and Geo Watch".
- [ ] **Step 2: Add the Geo Watch evals** to `EVALS["Geo Watch"]`, in the existing grader style:
  - "one suggested plume detection on the day-11 scene";
  - "no detection on a cloudy scene";
  - "an approved sampling round reaches the analyst";
  - "refuses to confirm its own detection".
- [ ] **Step 3:** Run `node --test test/geowatch.test.mjs test/agents.test.mjs`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - The behaviour detects `z >= 2` against `baseline`, or an MNDWI or VV water-area change beyond ±5%.
  - `confidence = min(0.95, 0.5 + 0.15 * (z - 2))`, and lower when `cloudPct > 30`.
  - The audit evidence lists the scene id, area, index, z, `cloudPct` and the sample id.
  - Server `tick` runs Geo Watch when any scene becomes due.
- [ ] **Step 5:** Run `npm test`. Expected: PASS, with `runEvals` for Geo Watch all green.
- [ ] **Step 6:** Commit: `feat(region): Geo Watch agent, detections, sampling round by chat, human review`.

### Task 7: Live mode (G4)

**Files:**
- Create: `src/geolive.mjs`, `data/geo/live-aoi.geojson`, `test/fixtures/pc-stats.json` (replaces the Task 5 placeholder), `test/fixtures/pc-search.json`
- Test: `test/geolive.test.mjs` (new)

**Interfaces:**
- Produces: `liveStats({ aoi, fetch = globalThis.fetch, timeoutMs = 10000 }) -> Promise<{ ok: true, name, scene: { id, acquiredAt, cloudPct }, stats } | { ok: false, reason }>`.
  - It searches `sentinel-2-l2a` over the area for the last 30 days (least cloudy item first), then requests statistics for NDTI, NDWI and NDCI.
  - Endpoints and expressions are the builder's choice (spec §12).
- Produces: the server reads `GEO_LIVE=1` and exposes the result as `region.live`. It is never mixed into the synthetic Scenes.

- [ ] **Step 1: Capture the fixtures** once, by hand, with a real request. This is the only network use, and it is outside the tests.
  - The area file outlines Rietvlei Dam, labelled `"example: Rietvlei Dam (real, approximate outline)"`.
  - Record the capture date in the fixture's `_captured` key.
- [ ] **Step 2: Write the failing tests**, using an injected `fetch` that returns the fixtures:
  - `ok: true` with the three indices.
  - The stats keys equal those of the synthetic Scene stats.
  - Review Focus 5: an injected fetch that rejects, one that never resolves (with `timeoutMs: 50`), and one returning `"not json"` each give `{ ok: false }` with a reason. None of them throws.
  - `generateWorks` output is unchanged whether `GEO_LIVE` is set or not.
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4:** Implement it using Node's built-in `fetch` and `AbortController`.
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(region): optional live Planetary Computer statistics behind GEO_LIVE`.

### Task 8: Region API, the 07:00 cards, focus and the project panel

**Files:**
- Modify: `src/regionview.mjs`, `src/server.mjs`
- Test: `test/region-api.test.mjs` (new)

**Interfaces:**
- Produces, from `src/regionview.mjs` (each takes a view `v`):
  - `regionPayload(sys, v)`;
  - `sinceYouLeft(sys, v, lastSeenIso) -> [{ kind, id, text, at, stillOpen }]`, capped at 8;
  - `supplyRisks(sys, v) -> { rawWater, capacity, storage }`, each with `inputs`;
  - `focusOf(sys, v, kind, id) -> { ids, trackerIds, zoneIds }`, where kind is `alert`, `workorder`, `project` or `detection`;
  - `projectPanel(sys, v, id) -> { footprint: {trackers, permits}, progress: {status, spendZar, budgetZar, lastReport}, impact, issues }`.
- Produces these routes, from the spec §9 table:
  - `GET /api/region`;
  - `GET /api/region/scenes/:id/grid?index=`;
  - `GET` and `POST /api/region/since`;
  - `GET /api/region/risks`;
  - `GET /api/region/focus/:kind/:id`;
  - `GET /api/projects/:id/panel`.

  `lastSeen` is held in a `Map` in `createServer`, defaulting to now − 24 h.

- [ ] **Step 1: Write the failing tests:**
  - **J17, as P-001.**
    - `/api/region/since` contains the plume detection (`stillOpen: true`), `TRK-PP2` left an area, and `PRJ-RWM` slipped a milestone.
    - `/api/region/risks` gives `capacity.outOfServiceMlD` 30, `rawWater.band` `"raised"` or `"high"`, and RES2 `storageHours` between 8 and 10 with `flagged: true`.
  - **J19.** `/api/projects/PRJ-RES2/panel` gives `spendZar` 1900000, `budgetZar` 2400000, `TRK-CON1` in `footprint.trackers`, at least one issue with an `auditId`, and impact text containing `"RES-2 storage"`.
  - **Mark seen.** `POST /api/region/since`, then `GET` returns only items that are still open.
  - **Focus.** After the round is approved, `/api/region/focus/detection/<id>` includes:
    - `TRK-BOAT`;
    - `TRK-COAG` (bound to `CHEM-COAG`, the chemical in the detection's dose proposal);
    - `INT-RB`;
    - the sampling WorkOrder;
    - the F07 alert, because the rule takes active Alerts on plant objects in `downstreamOf` the intake structure that were raised after the detection.

    It includes no RemoteSite.
  - **J21 and Review Focus 4, as a technician:**
    - `/api/region` has no Tracker, ping trail point or footprint vertex inside Z15 rects (checked with `toLocal`);
    - a hidden Tracker upsert is not written to that technician's SSE stream (the existing SSE test pattern);
    - focus on `PRJ-PS2` omits Z15 ids;
    - the panel for `PRJ-PS2` lists no Z15 tracker.
  - **Size and grid.**
    - `JSON.stringify(/api/region)` is under 300,000 bytes.
    - The grid route for `S2-20261012` returns `bands` only from `normal`, `raised`, `high`, `unknown`.
    - The grid route for a history scene gives 404.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Trails go in `regionPayload` only on request (`?trails=<trackerIds>`, used by focus), and their points are filtered by zone.
  - `regionPayload` sends the remote and region geometry clipped with `clipPath` after `toLocal` (R1).
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(region): region API, since-you-left, supply risks, operation focus, project panel`.

### Task 9: The Region view in the browser

**Files:**
- Create: `web/region.js`, `web/vendor/leaflet@1.9.4/` (`leaflet-src.esm.js`, `leaflet.css`, `images/`, `LICENSE`)
- Modify: `web/index.html` (nav `data-nav="region"` after Site map, import map entry `"leaflet": "/vendor/leaflet@1.9.4/leaflet-src.esm.js"`, css link), `web/app.js` (`views.region`, routing, `views.refreshRegion` on SSE), `web/styles.css`
- Test: `test/web.test.mjs`

**Interfaces:**
- Consumes: the Task 8 routes.
- Produces: `mountRegion(container, data, { onSelect, onFocus, onEnterPlant }) -> { focus(ids), clearFocus(), setLayer(name, on), setScene(id, index), view(): {center, zoom}, dispose() }`, plus `window.__region = { features, labels, offline }` for browser checks.

- [ ] **Step 1: Write the failing tests** in `test/web.test.mjs`. Fetch the files from the running test server:
  - `/vendor/leaflet@1.9.4/LICENSE` returns 200 and contains "BSD";
  - `index.html` has `data-nav="region"` and the `leaflet` import-map entry;
  - `app.js` contains `views.region`, `"Since you left"`, `"Today's supply risks"` and `"index, not calibrated"`;
  - `region.js` contains `"basemap offline"`, `"Enter plant"` and `"synthetic works"`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** to spec §6.
  - **Layout:**
    - a left rail with layers and filters (defaults per §6.3);
    - a right side tab with Projects and Operations;
    - a top strip with the timeline and the two cards.
  - **Map behaviour:**
    - grid clustering below zoom 14 (no plugin);
    - at most 12 labels;
    - focus fades the rest to 25% opacity and clears on Esc;
    - **Enter plant** appears at zoom ≥ 16 over the works and routes to `#/plant/<nearest plant-model id>`;
    - state lives in the hash (`#/region?c=lat,lon&z=..&focus=..`) so Back restores it.
  - **Fallbacks:**
    - **Tiles:** a tile-error or 4 s timeout switches to a plain background and shows "basemap offline".
    - **Leaflet missing:** if the import fails, show the cards and the lists with a message.
    - **Phone:** under 720 px, a list-first layout.
  - **Vendoring:** download Leaflet from `https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz` and record its sha256 in the commit message.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(region): Region view with layers, cards, timeline, focus, projects tab and Enter plant`.

### Task 10: Docs and browser journeys

**Files:**
- Modify: `README.md` (rows, J17 to J22 demo steps, vendored Leaflet, test count), `../02-BRD-Water-Works-OS.md` (v0.4; Appendix D rows 20 and 21: the banded index raster, and the vendored Leaflet with OpenStreetMap tiles), `../README.md` (spec link)
- Test: browser checks (Playwright), then `npm test`

- [ ] **Step 1:** Update the docs in the existing style; the patch scripts write with `newline=''`.
- [ ] **Step 2:** Run `npm start` and walk J17 to J22 in the browser:
  - J17 to J20 and J22: as P-001, P-002 and P-004 and the lab analyst, as the spec describes;
  - **J21:** as a millwright;
  - **J22:** route `tile.openstreetmap.org` to fail;
  - **phone:** at 390 px.

  Expected: each journey's stated outcome. Record a screenshot per journey in the scratchpad.
- [ ] **Step 3:** Run `npm test`. Expected: all pass. Report the count.
- [ ] **Step 4:** Commit: `docs: Region map and satellite layer (Phase 3 project 2)`, then run the final whole-branch review.
