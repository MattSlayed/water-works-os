# Water Works OS — Phases 1–3

An ontology-driven operating system for a **synthetic** water treatment works (Riverbend WTW), built from
`../03-PRD-Water-Works-OS.md` (NVT-PROJ-BBR-WTW-002). Grade: `demonstrable` over synthetic data.

## Run it

```bash
npm test          # 392 tests: generator, ontology, telemetry, functions, actions, agents + evals, copilot, chat, drawings, parsers, plant model, process graph, region, trackers, scenes, Geo Watch, live mode, agent harness, root cause, connectors, digester, studio, recommendations, API, web
npm start         # http://localhost:8830  (plant clock advances 1 minute every 2 seconds)
```

Node 22 or later. No other dependency is needed. `@anthropic-ai/sdk` is optional: with `ANTHROPIC_API_KEY` set, the
Technician Copilot writes its answers with Claude (`claude-opus-5-5`) from the same cited records; without it, every
agent runs on deterministic logic. Inference is cross-border and disclosed under POPIA s72 (NVT-PROJ-BBR-ARC-001 §4).

Use the "Acting as" selector to switch people. Try P-001 (works manager), P-002 (reliability engineer, can turn the
autonomy dial), P-004 (planner, resolves proposals) and P-028 (millwright, artisan view).

Phase 2, Workforce Intelligence (design: `docs/superpowers/specs/2026-10-23-workforce-intelligence-design.md`):

- **P-028, Chat:** send `start`. Step 1 is locked until a permit exists. Switch to **P-009** and open a permit and
  isolation on HLP-B (Assets & twin → HLP-B → **Open permit and isolate**), then back to P-028 and send `done` per step,
  `done 110.065` at step 7 (out of band: a deviation is proposed), and a sentence ending in `?` to ask the Copilot.
  After the last step, answer the question: it becomes a field note, and the Scribe sends the job card for a yes/no.
- **P-004, Projects:** the CL-3 contract, read from its WhatsApp group. Confirm the claimed milestone.
- **P-002, Procedures:** edit a step of the pump SOP and propose v4; **P-001** releases it.
- **P-028, My work:** your own time per step against the procedure; turn on agent submission. **P-030** has it on.
- The contractor's side of the group: `curl -X POST localhost:8830/api/channels/CHN-GRP-CL3/inbound -H "x-channel-sender: PAR-001" -H "content-type: application/json" -d '{"text":"Bearings out and slewing ring replaced"}'`

## What is in it

