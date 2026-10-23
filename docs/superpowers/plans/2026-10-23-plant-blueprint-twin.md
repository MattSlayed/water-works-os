# Plant Blueprint Ingestion and 3D Plant Twin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The plant's drawing set (GA, hydraulic profile, PFD, lists, P&IDs) is ingested as graded data, bound to existing records, released as a revision, and rendered as a 3D plant with physical and blueprint views, plus process-graph functions for projects 2 and 3.

**Architecture:** A layout module drives pure drawing generators. Text parsers and extraction produce cells. A released `PlantModel` materialises revision-scoped objects into the ontology; the seed ships rev A released, and rev B is ingested live. Graph functions read the current released model. A new `web/plant.js` renders it with vendored three.js.

**Tech Stack:** Node 22, zero runtime deps, `node:test`, vanilla ES modules, three.js 0.160.0 vendored.

**Spec:** `docs/superpowers/specs/2026-10-23-plant-blueprint-twin-design.md`

## Global Constraints

- No runtime dependencies; tests offline; `npm test` green after every task.
- Agents, graph functions and `/api/plant` read the **current released** `PlantModel` only. A release never rewrites existing Position, Asset or Sensor records.
- Plant object ids are `PM-RB-<rev>:<KIND>-<tag>` (colon, not slash), and each object has `modelId`.
- Disclosure text, verbatim: "Generated from plant model rev {rev} (drawing set RB-DS rev {rev}). Template geometry, not survey or CAD. Synthetic works."
- Cell grades are only `EXTRACTED`, `INFERRED` and `AMBIGUOUS`. A cell is `{key, sheet, field, value, grade, region, reasoning, reviewed:{by,at}|null}`, where `key = "<tag>|<field>"`.
- Georeference: `{crs: "EPSG:4326", origin: [-25.86, 28.62], rotationDeg: 0}`, site metres x→east, y→south.
- Python patch scripts write files with `newline=''`. The repo is `eol=lf`.

## Review Focus

1. **Ingesting rev B twice, or ingesting a sheet older than the released one**, must be refused with a reason and create no draft. Test in Task 5.
2. **A release attempted by the last reviewer, or with an unresolved `AMBIGUOUS` cell, or with a stale hash** must be refused. Test in Task 5.
3. **A technician's plant payload must contain no point inside the Z06 rectangle**, including line vertices. Test in Task 7.
4. **Graph walks over recycle loops must terminate**, and upstream of the clear-water reservoir must not include the filters via backwash. Test in Task 6.
5. **No WebGL, or a lost context**, must give the SVG fallback with working links, not a blank panel. Checked in the browser in Task 9.

---

### Task 1: Layout module and Phase 1 corrections

**Files:** Create `src/layout.mjs`. Modify `src/generate.mjs` (import ZONES and structures from layout; KKS; labels; c-model), `src/server.mjs` (map payload `bounds`), `web/app.js` (mapSvg viewBox from bounds). Test `test/layout.test.mjs`.

**Interfaces — Produces:**
- `ZONES` (same ids, names, clearances, hazards; new rects)
- `STRUCTURES: [{tag, kind, zoneId, centre:[x,y] | outline:[[x,y]...], diameter?, w?, l?, baseLevel, height, twl?, volumeM3?}]`
- `MACHINES: [{positionTag, structureTag, offset:[x,y,z], rotDeg}]`
- `GEOREF`
- `siteBounds(): [minX, minY, maxX, maxY]`
- `toLonLat([x,y]): [lon, lat]`, using dLat = −y/111320 and dLon = x/(111320·cos(lat0))

- [ ] **Step 1: write failing tests.**
  - Every structure lies inside its zone's rect.
  - Zones do not overlap.
  - Four `clarifier_circular` structures with diameter 30–34 and a 2×2 layout.
  - Twelve `filter_bed` structures, each 7×11, in two rows of six.
  - One `contact_tank` with volumeM3 between 2,500 and 5,000.
  - Two `reservoir_covered` structures with volumeM3 = 20,000.
  - TWL strictly falls along the inlet → flash_mix → flocculator → clarifier → filter → contact_tank → reservoir order, with a total fall of 5–7 m.
  - Every hero position (RWP-A…GEN-1, CHL-A/B) has a MACHINES entry whose structureTag exists.
  - `toLonLat([0,0])` deep-equals `[28.62, -25.86]`.
  - `generateWorks(7)`: F07's kks is `"15HFA07"` and SEN-F07-turb's historianTag is `"15HFA07.TURB"`.
  - CHL-A's Asset `assetClass` is `"Chlorinator"`.
  - HLP-A's `assetClass` matches `/split-case/i`.
  - P-001 and P-003 hold a valid `c-model` Competency.
