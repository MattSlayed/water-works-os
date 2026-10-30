# Riverbend on Atlas: physical layer, loader and tools (KG steps 2, 5, 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Riverbend physical layer into Timebase Atlas and its readings into Timebase Historian. Give the WaterOS
harness one clearance-filtered tool set over them, served in-app and as an MCP server, and an eval bank that proves it.

**Architecture:**
- **Physical layer from 3D (step 2).** Blender exports `riverbend.glb`. `seedKg` adds GeometryRef objects, sensor
  anchors and the generated *Riverbend Design Basis* (with heading chunks) to the in-memory ontology. That ontology
  stays the source of truth.
- **Loader (step 6, replaces the Neo4j mirror).** A pure `atlasModel(ont)` maps the physical layer to Atlas types,
  instances and edges. `load-atlas.mjs` writes it over REST to branch `riverbend`, publishes the draft and compiles.
  `backfill.mjs` writes every sensor's readings into the Historian dataset `Riverbend`. Sensor values are bound
  through the existing Connect source `historian-rb`.
- **Tools (step 5).** One tool set, `createKgTools`, has two backends:
  - The memory backend (CI, the offline export) reads the ontology and telemetry.
  - The Atlas backend reads Atlas `ExecuteCypherQuery` and Historian through MCP only.
  - WaterOS decides clearance for both: every result id must be visible in `ont.view(viewer)`, because an Atlas
    token reads the whole model.
  - Traversal rules (recycle edges, split shares, travel windows) stay in `functions.mjs`. Atlas supplies the edges.
- **Delivery.** The tools are served at `/mcp` on the WaterOS server. A rule-graded eval bank checks the tools in CI,
  and a Claude run script checks answers outside CI.

**Tech Stack:** Node 22 ESM, `node:test`, zero new dependencies (the MCP client and server are hand-written JSON-RPC
over `fetch`/`http`); Blender 5.2 in background mode; Timebase 2.0 `2.0-gc4` at `E:\Timebase` (live tasks only).

**Spec:** `docs/superpowers/specs/2026-10-29-riverbend-knowledge-graph-design.md` (§6.2, §6.3, §8, §9, §10, §11, §13
steps 2, 5, 6), amended by `docs/superpowers/specs/2026-10-29-riverbend-timebase-backend.md` (§2, §3, §4 traps, §5). The
amendment wins where they differ. Vendor docs: `docs/vendor/timebase/README.md` (job map).

## Global Constraints

- **Layers:**
  - Atlas holds the physical layer plus `Document` link nodes.
  - Readings live only in Historian and never enter the graph.
  - Document text and chunks stay in WaterOS (spike (e) no-go).
  - Alarms, events, anomalies and samples stay in WaterOS for this plan. Their Postgres → Atlas path belongs to the
    step-3 plan.
- **Agents never touch REST.** Agents, the tools and the MCP server reach Atlas and Historian **only through MCP**.
  Only `scripts/timebase/*` use REST, and they write only to branch **`riverbend`** (never `main`) and dataset
  **`Riverbend`**. A test enforces this with a static import check.
- **Atlas has no clearance.** Every graph result passes `ont.view(viewer).get(wosId)`, or it is dropped. The raw
  `cypher` tool is **manager only** and off by default (`WWOS_KG_CYPHER=1` turns it on).
- **Never sent to Atlas or Historian:** Person, Presence, Channel, Message, Execution, Feedback, WorkOrder, Alert,
  Sample, Region or RemoteSite objects. This list stays outside this plan's scope. The loader works from an explicit
  type allowlist (Task 5).
- **Beta rules:**
  - Localhost only, synthetic data only.
  - No Bridge target, no control system.
  - Never edit a component's `settings.config`.