| Area | Where | PRD |
|---|---|---|
| Synthetic works: 12 zones, 10 process stages, 21 hero/plant assets with part breakdowns, 45 people (with an accounts clerk, a finance officer and an IT administrator), competencies, shifts, WOs, permits, SOPs, OEM fault trees, lab samples | `src/generate.mjs` | AC-01, Appendix B |
| Ontology store with provenance, links, search, events and server-side pruning by clearance and zone | `src/ontology.mjs` | FR-ONT, FR-GOV-001 |
| 14-day, 1-minute telemetry replay with fault scenarios (HLP-B bearing, F07 breakthrough, DP-2 prime loss) | `src/telemetry.mjs` | FR-INT-001/002 |
| Function tools: failure risk, anomaly, breakthrough risk, storage hours, consequence, competence check | `src/functions.mjs` | §6.4, FR-ANL |
| Typed actions shared by people and agents; autonomy dial with ceilings; proposals, feedback, reversal; hash-chained audit | `src/actions.mjs`, `src/audit.mjs` | §6.3, FR-AGT-004/007/011, FR-GOV-002/003 |
| 14 agents, run logs, chaining (Asset Watch → Triage → Work Pack → Parts Readiness → Scheduler), manifest checks, eval suites | `src/agents.mjs`, `src/evals.mjs` | FR-AGT, AC-08..13 |
| Technician Copilot: situational insight, safety-gated checks, band checks with deviation proposal, tagging | `src/copilot.mjs`, `src/llm.mjs` | FR-AVZ-005..010 |
| HTTP API, SSE events, plant clock with scheduled agents, muster mode | `src/server.mjs` | FR-CON, FR-GEO-006 |
| Versioned procedures from SOPs (SharePoint source, permit locks, readings, expected minutes); executions, issues, field notes | `src/generate.mjs`, `src/actions.mjs`, `src/functions.mjs` | Phase 2 design §6 |
| Works number: chat stub, rule parser, Chat Intake agent, one reply per message, contractor claims from group chat | `src/channels.mjs`, `src/parse.mjs`, `src/agents.mjs` | Phase 2 design §5, §7, §8 |
| Scribe (job cards, close-outs, weekly reports; consent-gated submission), Project Watch, Procedure Steward; performance and project status | `src/agents.mjs`, `src/functions.mjs` | Phase 2 design §6.4, §7 |
| Chat, Issues, Projects, Procedures and My work views | `web/app.js` | Phase 2 design §9 |
| Web console (NOVATEK design system): console, site map + muster, asset workbench with three.js twin, agent hub, proposals, knowledge, compliance, ontology explorer, audit | `web/` | FR-CON, FR-GEO, FR-TWN, FR-AVZ |
| Layout sized for 120 ML/d (structures, levels falling 5.9 m by gravity, machine placements, georeference) and a synthetic drawing set in real text formats: DXF R2000 GA and hydraulic profile, DEXPI 1.3-subset PFD and eight P&IDs, CSV line, equipment and instrument lists; rev A and rev B, with seeded disagreements | `src/layout.mjs`, `src/drawings/make.mjs`, `data/drawings/` | Phase 3 design §4.1–4.2 |
| Zero-dependency DXF, DEXPI-subset and CSV readers; extraction into graded cells (EXTRACTED / INFERRED / AMBIGUOUS) and whole-tag binding to Positions and Sensors | `src/ingest/` | Phase 3 design §4.3 |
| Plant model revisions: seeded rev A, live ingest of newer sheets with review marks carried forward, cell review, four-eyes release with a content hash, revision-scoped plant objects, Issues for accepted disagreements | `src/plant.mjs`, `src/actions.mjs` | Phase 3 design §4.3–4.5 |
| Process graph over the released model: upstream and downstream sets with split shares, all simple paths, travel windows (onset, mean, tail), change-onset detection | `src/functions.mjs` | Phase 3 design §4.6 |
| Plant view: physical 3D (sky, sun shadows baked once, procedural materials, click-down into pump houses, states, alerts, band-tinted filter water) and blueprint (hidden-line, process lines by service, flow arrows, x-ray, skeletal map, upstream highlight with travel-window captions); SVG fallback without WebGL; server-side pruning that cuts lines at hidden zones; revision review and release screen | `web/plant.js`, `web/app.js`, `src/server.mjs` | Phase 3 design §5, §7 |
| Region geography in WGS84 (catchment, Riverbend Dam, river, intake, raw-water main, bulk line, roads, areas of interest), bulk-line zones Z13–Z15, remote pump stations, reservoirs and valve chambers with telemetry; spatial functions (within, distance, along a line, objects in an area) | `src/region.mjs`, `src/functions.mjs` | Region design §4.1–4.2 |
| Tagged vehicles and portable plant: pings every minute moving and five parked, live/stale/lost by age, allowed areas with geofence events; people are never tracked | `src/trackers.mjs` | Region design §4.3 |
| Seven projects with footprints, budget and spend, what they take out of service; treatment capacity as the bottleneck stage | `src/region.mjs`, `src/regionview.mjs` | Region design §4.4 |
| Synthetic Sentinel-2 and Sentinel-1 scenes: a year of statistics in the Planetary Computer shape, 90-day baselines, banded grids (index, not calibrated), the day-10 storm plume reaching the intake as a contributing cause of F07 | `src/scenes.mjs`, `src/telemetry.mjs` | Region design §5.1–5.3 |
| Geo Watch (agent 19): suggested detections, alert, coagulant-dose and sampling-round proposals, the round by chat, a Sample, human confirm or reject | `src/agents.mjs`, `src/actions.mjs` | Region design §5.4 |
| Agent harness: a decision statement per agent read back in plain sentences; shadow, assisted and bounded modes; shadow actions matched to what people did; four-eyes promotion one step at a time, automatic demotion; evidence freshness ("evidence stale"); inherited hard constraints (no control writes, chlorine and money at propose, the permit holder's own); named approvers with a backup after escalation, timeouts that drop or hold and never apply; approval cards; off switches per agent and per tool; relative revert that keeps a later human edit | `src/harness.mjs`, `src/actions.mjs`, `src/agents.mjs` | Agents design §4 |
| Root Cause (agent 20): symptom onset, upstream candidates on the released model with travel windows, the raw water and the plume, the breadth test, ranked local and contributing causes with evidence and "show me", rejected hypotheses with their timing, "Insufficient evidence" instead of a guess; an outcome check after a fix | `src/rca.mjs`, `src/agents.mjs` | Agents design §5 |
| Synthetic connectors in the real APIs' shapes (Microsoft Graph mail and driveItems, Teams, Gmail, Drive, Sheets, an ERP): 30 days of accounts mail with five planted traps (a duplicate, a smudged photo, no PO number, a total 6% over its PO, changed bank details), 40 POs, goods receipts and the clerk's filing log; nothing touches the network | `src/connectors/` | Agents design §7 |
| IT's connector catalogue: per connector and operation, the roles that may use it, the most an agent may do, and a per-role IT sign-off; studio agents run as their builder, whoever starts them, and read only the connectors their statement lists | `src/generate.mjs`, `src/actions.mjs`, `src/agents.mjs` | Agents design §7 |
| Document digester: fields graded read clearly / worked out / unsure from the text layer (Claude reads images when it is on), three-way match within a tolerance, duplicates and bank changes, the filing folder learnt from past filings; file only what is clean, post only as a proposal, bank changes to a person, unsure fields to review beside the document | `src/digest.mjs`, `src/templates.mjs`, `src/actions.mjs` | Agents design §8 |
| Agent Studio: rule / agent / person screen, a keyword planner for five templates (digester, watch, weekly report, chaser, supplier tidy-up) or Claude when on, statement checks against the catalogue, read-back sentences that edit the statement both ways, a 14-day replay matched to what the person did, start in shadow, IT sign-off before promotion, the named approver promotes | `src/studio.mjs`, `src/templates.mjs`, `src/harness.mjs` | Agents design §6 |
| Recommender (agent 21): six signals from each person's own work (filings by hand, the same check every morning, slow approvals, repeated overrides, long steps, a pile of one kind of issue); private, with evidence and a basis, dismissed for 30 days | `src/recommend.mjs`, `src/agents.mjs` | Agents design §9 |
| Studio, Suggested for you, IT catalogue and Documents screens | `web/app.js` | Agents design §10 |
| Optional live mode (`GEO_LIVE=1`): Sentinel-2 index statistics from Microsoft Planetary Computer over `data/geo/live-aoi.geojson`; tests use captured fixtures | `src/geolive.mjs` | Region design §5.5 |
| Region view: Since you left, Today's supply risks, scene timeline, layers and filters, clustering, projects and operations tab with the four-part project panel, operation focus, Enter plant; offline basemap fallback; phone layout; server-side pruning | `web/region.js`, `web/app.js`, `src/server.mjs` | Region design §6–7 |

Phase 3, project 1 — the plant from its drawings (design: `docs/superpowers/specs/2026-10-23-plant-blueprint-twin-design.md`):

- **J14, click-down (P-001):** Plant → select the high-lift pump house 20UMC01; it turns translucent. Select HLP-B in place
  (its alert ring pulses) → **Open twin**.
- **J15, blueprint reading (P-002):** Plant → **Blueprint** → select filter 15HFA07 → **Show upstream**. The path lights back
  through all four clarifiers at ¼ each and the dosing branches to the intake, with "onset ≈ …, mean ≈ … (design values
  at the measured inlet flow)".
