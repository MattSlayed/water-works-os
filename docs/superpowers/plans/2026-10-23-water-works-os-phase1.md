# Water Works OS — Phase 1 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable Water Works OS over the synthetic Riverbend works: ontology, telemetry replay, typed actions with an autonomy dial, an agent runtime with run logs and evals, a Technician Copilot, and a web console with map, twin and asset breakdown.

**Architecture:** One Node 22 process, zero npm dependencies. In-memory ontology store behind an interface that mirrors the production graph service, so Neo4j/Timescale adapters can replace it later. Agents are data (specs) executed by a runtime that calls only ontology query, action and function tools; every call is logged. The browser is plain ES modules; three.js comes from a pinned CDN for the 3D asset view.

**Tech Stack:** Node 22 (`node:test`, `node:http`, `node:crypto`), vanilla ES modules, three.js 0.160.0 (jsDelivr), SVG for the site map. Optional Claude Messages API via `fetch` when `ANTHROPIC_API_KEY` is set.

**Spec:** `../../../03-PRD-Water-Works-OS.md` (NVT-PROJ-BBR-WTW-002), with `../../../02-BRD-Water-Works-OS.md` for business rules.

## Global Constraints

- Synthetic data only, reproducible from a seed (PRD NFR-10, AC-01).
- Every object and link carries provenance `{source, source_uri, source_version, extracted_at, confidence}` (FR-ONT-002).
- Clearance ladder: `technician` < `operator` < `supervisor` < `engineer` < `manager`; zone `clearance` gates visibility; pruning happens server-side (FR-GOV-001, AC-14).
- Autonomy levels in order: `read` < `draft` < `notify` < `propose` < `act`. Effective level = min(agent setting, action ceiling). Human-only actions are never callable by agents (BR-05, AC-10).
- No action writes to plant control; `request_setpoint_change` records a request only (BR-06).
- Intrusive procedure steps require an open permit and a recorded isolation on the asset (BR-09).
- People appear as counts by zone unless muster mode is on (BR-07, FR-GEO-005).
- Plant clock is simulated; telemetry replays from 2026-10-01T00:00Z at 1-minute steps.

## Review Focus

1. Unknown object id passed to any API or tool → `404`/`null`, never a crash. (Task 2, Task 8)
2. Viewer below a zone's clearance asks for an object in that zone by id → treated as absent. (Task 2, Task 8)
3. Agent attempts a human-only action, or an action above its dial → refused with a logged refusal, run still completes. (Task 5, Task 6)
4. Proposal resolved twice, or reversed twice → second call refused. (Task 5)
5. Copilot asked for intrusive steps with no permit → steps withheld with a reason. (Task 7)

## File Structure

| File | Responsibility |
|---|---|
| `src/generate.mjs` | Seeded synthetic works: places, assets, parts with geometry hints, sensors, people, competencies, shifts, WOs, permits, documents, procedure steps, presence, requirements |
| `src/ontology.mjs` | Store: get/list/search/links/neighbors/upsert/link, events, `view(viewer)` pruning |
| `src/telemetry.mjs` | Seeded series per sensor, fault scenarios, replay clock, latest/history |
| `src/functions.mjs` | Function tools: `failureRisk`, `anomaly`, `breakthroughRisk`, `consequence`, `storageHours`, `competenceCheck` |
| `src/audit.mjs` | Hash-chained append-only audit log |
| `src/actions.mjs` | Action registry and service: invoke, propose, resolve, reverse |
| `src/agents.mjs` | Agent specs, runtime, tool wrapper with run log, chaining |
| `src/evals.mjs` | Eval suites and graders |
| `src/copilot.mjs` | Technician Copilot sessions and answers |
| `src/llm.mjs` | Optional Claude call |
| `src/system.mjs` | Wires everything into one `createSystem({seed})` |
| `src/server.mjs` | HTTP API + SSE + static web |
| `web/*` | Console, map, twin, asset workbench, agent hub, proposals, knowledge, compliance |
| `test/*.test.mjs` | One test file per src module |

---

### Task 1: Synthetic works generator

**Files:** Create `src/generate.mjs`, `test/generate.test.mjs`, `package.json` (`"type":"module"`, scripts `test`, `start`).

**Interfaces — Produces:** `generateWorks(seed = 7) -> { objects: Obj[], links: Link[], clock: string }` where `Obj = {id, type, ...props, prov}` and `Link = {from, rel, to, props?, prov}`. Ids: `SITE-RB`, `Z01`..`Z12`, `PU-<stage>`, `POS-<tag>`, `AST-<unit>`, `ASM-…`, `PRT-<asset>-<nn>`, `SEN-…`, `P-001`.., `CMP-…`, `WO-…`, `PTW-…`, `DOC-…`, `PS-…`, `SHF-…`, `REQ-…`.

