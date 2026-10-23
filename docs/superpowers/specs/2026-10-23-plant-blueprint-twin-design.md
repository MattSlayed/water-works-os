# Design: Plant blueprint ingestion and the 3D plant twin (Phase 3, project 1 of 3)

Status: **approved by Matthew 2026-10-23**, after the builder, water-engineering and 3D-graphics checks. Phase 3 has three projects in this order:

1. **Blueprint ingestion and the 3D plant** (this document).
2. The regional map and satellite layer.
3. The root-cause agent.

Research behind Phase 3: `../../../../04-PHASE3-VENDOR-RESEARCH.md` (NVT-PROJ-BBR-WTW-004).

## 1. Intent and the why

What Matthew asked for, in his words:

- the plant's blueprint is "used as a form of data ingestion along with the telemetry, reports and asset machinery";
- the plant is "a literal digital twin … a 3-D modelled plant … as close to realistic as possible";
- it can switch between a **blueprint mode** ("like a skeletal map") and a **real physical view**;
- you reach it by zooming in from the geospatial view;
- root-cause analysis is done by an AI agent that reasons by "actually understanding the blueprint of the plant".

What exists today:

- twelve zone rectangles on an SVG site plan;
- Positions and assets with KKS tags and process stages;
- `FEEDS` links between process units;
- a three.js twin of single assets.

There are no drawings, no pipes or channels, no physical layout of tanks and buildings, and no 3D model of the whole works.

This project makes the plant's **drawing set** a data source:

1. Drawings are ingested, graded and bound to the telemetry tags, asset records and documents the system already holds.
2. A person reviews them, and a competent person releases them as a **plant model revision**.
3. The released revision produces a 3D plant with a physical view and a blueprint view, from which you click down into the existing asset twin.
4. The released revision also gives projects 2 and 3 their foundations: real coordinates for the map, and a process graph with travel windows for the root-cause agent.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Ingest the drawing set as data. Every structure, every machine position, every line or channel, every valve and every instrument becomes a record with its source region and an evidence grade.
2. Bind to what exists:
   - equipment tags to Positions and Assets (KKS);
   - instrument tags to Sensors (whole historian tag);
   - documents and reports that cite those tags.

   Ambiguity goes to a person.
3. Release revisions. A newer drawing revision becomes a draft. On release, the twin changes and the old revision is superseded.
4. A 3D model of the whole works, generated from the released revision:
   - **Physical view:** architectural-visualisation realism, procedural, in the browser.
   - **Blueprint view:** blue edges, tags, flow arrows.

   Clicking a building opens it in place to show its machines, and from a machine you go into the asset twin.
5. Process-graph functions over the released revision: upstream/downstream sets with split fractions, paths, and **travel windows** that scale with measured flow.

**Non-goals (this project)**

- The regional map, the satellite layer, zooming in from the map, and operation focus. These are project 2. This project provides the georeference and the camera API.
- The root-cause agent. This is project 3. This project provides the graph functions.
- Reading scanned PDFs, OCR, real DWG, STEP or IFC, or photogrammetry. These follow NAB-012 §8.1 later.
- CAD-accurate equipment. Geometry is template geometry, with the disclosure badge.
- Hydraulic simulation. Flows come from the process flow diagram (PFD) and mass balance; travel windows are design estimates.

**Anti-goals (a failure even if it works)**

- The plant shows something the drawings don't say, presented as fact. Every rendering carries a disclosure: "Generated from plant model rev A (drawing set RB-DS rev A). Template geometry, not survey or CAD. Synthetic works."
- Extracted data is used as fact before release. Agents and graph functions read released revisions only.
- The plant looks backwards to a process engineer. Gravity falls from the inlet down to the clear-water reservoir, and tanks are sized for 120 ML/d.
- Ingestion silently overwrites records. Conflicts with existing records stay as cells or flags for a person, and existing Positions, Assets and Sensors are never rewritten by a release.
- Data from a zone the viewer can't see reaches their browser.

## 3. Constraints

- **Builds on Phases 1 and 2 as they stand:**
  - in-memory ontology with audience and clearance pruning;
  - typed actions, the autonomy dial and the audit log;
  - agents and SSE;
  - zero runtime dependencies, Node 22, `node:test` offline.