- **J13, living blueprint:** **P-002**, Plant → Revisions and review → **Ingest received drawings** (GA, line list and
  PID-05 at rev B). Accept extracted cells per sheet, accept the inferred lengths one by one, and **Exclude** the old
  washwater route RB-L-421X (the one AMBIGUOUS cell). P-002's Release is refused (four eyes). Switch to **P-001** and
  Release: the Plant re-renders at rev B with filter-to-waste lines on F01–F04, and an Issue is raised for instrument
  15CQ13, which matches no sensor.
- **J16, phone (P-004):** at under 720 px wide the Plant opens in blueprint; a tap selects an item and links its record.
- With WebGL off, the Plant shows the site plan with structure outlines and line paths, each linking to its record.

Phase 3, project 2 — the Region map and satellite layer (design: `docs/superpowers/specs/2026-10-23-region-map-satellite-design.md`):

- **J17, the 07:00 view (P-001):** Region. *Since you left* lists the suggested plume, PP-2 off the raw-water main site
  and the slipped main milestone; *Today's supply risks* shows raw water raised, 30 ML/d out of service (clarification
  limits the works to 90) and RES-2 under 12 h.
- **J18, plume response (P-008, then P-005):** click the plume: the panel opens, the day-11 NDTI grid lights the inflow arm
  and focus shows the sample boat, the intake and the coagulant truck with its ETA. Approve Geo Watch's sampling round in
  Proposals. As **P-005**, Chat: reply `raw 88 NTU at intake jetty`; a Sample is recorded. Back on Region, **Confirm**.
- **J19, project check (P-004):** Projects tab → RES-2 relining: the footprint, the contractor and PP-1 on site, R 1.90 m
  of R 2.40 m, storage −50% until 14 Nov, and the open issue with its log entry.
