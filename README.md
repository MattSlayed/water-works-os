# Water Works OS — Phase 1 MVP

An ontology-driven operating system for a **synthetic** water treatment works (Riverbend WTW), built from
`../03-PRD-Water-Works-OS.md` (NVT-PROJ-BBR-WTW-002). Grade: `demonstrable` over synthetic data.

## Run it

```bash
npm test          # 81 tests: generator, ontology, telemetry, functions, actions, agents + evals, copilot, API, web
npm start         # http://localhost:8830  (plant clock advances 1 minute every 2 seconds)
```

Node 22 or later. No other dependency is needed. `@anthropic-ai/sdk` is optional: with `ANTHROPIC_API_KEY` set, the
Technician Copilot writes its answers with Claude (`claude-opus-5-5`) from the same cited records; without it, every
agent runs on deterministic logic. Inference is cross-border and disclosed under POPIA s72 (NVT-PROJ-BBR-ARC-001 §4).

Use the "Acting as" selector to switch people. Try P-001 (works manager), P-002 (reliability engineer, can turn the
autonomy dial), P-004 (planner, resolves proposals) and P-028 (millwright, artisan view).

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
| Web console (NOVATEK design system): console, site map + muster, asset workbench with three.js twin, agent hub, proposals, knowledge, compliance, ontology explorer, audit | `web/` | FR-CON, FR-GEO, FR-TWN, FR-AVZ |

Design prototypes for the same screens: https://claude.ai/artifact/LwS7u1g2MyCjYfzRA4ivKL (private until shared).

## Not in this build

- Real connectors (OPC UA/MQTT gateway, ERP/CMMS, LIMS, HR, GIS, RTLS). The store and telemetry are in-memory stand-ins
  behind the same interfaces.
- Neo4j, Graphiti, Qdrant and TimescaleDB adapters; the photoreal splat site walk; Unreal showcase.
- Trained ML models: risk functions are transparent heuristics (`functions.mjs`).
- ERP write-back and any control-system write (PRD BR-06).
- Authentication: the acting user is a header for the demo. Do not expose this server beyond localhost.

Implementation plan and ledger: `docs/superpowers/plans/2026-10-23-water-works-os-phase1.md`.
