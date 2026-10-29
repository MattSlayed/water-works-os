# Riverbend knowledge graph: one plant, synthetic operations, and LLM access to physical, document and live data

Status: for Matthew's approval (his three open decisions are recorded in §12) · 2026-10-29 · author: Claude (with Matthew)

## 1. Intent

Matthew asked two things:
- Can the Unreal render be the interface for the WaterOS overlay?
- Can we use what we already have to generate synthetic plant operations and build the ontology (knowledge graph)?

The graph is what an LLM draws on when it answers from three kinds of source:
- **physical**: the plant, its equipment, and where each item sits in 3D
- **document**: SOPs, manuals, permits, lab reports, shift logs
- **live**: sensor readings, alarms and events

The point is a sales and portfolio demo that holds up to an engineer's questions. "Why is RES-2 falling?" or "What do we know about the hot bearing on HLP-B?" should get a cited answer that points at the right pump in 3D, quotes the right SOP step, and shows the right trend. Every answer must be checkable against a known truth, because the data is synthetic and we plant the faults ourselves.

## 2. The render question (answered)

The Unreal film is a fixed video. It cannot be the overlay, because nothing in it can be clicked, highlighted or bound to data.

- **The overlay** is the **three.js twin, built from the same Blender model** and exported as glTF. Each mesh keeps its asset id, so a click resolves to a graph node and a graph node can light up its mesh.
- **Unreal** stays the hero film and marketing stills. A Pixel Streaming control-room build is out of scope; it needs a strong GPU per viewer.
- **The 3D scene's real value to the graph** is its object names and `asset`/`floor` tags (178 objects, 46 asset ids in `riverbend_meta.json`). They become the spatial layer.

## 3. Goals, non-goals, anti-goals

**Goals**
1. **One canonical Riverbend.** One plant, one id set and one timeline, shared by WaterOS, the NOVACORE website mock and the 3D model.
2. **A synthetic operations dataset.** It covers 90 days at 1-minute resolution and is physically coherent: flows balance, turbidity falls through the treatment train, and reservoir levels integrate in minus out. It contains planted scenarios with an answer key.
3. **A knowledge graph** with the physical, document and live layers joined on asset ids, carrying provenance and clearance.
4. **LLM access through tools.** The LLM uses graph search, neighbours, process upstream/downstream, readings, events and documents. Every answer is cited and pruned to the asker's clearance.
5. **An evaluation set.** About 40 questions with expected answers and evidence ids, run against the tools.
6. **A static export** of a public-role slice, with prepared answers for the website.

**Non-goals (v1)**
- Real plant connectors (OPC UA, MQTT, a SCADA historian). The live layer has a contract that a real connector can fill later.
- Vector embeddings and semantic search. Lexical search plus entity linking comes first (§8.3).
- An interactive Unreal build or Pixel Streaming.
- Control writes of any kind. These stay forbidden, as in the existing harness.
- Replacing the in-memory ontology at runtime (§7.1).

**Anti-goals: this fails even if it technically works when:**
- The LLM answers from generic water-treatment knowledge when the graph had the answer, or invents a reading or tag.
- The graph, the 3D model and the website disagree on what exists. For example, the graph has F12 but the model has 8 filters.
- Anything from the hidden reference works leaks: its name, tags, coordinates, drawings or the numbers in `RIVERBEND-SITE.md` that would identify it.
- Personal data is reachable by a role that should not see it.
- The data is "random noise with spikes", which an engineer would dismiss in a minute.

## 4. What already exists