- [ ] Step 1: tests — same seed → identical JSON; different seed → different people names; 12 zones; positions for HLP-A..D and RWP-A..C; `AST` for HLP-B has ≥ 12 parts each with `explode` and `geom`; every link endpoint exists; every object has `prov.source`; 42 people; each hero asset has ≥ 3 sensors; at least one intrusive `ProcedureStep` (`intrusive: true`).
- [ ] Step 2: run `node --test test/generate.test.mjs` → FAIL (module missing).
- [ ] Step 3: implement with a mulberry32 PRNG; part templates `centrifugal_pump`, `blower`, `dosing_pump`, `valve`, `clarifier_drive`.
- [ ] Step 4: run → PASS. Step 5: commit `feat: synthetic Riverbend works generator`.

### Task 2: Ontology store and pruning

**Files:** `src/ontology.mjs`, `test/ontology.test.mjs`.

**Interfaces — Produces:** `createOntology({objects, links}) -> Ont` with `get(id)`, `list(type, pred?)`, `search(q, limit=20)`, `links(id, {rel, dir})`, `neighbors(id, rel?)`, `upsert(obj)`, `link(from, rel, to, props, prov)`, `on(fn)` (events `{kind, id, at}`), `view(viewer) -> Ont` (read-only, pruned). `viewer = {id, role, clearance}`. `CLEARANCES` array exported. `zoneOf(id)` resolves an object's zone through `zone`/`zoneId`/position/asset links.

- [ ] Tests: get unknown → null; search "HLP-B" finds position and asset; technician view cannot `get` an object in a `supervisor` zone (Z06 chlorine) and `list('Asset')` excludes it; manager sees all; `upsert` emits an event; links are pruned if either end is withheld.
- [ ] Fail → implement → pass → commit `feat: ontology store with server-side pruning`.

### Task 3: Telemetry replay

**Files:** `src/telemetry.mjs`, `test/telemetry.test.mjs`.

**Interfaces — Produces:** `createTelemetry({ont, seed, start, minutes = 14*24*60})` → `{now(), tick(n=1), latest(sensorId) -> {value, at, quality}|null, history(sensorId, n) -> number[], sensorsFor(objId)}`. Fault scenarios: `HLP-B` DE vibration and bearing temperature ramp over the final 5 days; `F07` turbidity and head loss rising after day 12; Cl residual normal.

- [ ] Tests: deterministic by seed; `tick(60)` advances `now()` by 60 min; HLP-B vibration latest > HLP-A latest at end of replay; unknown sensor → null.
- [ ] Fail → implement → pass → commit.

### Task 4: Function tools

**Files:** `src/functions.mjs`, `test/functions.test.mjs`.

**Interfaces — Produces:** `failureRisk(series:{vib:number[], temp:number[]}) -> {score:0..1, horizonDays, drivers:string[]}`; `anomaly(values:number[]) -> {z, flagged}`; `breakthroughRisk({turbidity:number[], headloss:number[]}) -> {score, hoursToLimit}`; `storageHours({levelPct, capacityMl, demandMlPerH}) -> number`; `consequence({redundancy, storageHours, compliance}) -> {score, supply, label}`; `competenceCheck(person, competencies, required:{type, level, regClass?}, onDate) -> {ok, reasons[]}`.

- [ ] Tests: rising vibration scores higher than flat; flat series not flagged; storageHours(50%, 40 ML, 5 ML/h) = 4; competence lapsed → `ok:false` with reason "lapsed"; level too low → reason "level".
- [ ] Fail → implement → pass → commit.

### Task 5: Audit and action service

**Files:** `src/audit.mjs`, `src/actions.mjs`, `test/actions.test.mjs`.

**Interfaces — Produces:** `createAudit() -> {append(entry) -> rec, all(), verify() -> boolean}`. `ACTIONS` registry: name → `{ceiling: level | 'human', required: string[], apply(ont, p, ctx) -> {objects, revert?}}` for every action in PRD §6.3. `createActionService({ont, audit}) -> {invoke({action, params, actor:{kind:'person'|'agent', id, role}, autonomy}) -> {status:'done', decision}|{status:'proposed', proposal}|{status:'refused', reason}, resolve(proposalId, {verdict:'approve'|'reject'|'edit', params?, reason, by}), reverse(decisionId, by), proposals(state?), decisions()}`. Decisions and proposals are ontology objects (`Decision`, `Proposal`, `Feedback`).

- [ ] Tests: missing required param → refused; agent invoking `open_permit` → refused "human-only"; agent with autonomy `propose` on `reserve_parts` → proposed; with `act` → done and a `Decision` exists; `resolve` approve executes and links `RESOLVED_BY`; resolving again → refused; reject with reason stores `Feedback`; `reverse` restores prior state, second reverse refused; `audit.verify()` true, and false after tampering.
- [ ] Fail → implement → pass → commit.

### Task 6: Agent runtime, catalogue and evals

**Files:** `src/agents.mjs`, `src/evals.mjs`, `test/agents.test.mjs`.

