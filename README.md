# Water Works OS — Phase 1 MVP

An ontology-driven operating system for a **synthetic** water treatment works (Riverbend WTW), built from
`../03-PRD-Water-Works-OS.md` (NVT-PROJ-BBR-WTW-002). Grade: `demonstrable` over synthetic data.

## Run it

```bash
npm test          # 169 tests: generator, ontology, telemetry, functions, actions, agents + evals, copilot, chat, API, web
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

Design prototypes for the same screens: https://claude.ai/artifact/LwS7u1g2MyCjYfzRA4ivKL (private until shared).

## Not in this build

- Real connectors (OPC UA/MQTT gateway, ERP/CMMS, LIMS, HR, GIS, RTLS, WhatsApp Business API, SharePoint/Drive). The
  store, telemetry and chat are in-memory stand-ins behind the same interfaces. The chat stub trusts the
  `x-channel-sender` header; a real webhook must verify the provider's signature.
- Voice-note transcription and photo storage: media are references (`photo:…`) only.
- AI conversion of arbitrary SOP PDFs into steps: the four synthetic SOPs are converted by hand.
- Neo4j, Graphiti, Qdrant and TimescaleDB adapters; the photoreal splat site walk; Unreal showcase.
- Trained ML models: risk functions are transparent heuristics (`functions.mjs`).
- ERP write-back and any control-system write (PRD BR-06).
- Authentication: the acting user is a header for the demo. Do not expose this server beyond localhost.

Implementation plans: `docs/superpowers/plans/2026-10-23-water-works-os-phase1.md` and
`docs/superpowers/plans/2026-10-23-workforce-intelligence-phase2.md`.