| Source | Has | Conflicts |
|---|---|---|
| **WaterOS** (`water-works-os/`, 471 tests) | `ontology.mjs` (in-memory store, interface written to mirror a Neo4j graph service, provenance, clearance pruning). `generate.mjs` (36 assets, 239 parts, 120 sensors, 45 people, 44 WOs, SOPs, OEM docs, 56 lab samples, projects, region). `telemetry.mjs` (14-day, 1-minute pure-function historian with the HLP-B bearing, F07 breakthrough, DP-2 prime-loss and storm-plume scenarios). `layout.mjs` and the synthetic drawing set (DXF GA, DEXPI PFD and 8 P&IDs, CSV lists). Process graph and travel windows. Root Cause agent. | Plant sized for **120 ML/d** with **F01–F12**, **HLP-A..D**, **RWP-A..C** and reservoirs **CWR1/CWR2**. Telemetry window starts **2026-10-01**. |
| **NOVACORE mock** (`nc/`) | `CONTRACT.md` canonical facts at **2026-10-28 07:00**: AIT-101 38 NTU, TT-612 78 °C, RES-2 at 38 % and falling 2.5 %/h, CL-4 out so 90 ML/d. `lake.js` tables (scada_raw, telemetry_hourly, alarms, work_orders, lab_results, permits, filter_runs, asset_health, kpi_daily, finance_spend). `sim.js` first-order process model. `kb.js` documents. People, roles and orchestration. | Same story tags as WaterOS, but **8 filters** and a different "now". |
| **3D model** (Blender, then Unreal) | 178 objects. Ids SRC, RWP-1, RWR-1/2, T-201..204, MIX, CL-1..4, F01–F08, FB-1/2, FPR-1, BWR-1, CCT-1/2, RES-1/2, CLB-1, DOS-1, HLP-H with HLP-A..E, ELB-1, SLD-1, DB-1, ADM-1, WKS-1, GH-1, DIST. Floors F-INTAKE, F-CLAR, F-FILT, F-DISINF, F-HLP. The HLP-B drive-end bearing is a separate object. | Proportions come from the hidden reference (§10). There are no instrument meshes. |

The stories already line up: the HLP-B bearing, the F07 breakthrough after a storm, DP-2, CL-4 out of service for the RES-2 relining, and bulk-line zones Z13–Z15. The plant counts and timelines do not.

