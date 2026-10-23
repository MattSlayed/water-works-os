# Design: The Region map and satellite layer (Phase 3, project 2 of 3)

Status: **draft for Matthew's approval**, after the builder check.

Phase 3 has three projects, in this order:

1. Blueprint ingestion and the 3D plant. Built, and merged into `feat/phase2-workforce-intelligence`.
2. **The Region map and satellite layer** (this document).
3. The agents: the root-cause agent, the default agents and an agent studio. That design comes next.

Research behind this document:
- `../../../../04-PHASE3-VENDOR-RESEARCH.md`, ideas G1 to G4 (the LyraSense pattern rebuilt on open Sentinel data);
- the project 1 design, `2026-10-23-plant-blueprint-twin-design.md`.

## 1. Intent and the why

**Who it is for.** In Matthew's words: "the site manager, and whoever reports to him or her and whoevers incharge of operations". In the synthetic works that means:
- the works manager, P-001;
- the shift supervisors;
- the planner, P-004;
- the reliability engineers.

**What it is for.** The Region map is a **daily screen**, not only an investigation tool. Opened at 07:00, in ten seconds it tells the site manager:

1. **What changed overnight:**
   - new detections and alerts;
   - tagged things that moved, stopped or left their allowed area;
   - projects that slipped.
2. **Today's risks to supply:**
   - raw-water quality coming down the river;
   - capacity out of service;
   - reservoir levels.
3. **Where everything is:** fleet, contractors' vehicles and portable plant, set against today's jobs and projects.

**Accuracy matters.** Matthew said the map "would play a factor within the logs as well if they do impact or root cause analysis". So:
- every position, detection and index value carries its source and its age;
- a guess is never shown as a fact.

**What Matthew asked for:**
- **Tagged things on the same map:** "assets that have tags on them, tracking telemetry and location that pings on the same map".
- **Layers and focus:** a layered map, with filters and operations highlighted. He chose operation focus (option A). Option B (status highlight) and option C (saved views per role) come later.
- **A projects side tab:** "there are many projects that are ongoing on a treatment plant, they should be clickable on the side tab".
- **Zoom into the plant:** from the map down into the 3D plant built in project 1.
- **Sentinel:** the recommendations G1 to G4. He "loves" them.
- **Plume and plant linked:** the satellite plume and the plant telemetry are connected.

**What exists today:**
- a schematic SVG site map with zone rectangles, people counts per zone, muster and permits (`mapSvg`, `views.map` in `web/app.js`);
- `GEOREF` (origin -25.86, 28.62) and `toLonLat` in `src/layout.mjs`;
- one Project, `PRJ-CL3`;
- the raw-water turbidity sensor `SEN-RAW-turb`;
- the 3D Plant view;
- 18 agents.

**Nothing in the system has real-world coordinates yet** apart from the georeference of the plant model.

## 2. Goals, non-goals, anti-goals

**Goals**
- **G1 Geography.**
  - Synthetic geography in WGS84: the catchment, Riverbend Dam, the river reach, the intake, the raw-water main, and the bulk pipeline to the remote sites.
  - Areas of interest drawn on the dam.
  - Spatial functions that people and agents both use.
- **Remote fixed sites** along the bulk line, with live telemetry.
- **Tagged things.** Vehicles and portable plant ping position and telemetry. Each has allowed areas, and a ping always shows its age.
- **Projects side tab.** Seven projects, each with:
  - a footprint;
  - who and what is on site;
  - progress and money;
  - impact on operations;
  - issues and risks.
- **G2 Satellite.** Synthetic Sentinel-2 and Sentinel-1 scenes with water indices, a scene timeline and banded overlays.
- **The plume story.** It links the dam to raw-water turbidity, and from there to F07 as a contributing cause.
- **G3 Geo Watch.** Agent 19: detection → alert → proposals → sampling round by chat → a person confirms or rejects.
- **G4 live mode.** An optional mode against Microsoft Planetary Computer, tested with a fixture.
- **The 07:00 cards.** "Since you left" and "Today's supply risks".
- **Operation focus**, and **Enter plant** into the existing 3D view.