- **Secrets:**
  - The client id comes from `TIMEBASE_CLIENT_ID`. The secret is read from the file named in
    `TIMEBASE_SECRET_FILE` (under `E:\Timebase\secrets\`).
  - Never print, log, commit or put a secret or token in an error message.
  - TLS uses `NODE_EXTRA_CA_CERTS=E:\Timebase\pulse-ca.pem`.
- **Atlas traps (spec §4), each handled in code:**
  - Full URNs: `urn:atlas:ontology:riverbend:<Name>` for types and properties, `urn:atlas:instance:riverbend:<slug>`
    for instances.
  - `attachToTypes: []` on every property POST.
  - Edges carry an `instanceId`.
  - An instance PATCH always sends the **full** property set.
  - Writes go to the per-client draft, then `POST /branches/riverbend/draft/publish`, then `PUT …/world` (compile).
  - Assert `Content-Type` is JSON on every call: unknown routes answer `200 text/html`.
  - A TVQ whose time is `0001-01-01…` or whose `Quality` is `0` is **no data**, never zero.
  - Cypher puts type tests in `WHERE`, never as a label on the far end of a traversal.
- **CI never needs Timebase.** Live checks run only by hand, or in opt-in tests gated on `TIMEBASE_ATLAS_URL`.
- **Window:** tools and scripts take the telemetry window from `createTelemetry` (today 2026-10-01, 14 days) and never
  hard-code dates. The step-3 plan extends it to 90 days and re-runs `backfill.mjs`.
- **Fictional-name rule.** Only Riverbend names, `CONTRACT.md` ids and tags, and the ids above. The glb holds only the
  121 asset-carrying objects in `scene-meta.json`: no images, no untagged objects. Never open `RIVERBEND-SITE.md` or
  `ref/`.
- **POPIA.** People data is reachable only through the `people` tool, via `ont.view(viewer)`, and never through
  Atlas.
- **Repo conventions:**
  - LF line endings, no new npm dependencies, suite green at every commit.
  - Branch `feat/riverbend-atlas` off `main`.
  - Tests that count Documents or objects get updated in the task that adds them.

## Review Focus

1. **Clearance leak through Atlas.** A technician asks about the Z06 chlorination building or one of its sensors. The
   Atlas backend returns the row, but the tool must answer "not found". *Pinned in Task 6.*
2. **Raw Cypher that writes, or that hits the far-end label trap** (`(p)-[:feeds*]->(f:Filter)`). The lint rejects
   it with the `WHERE f:Filter` hint. *Pinned in Task 6.*
3. **A sensor with no data yet,** either warm-up (`0001-01-01`, quality 0) or a gap. `readings` returns
   `{points: [], note: "no data"}`, not zeros. *Pinned in Task 6.*
4. **Re-running the loader.** A second run creates nothing new and deletes nothing still present. An object removed
   from the ontology is deleted from Atlas. *Pinned in Task 5 (`planLoad`).*
5. **Ids that do not exist,** whether retired (F12, RS-RES1) or invented. `get` answers `found: false`. For a retired
   id it also names the canonical replacement from `crosswalk.json`. *Pinned in Task 6.*

---

### Task 1: glTF export

**Files:**
- Create: `scripts/blender/export_glb.py`
- Create: `data/riverbend/riverbend.glb` (generated, committed)
- Test: `test/riverbend-glb.test.mjs`

**Interfaces:**
- Produces `riverbend.glb`:
  - Mesh nodes are named exactly as the `scene-meta.json` object keys, with `extras: { asset, floor? }`.
  - Coordinates stay in the Blender frame. The overlay (step 7) applies `scene-meta.frame`.

- [ ] **Step 1: Write the failing test.** Parse the GLB in plain Node: a 12-byte header, then the JSON chunk.
  - `glb holds exactly the scene-meta objects`: the set of node names with `extras.asset` deep-equals
    `Object.keys(sceneMeta.objects)`. Every such node's `extras.asset` equals `sceneMeta.objects[name].asset`.
  - `glb carries no images and no untagged nodes`: `(json.images ?? []).length === 0`, every mesh node has
    `extras.asset`, and the file is under 15 MB.
- [ ] **Step 2: Run** `node --test test/riverbend-glb.test.mjs`. Expected: FAIL, ENOENT.
- [ ] **Step 3: Write `export_glb.py`.**
  - Usage: `blender -b <blend> --python export_glb.py -- <scene-meta.json> <out.glb>`.
  - Select the mesh objects whose names are keys of `scene-meta.objects`. Copy their `asset` and `floor` custom
    properties.
  - Run `bpy.ops.export_scene.gltf(filepath=…, export_format='GLB', use_selection=True, export_extras=True,
    export_image_format='NONE', export_apply=True)`.
  - Do not save the blend.
- [ ] **Step 4: Run the export.**
  `"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b "..\riverbend\riverbend-blockout.blend" --python scripts/blender/export_glb.py -- data/riverbend/scene-meta.json data/riverbend/riverbend.glb`
  (the blend is in `Palantir Inspired OS/riverbend/`, outside the repo). Then run the test. Expected: PASS.
- [ ] **Step 5: Commit.**
  `git add scripts/blender/export_glb.py data/riverbend/riverbend.glb test/riverbend-glb.test.mjs && git commit -m "feat: Riverbend glTF export with asset extras"`

### Task 2: GeometryRefs and sensor anchors

**Files:**
- Create: `src/kg/geometry.mjs`
- Create: `src/kg/seed.mjs`
- Modify: `src/system.mjs` (call `seedKg` after `seedPlant`)
- Test: `test/geometry.test.mjs`

**Interfaces:**
- Consumes: `scene-meta.json`, `contract.json`, `PLAN` (layout.mjs), `currentPlantModel`/`plantId` (plant.mjs).
- Produces:
  - `geometryRefs(sceneMeta, ont, contract) -> { refs: GeometryRef[], links: [from, "HAS_GEOMETRY", to][], anchors: Map<sensorId, {geometryId, offset:[0,0,0]}>, skippedObjects: string[], skippedSensors: string[] }`.
  - `GeometryRef = { id: "GEO-<blenderName>", type: "GeometryRef", file: "riverbend.glb", node: <blenderName>, floor, centroid: [cx, cy, (zMin+zMax)/2], bbox: { w, l, h } }`.
  - `seedKg(ont)` upserts the refs and links, and sets `sensor.anchor` (Tasks 3, 5 and 6 rely on these).
- Resolving a scene `asset` key to the owner:
  - Use the Position whose `tag === asset`, if one exists.
  - Otherwise use the Structure `plantId(model, "structure", PLAN[asset].tag)` in the current plant model.
  - Otherwise put the blender object name in `skippedObjects`.
- Anchors:
  - First choice: the GeometryRef of `asset.positionId`.
  - Next: that of the owner of `contract.tags[sensor.tag].asset`.
  - Next: that of the structure holding the sensor's SamplePoint.
  - Otherwise the sensor id goes in `skippedSensors`.

- [ ] **Step 1: Write the failing test.**
  - `every scene object with a known asset gets one GeometryRef`: `refs.length + skippedObjects.length === 121`. Every ref's
    owner exists. `GEO-CL-1_Bridge` hangs off the CL-1 structure.
  - `the nine contract tags are anchored`: each of `AIT-101, FIT-102, FIT-201, AIT-301, AIT-157, PDT-157, AIT-401,
    LIT-501, TT-612` has an anchor whose `geometryId` is a ref id. TT-612 anchors to an HLP-B geometry.
  - `seedKg is idempotent`: running it twice leaves the GeometryRef count unchanged.
- [ ] **Step 2: Run** `node --test test/geometry.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `geometryRefs` and `seedKg`, and call `seedKg(ont)` in `createSystem`. Then fix any test that
  counts all objects.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -m "feat: GeometryRefs and sensor anchors from the 3D scene"`

### Task 3: Chunker and the Riverbend Design Basis

**Files:**
- Create: `src/kg/chunks.mjs`
- Create: `src/kg/design-basis.mjs`
- Create: `data/riverbend/design-basis.md` (generated, committed)
- Create: `scripts/make-design-basis.mjs`
- Modify: `src/kg/seed.mjs`
- Test: `test/design-basis.test.mjs`

**Interfaces:**
- Produces:
  - `chunkByHeading(documentId, markdown) -> Chunk[]`, where
    `Chunk = { id: "<documentId>#c<nn>", type: "Chunk", documentId, heading, order, text }`. There is one chunk per
    `## ` section. A section over 600 words splits at paragraph boundaries into `#c<nn>a`, `#c<nn>b`. Step 4 reuses
    this for every generated document.
  - `designBasis(ont) -> string` (markdown).
  - `seedKg` adds `Document { id: "DOC-DESIGN-BASIS", type: "Document", kind: "design-basis", title: "Riverbend Design Basis", revision: "A", body }`, its Chunks, `DOC-DESIGN-BASIS ─HAS_CHUNK→ Chunk`, and `Chunk ─ABOUT→` every structure or position whose tag the chunk names.
- Sections, in order:
  1. Basis of design: 100 ML/d, and 90 ML/d with CL-4 out.
  2. Raw water intake and pumping.
  3. Inlet works and coagulation.
  4. Clarification.
  5. Filtration.
  6. Disinfection.
  7. Storage.
  8. High-lift pumping.

  Each structure line gives its tag, plan size, floor level, top water level and volume, where the layout carries them. Levels are rounded to 0.1 m, volumes to 10 m³ and areas to 1 m².

- [ ] **Step 1: Write the failing test.**
  - `chunks split per heading`: a 3-section fixture yields 3 chunks with order 1–3 and the headings verbatim. A
    1300-word section yields `c01a`, `c01b` and `c01c`.
  - `design basis matches the layout`:
    - The regenerated markdown equals `data/riverbend/design-basis.md` byte for byte.
    - It contains `100 ML/d` and `90 ML/d`.
    - The Filtration chunk names F01 to F08, and nothing named F09 or above.
    - Every ABOUT target exists.
  - `seeded`: `ont.get("DOC-DESIGN-BASIS").kind === "design-basis"`, and it has 8 or more HAS_CHUNK links.
- [ ] **Step 2: Run** `node --test test/design-basis.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Run `node scripts/make-design-basis.mjs` to write the markdown, update tests that count
  Documents (9 → 10), then run `npm test`. Expected: all pass.
- [ ] **Step 4: Commit.** `git commit -m "feat: heading chunker and the generated Riverbend Design Basis"`

### Task 4: Timebase clients and the Historian backfill

**Files:**
- Create: `src/timebase/pulse.mjs`
- Create: `src/timebase/rest.mjs`
- Create: `src/timebase/mcp.mjs`
- Create: `src/timebase/historian-read.mjs`
- Create: `scripts/timebase/backfill.mjs`
- Create: `scripts/timebase/mcp-tools.mjs`
- Create: `test/fixtures/historian-read.json` (captured in Step 6, synthetic values only)
- Modify: `src/telemetry.mjs` (add `series`)
- Test: `test/timebase-clients.test.mjs`

**Interfaces:**
- Produces:
  - `pulseToken({ pulseUrl, clientId, secretFile, fetch? }) -> Promise<string>`:
    - Caches the token until 30 s before `exp`.
    - Errors carry the status and the OAuth `error` code only.
  - `restCall(base, method, path, body?, { token, fetch? }) -> { status, body }`:
    - Sends `redirect: "manual"`.
    - Throws `NotJson` when a 2xx reply is not `application/json`.
  - `connectMcp(baseUrl, getToken, { fetch? }) -> { listTools(): Promise<{name, description, inputSchema}[]>, callTool(name, args): Promise<any> }`:
    - Speaks Streamable HTTP: `initialize`, then `notifications/initialized` carrying `mcp-session-id`.
    - Accepts a JSON reply or SSE `data:` lines (last message wins).
    - Throws on a JSON-RPC `error`.
  - `tel.series(sensorId, fromIso, toIso) -> { t: string, v: number }[]` at 1-minute steps, clipped to the window.
  - `HISTORIAN_READ = { tool, args(tag, fromIso, toIso) -> object, points(result) -> { t, v, q }[] }` in
    `historian-read.mjs`, pinned in Step 6.
  - `historianTags(ont) -> [{ n: tag, d: name, u: { 1: unit }, fl: { Site: "Riverbend WTW", Asset, Source: "synthetic" }, t: "System.Double", sensorId }]`.
    `Asset` is the sensor's position tag, else its process unit id.

- [ ] **Step 1: Write the failing test.** Use fake `fetch` throughout; no network.
  - `token never leaks`: a 401 reply makes `pulseToken` reject with a message that contains neither the secret file
    text nor `access_token`.
  - `rest rejects html`: a fake `200 text/html` reply throws `NotJson`.
  - `mcp parses SSE and JSON`: both reply styles return the same tool list. The session id is echoed on the second
    call.
  - `historian tags`: one entry per Sensor (117), all `n` unique, and `AIT-157` maps to the F07 sensor.
  - `series`: `tel.series(id, start, start+10min)` has 11 points that match `history`.
- [ ] **Step 2: Run** `node --test test/timebase-clients.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules and `series`. Run the test. Expected: PASS (the `HISTORIAN_READ` adapter test
  is added in Step 6).
- [ ] **Step 4 (Matthew).** In Pulse, create client **`WaterOS`** (audiences Atlas and Historian). Save its secret to
  `E:\Timebase\secrets\wateros.secret`, and copy the Pulse CA PEM to `E:\Timebase\pulse-ca.pem`.
- [ ] **Step 5: Backfill.**
  - `backfill.mjs [--reset]`:
    - `--reset` sends `DELETE /api/datasets/Riverbend`.
    - Creates the dataset `{ n: "Riverbend", pa: 0, ps: 0, lda: 120 }` and the tags from `historianTags`.
    - Writes `tel.series` for each sensor oldest-first in batches of 20,000 points with `q: 192`.
    - Prints only the counts.
  - Run: `TIMEBASE_CLIENT_ID=WaterOS TIMEBASE_SECRET_FILE=E:\Timebase\secrets\wateros.secret NODE_EXTRA_CA_CERTS=E:\Timebase\pulse-ca.pem node scripts/timebase/backfill.mjs --reset`.
  - Expected: 117 tags, 0 rejected points.
- [ ] **Step 6: Pin the Historian read tool.**
  - `node scripts/timebase/mcp-tools.mjs historian` lists the tools with their input schemas.
  - Pick the tool that returns raw values for one tag over a start–end range, and fill `HISTORIAN_READ`.
  - Call it once for AIT-157 over one hour, and save the reply as `test/fixtures/historian-read.json`.
  - Add the test `historian adapter`: `HISTORIAN_READ.points(fixture)` returns 60–61 points with ISO `t`.
  - Run the test. Expected: PASS.
- [ ] **Step 7: Commit.** `git commit -m "feat: Pulse, REST and MCP clients; Historian backfill of every sensor"`

### Task 5: Atlas model and loader

**Files:**
- Create: `src/timebase/atlas-model.mjs`
- Create: `scripts/timebase/load-atlas.mjs`
- Test: `test/atlas-model.test.mjs`

**Interfaces:**
- Consumes: the ontology after `seedKg`; `graphFrom` (functions.mjs) for flow edges.
- Produces:
  - `atlasModel(ont, { domain = "riverbend" }) -> { properties, entityTypes, relationshipTypes, instances, edges }`, in
    the REST body shapes the spike proved (`b-model.mjs`, `d-bind.mjs`).
  - `slug(id)`: lower case, every run of characters outside `[a-z0-9]` becomes `-`. The test proves it is injective
    over the loaded ids.
  - `planLoad(desired, existing: { id, properties }[]) -> { create, update, remove }`. `update` holds only instances
    whose properties differ, always with the full property set.
- **Types** (an explicit allowlist): Site, Zone, ProcessUnit, Structure, Position, Asset, Part, Sensor, Line, Valve,
  SamplePoint, Document.
  - Each subclasses the abstract `WosObject`, which carries `wosId`, `zone` (from `ont.zoneOf`) and `minClearance`.
  - Type-specific scalar properties:
    - Position: tag, kks, name, stage
    - Asset: positionTag, assetClass, make, model, criticality, state
    - Structure: tag, kind, baseLevel, height, w, l, diameter, twl
    - Sensor: tag, historianTag, unit, rangeLo, rangeHi, alarmHi
    - Line: lineNumber, service, dn, length, causal, recycle
    - Zone: name, clearance
    - Document: title, kind, revision
    - Part: name, group, material
  - `geometry`: the owner's GeometryRefs as one JSON string.
  - `Sensor.Value`: TVQ, bound `historian-rb/Riverbend/<tag>`.
- **Relationships:**
  - `hasZone`, `contains`, `hasPosition`, `installedAt`, `hasPart`, `measures`, `at`, `governs` and `about`
    (Document → owner only), from the ontology links.
  - `feeds { share, recycle, lineId, mode, length, pumped }` from the `flow` and `injection` edges of `graphFrom`.

- [ ] **Step 1: Write the failing test.**
  - `allowlist only`: no instance has a type outside the 12. No property value contains a Person id or name from the
    ontology.
  - `full URNs`: every type, property key and edge endpoint starts with `urn:atlas:`. Every property has
    `attachToTypes: []`. Every edge has `instanceId`, `source` and `target`.
  - `one instance per object`: the instance count equals the allowlisted object count, and `slug` is injective.
  - `feeds edges`: the RES-2 structure has at least one incoming `feeds` edge. Every recycle edge has
    `recycle === true`.
  - `planLoad`:
    - Desired equal to existing gives `{create:[], update:[], remove:[]}`.
    - One changed property gives one update with the full set.
    - One missing object gives one remove.
- [ ] **Step 2: Run** `node --test test/atlas-model.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement `atlasModel` and `planLoad`.** Run the test. Expected: PASS.
- [ ] **Step 4: Write `load-atlas.mjs`.** It runs in order:
  1. Branch `riverbend` from `main` (409 is fine).
  2. Domain `riverbend`, libraries `["atlas-common"]`.
  3. Properties, then types, then relationship types. On 409, `PUT` the full definition.
  4. Instance map `plant`.
  5. GET the existing instances and apply `planLoad`.
  6. Publish the draft.
  7. Compile.
  8. Print counts per type, plus the upstream of RES-2 from
     `MATCH (r)<-[:feeds*1..12]-(u) WHERE r.wosId = $id RETURN u.wosId`.

  It must never target `main`: refuse to run if the branch argument is `main`.
- [ ] **Step 5: Live run.** Use the Task 4 environment variables: `node scripts/timebase/load-atlas.mjs riverbend`.
  - Expected: counts equal `atlasModel`'s, and RES-2 has a non-empty upstream.
  - A second run prints `create 0 update 0 remove 0`.
  - `GET /api/v1/worlds` shows `main` unchanged.
  - Read `MATCH (s:Sensor) WHERE s.tag = 'AIT-157' RETURN s.Value` after 70 s. It is non-empty.
- [ ] **Step 6: Commit.** `git commit -m "feat: Atlas model of the Riverbend physical layer and an idempotent loader"`

### Task 6: Clearance-filtered tools with two backends

**Files:**
- Create: `src/kg/tools.mjs`
- Create: `src/kg/backend-memory.mjs`
- Create: `src/kg/backend-atlas.mjs`
- Create: `src/kg/cypher-lint.mjs`
- Test: `test/kg-tools.test.mjs`
- Test: `test/kg-backend-atlas.test.mjs` (fake MCP)

**Interfaces:**
- **Backend:**
  `{ search(q, types?, limit) -> {id, type, label, score}[], get(id) -> object|null, neighbors(id, rel?) -> {rel, dir, id}[], flowEdges() -> edge[] /* graphFrom edge shape */, readings(sensor, fromIso, toIso) -> {t, v, q}[], cypher(query, params) -> {columns, rows} }`.
  - The memory backend reads `ont`, `tel.series` and `graphFrom`.
  - The Atlas backend uses `connectMcp` and `ExecuteCypherQuery` on domain `riverbend`, branch `riverbend`, with
    `wosId` as the id. Its readings come from Historian MCP via `HISTORIAN_READ`, keyed by `sensor.tag`.
- **Tools:**
  `createKgTools({ backend, ont, tel, crosswalk }) -> { name, description, inputSchema, minClearance?, run(input, viewer) }[]`.
  - `search`, `get`, `neighbors`, `upstream`, `downstream`, `readings`, `events`, `documents`, `read`, `locate`,
    `people`, and `cypher` (minClearance `manager`, only when `WWOS_KG_CYPHER=1`).
  - Every item carries `cite`: an object id, a chunk id, or `<sensorId>@<from>..<to>`.
  - `upstream`/`downstream` run `upstreamOf`/`downstreamOf` and `travelWindow` from functions.mjs over
    `backend.flowEdges()`.
  - `readings(sensorId, from, to, agg = "summary"|"raw")`:
    - The summary is `{ n, min, max, mean, first, last, slopePerH, firstAboveAlarmAt }`.
    - Points that are no-data (Global Constraints) are dropped. Zero points give `{points: [], note: "no data"}`.
  - `events(scope, from, to, kinds?)` reads Alert, WorkOrder and Sample objects from `ont.view(viewer)` (the step-3
    plan adds Alarm, Event and Anomaly).
  - `documents(aboutId?, q?)` returns HAS_CHUNK chunks. For documents with no chunks it falls back to Procedure steps,
    cited `<procedureId>#<stepId>`.
  - `read(chunkId)` returns one passage.
  - `locate(id)` returns the GeometryRefs of the id, its position, or its anchor. It returns `[]` when there are none.
  - `people(q?, zoneId?)` returns Person `{id, name, role}` and Presence `{personId, zoneId, since}` through
    `ont.view(viewer)`. It never uses the backend.
- **Clearance filter:** an item is kept only if `ont.view(viewer).get(item.id)` is truthy. This applies to both
  backends.
- **Lint:** `lintCypher(q) -> { ok, errors: string[] }`.
  - It rejects write or procedure clauses (`CREATE`, `MERGE`, `SET`, `DELETE`, `REMOVE`, `DROP`, `CALL`, `LOAD CSV`)
    outside string literals.
  - It rejects a labelled far-end node in a relationship pattern, with the hint "move the label to WHERE x:Label".
  - It rejects inline property maps in node patterns, with the hint "use WHERE".

- [ ] **Step 1: Write the failing tests** (memory backend, plus the Atlas backend with a fake `connectMcp` that returns
  canned tables).
  - `technician cannot see Z06`, with both backends: `get` on the chlorination building returns
    `{found: false}`, and `search("chlor")` omits it. A supervisor sees it.
  - `cypher is manager only and linted`:
    - The tool is absent for a supervisor.
    - With the flag on and a manager viewer, `MATCH (p)-[:feeds*]->(f:Filter) RETURN f` returns the far-end error.
    - `MATCH (n) DETACH DELETE n` returns the write error.
    - `MATCH (r)<-[:feeds*]-(u) WHERE u:Filter RETURN u.wosId` passes.
  - `no data is not zero`: a canned Historian reply with `0001-01-01T00:00:00Z` and `q: 0` gives
    `{points: [], note: "no data"}`.
  - `retired and invented ids`: `get("F12")` returns `{found: false, retired: true}` plus the crosswalk's canonical
    entry, if any. `get("PMP-999")` returns `{found: false}`.
  - `upstream of F07 matches the existing route`: the tool's ids equal `/api/plant/graph/upstream/<F07>` items for the
    same viewer.
  - `documents cite chunks`: `documents({ q: "Filtration" })` returns `DOC-DESIGN-BASIS#c05` with `cite` set.
  - `people never touches the backend`: a backend spy records zero calls during `people`.
  - `agents never import REST`: no file in `src/kg/` or `src/mcp-server.mjs` imports `../timebase/rest.mjs` or
    `./timebase/rest.mjs`. Read the sources and check their import lines.
- [ ] **Step 2: Run** `node --test test/kg-tools.test.mjs test/kg-backend-atlas.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the four modules. Run the tests. Expected: PASS. Then run `npm test`. Expected: all pass.
- [ ] **Step 4: Commit.** `git commit -m "feat: clearance-filtered KG tools over memory and Atlas backends"`

### Task 7: WaterOS MCP server

**Files:**
- Create: `src/mcp-server.mjs`
- Modify: `src/server.mjs` (route `POST /mcp`; backend chosen at start)
- Test: `test/mcp-server.test.mjs`

**Interfaces:**
- `handleMcp(req, res, { tools, viewer })` speaks Streamable HTTP with JSON replies only: `initialize`,
  `notifications/initialized`, `tools/list` (filtered by `minClearance`) and `tools/call`.
- The viewer comes from the same `x-acting-user` resolution as the rest of the API. With no viewer the server answers
  `401`.
- Backend: the memory backend by default. `WWOS_KG_BACKEND=atlas` (with the Task 4 environment variables) selects the
  Atlas backend. If the Atlas backend fails to connect, the server logs one line without secrets and falls back to
  the memory backend.

- [ ] **Step 1: Write the failing test.** Use an in-process server, as the existing server tests do.
  - `initialize then list`: as a technician, `tools/list` has 11 tools and no `cypher`.
  - `call search`: `tools/call search {q: "HLP-B"}` returns content whose JSON items carry `cite`.
  - `no viewer`: the call answers 401.
  - `clearance holds over MCP`: as a technician, `get` on the chlorination building returns `{found: false}`.
- [ ] **Step 2: Run** `node --test test/mcp-server.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement, then run** `npm test`. Expected: all pass.
- [ ] **Step 4: Commit.** `git commit -m "feat: WaterOS MCP server for the KG tools (closes backlog P5)"`

### Task 8: Eval bank, grader and Claude run

**Files:**
- Create: `data/eval-questions.json`
- Create: `src/kg/grade.mjs`
- Create: `scripts/kg/eval-claude.mjs`
- Test: `test/kg-eval.test.mjs`

**Interfaces:**
- **Question:**
  `{ id, kind: "physical"|"document"|"live"|"cause"|"trap", asker: <Person id>, question, expect: "answer"|"not_found"|"insufficient", required: [{ label, pattern?, value?, tol? }], forbidden: [pattern], evidence: [id] }`.
- **Questions in this plan:** 24 that the current data answers.
  - 6 physical, e.g. "Which pumps feed the bulk line and how many are on duty?"
  - 5 document (procedure steps and the Design Basis).
  - 6 live (S1 TT-612 and S2 AIT-157 in the current window), e.g. "When did TT-612 first go above 70 °C?"
  - 7 trap:
    - F12.
    - The Z06 chlorination dosing asked as a technician.
    - RS-RES1.
    - An invented tag.
    - A question above the asker's clearance.
    - Two more of the implementer's choosing.

  The step-3 and step-4 plans add the cause, drift and contradiction questions to reach about 40.
- **Answer format** (the Claude run's system prompt fixes it): plain text with citations as `[<cite>]`. "Not found" or
  "insufficient evidence" is stated in words.
- **Grader:** `grade(answerText, q, { exists(cite), visible(id, asker), tags: Set }) -> { right, citationsValid, uncitedFacts, leak, inventedTags }`. It is a rule grader with no LLM.
  - `right`: every `required` item matches and no `forbidden` pattern matches.
  - `citationsValid`: every bracketed cite resolves.
  - `leak`: a cited id that is not visible to the asker.
  - `inventedTags`: matches of `/\b[A-Z]{2,4}-\d{3}\b/` that are not in `crosswalk.sensors`.
- **`eval-claude.mjs [--backend memory|atlas] [--out file]`:**
  - Runs a manual tool-use loop over `createKgTools`, using the model and client pattern of `src/llm.mjs`.
  - Load the `claude-api` skill before writing this file.
  - Writes per-question grades and the totals.
  - Pass bar: 90 % right, 100 % of citations valid, 0 leaks and 0 invented tags.

- [ ] **Step 1: Write the failing test** (CI, no API key).
  - `evidence is reachable for the asker`: for every question with `expect: "answer"`, each `evidence` id is returned
    by `get` through the tools for `asker`.
  - `traps are traps`: for every `not_found` question, each `evidence` id (the thing asked about) is `found: false`
    for that asker.
  - `grader`: hand-written answers grade as follows:
    - One with every fact and valid cites is right.
    - One missing a fact is not right.
    - One citing a Z06 id as a technician is a leak.
    - One mentioning `AIT-999` has an invented tag.
- [ ] **Step 2: Run** `node --test test/kg-eval.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Write the bank, the grader and the script.** Run the test. Expected: PASS.
- [ ] **Step 4 (needs `ANTHROPIC_API_KEY`).** `node scripts/kg/eval-claude.mjs --backend memory --out <scratch>/eval-memory.json`.
  Record the totals in the ledger. A miss on the bar is a finding for review, not a reason to edit questions.
- [ ] **Step 5: Commit.** `git commit -m "feat: KG eval bank, rule grader and the Claude run script"`

### Task 9: Live parity, walk and close-out

**Files:**
- Modify: `README.md` (KG section: how to load, backfill and run the MCP server)
- Modify: `docs/superpowers/specs/2026-10-29-riverbend-timebase-backend.md` (§4 status, alarms row unchanged)
- Modify: `docs/superpowers/specs/2026-10-29-riverbend-knowledge-graph-design.md` (§13: steps 2, 5 and 6 done; step 6 = Atlas loader)

- [ ] **Step 1: Parity.** `node scripts/kg/eval-claude.mjs --backend atlas --out <scratch>/eval-atlas.json`. Then diff
  the rights against the memory run. Expected: identical, except where Atlas lacks warm data. Explain any difference
  in the ledger.
- [ ] **Step 2: Walk.**
  - Start the server with `WWOS_KG_BACKEND=atlas`.
  - Add it to Claude Code: `claude mcp add --transport http wateros http://localhost:8830/mcp --header "x-acting-user: P-001"`.
  - Ask "What is upstream of F07 and what is its turbidity now?" The answer should cite ids.
  - Repeat as a technician person id and ask about the chlorinators. Expected: not found.
  - In the Atlas web UI (`https://localhost:4552`), open branch `riverbend` and confirm the domain, types and
    instances. Confirm `main` is empty.
- [ ] **Step 3: Docs.** Update the README and both spec status lines, then run `npm test`. Expected: all pass.
- [ ] **Step 4: Commit.** `git commit -m "docs: Riverbend on Atlas: steps 2, 5 and 6 done"`
- [ ] **Step 5 (ask Matthew).** Offer to remove the spike leftovers: branch `spike-riverbend` and client
  `WaterOSSpike` with its secret file. Keep Connect source `historian-rb` and dataset `Riverbend`, which this plan
  reuses.