**Where the outside inputs live, and what step 0 does with them:**
- **Scene metadata:** `E:\Unreal Projects\Riverbend\SourceArt\riverbend_meta.json` (178 objects), plus `pumphall.json` beside it. Both are exported by the Blender scripts.
- **Website mock source** (`CONTRACT.md`, `lake.js`, `sim.js`, `kb.js`): this currently sits in a **temporary** session scratchpad, under `…\Temp\claude\…\scratchpad\nc\`.
- **Step 0:**
  - Copy the mock source to `Palantir Inspired OS/novacore-mock/`, outside this repo.
  - Copy the facts this project needs into the repo: `data/riverbend/contract.json` (the 12 canonical facts, the tag list and the floors) and `data/riverbend/scene-meta.json`. These copies are what the tests read.
- **The mock is not edited by this project.** Step 7 writes a static export folder that the mock, and later the website, read. Wiring it in is a separate task.

**The RES-2 collision, and how it resolves:**
- WaterOS's RES-2 is a remote town reservoir on the bulk line. The mock's RES-2 (LIT-501, floor F-DISINF) is the on-site clear-water reservoir. The 3D model has RES-1 and RES-2 on site.
- So RES-1/RES-2 mean the **on-site** clear-water reservoirs. WaterOS's remote RS-RES1/RS-RES2 are renamed **CR-1/CR-2**, "command reservoirs".
- **PRJ-RES2 relines cell B of the on-site RES-2.** That halves its working volume.
- **The mock's line "CL-4 out because of the RES-2 relining" is replaced with two independent causes:**
  - CL-4 is out for the clarifier refurbishment contract. WaterOS's existing refurbishment project and its WhatsApp group move from CL-3 to **CL-4**.
  - RES-2 is relined, halving its storage.
- **Together these give the headline question a real two-part answer.** Clarification is capped at 90 ML/d, below demand, and the half-size RES-2 drains faster. The F07 backwash deferral then made it worse.

## 5. One canonical plant (decided by Matthew, 2026-10-29)

The 3D model's plant is canonical. That means 8 filters, 4 clariflocculators, HLP-A..E, RWP-1 with its pumps, RWR-1/2 and RES-1/2, and a nominal **100 ML/d**, which drops to **90 ML/d with CL-4 out**. The visuals and the website mock already show this plant. WaterOS is regenerated to match:
- `layout.mjs` and the drawing set are regenerated to these counts. The DXF GA becomes a plan view of the 3D model's footprints in the local, mirrored frame.
- `generate.mjs` assets and positions are mapped through the crosswalk below.
- Tests that hard-code F09–F12 or HLP-D as the fourth pump are updated. There are about 8 such tests across 5 files; the rest should hold.

**Crosswalk** (a single file, `data/crosswalk.json`, is the only place the mapping lives):

| 3D / canonical | WaterOS today | Note |
|---|---|---|
| F01–F08 | F01–F12 | F09–F12 are dropped; the F07 story is kept |
| HLP-A..E | HLP-A..D | HLP-E is new (small duty) |
| RWP-1 (pump station) with RWP-A..C pumps | RWP-A..C | The station becomes a Structure; the pumps stay Positions |
| RES-1 / RES-2 (on site) | CWR1 / CWR2 | Sensor tags LIT-501 etc. per `CONTRACT.md` |
| CR-1 / CR-2 (remote) | RS-RES1 / RS-RES2 | Renamed to free RES-1/2 |
| RWR-1 / RWR-2 | — | New: raw-water reservoirs |
| T-201..204, MIX, DOS-1, CLB-1, FPR-1, BWR-1, CCT-1/2, SLD-1, DB-1 | partly in zones Z02–Z09 | Each becomes a Structure under its zone |
| ADM-1, WKS-1, GH-1, ELB-1 | Z10–Z12 | Structures |

The alternative is to keep WaterOS's 120 ML/d plant and re-model the 3D scene. That costs more and loses the film's match.

## 6. Ontology

### 6.1 Principles
- **Reuse WaterOS's types and relations.** Its 50 object types and its relations (CONTAINS, HAS_ZONE, HAS_POSITION, INSTALLED_AT, HAS_PART, MEASURES, FEEDS, ABOUT, GOVERNS, COVERS, ASSIGNED_TO, and so on) are the schema. Only what is missing gets added.
- **Every object carries `prov`** (source, source_uri, version, extracted_at, confidence) and zone-based clearance, as today.
- **Asset ids are the join key across all three layers.**

### 6.2 Physical layer

```
Site ─HAS_ZONE→ Zone ─CONTAINS→ Structure ─CONTAINS→ ProcessUnit stage membership
Structure ─HAS_POSITION→ Position ←INSTALLED_AT─ Asset ─HAS_PART→ Part
ProcessUnit ─FEEDS{share}→ ProcessUnit            (flow topology, from the PFD)
Line ─FROM/TO→ Position|Structure                 (pipes, from P&IDs / line list)
Sensor ─MEASURES→ Asset|ProcessUnit|Line
X ─HAS_GEOMETRY→ GeometryRef {file:"riverbend.glb", node:"HLP-B_Bearing_DE", floor:"F-HLP", centroid, bbox}   ← new
```

- `GeometryRef` is the only new type. It is generated from `riverbend_meta.json` and the glTF export, one per object that carries an asset id. The 57 untagged objects (terrain, fence, lights) get no graph node.
- **Sensors** have no meshes. Each Sensor anchors to its asset's GeometryRef with an optional local offset, so the overlay can place a pin. Instrument meshes may be added later.
- **Design basis.** The physical properties an engineer asks about (volumes, top water levels, filter area, pump duty points, materials) live as properties on Structure and Asset. They also live in one generated document, *Riverbend Design Basis*, written in fictional terms (§10).

### 6.3 Document layer

```
Document ─ABOUT→ Asset|Structure|ProcessUnit|Chemical
Document ─GOVERNS→ Procedure ─COVERS→ assetClass
Document ─HAS_CHUNK→ Chunk {text, heading, order}     ← new
Requirement ─COVERS→ ...  (Blue Drop requirements, existing)
```

- Documents keep their full text. **Chunks** (one per heading section, roughly 200–600 words) are the retrieval unit.
- Each chunk inherits its document's ABOUT links and clearance, so retrieval can quote a passage and cite `DOC-…#chunk`.
- Document families:
  - **Existing:** SOPs, OEM manuals, calibration docs, procedures.
  - **New, generated from the data (§7.4):** shift logs, the alarm journal, lab certificates, incident reports, the monthly compliance report, the Design Basis, P&ID and line-list notes, and permits.