**Non-goals**
- Option B (status highlight) and option C (saved views per role).
- Tracking people: no dots, no trails, no phones or wearables.
- Real GPS or vehicle-tracking connectors. Data is synthetic only, but the ping shape is documented so that a connector can feed it later.
- Route optimisation or dispatch.
- InSAR ground movement: EGMS and OPERA do not cover South Africa.
- Commercial imagery and flood maps.
- Calibrated water quality from satellites.
- Real imagery tiles. Only the index grid is drawn, never RGB satellite pictures.

**Anti-goals.** Each of these would make it a failure even if it works. Matthew's choices:
1. **Clutter.** Too many dots, labels and colours at once, so the manager cannot see what matters at a glance.
2. **A surveillance feel.** It reads as tracking workers and contractors rather than running the operation.
3. **Slow or fragile.** Heavy on a site laptop or phone, or broken when the tiles or the internet are down.

**My call, added:** no **false confidence**. Matthew did not pick it, but his accuracy requirement implies it:
- a stale ping is never drawn as live;
- a cloudy scene is never read as clear water;
- an index is never shown as NTU (turbidity units) or µg/L;
- a detection stays "suggested" until a person confirms it.

## 3. Constraints

- **Stack.** Node 22, zero runtime dependencies, `node:test`, vanilla ES modules. Tests never touch the network.
- **Leaflet 1.9.4** is vendored under `web/vendor/leaflet@1.9.4/` with its licence, the same way as three.js.
  - It is not a package dependency.
  - An import map, or a classic script tag, serves it from `/vendor/...`.
- **Basemap.** OpenStreetMap raster tiles, loaded by the browser only, with attribution shown.
  - **Offline:** if no tile loads within 4 s, or the browser reports being offline, the map switches to a plain background. Every vector layer still draws.
  - The server never proxies or caches tiles.
- **Payload.** The region payload (`GET /api/region`) stays under about 300 KB as JSON.
  - Pings arrive as small events on the existing SSE stream.
  - Scene grids are fetched one scene at a time.
- **Budgets, on a mid-range laptop:**
  - the Region view is interactive in under 1.5 s on localhost;
  - no more than about 400 vector features are drawn at the default zoom;
  - clustering applies above that.
- **Clearance.** The existing view rules apply. `clipPath` works in plant-local metres against rectangles, so region lines and footprints are projected to local metres (the inverse of `toLonLat`) before clipping, and hidden zones stay rectangles in that frame.
  - A tagged thing, ping, detection or project footprint inside a zone above the viewer's clearance is hidden.
  - Lines are clipped at hidden zones with the existing `clipPath` in `src/server.mjs`.
  - Remote sites carry a zone like everything else.
- **Doctrine.** NOVATEK doctrine gates are waived ("apply no gate restrictions"). Departures from the rendering rules get rows in BRD Appendix D.
- **The project 1 timing test stays green.** F07 remains a local fault, and the other filters show no change onset. See §5.3.
- **Server and test rules.** The server stays on localhost. Commits carry the attribution lines.

## 4. Geography and data

### 4.1 Region geometry (synthetic, WGS84)

All geometry is synthetic and is labelled "synthetic works" on screen. It is placed on open land around the plant origin (-25.86, 28.62).

The plant sits near the dam's outlet side. Approximate extent: 25 km × 20 km.

| Object | Geometry | Notes |
|---|---|---|
| `CAT-RB` Catchment | polygon, about 180 km² | upstream of the dam |
| `WB-RB` Riverbend Dam (WaterBody) | polygon, about 6 km² | full-supply outline; extent changes come from scenes |
| `RIV-RB` river reach | polyline into the inflow arm | the plume travels down it |
| Intake | point on the dam shore | links to the plant's intake structure |
| Raw-water main | polyline from the intake to the works | follows existing `RB-L-001` at the plant end |
| Bulk pipeline | polyline from the works to remote sites | carries treated water out |
| `AOI-INFLOW`, `AOI-INTAKE`, `AOI-DAM` | polygons | the areas that scene statistics are computed over |
| Synthetic roads | polylines | the routes tagged things move along; drawn only when the basemap is off |
| Plant zones | polygons | the existing zone rectangles, converted through `toLonLat` |

**Spatial functions** go in `src/functions.mjs`. They work in WGS84 with a local equirectangular projection, which is accurate enough at this scale:
- `within(point, polygon)`;
- `distanceM(a, b)`;
- `nearestAlong(line, point)`;
- `objectsIn(areaId, types?)`.