- [ ] **Step 2: run** `node --test test/layout.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: implement `src/layout.mjs`** within the water engineer's ranges (spec §4.2 and the research notes):
  - Zones keep their order along x.
  - Z07 widens to fit two 84 m embanked reservoirs.
  - `generate.mjs` takes ZONES from it.
  - Filter KKS becomes `15HFA${pad2}`.
  - CHL templates are relabelled "Chlorinator" and big pumps "Horizontal split-case pump"; parts and procedures are unchanged.
  - `c-model` for P-001 and P-003.
  - The server map payload adds `bounds`, and mapSvg uses it for the viewBox.
- [ ] **Step 4: run** `npm test`. Expected: all pass, including Phase 1/2 suites; fix any test that asserted old layout facts and ledger it.
- [ ] **Step 5: commit** `feat: layout module sized for 120 ML/d; KKS, chlorinator and pump-class fixes`.

### Task 2: Synthetic drawing set

**Files:** Create `src/drawings/make.mjs`, `scripts/make-drawings.mjs`, `data/drawings/*` (generated and committed) and `data/drawings/README.md`. Test `test/drawings.test.mjs`.

**Interfaces:**
- **Consumes:** Task 1 layout.
- **Produces:** `drawingSet(rev = "A"): {[filename]: text}`. Filenames:
  - `RB-GA-001_<rev>.dxf`
  - `RB-HP-001_A.dxf`
  - `RB-PFD-001_A.xml`
  - `RB-LL-001_<rev>.csv`, `RB-EL-001_A.csv`, `RB-IL-001_A.csv`
  - `RB-PID-0{1..8}_<rev>.xml`

  Rev B changes GA, LL and PID-05 only.
- **Also produces:** `DRAWING_META: {[number]: {kind, title, revs:[...]}}`.

Content rules:
- **DXF:** R2000 ASCII. HEADER `$ACADVER AC1015`. TABLES layers EQUIP, BUILDING, PIPE, CHANNEL, ROAD, FENCE, TITLE. ENTITIES as LWPOLYLINE, CIRCLE, TEXT, and INSERT with ATTRIB `TAG`, `KIND`, `BASE`, `HEIGHT`, `DIA` or `W`/`L`, `TWL`. A title block INSERT with ATTRIB `DWGNO`, `REV`, `TITLE`, `CRS`, `ORIGIN`, `ROT`.
- **DEXPI:** `<PlantModel>` with `<Equipment ID TagName ComponentClass>`, `<Nozzle ID>`, `<GenericAttributes><GenericAttribute Name="KKS" Value=…/>`, `<PipingNetworkSystem><PipingNetworkSegment ID LineNumber><Connection FromID ToID/>`, `<PipingComponent ComponentClass TagName>` and `<ProcessInstrumentationFunction TagName>` with `<GenericAttribute Name="MeasuredAt" Value=…/>`. The PFD carries `<Stream ID From To DesignFlowM3h SplitFraction Recycle Mode>`.
- **PID-05 is the typical filter:** a `<TagTable>` mapping F01..F12 to their KKS and valve tags, with 6 actuated valves per filter.
- **Seeded disagreements (exactly these):**
  - GA has tag `17BBB01` (an old sludge sump) that is on no P&ID.
  - LL gives line `RB-L-210` as DN400, while PID-05 says DN450.
  - IL has instrument `15CQ13` that matches no Sensor.

Steps:
- [ ] **Failing tests:**
  - `drawingSet("A")` has 14 files.
  - `drawingSet("B")` changes exactly 3 files: GA, LL and PID-05.
  - Rev B PID-05 contains a `filter-to-waste` service for F01–F04 only.
  - The committed `data/drawings/` files equal `drawingSet` output byte for byte.
  - The GA DXF starts with `0\nSECTION` and contains `$ACADVER`.
- [ ] **Run:** FAIL.
- [ ] **Implement** (deterministic, no PRNG). `scripts/make-drawings.mjs` writes both revisions. The README documents the subsets and design values.
- [ ] **Run** `node scripts/make-drawings.mjs && npm test`. Expected: PASS.
- [ ] **Commit:** `feat: synthetic Riverbend drawing set (GA, HP, PFD, lists, P&IDs; rev A and B)`.

### Task 3: Parsers

**Files:** Create `src/ingest/dxf.mjs`, `src/ingest/dexpi.mjs`, `src/ingest/csv.mjs`. Test `test/parsers.test.mjs`.

**Produces:**
- `parseDxf(text): { header, layers:[...], entities:[{type, layer, ...}], inserts:[{block, layer, at:[x,y], attribs:{}}] }`
- `parseDexpi(text): { equipment:[{id, tag, cls, kks, nozzles:[id]}], segments:[{id, line, from, to}], components:[{cls, tag, segment}], instruments:[{tag, kks, measuredAt}], streams:[{id, from, to, flow, split, recycle, mode}], tagTable:{[filter]:{kks, valves}} }`
- `parseCsv(text): [{...row}]`

These are small purpose-built readers for the documented subsets. The XML reader handles elements, attributes and self-closing tags, with no DTD and no CDATA.

- [ ] **Failing tests:** each parser reads its committed sheet. Counts equal the generator's source arrays (structures, lines and instruments from `src/layout.mjs` and `make.mjs` exports). Malformed input (truncated DXF, unclosed XML tag) throws `/malformed/`. A CSV with a quoted comma parses.
- [ ] **Run:** FAIL.
- [ ] **Implement.**
- [ ] **Run:** PASS.
- [ ] **Commit:** `feat: zero-dependency DXF, DEXPI-subset and CSV readers`.

### Task 4: Extraction and binding into cells

**Files:** Create `src/ingest/extract.mjs`. Test `test/extract.test.mjs`.

**Produces:** `extractPlant(files: {[name]: text}, ont): { sources:[{number, rev, kind, sha256}], items:[{kind: "structure"|"machine"|"line"|"valve"|"instrument"|"samplepoint", tag, fields:{}}], cells:[cell], bindings:{[tag]: {id, grade, score?}} }`.

Grades:
- attributes, elements and list rows: `EXTRACTED`;
- geometry-derived values (diameter from a CIRCLE when the ATTRIB is missing, path length): `INFERRED`;
- cross-sheet disagreement: `AMBIGUOUS`, with reasoning naming both sheets.

Bindings:
- whole tag equal to Position.kks, Position.tag or Sensor.historianTag prefix before `.`: `EXTRACTED`;
- token overlap ≥ 0.6 (tokens `\p{L}+|[0-9]+`): `INFERRED`, with score;
- otherwise `AMBIGUOUS`.

Lines carry service, conveyance, DN or width×depth, normalDirection, mode, designFlow and splitFraction (from the PFD), recycle, `causal` (true for process and dosing services), and `injectionAt` for dosing lines.

- [ ] **Failing tests:**
  - On rev A, exactly 3 `AMBIGUOUS` cells, keys `17BBB01|presence`, `RB-L-210|dn` and `15CQ13|binding`.
  - Every hero position binds `EXTRACTED`.
  - F01 binds to POS-F01 and not F10.
  - The coagulant line has `causal: true` and `injectionAt` equal to the flash-mix tag.
  - The washwater return has `recycle: true`.
  - The backwash supply has `mode: "intermittent"`.
  - Sample points carry `lagMin` between 2 and 10.
- [ ] **Run:** FAIL.
- [ ] **Implement.**
- [ ] **Run:** PASS.
- [ ] **Commit:** `feat: drawing extraction and tag binding into graded cells`.

### Task 5: PlantModel, seeded rev A, ingest, review and release

**Files:** Create `src/plant.mjs`. Modify `src/generate.mjs` (seed), `src/ontology.mjs` (the `zones` rule), `src/actions.mjs` (two actions) and `src/system.mjs`. Test `test/plant.test.mjs`.

**Produces:**
- `plantModelFrom(extract, {rev, id}) -> PlantModel`
- `packageHash(model)`: sha256 over canonical JSON of sources, items and cells, excluding status, governs and release.
- `materialise(model) -> objects[]`: Structure, MachinePlacement, Line, Valve and SamplePoint objects with ids `PM-RB-<rev>:<KIND>-<tag>`, each with `modelId`. Lines get `zones[]` from their path.
- `currentPlantModel(ont) -> PlantModel | null`
- `createPlantService({ont, tel, actions, audit}) -> { ingest(drawingIds, by) -> PlantModel }`, wired into `system.plant`.

Other changes:
- **Seed:** rev A is extracted once, memoised at module level and cloned per system. It is released by P-001 at `2025-02-01T00:00:00Z`, with every cell reviewed by P-002 at `2025-01-30T00:00:00Z`. Rev B Drawing records are registered with status `received`.
- **Ontology view:** an object with `zones[]` is hidden if any of those zones is above the viewer's clearance.
- **`review_cells`** (needs act, ceiling human, engineer): params `{modelId, accept: "EXTRACTED", sheet}` or `{modelId, marks: [{key, value?}]}`.
- **`release_plant_model`** (ceiling human, engineer, `c-model`): params `{modelId, hash}`. It refuses when:
  - any `INFERRED` or `AMBIGUOUS` cell is unreviewed;
  - the releaser is the last reviewer;
  - the hash is stale;
  - the model is not a draft.

  It sets the previous model to `superseded` with `governs.to`, sets this one to `released` with `governs.from`, and emits SSE.
- **`ingest`:** the set is the current released sources, with given newer revisions replacing older ones. It refuses with `/already|older/` if a given drawing is not newer. Cells unchanged by `key` and value carry their review marks forward.

- [ ] **Failing tests:**
  - `currentPlantModel` is `PM-RB-A`, released.
  - Rev A has more than 900 cells.
  - The hash is unchanged after status and governs change.
  - Ingesting rev B sheets gives draft `PM-RB-B`, where only changed or new cells are unreviewed, including `RB-PID-05` filter-to-waste for F01–F04 and the seeded `AMBIGUOUS` washwater outlet.
  - **(Review Focus 1)** Ingesting rev B again, or rev A, is refused.
  - **(Review Focus 2)**
    - P-002 reviews, then P-002's release is refused with `/last reviewer/`.
    - A release with an unresolved `AMBIGUOUS` cell is refused.
    - A stale hash is refused.
    - P-001's release succeeds: A is superseded, B is current, and the F01–F04 filter-to-waste Lines exist only under `PM-RB-B`.
  - POS-HLP-B is unchanged byte for byte.
  - On release, each reviewed `AMBIGUOUS` cell whose reasoning cites an existing record (the `15CQ13|binding` cell) raises one `Issue` titled `Drawing disagrees with record: <key>` for the record's owner (spec §4.3 step 3). Releasing again raises no duplicate.
  - A technician's view hides a Line whose `zones` include Z06.
- [ ] **Run:** FAIL.
- [ ] **Implement.**
- [ ] **Run** `npm test`. Expected: PASS.
- [ ] **Commit:** `feat: plant model revisions — seeded rev A, live ingest, four-eyes release`.

### Task 6: Process-graph functions

**Files:** Modify `src/functions.mjs`. Test `test/graph.test.mjs`.

**Produces:**
- `graphFrom(objects) -> {nodes: Map, out: Map, in: Map}`. Edges are causal Lines, plus dosing injection edges.
- `upstreamOf(id, g, {depth=20, mode}) -> [{id, share}]`
- `downstreamOf(id, g, {depth, mode})`
- `processPaths(from, to, g, {limit=10}) -> [[id]]`
- `travelWindow(path, g, {flowMlD}) -> {onsetH, meanH, tailH, basis}`
  - t = V / (Q·share).
  - Clarifier and contact tank onset = T10, using baffling factors of 0.4 and 0.5.
  - Reservoir: an exponential response, with onset 0.1·t and tail 3·t.
  - Line transit = length / velocity, at 1.0 m/s gravity and 2.0 m/s pumped.
  - Add sample lag.
- `onsetMinute(values, {baseline=120, rel=0.25}) -> index | null`: the first sample deviating more than `rel` from the baseline median.

Steps:
- [ ] **Failing tests:**
  - Upstream of F07 includes all four clarifiers, each with a share of 0.25, and the DP-1 and DP-2 dosing positions.
  - **(Review Focus 4)** The walk terminates with the washwater return present, and upstream of the reservoir excludes the filters in normal mode.
  - `travelWindow` from the intake to the F07 outlet at 120 ML/d gives a mean of 3–5 h and an onset of 0.8–1.8 h, and at 60 ML/d the mean is 2× that.
  - **Timing argument:**
    - using `sys.tel` after `tick` to day 13, take `onsetMinute` of `SEN-DP-2-flow` and of `SEN-F07-turb`;
    - the F07 onset comes earlier than the DP-2 onset plus the flash-mix-to-F07 onset window, so DP-2 cannot explain F07;
    - fewer than 2 other filters show an onset, so F07 is a local fault.
- [ ] **Run:** FAIL.
- [ ] **Implement.**
- [ ] **Run:** PASS.
- [ ] **Commit:** `feat: process graph — upstream sets with shares, paths, travel windows`.

### Task 7: Plant API and pruning

**Files:** Modify `src/server.mjs`. Test the new cases in `test/server.test.mjs`.

**Produces** routes per spec §7, in this file's route table:
- `GET /api/plant`: `{model:{id, rev, disclosure, georef}, structures, machines(with asset state), lines(path clipped), valves, samplePoints, bounds}` for the viewer.
- `GET /api/plant/models` and `/models/:id`.
- `POST /api/plant/ingest`.
- `GET /api/plant/graph/upstream/:id`, `/downstream/:id` and `/paths?from&to`, plus `/window?from&to&flow`. Graph routes use the viewer's pruned objects.

Line clipping: drop each path segment whose midpoint lies inside a hidden zone's rect, splitting the path into parts.

Steps:
- [ ] **Failing tests:**
  - **(Review Focus 3)** As a technician, `GET /api/plant` has no structure in Z06, and no point of any line path inside the Z06 rect.
  - As the manager, Z06 is present.
  - The technician's upstream of the contact tank is 404.
  - A technician's ingest gets 403.
  - Ingest then release over HTTP gives 200, and `/api/plant` then returns rev B.
- [ ] **Run:** FAIL.
- [ ] **Implement.**
- [ ] **Run:** PASS.
- [ ] **Commit:** `feat: plant API with server-side pruning and graph routes`.

### Task 8: Vendored three.js and the twin lifecycle fix

**Files:** Create `web/vendor/three@0.160.0/three.module.js` and `addons/{controls/OrbitControls.js, renderers/CSS2DRenderer.js, lines/Line2.js, lines/LineMaterial.js, lines/LineSegments2.js, lines/LineSegmentsGeometry.js, lines/LineGeometry.js, utils/BufferGeometryUtils.js, objects/Sky.js, environments/RoomEnvironment.js}`. The source is the `three@0.160.0` npm tarball via `npm pack`, unpacked in the scratchpad. Copy files only; do not add them to package.json. Modify `web/index.html` (import map → `/vendor/...`) and `web/twin.js` (`dispose`: traverse and dispose geometries and materials, then `renderer.dispose()` and `forceContextLoss()`). Test `test/web.test.mjs`.

- [ ] **Failing test:**
  - `/vendor/three@0.160.0/three.module.js` serves 200 with javascript content-type;
  - the index import map contains no `cdn.jsdelivr`;
  - each addon file named above exists and all its imports resolve to files in `web/vendor`.
- [ ] **Run:** FAIL.
- [ ] **Vendor the files and edit.**
- [ ] **Run:** PASS. Browser check: the asset twin still renders.
- [ ] **Commit:** `chore: vendor three.js 0.160.0 for offline use; dispose WebGL context in the asset twin`.

### Task 9: Plant view, physical mode

**Files:** Create `web/plant.js`. Modify `web/app.js` (`views.plant(id)`, nav `data-nav="plant"`), `web/index.html` and `web/styles.css`. Test `test/web.test.mjs` (view and nav present).

**Produces:**
- `mountPlant(container, data, {mode="physical", quality="medium", onSelect}) -> {flyTo(id), highlight(ids, {dim:true}), setMode(m), setStates(map), dispose()}`
- `window.__plant = {calls, triangles, mode}`

Physical view, per spec §5.2:
- PMREM sky environment, ACES tone mapping, a fixed sun (azimuth 110°, elevation 35°), and shadows baked once.
- Procedural canvas textures, and kind-specific geometry.
- Instanced rails, windows, flanges and pipes.
- Clarifier rake arms turn only when that CL-n Asset state is `running` and reduced motion is off.
- Water ripple on the normal-map offset.
- Alert pulse while an alert is active.
- Basin water tinted by band (≤ alarm·0.7 = in limit, ≤ alarm = near, otherwise over), using the sample point's sensor.

Behaviour:
- Picking uses proxy boxes. Selecting a pump, blower or chlorine house makes its walls translucent, and its machines are picked in place. The side panel shows the record and an "Open twin" link to `#/asset/<assetId>`.
- The disclosure badge is shown, from `model.disclosure`.
- Fallbacks:
  - no WebGL or a lost context: `mapSvg` plus structure outlines and links;
  - width under 720, `deviceMemory` ≤ 4, or median frame time over 33 ms across the first 30 frames: blueprint mode (Task 10).
- The Plant view refreshes states on SSE.

Steps:
- [ ] **Failing test:** `async plant(` is in app.js, `data-nav="plant"` is in the index, and `/plant.js` is served.
- [ ] **Run:** FAIL.
- [ ] **Implement.**
- [ ] **Run** `npm test`: PASS.
- [ ] **Browser (Playwright):** as P-001, `#/plant` renders and `__plant.triangles` is under 150000 and `calls` under 250. Select the high-lift pump house, then HLP-B, then "Open twin" opens the asset twin (J14). With `WebGLRenderingContext` stubbed off, the SVG fallback shows links (**Review Focus 5**).
- [ ] **Commit:** `feat: 3D plant, physical view, with click-down into the asset twin`.

### Task 10: Blueprint view, graph highlight, and the model review UI

**Files:** Modify `web/plant.js`, `web/app.js` (`views.plantmodels(id)`) and `web/styles.css`. Test `test/web.test.mjs`.

**Blueprint view:**
- Navy background, merged edges, hidden-line by default with an x-ray toggle.
- Line2 process lines coloured by service, and static instanced flow arrows.
- Thin dashed utility lines.
- A "skeletal map" toggle.
- CSS2D labels: equipment always; valves and instruments past a zoom threshold or when selected. Labels are decluttered on a 48 px screen grid by priority.
- Dimensions are shown for the selected item.
- A 300 ms cross-fade via two render targets, instant under reduced motion.

**J15:** on selecting F07 in blueprint view, "Show upstream" calls the graph API, then `highlight(upstream ids)`, and shows CSS2D captions "onset ≈ x h, mean ≈ y h (design values at Q ML/d measured)", with Q from `SEN-RAW-flow`.

**`#/plantmodels` view (J13):**
- Revision list, with "Ingest received drawings" for engineers.
- A review grid: unreviewed cells first, `AMBIGUOUS` highlighted, per-sheet "Accept extracted", and per-cell accept or correct.
- "Release" for holders of `c-model`; a refusal shows the server's reason.
- After release, the Plant view re-renders.

Steps:
- [ ] **Failing test:** `async plantmodels(` and `setMode` are present.
- [ ] **Run:** FAIL.
- [ ] **Implement.**
- [ ] **Run:** PASS.
- [ ] **Browser:**
  - **J13:** P-002 ingests, accepts and marks; P-002's release is refused; P-001 releases; the plant shows the F01–F04 filter-to-waste lines and the badge says rev B.
  - **J15:** the upstream highlight shows four clarifiers.
  - **J16:** at 390 px it opens in blueprint view, and a tap opens the record.
- [ ] **Commit:** `feat: blueprint view, upstream highlight, and plant model review and release UI`.

### Task 11: Docs, departures and final review

**Files:** Modify `README.md`, `../02-BRD-Water-Works-OS.md` Appendix D (add rows for the NAB-012 §7 rendering departures and for template 3D on the whole works) and `../README.md` (link the spec).

- [ ] **README:** add the Plant view and plant models rows, the demo steps for J13–J16, and a note on the vendored three.js.
- [ ] **Appendix D:** add the rows.
- [ ] **Run:** `npm test` green, and record the count.
- [ ] **Final review:** run the final review workflow (dimensions, then adversarial verify), and fix Critical and Important findings test-first.
- [ ] **Commit:** the docs and the fixes.
