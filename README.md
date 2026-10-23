# Water Works OS — Phases 1–3

An ontology-driven operating system for a **synthetic** water treatment works (Riverbend WTW), built from
`../03-PRD-Water-Works-OS.md` (NVT-PROJ-BBR-WTW-002). Grade: `demonstrable` over synthetic data.

## Run it

```bash
npm test          # 211 tests: generator, ontology, telemetry, functions, actions, agents + evals, copilot, chat, drawings, parsers, plant model, process graph, API, web
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
| Synthetic works: 12 zones, 10 process stages, 21 hero/plant assets with part breakdowns, 42 people, competencies, shifts, WOs, permits, SOPs, OEM fault trees, lab samples | `src/generate.mjs` | AC-01, Appendix B |
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

three.js 0.160.0 (MIT) is vendored under `web/vendor/three@0.160.0/` from the npm tarball, so the console needs no CDN;
it is not a package dependency. Regenerate the drawing set with `node scripts/make-drawings.mjs`.

Design prototypes for the same screens: https://claude.ai/artifact/LwS7u1g2MyCjYfzRA4ivKL (private until shared).

## Not in this build

- Real connectors (OPC UA/MQTT gateway, ERP/CMMS, LIMS, HR, GIS, RTLS, WhatsApp Business API, SharePoint/Drive). The
  store, telemetry and chat are in-memory stand-ins behind the same interfaces. The chat stub trusts the
  `x-channel-sender` header; a real webhook must verify the provider's signature.
- Voice-note transcription and photo storage: media are references (`photo:…`) only.
- AI conversion of arbitrary SOP PDFs into steps: the four synthetic SOPs are converted by hand.
- Neo4j, Graphiti, Qdrant and TimescaleDB adapters; the photoreal splat site walk; Unreal showcase.
- Trained ML models: risk functions are transparent heuristics (`functions.mjs`).
- Real CAD, survey or point-cloud geometry: the plant is template geometry generated from a synthetic drawing set, and
  every rendering says so. Roads are not drawn (the GA's road polylines are not extracted into the model). P&ID symbol
  recognition from images is not attempted; the readers take the documented text subsets only.
- ERP write-back and any control-system write (PRD BR-06).
- Authentication: the acting user is a header for the demo. Do not expose this server beyond localhost.

Implementation plans: `docs/superpowers/plans/2026-10-23-water-works-os-phase1.md`,
`docs/superpowers/plans/2026-10-23-workforce-intelligence-phase2.md` and
`docs/superpowers/plans/2026-10-23-plant-blueprint-twin.md`.