Agents use the same functions, so a person and an agent get the same answer to "what is inside this area?".

### 4.2 Remote fixed sites

Seven fixed sites, each a `RemoteSite` with a position, a zone and sensors.

**New zones (my call).** Z13 to Z15 are real `Zone` objects, so the view rule covers them. They carry a `geo` polygon and no `rect`, and the schematic Site map (`consolePayload`, `mapSvg`) skips zones without a `rect`:
- Z13, bulk line and valve chambers: technician;
- Z14, pump station and reservoir yards: technician;
- Z15, PS-2 MCC room: supervisor, mirroring the plant's electrical Z10. This is the remote zone that J21 proves is pruned.

| Site | Sensors | Feeds |
|---|---|---|
| `PS-1`, `PS-2` booster pump stations | flow, discharge pressure, pump state | capacity and supply risk |
| `RES-1`, `RES-2` reservoirs | level (%), inflow, outflow | "hours of storage" in Today's supply risks |
| `VC-1`, `VC-2`, `VC-3` valve chambers | pressure, valve position | pipeline section status for projects |

- **Telemetry** comes from the existing `createTelemetry`, using its baseline, noise and fault-profile pattern.
- **`RES-2` is drawn down** by the reservoir relining project, which takes its sister cell out of service (§4.4).

### 4.3 Tagged things

There are twelve `Tracker` objects. Each one is bound to the thing it is fixed to.

**Vehicles (8):**
- two works bakkies;
- a coagulant delivery truck;
- a chlorine delivery truck;
- a sludge tanker;
- two contractor vehicles, linked to their projects;
- a sample boat on the dam.

**Portable plant (4):**
- portable pumps PP-1 and PP-2;
- a mobile genset;
- a sampling kit.

**Pings**
- **Fields:** `{trackerId, at, lat, lon, speedKmh, headingDeg, batteryPct, source}`.
- **Portable plant** also reports `runHours`, `fuelPct` and `state` (running, idle or off).
- **Frequency:** every 1 minute while moving and every 5 minutes while parked.
- **Generation:** the existing seeded random generator, moving along synthetic roads, scheduled against today's work orders and project days. Ping series cover the same window as `createTelemetry` and behave the same way at its end, so trackers never go stale merely because the demo clock ran past the data (my call).

**Allowed areas**
- Each tracker has a list of geofence polygons.
- Leaving one raises a `GeofenceEvent` and lists the tracker under "Since you left".
- Example: PP-2 parked outside its project footprint. It is the "off site?" case in the mockup.

**Age and history**
- A ping older than 15 minutes is **stale**: drawn grey and labelled with its age, for example "last seen 2 h 10 min ago".
- A ping older than 24 hours is **lost**.
- Ping history is kept for the whole synthetic period, so that analysis can replay it.

**Trails**
- Trails cover the last 6 pings and are **off by default**. They appear only in operation focus, for the trackers taking part.
- This is my call, aimed at the surveillance-feel anti-goal.

**People**
- People are never trackers.
- They stay as counts per zone (the existing muster and presence counts).
- Contractor activity shows only through the vehicles and plant linked to their project.

### 4.4 Projects

There are seven projects: the existing `PRJ-CL3` and six new synthetic ones.

| Project | Takes out of service | Footprint |
|---|---|---|
| `PRJ-CL3` Clarifier 3 scraper drive refurbishment (existing) | clarifier 3 (−25% clarification capacity) | Z04 clarifier 3 |
| `PRJ-RWM` Raw-water main section replacement | one of two raw-water main barrels, VC-1 to VC-2 (intake capacity capped) | strip along the main |
| `PRJ-RES2` Reservoir RES-2 relining | RES-2 cell B (storage −50% at RES-2) | RES-2 site |
| `PRJ-FMR` Filter media replacement F09–F12 | four filters, one at a time | filter gallery |
| `PRJ-INT` Intake screen upgrade | one intake screen | intake |
| `PRJ-SLG` Sludge lagoon desludging | none; tanker traffic | lagoons |
| `PRJ-PS2` PS-2 MCC upgrade | one PS-2 duty pump (standby only) | PS-2 site |