### 6.4 Live layer

```
Sensor {historianTag, unit, range, alarmLo/Hi, band}  ─MEASURES→ ...
Alarm  {sensorId, raisedAt, clearedAt, priority, value} ─ON→ Sensor          ← promoted from telemetry to graph objects
Event  {kind: backwash|start|stop|trip|storm|dose_change|calibration, at, ...} ─ON→ Asset|ProcessUnit   ← new type
Anomaly{sensorId, onset, score, method} ─ON→ Sensor ─ explained by? → Finding                          ← new type
Sample {lab results, existing} ─AT→ SamplePoint
WorkOrder / Permit / Issue (existing) ─TARGETS→ Asset
```

- **Tag scheme:**
  - Every Sensor gets an ISA-style `tag`.
  - The 9 tags in `CONTRACT.md` keep their numbers (AIT-101, FIT-102, FIT-201, AIT-301, AIT-157, PDT-157, AIT-401, LIT-501, TT-612).
  - Every other tag follows `<ISA letters>-<area><nn>`, where the area is 1 for intake and raw water, 2 for inlet and coagulation, 3 for clarification, 1 again for filters by bay (the 15x numbers, such as AIT-157 = F07), 4 for disinfection, 5 for storage and 6 for high-lift.
  - The existing ids (`SEN-…`) stay as object ids, and the KKS tags stay as `historianTag`.
  - The crosswalk lists every sensor with its tag. An "invented tag" is any tag-shaped string that is not in it.
- **Readings never enter the graph.** About 19 million points would bloat it and help nobody.
- The graph holds the **sensor definitions plus everything that happened**: alarms, events, anomalies, samples and work orders. Readings are fetched through the `readings` tool (§8.2).

## 7. Storage

### 7.1 Graph
- **Runtime:** the existing in-memory `ontology.mjs` stays the runtime store. Its interface is synchronous and about 30 modules call it. An async Neo4j adapter would mean rewriting all of them for no demo benefit.
- **Neo4j mirror (new):** a write-through mirror subscribes to `ontology.on(...)` and upserts into Neo4j. A loader does the full initial sync.
  - Neo4j serves Cypher exploration, Bloom-style browsing, and the graph view for engineers in sales demos.
  - Uniqueness constraints are on `id`, with an index on `type`.
- **The app still runs without Neo4j.** The mirror is off when no connection string is set, so CI does not need Neo4j.
  - `shortcut: write-through mirror, the app never reads from Neo4j; switch callers to an async adapter only if a real tenant needs the graph to outlive the process.`

### 7.2 Time series
- **Runtime:** keep the pure-function historian, extended to 90 days and the coupled model (§7.3). It is deterministic, has zero dependencies and is already the WaterOS pattern.
- **Export:** an exporter writes **Parquet** (or gzip CSV if no Parquet writer is wanted, since WaterOS is zero-dependency) per sensor-day. It serves outside tools, DuckDB checks and a later TimescaleDB load.

### 7.3 Synthetic data generator

**Process model.** This extends `telemetry.mjs` and uses `sim.js` for the first-order shape. Each signal is a deterministic function of seed, time and scenario state. There is no `Date.now()` and no unseeded random.
- **Raw water:**
  - Flow follows the intake schedule.
  - Turbidity follows the catchment: a base level, plus a 24 h cycle, plus storm events from the existing scene and plume model.