**Interfaces — Consumes:** Tasks 2–5. **Produces:** `AGENT_SPECS` (14 agents from PRD §7.7 with `{name, purpose, trigger, tools, autonomy:{[action]:level}, version}`); `createRuntime({ont, tel, actions, audit, fns}) -> {specs(), setAutonomy(name, action, level), run(name, {actingUser, mission?, scope?, trigger?}) -> Run, runs(), onEvent chain}`. `Run = {id, agent, version, trigger, startedAt, read:[ids], calls:[{tool, args, result}], reasoning:string[], outputs:[...], refusals:[...], status}` stored as `AgentRun`. Chain: `Asset Watch` alert → `Maintenance Triage` → `Work Pack` → `Parts Readiness` → `Scheduler`. `runEvals(runtimeFactory, name) -> {passed, total, cases}` with graders `exact`, `rule`.

- [ ] Tests: Asset Watch raises an alert on HLP-B and not HLP-A; full chain yields a Scheduler proposal naming a millwright with valid competence; every run has ≥ 1 read and ≥ 1 call; setting Parts Readiness `reserve_parts` to `propose` turns its Decision into a Proposal (AC-09); an agent spec listing `open_permit` is refused at run time (AC-10); Shift Handover draft mentions F07; evals for every agent run and report totals ≥ 3.
- [ ] Fail → implement → pass → commit.

### Task 7: Technician Copilot

**Files:** `src/copilot.mjs`, `src/llm.mjs`, `test/copilot.test.mjs`.

**Interfaces — Produces:** `createCopilot({ont, tel, actions, audit, llm?}) -> {open({assetId, partId?, workOrderId?, user}) -> Session, ask(sessionId, question) -> Promise<{answer, citations:[{id,label}], lookHere:[partIds], checks?:[...], withheld?:string}>, tag({sessionId, partId, note, reading?, photo?}) -> Finding}`. `Session.insight = {asset, part, alerts, trends, history, deviations, permit, isolation, hazards, procedure}`. Intents (deterministic mode): next checks, reuse/limit question, history, parts/stock, safety. `llm.mjs`: `askClaude({system, context, question}) -> Promise<string|null>` returns null without key.

- [ ] Tests: open on HLP-B part returns insight with alerts and history; "what should I check next" returns ordered checks with citations; with no permit, intrusive checks withheld with reason; after opening a permit and recording isolation, intrusive checks appear; reading over band answered "over the limit" and a deviation is proposed; `tag` creates a Finding linked to part and WO and emits `tagged`.
- [ ] Fail → implement → pass → commit.

### Task 8: System wiring and HTTP API

**Files:** `src/system.mjs`, `src/server.mjs`, `test/server.test.mjs`.

**Interfaces — Produces:** `createSystem({seed}) -> {ont, tel, actions, audit, runtime, copilot, tick(n)}`; server `createServer(system) -> http.Server`. Routes (all honour `x-acting-user` → person → viewer): `GET /api/me`, `/api/people?role`, `/api/console`, `/api/objects?type&q`, `/api/objects/:id`, `/api/map`, `/api/assets/:id/model`, `/api/telemetry/:sensorId?n`, `/api/agents`, `POST /api/agents/:name/run`, `PUT /api/agents/:name/autonomy`, `GET /api/runs`, `/api/runs/:id`, `/api/proposals`, `POST /api/proposals/:id/resolve`, `POST /api/actions/:name`, `POST /api/copilot/open`, `POST /api/copilot/:id/ask`, `POST /api/copilot/:id/tag`, `GET /api/evals/:name`, `/api/knowledge`, `/api/compliance`, `POST /api/muster`, `POST /api/clock/tick`, `GET /api/events` (SSE). Static files from `web/`.

- [ ] Tests (server on port 0): `/api/objects/NOPE` → 404; technician GET a Z06 object → 404, manager → 200; console payload has `train`, `alarms`, `proposals`, `people`; run Asset Watch via POST → 200 with run id; proposal resolve twice → second 409.
- [ ] Fail → implement → pass → commit.

### Task 9: Web console

**Files:** `web/index.html`, `web/app.js`, `web/map.js`, `web/twin.js`, `web/styles.css`, `test/web.test.mjs`.

Views: Console (process train, map, alarms, agent feed, proposals, people by zone), Map (layers, muster), Asset Workbench (three.js model, component tree, explode slider, isolate, locate, part panel, tag form, Copilot chat), Agent Hub (catalogue, launch, autonomy dial per action, run log, evals), Proposals (approve/edit/reject with reason, equal-weight buttons), Knowledge Hub, Compliance, Ontology Explorer. Role switcher in top bar sets `x-acting-user`. Theme tokens on `:root` with dark default.

- [ ] Test: static smoke — server serves `/`, `/app.js`, `/twin.js` with 200 and `index.html` references each view id.
- [ ] Browser verification: load in Playwright, switch to artisan, open HLP-B, explode, tag a part, ask copilot; no console errors.
- [ ] Commit.

### Task 10: README and run

**Files:** `README.md`. How to run, what is real vs synthetic, the PRD requirement coverage table, Claude mode.

- [ ] `npm test` all green; `npm start` serves; commit.