**New Project fields:**
- `footprint` (a polygon);
- `budgetZar`;
- `spendZar` (a synthetic time series of commitments);
- `takesOutOfService[]` (object ids and dates);
- `capacityImpact`: `{stage, capacityMlD | storagePct, text}`. Treatment stages (intake, raw-water main, clarification, filtration) each have a design capacity. **Treatment capacity today is the smallest stage capacity, not a sum of losses** (stages are in series). Outbound items (PS-2, reservoirs) count against supply and storage, not treatment (my call).

Existing fields are kept: milestones, claims, `channelId` and owner. New projects get milestones, claims and issues, in the same style as CL-3.

**The project panel** opens when a project is clicked in the side tab or on the map. It has four parts, all chosen by Matthew:

1. **Footprint and who is on it:**
   - the vehicles and portable plant inside the footprint now;
   - the permits and isolations in force (the existing Permit records).
2. **Progress and money:**
   - the existing `projectStatus`: milestones claimed and confirmed, and quiet days;
   - spend against budget;
   - the last weekly report from Scribe or Project Watch.
3. **Impact on operations:**
   - what is out of service and until when;
   - the capacity or storage effect today;
   - a "supply risk while it runs" line, computed from §6.2's rules.
4. **Issues and risks:**
   - open issues, overdue milestones, and alerts or geofence events inside the footprint;
   - each linked to its audit log entry.

### 4.5 Ontology additions

| Type | Key fields |
|---|---|
| `Region` | `id`, `kind` (catchment, waterbody, river, main, pipeline, road, aoi), `geometry` (GeoJSON-like), `zoneId?` |
| `RemoteSite` | `id`, `kind`, `lat`, `lon`, `zoneId`, sensors via existing Sensor links |
| `Tracker` | `id`, `kind` (vehicle, portable), `boundTo` (asset id or a free label), `projectId?`, `geofences[]`, `zoneId` (from the latest ping) |
| `Ping` | kept in the telemetry store, not as ontology objects; latest-ping fields are mirrored on the Tracker |
| `GeofenceEvent` | `trackerId`, `at`, `regionId`, `kind` (left, entered) |
| `Scene` | `id`, `mission` (S2, S1), `acquiredAt`, `cloudPct`, `usable`, `stats` per AOI, `gridRef` |
| `GeoDetection` | `id`, `sceneId`, `aoiId`, `kind` (plume, bloom, extent_change), `index`, `z`, `confidence`, `status` (suggested, confirmed, rejected), `reviewedBy?`, `sampleIds[]` |

- **Visibility.** Every new object carries `zoneId` or `zones[]` and is subject to the existing view rule.
- **Detection status.** `GeoDetection.status` uses the suggested / confirmed / rejected vocabulary that Phase 3b's Annotation (P4) will take over.
- **Samples.** They reuse the existing `Sample` type, with `point: "Raw water"` and a `detectionId`.

## 5. Satellite

### 5.1 Scenes

- **Sentinel-2:** a scene every 5 days.
- **Sentinel-1:** a scene every 6 days.
- **History for baselines (my call):** scene statistics (not grids) are generated for the 12 months before the telemetry window, from a seeded seasonal climatology per area. That gives each area about 70 Sentinel-2 and 60 Sentinel-1 scenes of history with no telemetry behind them. Grids exist only for scenes inside the telemetry window. The timeline shows the last 60 days by default.
- **Period:** the whole synthetic period.
- **Generation:** acquisition times use the real overpass pattern of about 10:00 local. Cloud cover comes from the seeded random generator, weighted for summer storms.
- **Unusable scenes:** a Sentinel-2 scene with cloud above 60% over an area of interest is marked `usable: false` for that area. The timeline shows it, but its statistics are not used and it is never read as clear water.
- **Sentinel-1** radar sees through cloud. It contributes the water extent (radar backscatter in dB) and is used for extent change.

### 5.2 Indices, statistics and grids

- **Indices per scene and area of interest:**
  - NDWI and MNDWI (water extent);
  - NDTI (turbidity);
  - NDCI (chlorophyll);
  - radar backscatter VV in dB.