- **Clarified turbidity:** a first-order lag of raw turbidity, using the residence time from `travelWindow`. Removal depends on coagulant dose against demand and on the CL hydraulic load. CL-4 out raises the load on CL-1..3.
- **Each filter:**
  - Run hours drive headloss.
  - Backwash triggers at 2.4 m headloss or 48 h, staggered so that no two filters backwash at once.
  - Filtered turbidity rises near the end of a run.
  - F07's media fault plus the plume gives the breakthrough.
- **Disinfection:** chlorine residual is dose minus demand. Demand rises with temperature and with turbidity carried over from the filters.
- **Reservoirs:** level integrates (filtered flow minus outgoing). Outgoing follows the diurnal demand from the bulk-line zones.
- **Pumps:**
  - Current comes from flow and the duty point.
  - Vibration and bearing temperature come from ambient plus load.
  - HLP-B's drive-end bearing degrades on a planted curve and reaches 78 °C at "now".
- **Window:**
  - 90 days, **2026-07-30 07:00 to 2026-10-28 07:00**. The end is the website mock's "now", so `CONTRACT.md` facts hold at the last minute.
  - The clock can replay forward from there.
  - WaterOS scenario times are re-anchored to this window. Tests anchor on scenario times, not on absolute dates.

**Scenarios**, each with an entry in `data/answer-key.json` giving its cause, onset, evidence ids and the expected answer:

| Id | Scenario | Signals | Notes |
|---|---|---|---|
| S1 | HLP-B drive-end bearing degradation | TT-612, vibration, current | Existing. A WO and a permit follow. |
| S2 | F07 breakthrough after a storm plume | AIT-157, PDT-157, AIT-301 | Existing. The plume is a contributing cause; the local cause is the F07 media. |
| S3 | DP-2 intermittent loss of prime | Dose flow, chlorine residual | Existing |
| S4 | CL-4 out for refurbishment, and RES-2 cell B being relined | Capacity 90 ML/d, RES-2 falling | Two independent causes (§4); ties to the website facts |
| S5 | Three storms over 90 days, coagulant dose adjusted | AIT-101 spikes, dose changes | Two are handled well; one is handled late, as a lesson |
| S6 | Filtered-water turbidity analyser drifts, caught by a lab grab sample | AIT-301 vs. lab results | Tests "trust the lab over the sensor" |
| S7 | Quiet weeks with routine backwashes and PM work orders | — | Negative controls for false positives |

**Volume:** about 150 sensors × 129,600 minutes ≈ 19 M points, computed on demand. The graph gets about 8–15 k objects, mostly samples, events, alarms, work orders and chunks.

### 7.4 Documents generated from the data
- **Template-built from the data:**
  - Shift logs (2 a day)
  - The alarm journal
  - Lab certificates (daily and grab samples)
  - Incident reports (S1, S2, S6)
  - The monthly compliance report (Blue Drop style)
  - Permits and isolation certificates
  - The Design Basis
- **Generation rules:**
  - Each document cites the ids it was built from, so no document can contradict the data.
  - An optional LLM pass rewrites the template text to read like a person wrote it. The result is stored as a fixture with `prov.source = "SYNTH-LLM"`; it is never regenerated at runtime.
- **Planted human imperfections:**
  - A shift log that understates the bearing temperature
  - A late entry
  - A handover note that contradicts the alarm journal
  - These exist so the LLM must weigh sources. Each one is listed in the answer key.

## 8. How the LLM reaches it

### 8.1 Retrieval pattern: entity-linked
1. **Resolve entities** in the question: tags, asset names, sensor names, documents, people (role-gated) and time phrases. This uses lexical search over `id`, `tag`, `positionTag` and `name`, plus the crosswalk.
2. **Expand the subgraph:** one or two hops from each entity, plus the process upstream and downstream sets with their travel windows (existing functions).
3. **Pull evidence:** chunks ABOUT those nodes; alarms, events and anomalies in the time window; and readings summarised for the sensors involved (min, max, mean, onset, slope).
4. **Answer** with citations to object ids, chunk ids and reading windows. Where a GeometryRef exists, the answer carries a `focus` list so the overlay can frame the right meshes.