- **three.js 0.160.0 and the addons the plant uses are vendored into `web/vendor/three@0.160.0/`** and served by the Node server. The import map points there. *(My call: water-works OT networks are often offline, and Playwright checks need local files. About 1.3 MB committed.)*
- **Follows NAB-012** for the review and release mechanics:
  - graded cells (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`);
  - review marks;
  - a content hash and `governs` interval;
  - a source register with rights;
  - position kept apart from unit;
  - DEXPI for P&IDs;
  - the disclosure badge.
- **P&ID connections stay context, as NAB-012 says.** Flow direction and design flow come from the **PFD/mass balance and the line list**, not the P&ID, as in a real drawing set. This removes the doctrine departure the first draft proposed. *(Water engineer's point, adopted.)*
- **Departures from NAB-012 §7 rendering rules, recorded for BRD Appendix D** under "apply no gate restrictions". Motion and colour are tied to records:
  - the clarifier rake turns only while its drive's state is running; it is a centre drive, so the bridge is fixed and the rake arms turn;
  - the water surface has a gentle ripple, off under reduced motion;
  - flow arrows are static glyphs;
  - an alert outline pulses only while an alert record exists, and is steady under reduced motion;
  - basin water is tinted by **status band** (in limit / near / over) from the nearest turbidity analyser, never a continuous colour ramp;
  - template 3D is used for the whole works, not only hero assets, because Matthew asked for a literal 3D plant.

## 4. The blueprint as data

### 4.1 The synthetic drawing set (real, text-based formats)

The drawing set stands in for what a 120 ML/d works really has. Filters use the real "typical" convention: one P&ID sheet drawn for a typical filter, plus a tag table covering F01–F12.

| Sheet | Format | Carries |
|---|---|---|
| `RB-GA-001` site general arrangement | **DXF R2000 ASCII**: `LWPOLYLINE`, `CIRCLE`, `LINE`, `TEXT`, `INSERT` + `ATTRIB` | Structures (outline or centre plus diameter, base level, height); machine blocks inside structures with offsets; roads, fence, yard piping routes and channels on layers. Title block per the NOVATEK template, including a **georeference** `{crs: "EPSG:4326", origin: [lat, lon], rotationDeg}` used by project 2. |
| `RB-HP-001` hydraulic profile | DXF | Per structure: top water level (TWL), floor and invert levels. The source of the falls. |
| `RB-PFD-001` PFD and mass balance | DEXPI-style XML | Process streams, design flows at 120 ML/d, split fractions (four clarifiers at ¼ each, twelve filters with N−1 in service), recycle streams (washwater recovery return ≤ 10 %, supernatant) |
| `RB-LL-001` line list; `RB-EL-001` equipment list; `RB-IL-001` instrument list | CSV | The binding sources: line number, service, conveyance, DN or width × depth, normal direction, mode (continuous or intermittent); equipment KKS tags; instrument KKS tags with sample point |
| `RB-PID-01..08` P&IDs | **DEXPI-style XML** (a documented subset of DEXPI 1.3 Proteus: `Equipment`/`TagName`/`Nozzle`, `PipingNetworkSegment` with `Connection FromID/ToID`, `PipingComponent` valves, `ProcessInstrumentationFunction`; KKS codes in `GenericAttributes`) | Sheets: 01 intake and inlet; 02 coagulant, polymer and lime dosing; 03 flash mix, flocculation and splitter; 04 typical clarifier and sludge draw; 05 typical filter (about 6 actuated valves) with tag table F01–F12; 06 backwash pumps, air-scour blowers, washwater recovery; 07 gas-chlorine system, contact tank, clear-water reservoirs; 08 high-lift pumps, surge vessel, outgoing main. |

How the drawings are produced:

- `scripts/make-drawings.mjs` exports pure functions that **generate the drawing text** from the layout constants. The script writes the drawings to `data/drawings/` for people to open. The seed calls the same functions in memory, so `generateWorks()` stays pure and deterministic.
- `data/drawings/README.md` documents the DXF and DEXPI subsets.
- **Rev B** (filter media replacement project on F01–F04) ships unreleased: `RB-PID-05` rev B, `RB-LL-001` rev B and `RB-GA-001` rev B. It adds a new nozzle-lateral underdrain and a **filter-to-waste line** on F01–F04, and moves the washwater outlet. It produces new items, changed cells and one `AMBIGUOUS` "old washwater outlet: removed or abandoned?" *(Engineer's suggestion; the first draft's air-scour header contradicted the existing blowers.)*

### 4.2 Fixes to the Phase 1 layout and data (made before generating drawings)

These are my calls, from the water engineer's read.

- **Site enlarged and zones resized for real sizing at 120 ML/d:**
  - four circular clarifiers of about 32 m diameter in a 2×2 arrangement;
  - twelve filters of about 7 × 11 m in two rows either side of a pipe gallery;
  - a flash-mix chamber and splitter;
  - a chlorine contact tank of about 3,500 m³;
  - two 20 ML covered reservoirs with embankments (Z07 is enlarged);
  - a washwater recovery tank and thickener;
  - an inlet Parshall flume.

  Zone ids, names and clearances are unchanged; rectangles and coordinates change. Tests that assert coordinates are updated under TDD.
- **Hydraulic grade:** gravity falls about 6 m from inlet TWL to clear-water TWL. Filters take about 3.5 m of that.
- **Filter KKS fixed to two digits** (`15HFA01`…`15HFA12`). Historian tags are updated to match; the Tag Matcher evals still pass.
- **Disinfection is gas chlorine,** as the Phase 1 seed already says (1-tonne drums, chlorine hazard zone). The P&ID shows drums on scales, a vacuum regulator, chlorinators, an ejector with booster pump, leak detection and a scrubber. CHL-A and CHL-B are relabelled chlorinators. Their twin template stays a simplified skid and says so in its disclosure.
- **Large duty pumps relabelled to horizontal axially split double-suction:** raw-water, high-lift and backwash (40–60 ML/d, DN500–700 nozzles). The part breakdown the Phase 2 procedures use (bearing housing, sleeve, seal, impeller, wear ring) still applies. Template label and disclosure updated.

### 4.3 Ingestion: drawing → cells → binding → release

1. **Register.** Each sheet becomes a `Drawing` record:
   - number, revision, kind, format, sha256, title block;
   - rights `{owner, licence, hostable, derive, transmit_offregion}`;
   - `sourceRef`.
2. **Extract** with parsers in `src/ingest/`:
   - `dxf.mjs`;
   - `dexpi.mjs`, a small XML subset parser written for the documented subset;
   - `csv.mjs`.

   Every value becomes a cell `{field, value, grade, region, reasoning}`:
   - attributes, DEXPI elements and list rows are `EXTRACTED`;
   - values computed from geometry are `INFERRED`;
   - disagreements between sheets are `AMBIGUOUS` (for example, a tag on the GA but on no P&ID, or a DN that differs between the line list and the P&ID).
3. **Bind** by **whole tag**. KKS equipment tags go to Positions and Assets; instrument KKS tags go to Sensors via `historianTag`; tags are also matched to Documents that cite them.
   - Exact match: `EXTRACTED`.
   - Token-overlap match: `INFERRED`, with its score.
   - No match, or more than one match: `AMBIGUOUS`.

   A drawing value that disagrees with an existing record (zone or stage) is an `AMBIGUOUS` cell citing both. Release never rewrites the existing record. If accepted, a flag goes to the record's owner as an Issue.
4. **Review.** A grid with rows as items and columns as fields; each cell opens its reasoning and source region.
   - `EXTRACTED` cells can be accepted in bulk per sheet.
   - Every `INFERRED` and `AMBIGUOUS` cell must be individually reviewed or corrected.
   - Cells whose content is unchanged from the previous released revision **carry their review marks forward**, matched by content hash. A rev B review then only touches what changed.
5. **Release.** `release_plant_model` is human-only. It needs engineer clearance or above and a valid `c-model` competence. **The releaser must not be the last reviewer** (four eyes). The release names the content hash, and the action re-checks it.
   - `c-model` is seeded for P-001 (works manager) and P-003 (second reliability engineer).
   - J13 runs as: P-002 reviews, P-001 releases.

### 4.4 What a release writes (revision-scoped)

- **Plant objects carry their revision.** Ids look like `PM-RB-A/STR-15HFA07` and every object has `modelId`. A release does not update or delete earlier revisions' objects. It sets `PlantModel.status` (`released` / `superseded`) and `governs {from, to}`.
- **Readers ask for the current released model.** `currentPlantModel()` returns it; the graph functions, the API and the twin read only its objects. This needs no unlink support in the ontology.
- **Existing Positions, Assets and Sensors are not rewritten.** Plant objects link to them (`STR -CONTAINS-> Position`, `Sensor -AT-> SamplePoint`).

### 4.5 Ontology additions

| Type | Key fields | Notes |
|---|---|---|
| `Drawing` | number, rev, kind (`ga`, `hp`, `pfd`, `ll`, `el`, `il`, `pid`), format, sha256, titleBlock, rights, sourceRef | Source register |
| `PlantModel` | id `PM-RB-<rev>`, rev, status (`draft`, `in_review`, `released`, `superseded`), governs, sources[], cells[], packageHash, reviews[], release `{by, at, hash}`, georef | One per revision; cells live here |
| `Structure` | modelId, tag, kind, zoneId, outline or centre+diameter, baseLevel, height, TWL, volume | Civil structures. Kinds: `inlet_works`, `parshall_flume`, `flash_mix`, `flocculator`, `splitter`, `clarifier_circular`, `filter_bed`, `pipe_gallery`, `contact_tank`, `reservoir_covered`, `washwater_tank`, `thickener`, `pump_house`, `chemical_store`, `chlorine_house`, `mcc`, `lab`, `admin`, `surge_vessel`, `channel` |
| Machine placement | modelId, positionId, structureId, offset `[x, y, z]`, rotation | Positions (pumps, blowers, dosing, drives, chlorinators, generator) placed inside structures. Position and unit are kept apart, as Phase 1 already does. |
| `Line` | modelId, lineNumber, service, conveyance (`pipe` DN, or `channel` width × depth), from, to (nozzle or structure), path (polyline with levels), normalDirection, mode (`continuous` / `intermittent`), designFlow, splitFraction, causal (bool), recycle (bool), injectionAt? | Services: raw, flocculated, settled, filtered, chlorinated, final, backwash supply, dirty washwater, filter-to-waste, supernatant return, sludge, coagulant, polymer, lime, chlorine (vacuum/solution), air (scour), instrument air, service water, sample, drain or overflow. `causal = true` for process streams **and chemical dosing lines**, so the root-cause walk reaches DP-2 at its injection point. Utility, instrument and drain lines are `causal = false`. |
| `Valve` | modelId, tag, kind, lineId, normal state, actuated | About 70 on the filter tag table |
| `SamplePoint` | modelId, lineId or structureId, position (before or after a dose point), lagMin | Analysers measure a sample point, not a box. Sample-line lag counts toward travel windows. |
| Links | `Structure -CONTAINS-> Position`; `Line -FROM/TO->` structure or nozzle; `Sensor -AT-> SamplePoint`; `Drawing -SHOWS->` any; `PlantModel -INCLUDES->` any | `FEEDS` between ProcessUnits stays for Phase 1 readers |

### 4.6 Process-graph functions (`src/functions.mjs`, over the current released model)

- **`upstreamOf(id, g, {depth})` and `downstreamOf(id, g, {depth})`**
  - Return **sets with split fractions**. F07's upstream is all four clarifiers at ¼ each.
  - Walk `causal` lines only, and stop at `recycle` edges, marking them, so cycles terminate.
  - Intermittent lines (backwash, filter-to-waste) are included only when `{mode: "backwash"}` is asked for.
- **`processPaths(fromId, toId, g, {limit})`:** all simple paths up to a depth limit, not just one.
- **`travelWindow(path, g, {flowMlD})`**
  - Per item, residence time t = V ÷ (Q × split), with Q from **measured flow** when given (inlet flow sensor), else design flow.
  - Clarifiers and contact tanks: onset ≈ T10 using the baffling factor.
  - Reservoirs: an exponential response.
  - Lines: length ÷ velocity. Sample-line lag is added.
  - Returns `{onsetH, meanH, tailH, basis: "design values at Q=…"}`. Root-cause comparisons use the window, not a single shift.
  - Expected at 120 ML/d: intake → filter outlet mean ≈ 4 h, onset ≈ 1–1.5 h.
- **`graphFrom(released)`** builds the graph.
- **Viewer pruning:** for a viewer, the graph is computed over **their pruned model**. Results can differ by clearance, which matches how the rest of the system behaves. Agents running as SYSTEM see the whole model.

**Note for projects 2 and 3.** As the telemetry stands, DP-2's prime loss and F07's breakthrough start together on day 12, with no lag. A travel-window-aware agent should therefore conclude that **F07 is a local filter fault and DP-2 is real but not its cause**. Project 2 adds the satellite plume and a raw-water turbidity rise that loads every filter; F07 is the one that breaks through, so it is the weak filter. That gives project 3 a two-cause story. A graph test here asserts the timing argument.

## 5. The 3D plant

### 5.1 Where it lives

- A new **Plant** view at `#/plant`, and `#/plant/<id>`.
- `web/plant.js`:
  - `mountPlant(container, model, { mode, onSelect })`;
  - API: `flyTo(id)`, `highlight(ids)`, `setMode(m)`, `setStates(map)`, `dispose()`.
- Project 2 uses this API for the map zoom and operation focus.
- Clicking selects. The camera moves only on an explicit "Fly to" or "Open", per NAB-012 §7 rule 7.
- **Click-down, my call:** selecting a pump house, blower house or chlorine house makes its roof and walls translucent, showing its machines in place. These use the hero asset templates at low segment counts. "Open twin" on a machine goes to `#/asset/<id>`.
- `dispose()` releases geometries, materials and textures, then calls `forceContextLoss()`. The same fix is applied to `twin.js`.

### 5.2 Physical view

Architectural-visualisation realism, procedural, with no external models or images.

- **Lighting**
  - A PMREM environment from a sky, with ACES tone mapping.
  - A **fixed mid-morning sun** with soft shadows: 2048 shadow map by default, 4096 on high. The shadow map is baked once and re-baked only on rebuild.
  - Horizon fog.
- **Fake ambient occlusion:** decals under structures and gradients at wall bases. Screen-space AO (GTAO) is optional on the "high" quality tier only.
- **Materials:** procedural canvas textures for concrete, with grime near bases, gravel, grass and asphalt. A small shared material set: concrete, galvanised, painted steel, ductile iron, glass and water.
- **Geometry**
  - Clarifiers: lathe profiles, a launder lip, and a fixed bridge with rake arms.
  - Basins and filters: extruded with bevelled wall tops.
  - Handrails, walkways, windows, flanges and valves: instanced.
  - Buildings: extruded from GA outlines with a parapet, roof and glazing.
  - Reservoirs: covered, with grass embankments.
  - Terraces: follow the hydraulic profile, with retaining walls.
  - Pipework: instanced cylinders per material.
  - Underground lines: a faded dashed line at grade.
  - Channels: open concrete.
- **State:** each machine, its plinth and its status light are tinted by the asset's state. Whole basins are not tinted.
- **Labels:** CSS2D only, never baked into geometry. They appear on hover or selection.
- **Quality tiers**
  - **Medium (default):** 2048 shadows, no post-processing.
  - **High (opt-in):** 4096 shadows and GTAO, if the vendored addon is present.
  - Pixel ratio is capped at 1.5.
  - Reference device: Intel Iris Xe-class integrated GPU at 1080p.
- **Budget:** fewer than 150 k triangles and about 250 draw calls.
- **Rendering on demand:** frames are drawn on camera changes, state updates and transitions. A continuous loop runs only while the water ripple or the rake is visible and reduced motion is off.

### 5.3 Blueprint view

- Navy background; merged edges per colour.
- A hidden-line look by default, with an x-ray toggle.
- Process lines are thick and coloured by service, with static flow arrows (normal direction).
- Utility and instrument lines are thin and dashed.
- "Skeletal map" toggle: shows process lines, footprints and labels only.
- Labels:
  - equipment and structures always;
  - valves and instruments only past a zoom threshold or when selected;
  - decluttered on a screen grid by priority (selected > alert > equipment > rest).
- Dimensions are shown for the selected item only.
- The cross-fade between views (≈ 300 ms) composites two render targets. It is instant under reduced motion.

### 5.4 Weak devices and phones

- **No WebGL or a lost context:** the existing SVG site plan, `mapSvg`, extended with structure outlines and line paths from the released model, with the same click-through to records.
- **Viewport under 720 px, or `deviceMemory` ≤ 4, or a median frame time over 33 ms across the first 30 frames:** blueprint view, no shadows.

### 5.5 Pruning in the scene

- `GET /api/plant` is pruned on the server, so withheld geometry never reaches the browser.
- Structures, machines and valves in a hidden zone are left out.
- Line segments inside a hidden zone are left out, so the line is cut at the zone boundary.
- No "withheld" slab is drawn: the hidden zone is simply absent, per NAB-012 §7 rule 2.
- Lines get a `zones[]` field, computed from their path, for this.

### 5.6 Living blueprint demo (J13)

1. P-002 ingests the rev B sheets.
2. The grid shows new underdrain and filter-to-waste items, changed washwater cells, and one `AMBIGUOUS` cell.
3. Unchanged cells arrive already reviewed.
4. P-002 reviews; P-001 releases.
5. The plant re-renders over SSE with the filter-to-waste lines on F01–F04, and the badge names rev B.

## 6. Journeys

- **J13 — living blueprint:** as in §5.6.
- **J14 — click-down:** P-001 opens Plant in the physical view, selects the high-lift pump house (it opens translucent), selects HLP-B in place, and chooses "Open twin". The exploded asset twin follows.
- **J15 — blueprint reading:** P-002 switches to the blueprint view and selects F07. Upstream lights up back to the intake through all four clarifiers at ¼ each, plus the coagulant dosing point. Captions read "onset ≈ 1.2 h, mean ≈ 4 h (design values at 118 ML/d measured)".
- **J16 — phone:** a supervisor at 390 px gets the blueprint view. Tapping an item opens its record.

## 7. API (in the existing route table)

| Route | Returns |
|---|---|
| `GET /api/plant` | The current released model, pruned for the viewer, with machine states |
| `GET /api/plant/models`, `/models/:id` | Revisions; one revision with its cells and review state |
| `POST /api/plant/ingest {drawingIds}` | Engineer and above: extraction and binding produce a draft `PlantModel` |
| Actions | `review_cells` (engineer; bulk-accept `EXTRACTED` per sheet; individual marks for the rest), `release_plant_model` (human-only, engineer+, `c-model`, not the last reviewer, hash checked) |
| `GET /api/plant/graph/upstream/:id`, `/downstream/:id`, `/paths?from=&to=`, `/window?path=…&flow=…` | Graph functions over the viewer's pruned released model |

## 8. Theirs: confirmed with Matthew

- **Location (decision 2):** the works origin is placed at about **-25.86, 28.62**, City of Tshwane, Gauteng, east of Pretoria.
  - Map search finds no named dam or water treatment works within about 8 km.
  - The synthetic Riverbend Dam is drawn up-valley.
  - Everything is labelled "synthetic works".
  - **Confirmed by Matthew 2026-10-23.**

## 9. Left to the builder

- The exact DXF, DEXPI and CSV subsets.
- Material and mesh parameters.
- Synthetic design values within the water engineer's ranges, recorded in `data/drawings/README.md`.
- Pagination of the review grid. The set is about 1,500 cells once valves are counted.
- Whether the Plant view shares the Copilot panel.

## 10. Verification

- **Parsers:** run over the committed drawings. Assert counts, grades, the seeded `AMBIGUOUS` cells, and that the DXF and DEXPI subsets round-trip from `make-drawings.mjs`.
- **Binding:** every hero asset is bound by its whole tag; one deliberately unmatched tag; the F01/F10 prefix trap is gone.
- **Release:**
  - the hash is stable under register changes;
  - the four-eyes rule holds;
  - review marks carry forward for unchanged cells;
  - superseded objects are not read;
  - existing records are untouched.
- **Graph:**
  - upstream of F07 contains all four clarifiers at ¼ and reaches the coagulant injection point;
  - recycle stops the walk;
  - the travel window scales as 1/Q;
  - the timing test concludes DP-2 does not explain F07 on the current telemetry.
- **Pruning:** a technician gets no Z06 structures and lines cut at the Z06 boundary; the graph API for a technician omits Z06 nodes.
- **Browser (Playwright):**
  - both views render;
  - the toggle works;
  - J13, J14 and J16 run end to end;
  - `window.__plant` reports fewer than 150 k triangles and fewer than 250 draw calls;
  - no-WebGL falls back to SVG.

  Frame rate is checked by hand on a GPU, because headless rendering is software-only.
- **Final review:** a review workflow, as in Phase 2.