- **Statistics** come in the Planetary Computer statistics response shape: count, min, max, mean, std and percentiles. Synthetic and live data therefore share one parser.
- **Grid.** Each scene also carries a coarse grid over `AOI-DAM` of about 60 m cells (roughly 2,000 cells). The Region view draws it as a banded overlay:
  - three bands per index: within normal, raised, high;
  - the bands are set from that area's baseline: mean ± 2σ over the usable scenes in the 90 days before it (a same-season window, so the dry-season baseline is not used in summer);
  - **never a continuous colour ramp**: this is a new BRD Appendix D row, following row 18's banding rule.
- **Labels.** Every index value shows "index, not calibrated".

### 5.3 The plume and F07 (reconciled with project 1)

Project 1 proved, under test, that **F07 is a local filter fault**:
- its head loss moves at the start of day 12;
- DP-2's loss of prime is real but cannot be its cause;
- fewer than two other filters show a change onset.

That test stays green. The plume is written as a **contributing cause**:

1. **Storm.** A storm on day 10 sends a plume down `RIV-RB` into the inflow arm.
2. **Scene.** The next usable Sentinel-2 scene (day 11) shows NDTI in `AOI-INFLOW` at z ≈ 2.6. Geo Watch raises a suggested detection.
3. **Intake.** The plume reaches `AOI-INTAKE`. `SEN-RAW-turb` rises from about 25 NTU to about 90 NTU over day 11 into day 12, after a travel delay derived from the distance along the dam (`distanceM` and a stated drift speed). `SEN-RAW-turb` has a daily swing of about 8 NTU, so its onset is found with `onsetMinute(..., {period: 1440})`. Working back from F07's onset (day 12 + 1 min) through the travel window, the raw-turbidity onset has to land between about day 11.8 and day 11.95.
4. **Clarifiers.** Clarifier load rises and floc carry-over increases a little.
   - Healthy filters absorb it within their normal noise: no change onset.
   - F07 is the weakest filter (its media fault is the existing day-12 profile), so it breaks through first.
5. **The answer.** The root-cause story is **"plume (contributing) + F07 media (local)"**. The root-cause agent in project 3 should reach exactly this, and the evals will check it.

**The calibration is a stated assumption.** The amount of raw-water turbidity rise, the extra carry-over and the drift speed are set so that:
- the raw-turbidity onset falls inside the travel window from intake to F07, using the existing `travelWindow`;
- no other filter crosses the onset threshold.

### 5.4 Geo Watch (agent 19)

A new entry in `AGENT_SPECS` (`src/agents.mjs`), with the same shape as the other 18:

| Field | Value |
|---|---|
| name | Geo Watch |
| purpose | Watch the dam and catchment in each new scene; raise and triage index anomalies and extent changes; ask for a raw-water sample |
| trigger | event: "Scene ingested" |
| tools | `raise_alert` (act), `propose_dose_change` (propose), `start_sampling_round` (propose), `notify` (act) |

**The loop:**