### 8.2 Tools
These are exposed to the in-app agents and as an **MCP server**, which closes WaterOS backlog item P5. All of them run through `ont.view(viewer)`.

| Tool | Returns |
|---|---|
| `search(q, types?)` | Ranked objects |
| `get(id)` / `neighbors(id, rel?)` | Objects and links |
| `upstream(id)` / `downstream(id)` | Process sets with split shares and travel windows |
| `readings(sensorId, from, to, agg)` | Series or summary from the historian |
| `events(scope, from, to, kinds?)` | Alarms, events, anomalies and samples |
| `documents(aboutId?, q?)` / `read(chunkId)` | Chunks with citations |
| `locate(id)` | GeometryRef(s) for the overlay |
| `cypher(query)` | **Manager clearance only, read-only**, against the Neo4j mirror. Off by default. Raw Cypher bypasses zone pruning, so it is limited to the one role that already sees everything. |

### 8.3 Search
- **v1:** lexical search plus entity linking. The vocabulary (tags, ids and equipment names) is exact, and the questions are about named things.
- **Later:** embeddings, via the Neo4j vector index on Chunk, for "have we seen anything like this before?". Out of scope here.

### 8.4 The website (prepared answers only)
- An offline script runs the tools as the **public role** over the question bank and stores the answers with their citations. It also exports a pruned static slice (graph JSON, a downsampled reading series, chunks) for the mock.
- The website never calls an LLM.
- **The public role** is a new clearance rank below technician. It sees:
  - every zone at operator level
  - assets, sensors and hourly readings
  - alarms, events, samples, work orders and incident reports
  - SOPs and the Design Basis

  It never sees Person, Presence, Channel, Message, Execution or Feedback objects, or the names in permits and logs, which become role names. The data is synthetic, so the demo shows as much as it can without exposing anyone.

## 9. Overlay link
- **glTF export.** Blender exports `riverbend.glb` from the existing blockout. Object names are unchanged, and `asset` and `floor` are written to glTF `extras`.
- **WaterOS plant view.** `web/plant.js` gains a glTF path beside its procedural one.
  - Click a mesh: read the node name, then the GeometryRef, then the graph object, then the asset card.
  - An answer's `focus` list frames and highlights those meshes. Sensor pins come from the anchors.
- **Website mock.** It uses the same `.glb` (the earlier route D).
- **Unreal** reads nothing from the graph in v1.

## 10. Constraints
- **Fictional-name rule:**
  - Allowed: only Riverbend names and the `CONTRACT.md` ids and tags, plus the ids above.
  - Never used: the reference works' name, owner, engineer, drawing numbers, real tags or coordinates.
  - The Design Basis and all generated documents may use **rounded or shifted** dimensions. `RIVERBEND-SITE.md` itself never enters the graph, the repo or the website.
- **POPIA:**
  - Person objects stay synthetic and role-gated, as today.
  - Shift logs name roles or synthetic people only.
  - Website exports exclude Person, Presence and Channel entirely.
- **Agents:** no control writes, and no autonomy change. The existing harness rules apply to every new tool.
- **Determinism:** every dataset is reproducible from the seed. Generated text fixtures are committed, not regenerated.
- **Repo conventions:** Node 22, zero required dependencies, LF line endings, tests stay green, TDD per the superpowers plan.

## 11. Evaluation
- **Question bank:** `data/eval-questions.json`, about 40 questions in five kinds:
  - **Physical:** "Which pumps feed the bulk line and how many are on duty?"
  - **Document:** "What does the SOP say to do before changing the HLP-B drive-end bearing?"
  - **Live:** "When did TT-612 first go above 70 °C?"
  - **Cross-layer cause:** "Why did filtered turbidity rise on the 26th, and was the storm the cause?"
  - **Trap:** the drifted analyser, the contradicting handover note, questions above the asker's clearance, and questions about things that do not exist (F12).