- **J20, into the plant (P-002):** zoom in over the works → **Enter plant** opens the Plant on the intake pump house;
  Back returns to the same map.
- **J21, technician (P-028):** nothing from the PS-2 MCC room (Z15) reaches the map, the panel, focus or the stream.
- **J22, offline:** with no tiles the map draws every layer on a plain background and says "basemap offline".
- **J23, the harness (P-002):** Agents → Decision statements → Process Watch reads back what it may do, who answers
  (anyone with the action's clearance) and that it never writes to the control system. Turn `request_setpoint_change`
  off: its open backwash request is withdrawn. Turn it back on. P-002 owns the default agents, so Promote is refused.
- **J24, root cause (P-001):** the F07 alert's record → **Find root cause**. F07 (local) ranks first, the storm plume
  contributes (suggested, weight 0.5; 0.7 once confirmed), raw water rose about 2.7 h before F07, inside the travel
  window, and DP-2 is rejected as too late. **Show me** on the plume opens the Region on it.
- **J25, the clerk builds an agent (P-043):** Agent Studio → "When a supplier invoice comes into the accounts inbox,
  read it, check it against the PO and file it in the right supplier folder." → an agent. The read-back says filing
  needs IT approval, Thandi Mokoena answers for posting, and Precious Sithole after 4 hours. Replay: 23 of 25 agree,
  1 unsure, 1 caught. **Start in shadow.**
- **J26, IT and finance (P-045, then P-044):** IT catalogue → **Sign off for accounts_clerk** on m365.files write.
  As P-044, Agents → the clerk's digester → **Promote to assisted**. The clerk cannot promote it herself.
- **J27, a suggestion (P-028):** Agent Studio → Suggested for you shows a watch on HLP-B bearing temperature with its
  readings as evidence. Dismiss it with "I like to look myself"; a day later it has not come back.
- **J28, Claude off:** with no API key, J25 works on the text-layer documents and the studio says "Claude is off".
- Live mode: `GEO_LIVE=1 npm start` fetches real Sentinel-2 statistics for the example area (a rough outline of
  Rietvlei Dam) and shows them as their own line; they are never mixed into the synthetic works.

Leaflet 1.9.4 (BSD-2-Clause) is vendored under `web/vendor/leaflet@1.9.4/` from the npm tarball; OpenStreetMap tiles load
in the browser only, with attribution.

three.js 0.160.0 (MIT) is vendored under `web/vendor/three@0.160.0/` from the npm tarball, so the console needs no CDN;
it is not a package dependency. Regenerate the drawing set with `node scripts/make-drawings.mjs`.

Design prototypes for the same screens: https://claude.ai/artifact/LwS7u1g2MyCjYfzRA4ivKL (private until shared).

## Not in this build

- Real connectors (OPC UA/MQTT gateway, ERP/CMMS, LIMS, HR, GIS, RTLS, WhatsApp Business API, Microsoft 365, Google
  Workspace). The store, telemetry, chat and the synthetic Microsoft 365, Google and ERP stores are in-memory stand-ins
  behind the same interfaces; documents carry a text layer rather than real PDFs. The chat stub trusts the
  `x-channel-sender` header; a real webhook must verify the provider's signature.
- Voice-note transcription and photo storage: media are references (`photo:…`) only.
- AI conversion of arbitrary SOP PDFs into steps: the four synthetic SOPs are converted by hand.
- Neo4j, Graphiti, Qdrant and TimescaleDB adapters; the photoreal splat site walk; Unreal showcase.
- Trained ML models: risk functions are transparent heuristics (`functions.mjs`).
- Real CAD, survey or point-cloud geometry: the plant is template geometry generated from a synthetic drawing set, and
  every rendering says so. Roads are not drawn (the GA's road polylines are not extracted into the model). P&ID symbol
  recognition from images is not attempted; the readers take the documented text subsets only.
- Real GPS or vehicle-tracking feeds, satellite imagery tiles, InSAR (no EGMS/OPERA coverage of South Africa), flood maps,
  and calibrated water quality from satellites: indices stay indices. Tracking people is out by design.
- ERP write-back and any control-system write (PRD BR-06).
- Authentication: the acting user is a header for the demo. Do not expose this server beyond localhost.

Implementation plans: `docs/superpowers/plans/2026-10-23-water-works-os-phase1.md`,
`docs/superpowers/plans/2026-10-23-workforce-intelligence-phase2.md`,
`docs/superpowers/plans/2026-10-23-plant-blueprint-twin.md` and
`docs/superpowers/plans/2026-10-23-region-map-satellite.md`.