1. **Detect.** An index anomaly (z ≥ 2 against the area's baseline) or an extent change (MNDWI or Sentinel-1 water area ± 5%) creates a GeoDetection with status *suggested* and a confidence. It also raises an Alert that links to the detection.
2. **Propose.** A coagulant dose change for the plant, routed through the existing Proposal and autonomy dial; and a raw-water sampling round.
3. **Sample.** The seed data gains a released "Raw-water grab sample" procedure (released by P-001, like the other procedures) for the intake structure. On approval, `start_sampling_round` creates a sampling WorkOrder on the intake and starts its Execution. The step is sent by chat to the lab analyst on shift, through the existing channel. Chat Intake reads the reply ("raw 88 NTU at intake jetty") as the step's reading; a reading on a sampling Execution is also written as a `Sample` with the `detectionId` (my call: the existing procedure path, not a new lighter one).
4. **Confirm.** A person (lab analyst or engineer) confirms or rejects the detection, with the sample attached. Geo Watch never confirms its own detection.
5. **Log.** Each step is an audit entry carrying the scene id, the area, the index, z, the cloud percentage and the sample, so that analysis can cite it.

Geo Watch gets evals in `src/evals.mjs`, in the existing style:
- the plume scene → one suggested detection;
- a cloudy scene → no detection;
- an approval → a sampling round reaches the analyst;
- a self-confirmation is refused.

### 5.5 Live mode (G4)

- **Switch.** With `GEO_LIVE=1`, the server searches the Planetary Computer catalogue for Sentinel-2 L2A over a user-supplied area (`data/geo/live-aoi.geojson`) and requests statistics for NDTI, NDWI and NDCI. It uses Node's built-in `fetch`, with no login.
- **Example area.** The example file outlines a **real Gauteng dam**, labelled as such.
- **Kept separate.** Live results appear as a separate "Live: <name>" area and are never mixed into the synthetic works.
- **Tests.** They use a captured response fixture (`test/fixtures/pc-stats.json`). Live mode is never on in tests.
- **Failure.** If the network fails, the Region view shows "live data unavailable" and carries on with the synthetic data.

## 6. The Region screen

### 6.1 Layout

This builds on the mockup Matthew reacted to (`.superpowers/brainstorm/.../region-map.html`).

**Desktop:**
- **Left rail:** layers and filters.
- **Centre:** the map.
- **Right side tab:** two lists, **Projects** and **Operations**.
- **Top strip:**
  - the scene timeline (date strip, scene markers, cloud %);
  - the two 07:00 cards, which can be collapsed.
- **Navigation:** a new nav entry, `data-nav="region"`, sits next to Map and Plant. The existing schematic Map stays as the on-site view.

**Phone (under 720 px):** list-first. The order is:
1. the cards;
2. projects and operations;
3. a "Show on map" button that opens a simplified map with clusters and no grid.

### 6.2 The 07:00 cards

**"Since you left"** lists changes since this person's last visit to Region, **plus anything still open or unreviewed** whatever its age (suggested detections, open geofence breaches, lost trackers), marked "still open". The server stores `lastSeen` per person, in memory like the rest of the state. With no `lastSeen` (first visit, or after a restart) it defaults to 24 hours before now (my call). The list covers:
- new detections and alerts in the region;
- geofence events;
- trackers that went stale or lost;
- remote-site alarms;
- projects with a slipped milestone or a new issue.

The list caps at 8 lines, each a link that focuses the map on its subject. A "Mark seen" button resets `lastSeen`.

**"Today's supply risks"** has three short rules, each showing its inputs:
1. **Raw-water quality:** the latest usable index band at `AOI-INFLOW` and `AOI-INTAKE`, `SEN-RAW-turb` now, and any open plume detection.
2. **Capacity out of service:** design capacity minus today's treatment capacity (the smallest stage capacity, §4.4), in ML/d, against demand. On 14 October, CL-3 caps clarification at 90 ML/d and PRJ-RWM caps the raw-water main at 100 ML/d, so treatment capacity is 90 and 30 ML/d is out of service. Outbound items are listed separately under storage and supply.
3. **Storage:** RES-1 and RES-2 levels as hours of storage at today's outflow, flagged below 12 h.

### 6.3 Layers, filters and clutter

**Layers.** The default-on layers are bold.

| Layer | Default |
|---|---|
| **Basemap** | on |
| **Catchment and river** | on |
| Satellite index grid (NDTI ▾ choose index) | off |
| **Detections** | on |
| **Fixed plant and remote sites** | on |
| **Tagged things** | on |
| People (counts per zone) | off |
| **Alerts** | on |

**Filters:**
- by kind (pumps, vehicles, portable plant, contractors);
- "in alarm only";
- "stale or lost only".

**Clutter rules:**
- trackers cluster below zoom 14;
- labels show only on hover, selection or focus, with at most 12 at once;
- the plant's internal assets are not drawn on the region map: the works is one object until **Enter plant**.

### 6.4 Operation focus (option A)

Pick an operation from the Operations list, or from an object's panel:
- an alert response;
- a work order;
- a project;
- a detection response.

**Everything taking part lights up:**
- its assets and remote sites;
- the zones involved, with people counts;
- its trackers, with trails;
- its open steps and alerts.

Everything else drops to about 25% opacity. **Esc** or "Clear focus" restores the view.

**What takes part** is computed on the server from links that already exist: a work order's asset and assignee's zone, a project's footprint and `takesOutOfService`, an alert's asset, and a detection's area plus its sampling round. That way, the agents in project 3 can call the same function.

### 6.5 Enter plant

When the view is zoomed close over the works (zoom ≥ 16 with the works in view), a button **Enter plant** appears.

- It opens the existing Plant view (`views.plant`), framed on the plant-model object nearest the map centre, using the existing `frame` and `flyTo`.
- **Back to region** restores the map's centre, zoom, layers and focus. The state is kept in the URL hash, so the browser's back button works too.
- Selecting the intake or raw-water main in the region opens the plant on structure `10UPA01` or line `RB-L-001`.

### 6.6 Basemap, offline and fragility

- **Tiles.** OpenStreetMap tiles with attribution.
- **Plain background** when tiles fail (§3), with a small "basemap offline" note. Every layer still works.
- **No other network calls.** Live mode is server-side and optional.
- **Fallback.** If Leaflet fails to load, the view shows the 07:00 cards and the two lists, with a message instead of the map.

## 7. Security, privacy and logs

- **Clearance pruning** works the same as project 1, on `/api/region`, the SSE ping events and the scene grids. Pings inside hidden zones are dropped, not just hidden in the browser.
  - Fixes the project 1 deferred minor for the new events: SSE events for Region carry no ids of hidden objects.
- **No people tracking.** People are never positioned. Tracker pings carry no personal data: no driver name. A vehicle's assignment to a person sits on the work order, as it does today.
- **Audit.** Each of these is an audit or event entry with `source` (synthetic, live or person) and age at the time of use:
  - a geofence event;
  - a detection;
  - a confirmation or rejection;
  - a sampling round;
  - an operation focus used to drive an action.
- **Live mode** sends only the area's polygon to Planetary Computer, never works data.

## 8. Journeys

- **J17 — The 07:00 view (P-001, works manager).** Open Region.
  - "Since you left" lists:
    - the plume detection (suggested);
    - PP-2 outside its allowed area;
    - `PRJ-RWM` with a slipped milestone.
  - "Today's supply risks" shows:
    - the raw-water band "high" at the inflow;
    - 30 ML/d out of service;
    - RES-2 at 9 h of storage (flagged).
- **J18 — Plume response (shift supervisor, then the lab analyst).**
  1. Click the detection: the scene timeline jumps to day 11 and the NDTI grid shows the plume.
  2. Approve Geo Watch's sampling round. The analyst gets the chat and replies "raw 88 NTU at intake jetty". A Sample is recorded.
  3. The analyst confirms the detection.
  4. Operation focus "Plume response" lights up the sample boat, the intake, the coagulant truck with its ETA, and F07's alert at the works.
- **J19 — Project check (P-004, planner).** Projects tab → `PRJ-RES2`.
  - The map frames the RES-2 footprint, with the contractor vehicle on site.
  - The panel shows milestones, spend of R 1.9 m against R 2.4 m, "RES-2 storage −50% until 14 Nov", and one open issue linked to its log entry.
- **J20 — Down into the plant (P-002).** Zoom to the works → **Enter plant** → the Plant view framed on the intake → **Back to region** returns to the same map.
- **J21 — Technician view (a millwright).** Open Region.
  - Nothing inside Z06 or other zones above technician clearance appears: no trackers, pings or footprints.
  - Lines stop at the zone edge.
- **J22 — Offline.** Block the tile host. The map shows a plain background with all layers, and "basemap offline".

## 9. API (in the existing route table)

| Route | Returns |
|---|---|
| `GET /api/region` | geometry, remote sites with latest readings, trackers with latest ping and age, projects (summary plus footprint), detections, latest scene list; all pruned |
| `GET /api/region/scenes/:id/grid?index=ndti` | the banded grid for one scene (and its usable flag) |
| `GET /api/region/since` | the "Since you left" list for the caller; `POST` the same path marks it seen |
| `GET /api/region/risks` | Today's supply risks with their inputs |
| `GET /api/region/focus/:kind/:id` | the ids taking part in an operation |
| `GET /api/projects/:id/panel` | the four-part project panel |
| SSE `ping` and `geofence` events | the existing stream, pruned per subscriber |

Geo Watch tools go in `ACTIONS` (`src/actions.mjs`) with the existing target-type and autonomy checks: `propose_dose_change` and `start_sampling_round`.

## 10. Theirs: confirmed with Matthew (2026-10-23)

1. **Who:** the site manager, their reports and the operations lead.
2. **Daily screen:** what changed overnight, today's supply risks, and where everything is.
3. **Tagged:** vehicles and fleet, portable plant, and remote fixed sites. Not people's devices.
4. **Project panel:** footprint and who is on it; progress and money; impact on operations; issues and risks.
5. **Focus:** operation focus (option A) now. B and C come later.
6. **Anti-goals:** clutter, a surveillance feel, slow or fragile.
7. **Sentinel:** G1 to G4 as recommended.
8. **Plume and plant:** the plume links to raw-water turbidity and the F07 breakthrough.

## 11. My calls (Matthew to check while reading)

1. **Leaflet** 1.9.4, vendored, with OpenStreetMap tiles; a plain-background fallback when offline.
2. **The plume is a contributing cause**, not the sole cause, so that project 1's F07 timing proof stands (§5.3).
3. **Trails** are off by default and shown only in operation focus.
4. **No false confidence** is an anti-goal: stale pings greyed with their age, cloudy scenes unusable, indices never in NTU.
5. **Banded index grid**, never a continuous ramp (new BRD Appendix D row). The Leaflet vendoring gets a row too.
6. **Seven projects**, six of them new, with budget and spend in rand. The values are synthetic.
7. **Remote sites** get new zones Z13 to Z15, so the clearance rules cover them.
8. **The existing schematic Map stays.** Region is a new view next to it.
9. **Live mode** uses a user-supplied area, with a real Gauteng dam as the example, and is never mixed with synthetic data.
10. **Geo Watch** cannot confirm its own detections. A person confirms, with a sample.
11. **Scene history:** 12 months of scene statistics before the telemetry window give the baselines; the band baseline is a 90-day same-season window.
12. **Capacity** is the bottleneck stage, not a sum of losses. Outbound sites count against supply and storage.
13. **"Since you left"** shows new items since `lastSeen` plus anything still open, and defaults to 24 hours on a first visit.
14. **New zones** Z13 to Z15 are Zone objects with a `geo` polygon and no `rect`. Z15 (PS-2 MCC room) is supervisor.
15. **The sampling round** uses the existing procedure path: a seeded, released raw-water sampling procedure, a WorkOrder and an Execution. Its reading also becomes a Sample.
16. **Tracker pings** cover the same window as the telemetry, so they do not go stale merely because the demo clock runs on.

## 12. Left to the builder

- The exact synthetic coordinates, road routes and footprint shapes, within §4.1's extent and the "synthetic works" label.
- The tracker schedules and ping jitter.
- The cloud model and the exact index baselines.
- The banding colours, chosen from the NOVATEK palette and readable in both themes.
- The cluster styling and the label-collision method.
- The drift speed and the extra carry-over size in §5.3, provided the stated constraints hold.
- The Planetary Computer request details: collection `sentinel-2-l2a`, plus the expressions for each index.

## 13. Verification

- **Unit tests:**
  - spatial functions: within, distance, along, and `objectsIn` at area edges;
  - ping age states (live, stale, lost);
  - geofence events;
  - scene usability under cloud;
  - index statistics in the Planetary Computer shape (the synthetic data and the fixture both parse);
  - banding;
  - focus participants for each kind;
  - "Since you left" relative to `lastSeen`;
  - supply-risk rules;
  - the project panel numbers.
- **Plume tests:**
  - a detection appears on the day-11 scene;
  - the `SEN-RAW-turb` onset falls inside the travel window from intake to F07;
  - **the project 1 timing test still passes unchanged**;
  - the existing assertion that fewer than two other filters have an onset still holds (today none does, so the margin is thin: the extra carry-over must stay inside every healthy filter's noise).
- **Tests that change on purpose:** the Zone count in `generate.test` (12 → 15) and `AGENT_SPECS.length` in `agents.test` (18 → 19).
- **Geo Watch evals:** the four listed in §5.4.
- **Server tests:**
  - the `/api/region*` routes;
  - clearance pruning for a technician (J21), including that SSE pings from hidden zones are not sent;
  - the payload stays under 300 KB.
- **Browser checks:** journeys J17 to J22 in the running console, including a phone width and the blocked-tiles case.
- **Final review:** a whole-branch review before merge, as in project 1.