- **Scoring per question:**
  - Right answer
  - Every cited id exists and supports the claim
  - No fact appears without a citation
  - Clearance respected
  - "Insufficient evidence" when that is the truth
- **Grading:**
  - Each answer-key entry lists **required facts** (values with tolerances, ids, times) and **forbidden claims**.
  - "Right" means every required fact appears and no forbidden claim does. This is a rule grader, like the existing evals, with no LLM judge.
- **Pass bar for the demo:**
  - The **Claude run** must get 90 % right, with 100 % of citations valid, 0 clearance leaks and 0 invented tags.
  - **CI** runs without an API key and checks the tools themselves: every expected evidence id is reachable through the tools for the asker's role, citations resolve, clearance holds, and trap questions return "not found" or "insufficient evidence".
  - CI does not build a rule-based question answerer.

## 12. Decisions

**Matthew's (decided 2026-10-29)**
1. **Canonical plant:** the 3D/website plant: 8 filters, HLP-A..E, 100 ML/d (90 ML/d with CL-4 out). WaterOS is updated to match.
2. **Neo4j:** build the write-through mirror and loader in this project (step 6). Matthew starts a local Neo4j before that step.
3. **Generated documents:** a one-time LLM rewrite. The results are stored as fixtures with `prov.source = "SYNTH-LLM"`.

**My calls (check while reading)**
- The 90-day window ends at the mock's "now", 2026-10-28 07:00, and WaterOS scenarios are re-anchored to it.
- Readings stay out of the graph. The graph holds definitions and everything that happened.
- In-memory stays the runtime, with Neo4j as a write-through mirror rather than an async rewrite.
- Lexical search plus entity linking for v1; no embeddings.
- Chunks are per heading section.
- The overlay uses glTF from Blender; Unreal is film only.
- HLP-E is a small-duty pump like HLP-D.
- RWP-1 is a station Structure that holds the RWP-A..C pumps.
- **RES-2 is the on-site reservoir**, and the remote reservoirs become CR-1/CR-2.
- **CL-4 is out for refurbishment, not because of the relining.** The existing refurbishment project and its group chat move from CL-3 to CL-4.
- **Sensor tags** keep the `CONTRACT.md` numbers and follow an area rule for the rest.
- **The public role** sees everything except people data.
- **Rule-based grading against required facts.** The 90 % bar applies to the Claude run; CI checks the tools, citations and clearance.
- `cypher` is manager-only.
- **Step 0** copies the mock source out of the temporary scratchpad.

**Left to the builder**
- Exact sensor list per asset class beyond the existing profiles
- The file layout for the export
- Parquet versus gzip CSV
- Template wording
- Chunk size limits
- Scenario curve shapes, as long as the answer-key onsets and the `CONTRACT.md` facts hold

## 13. Build order
0. **Inputs.** Copy the mock source to `novacore-mock/` and the contract and scene meta into `data/riverbend/`.
1. **Crosswalk and canonical plant.** Update `layout.mjs`, the drawings and `generate.mjs`, and fix the tests that change.
2. **Physical layer from 3D.** Export glTF and the meta, generate GeometryRefs and sensor anchors, and write the Design Basis.
3. **Generator.** Build the coupled 90-day model, S1–S7 and the answer key, and promote Alarm, Event and Anomaly to graph objects.
4. **Documents.** Generate the document families, chunk them, add the planted imperfections and the one-time LLM pass.
5. **Tools and MCP server**, with the eval bank and scoring.
6. **Neo4j mirror and loader.**
7. **Overlay.** Add glTF loading in `web/plant.js` and `focus` framing, then the website static export with prepared answers.

Each step is its own plan under `docs/superpowers/plans/` and is browser-walked before the next.
