# Agent Harness and Root-Cause Agent Implementation Plan (3a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Govern every agent through a decision statement, with shadow, assisted and bounded modes, evidence freshness, hard constraints, real approvers, off switches and relative revert. Add agent 20, the root-cause agent.

**Architecture:**
- **`src/harness.mjs`** (new) owns:
  - the decision statement: building it from a manifest, its sentences, and the hard constraints;
  - the constraint and freshness checks;
  - shadow matching;
  - promotion and demotion rules.
- **The runtime** (`src/agents.mjs`) reads each agent's `AgentSpec` to choose a mode before it calls `actions.invoke`.
- **The action service** (`src/actions.mjs`) enforces constraints, freshness and approvers, and reverts relatively.
- **`src/rca.mjs`** (new) is the deterministic root-cause analysis. It sits on project 1's process graph and project 2's region read models.

**Tech Stack:** Node 22, zero runtime dependencies, `node:test`, vanilla ES modules.

**Spec:** `docs/superpowers/specs/2026-10-24-agent-harness-studio-design.md` (§4, §5, §11 J23–J24, §12 3a, §14a)

## Global Constraints

- Zero runtime dependencies. Every flow works without `ANTHROPIC_API_KEY`; Claude, through `src/llm.mjs`, only words summaries.
- The 19 existing agents keep their behaviour:
  - they run as `SYSTEM_USER` (manager) as today;
  - they start in `bounded` mode at their current levels;
  - their approver is "any person with the action's clearance", which is today's `resolve` rule.
- `onTimeout` is `hold` or `drop`, **never** `apply`.
- Hard constraints are inherited and cannot be removed. Money is `propose` at most. Control-system writes are never allowed.
- An agent action on an asset under an open permit is allowed only when the person behind it (the actor, or `onBehalfOf`) is the permit holder or holds supervisor clearance or above. Otherwise it is capped at `propose`.
- Nothing persists to disk; state is in memory, as everywhere else in the repo.
- The server stays on localhost. Python patch scripts write with `newline=''`. Commits end with the two attribution lines.

## Review Focus

1. **Pausing an agent with open proposals.**
   - Expected: its open proposals are withdrawn, its queued shadow actions are dropped, and a later run does nothing.
   - Owner: Task 3.
2. **An escalated proposal nobody answers.**
   - Expected: after `escalateAfterMin` the backup may answer. On timeout it is held or dropped, and never applied.
   - Owner: Task 5.
3. **Reversing an agent decision after a person edited the same object.**
   - Expected: the person's later field stays. Only the fields still holding what the agent wrote revert.
   - Owner: Task 6.
4. **Telemetry evidence older than its freshness limit, or a cited object missing.**
   - Expected: the write is refused with "evidence stale" or "evidence missing", and the refusal is audited.
   - Owner: Task 4.
5. **Root cause on an object with no onset, or with no released plant model.**
   - Expected: the verdict is "Insufficient evidence", never a guess.
   - Owner: Task 7.

---

### Task 1: The decision statement

**Files:**
- Create: `src/harness.mjs`
- Modify: `src/generate.mjs` (seed an `AgentSpec` per agent), `src/agents.mjs` (`v()` owner becomes `"P-002"`)
- Test: `test/harness.test.mjs` (new)

**Interfaces:**
- Produces, from `src/harness.mjs`:
  - `HARD_CONSTRAINTS`: `[{ id, text }]` for `no-control-write`, `chlorine-propose`, `permit-holder`, `reg3630-cover`, `money-propose`, `human-only-releases`.
  - `specFromManifest(m) -> AgentSpec`, with fields:
    - `{ id: "AGS-<slug>", type: "AgentSpec", name, version, owner, purpose, trigger };`
    - `reads: [{ source, freshnessMin }]`, where telemetry is 30 min and objects are null (no limit);
    - `tools: [{ action, level, enabled: true }]`;
    - `constraints: HARD_CONSTRAINTS ids`;
    - `approver: { clearanceOf: "action" }`, `backup: null`, `escalateAfterMin: null`, `onTimeout: "hold"`;
    - `exclusions: []`, `mode: "bounded"`;
    - `promotion: { minCases: 20, minAgreePct: 90, maxBreaches: 0, maxStalePct: 5 }`;
    - `state: "live"`, `killedAt: null`, `killedBy: null`.
  - `statementSentences(spec, ont) -> string[]`: plain sentences, for example "It runs every 5 min.", "It may raise alerts without asking.", "It asks before proposing a setpoint change; any supervisor or above may answer.", "If nobody answers, nothing happens.", "It never writes to the control system."
  - `specFor(ont, agentName) -> AgentSpec`.

- [ ] **Step 1: Write the failing tests** (`test/harness.test.mjs`):
  - Every name in `AGENT_SPECS` has an `AgentSpec`, with `mode` `"bounded"`, `state` `"live"` and owner `"P-002"` (a Person).
  - Each spec's tool levels equal the manifest's autonomy.
  - `statementSentences` for Process Watch includes `/every 5 min/`, `/without asking/` and `/never writes to the control system/`, and never contains `undefined`.
  - Removing a hard constraint id from a spec (via `ont.upsert`) and reading it back through `specFor` still lists all `HARD_CONSTRAINTS`: they are merged in on read.
- [ ] **Step 2:** Run `node --test test/harness.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.**
  - Seed with `specFromManifest` for every `AGENT_SPECS` entry inside `generateWorks`. Import `AGENT_SPECS` lazily, or move it to a data module if the import is circular; record the choice.
  - `specFor` merges `HARD_CONSTRAINTS` into `constraints` on every read.
- [ ] **Step 4:** Run `npm test`. Expected: all pass. Update any count of object types a test asserts.
- [ ] **Step 5:** Commit: `feat(harness): decision statements for every agent`.

### Task 2: Modes and shadow actions

**Files:**
- Modify: `src/agents.mjs` (`makeCtx().act`), `src/harness.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Consumes: `specFor` (Task 1).
- Produces:
  - **Shadow mode:** `ctx.act` records `ShadowAction { id: "SHA-…", agent, specVersion, runId, action, params, at, status: "pending" }` and returns `{ status: "shadowed" }`. It **never** calls `actions.invoke`.
  - **Assisted mode:** the level passed to `invoke` is `min(tool level, "propose")`.
  - **Bounded mode:** unchanged.
  - **Disabled tool:** `{ status: "refused", reason: "tool turned off" }`.
  - `matchShadow(ont, nowIso)`, which updates pending shadow actions. The matching rule, deterministic and documented in code:
    - **agreed:** a Decision by a person has the same `action` and the same key target param (the first of `assetId`, `targetId`, `workOrderId` or `alertId` that is present) within 24 h after;
    - **differed:** the same target with a different action, within 24 h;
    - **missed:** none within 24 h, once 24 h have passed.
  - `shadowRecord(ont, agent) -> { cases, agreed, differed, missed, agreePct }`.

- [ ] **Step 1: Write the failing tests:**
  - With Process Watch's spec set to `shadow`, a run creates no Alert and no Proposal, and creates ShadowActions whose `action` set includes `raise_alert`.
  - A person then raises an alert on the same F07 target. `matchShadow` marks that shadow action `agreed`, and `shadowRecord` gives `agreePct` 100 for that case.
  - Ticking the clock past 24 h with no human decision marks the other shadow actions `missed`.
  - With the spec set to `assisted`, Maintenance Triage's `rank_alert` (level `act`) becomes a Proposal.
  - With the spec set to `assisted`, `notify` still applies (below `propose`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement in `makeCtx().act`, reading `specFor(ont, spec.name)` on each call.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(harness): shadow, assisted and bounded modes`.

### Task 3: Promotion, demotion and off switches

**Files:**
- Modify: `src/actions.mjs` (three actions), `src/agents.mjs` (demotion after a run), `src/harness.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Produces these actions:
  - **`promote_agent`** `{ agent, to: "assisted" | "bounded" }`. Ceiling `human`, minimum clearance `engineer`.
    - Refused when the actor is the spec's owner ("the builder cannot promote their own agent").
    - Refused when `to` is not exactly one step up.
    - Refused when `shadowRecord` misses the promotion criteria; the reason names the unmet criterion.
  - **`set_agent_state`** `{ agent, state: "live" | "paused" | "retired" }`. Ceiling `human`, minimum clearance `engineer`.
    - Pausing withdraws the agent's open proposals (state `withdrawn`) and drops its pending ShadowActions (status `dropped`).
    - Runs of a paused or retired agent complete with `status: "skipped"`.
  - **`set_tool_enabled`** `{ agent, action, enabled }`. Ceiling `human`, minimum clearance `engineer`. Turning a tool off withdraws that agent's open proposals for that action.
- Produces: `demoteIfNeeded(ont, spec, run) -> null | reason`, applied after each run. A `bounded` spec drops to `assisted` when any of these is true:
  - the run hit a hard constraint;
  - the stale-evidence refusals over its last 20 runs exceed `maxStalePct`;
  - overrides (reject or edit feedback) over its last 20 proposals exceed 20%.

  Each demotion appends an audit entry `{ action: "demote_agent", reason }`.

- [ ] **Step 1: Write the failing tests:**
  - P-002 (the owner) `promote_agent` → refused, matching `/own agent/`. P-003 promoting a shadow agent with 0 cases → refused, matching `/minCases/`.
  - After 20 agreed seeded shadow cases, P-003 promotes shadow → assisted: `done`. Promoting assisted → live is not a mode → refused.
  - Review Focus 1: pausing Geo Watch withdraws its two open proposals, and a following run returns `status: "skipped"`.
  - `set_tool_enabled(Process Watch, request_setpoint_change, false)` withdraws the open setpoint proposal (J23), and a run raises no new one.
  - A run that hits the permit constraint (Task 4) demotes a bounded agent to assisted, with an audit entry.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The Task 4 dependency in the last test is satisfied by ordering: write that test here and leave it as `todo` until Task 4 lands, then enable it there.
- [ ] **Step 4:** Run `npm test`. Expected: PASS, with the one `todo`.
- [ ] **Step 5:** Commit: `feat(harness): four-eyes promotion, automatic demotion, off switches`.

### Task 4: Evidence freshness and hard constraints

**Files:**
- Modify: `src/agents.mjs` (reads record their source time), `src/actions.mjs` (`invoke` checks for agent actors), `src/harness.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Produces: `ctx.read` records `{ id, sourceAt }`. `sourceAt` is `tel.latest(id).at` for a Sensor, and the object's own `at` / `updatedAt` / `prov.extracted_at` otherwise.
- Produces: `checkWrite({ ont, tel, actor, action, params, evidence, spec, now }) -> { level: cap | null, refuse: reason | null, checked: [constraint ids] }`.
  - **Freshness:** cited evidence (`meta.evidence` sensor ids) older than the spec's `freshnessMin` → refuse with `"evidence stale: <id> <age> min"`. A cited object that is missing → refuse with `"evidence missing: <id>"`.
  - **`permit-holder`:** the asset under an open Permit, and the person behind the action is neither the holder nor supervisor or above → cap at `propose`.
  - **`chlorine-propose`:** `request_setpoint_change` or `propose_dose_change` on CHEM-CL2 or Z06 dosing → cap at `propose`.
  - **`money-propose`:** any action tagged `money: true` in `ACTIONS` → cap at `propose`. None exist yet; the tag is added for 3b.
  - **`no-control-write`:** any action tagged `control: true` → refuse.
- `invoke` applies `checkWrite` for agent actors before choosing the effective level. The proposal or decision stores `constraintsChecked` and `evidenceAges`.

- [ ] **Step 1: Write the failing tests:**
  - Review Focus 4: an agent invokes `raise_alert` citing `SEN-F07-turb` after the telemetry cursor has been frozen 45 min behind `now`. Simulate this with a spec freshness of 30 and a stubbed `tel.latest` `at`. Expected: refused with `/evidence stale: SEN-F07-turb/`, with an audit entry carrying `outcome: "refused"`.
  - Citing `SEN-NOPE` is refused with `/evidence missing/`.
  - Technician Copilot acting for P-030 (not the holder) runs `record_reading` on HLP-B with permit PTW-0412 open for P-028 → `proposed`. The same call acting for P-028 → `done`.
  - Removing `permit-holder` from a spec has no effect (Task 1 merge).
  - The Task 3 demotion `todo` is enabled and passes.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. The existing channel test for P-028's permitted job still passes.
- [ ] **Step 5:** Commit: `feat(harness): evidence freshness and inherited hard constraints`.

### Task 5: Approvers, escalation, timeouts and approval cards

**Files:**
- Modify: `src/actions.mjs` (`invoke` stamps a proposal, `resolve` checks the approver), `src/server.mjs` (tick applies timeouts), `src/harness.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Produces: a Proposal created by an agent carries:
  - `approver` (a person id, or `{ clearanceOf: "action" }`);
  - `backup`, `escalateAt` (ISO or null), `onTimeout`;
  - `card: { evidence: [{ id, ageMin }], constraintsChecked, expectedEffect, alternatives }`.

  `expectedEffect` is a one-line text from the action (a map in `harness.mjs`). `alternatives` holds what the agent passed in `meta.alternatives`, or `[]`.
- Produces: `resolve` refusals:
  - a named approver is set and `by` is neither the approver nor (after `escalateAt`) the backup → `"waiting for <approver>"`;
  - a reject or edit with no reason (already enforced).
- Produces: `applyTimeouts(ont, nowIso)`, called on each server tick:
  - proposals past `escalateAt + escalateAfterMin` with `onTimeout: "drop"` become `withdrawn` with reason `"timed out"`;
  - `hold` proposals stay open and get `timedOut: true`;
  - **never applied.**
- Produces: a reject or edit Feedback with a reason adds `{ agent, case: { action, params }, expect: "not " + action, reason }` to `LearnedEval` objects, which `runEvals` reports as `learned: n`.

- [ ] **Step 1: Write the failing tests** (Review Focus 2):
  - A spec with approver P-004, backup P-001 and escalate after 60 min makes a proposal.
  - P-001 resolving before 60 min → refused with `/waiting for P-004/`. After `tel.tick(61)`, P-001 → `done`.
  - With `onTimeout: "drop"` and nobody answering after twice the window, `applyTimeouts` → state `withdrawn` and no Decision. With `"hold"` → still open, `timedOut: true`.
  - A default agent (approver `{ clearanceOf }`) is resolved by any supervisor as today.
  - A Process Watch proposal's `card` has the evidence with `ageMin`, `constraintsChecked` including `permit-holder`, and a non-empty `expectedEffect`.
  - Rejecting with the reason "artisan on leave" adds one `LearnedEval`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(harness): named approvers, escalation, timeouts that never apply, approval cards`.

### Task 6: Relative revert everywhere

**Files:**
- Modify: `src/actions.mjs` (`setProps`; `close_permit` and `record_isolation`)
- Test: `test/harness.test.mjs`

**Interfaces:**
- Produces: `setProps(ont, id, patch)` returns a revert that restores **only** the fields still equal to what the patch wrote. If a later edit changed a field, that field is kept, and the revert reports `{ kept: [field] }` in the audit.
- Produces: `close_permit` and `record_isolation` store a real revert function, instead of calling `setProps` at apply time as today. That bug made them irreversible.

- [ ] **Step 1: Write the failing tests:**
  - Review Focus 3: an agent `update_work_order` sets `priority` to P1; a person then sets `planned` and `priority` to P2. Reversing the agent decision leaves `priority` at P2 and `planned` unchanged, and the audit notes `kept: ["priority"]`.
  - `close_permit` followed by reverse → permit `open` again.
  - `record_isolation` followed by reverse → the isolation is gone.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. Every existing reverse test still passes.
- [ ] **Step 5:** Commit: `fix(actions): relative revert for every action; permit close and isolation are reversible`.

### Task 7: The root-cause agent (agent 20)

**Files:**
- Create: `src/rca.mjs`
- Modify: `src/agents.mjs` (spec and behaviour, `v({ name: "Root Cause", trigger: { kind: "event", on: "Alert ranked high" }, tools: ["draft_document"], autonomy: { draft_document: "act" } })`), `src/evals.mjs`, `test/agents.test.mjs` (19 → 20)
- Test: `test/rca.test.mjs` (new)

**Interfaces:**
- Consumes: `graphFrom`, `upstreamOf`, `processPaths`, `travelWindow` and `onsetMinute` from `src/functions.mjs`; `currentPlantModel` from `src/plant.mjs`; GeoDetections and Scenes.
- Produces: `rootCause(ctx, { targetId, at? }) -> RcaReport`:
  - `{ symptom: { id, sensorId, onsetAt }, causes: [{ id, label, kind: "local" | "contributing", weight, evidence: [{ id, ageMin, note }], showMe }], rejected: [{ id, label, reason }], verdict: "explained" | "Insufficient evidence", window: { onsetH, meanH, tailH } }`.
  - **Method**, in this order:
    1. **Symptom onset:** a filter uses its head-loss series with `period: 1800`; any other sensor uses its own period, or none.
    2. **Upstream candidates:** `upstreamOf` from the symptom, plus the intake's region inputs: `SEN-RAW-turb`, and plume GeoDetections whose AOI drains to the intake.
    3. **Timing:** a candidate's onset must fall inside `[symptom − tailH, symptom − onsetH]`; otherwise it is rejected as "too late" or "too early", with the minutes shown.
    4. **Breadth:** fewer than 2 siblings with an onset → a local cause on the symptom object.
    5. **Weights:** local 1.0; contributing 0.7 if the detection is confirmed, 0.5 if suggested.
  - `showMe` links are `#/region/focus=detection:<id>`, `#/plant/<id>` or `#/object/<sensor>`.
- Produces: the Root Cause agent drafts a Draft of `kind: "rca"`, with `data: RcaReport`, for the alert in `scope.alertId`.
- Produces: `outcomeOf(ctx, { reportId, actionAt, windowH = 24 }) -> "Effective" | "Partially effective" | "Ineffective" | "Insufficient evidence"`. It compares the symptom sensor over the window with its pre-onset baseline: back within the tolerance is Effective, halfway is Partially effective, unchanged is Ineffective, and no data is Insufficient evidence.

- [ ] **Step 1: Write the failing tests** (`test/rca.test.mjs`, F07 at the clock after Process Watch has run):
  - `causes[0]` is the F07 structure, kind `local`.
  - A `contributing` cause cites the plume GeoDetection, with `weight` 0.5 while suggested and 0.7 once confirmed (confirm through the J18 path).
  - `rejected` includes DP-2 with `/too late/` and its minutes.
  - The raw-water onset is between 100 and 300 minutes before F07's (about 2.2 h).
  - Review Focus 5: `rootCause` on HLP-B's alert gives a `local` HLP-B cause and no contributing cause. `rootCause` with a target that has no onset (RES-CWR1), or with no released plant model, gives `verdict: "Insufficient evidence"` and empty `causes`.
  - `outcomeOf` with a synthetic recovery → `"Effective"`; with no data after the action → `"Insufficient evidence"`.
  - `AGENT_SPECS.length` is 20, and the Root Cause evals pass: F07 explained, DP-2 rejected, insufficient evidence for RES-CWR1.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Claude is used only to word `summary` when an API key is set; the default is a template.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(rca): root-cause agent over the process graph, region and history`.

### Task 8: Routes and screens (J23, J24)

**Files:**
- Modify: `src/server.mjs`, `web/app.js` (`views.agents` cards; `views.rca`; "Find root cause" buttons on the alert object view, the Region detection panel and the Plant selection side panel), `web/styles.css`, `web/index.html` (none, if `#/rca/<id>` routes inside `#view`)
- Test: `test/server.test.mjs`, `test/web.test.mjs`

**Interfaces:**
- Produces these routes:
  - `GET /api/agents/:name/spec` → `{ spec, sentences, shadow: shadowRecord, promotion }`;
  - `POST /api/actions/promote_agent|set_agent_state|set_tool_enabled`, through the existing action route;
  - `POST /api/rca` `{ targetId }` → runs Root Cause for the viewer and returns the Draft;
  - `GET /api/rca/:draftId`.

  All responses are pruned through the viewer's view.
- Produces the Agents view cards:
  - sentences;
  - a mode badge;
  - the shadow record against the criteria;
  - the approver;
  - one switch per tool and one per agent, shown to engineers and above;
  - Promote and Demote, refused with the server's reason.

- [ ] **Step 1: Write the failing tests:**
  - Server: a technician gets 403 on `set_agent_state` (minimum clearance engineer). `/api/agents/Process%20Watch/spec` returns `sentences.length >= 4`. `/api/rca` with the F07 alert returns a Draft whose `data.causes[0].kind` is `"local"`.
  - Web: `app.js` includes `async rca(`, `Find root cause`, `data-tool-toggle`, `data-agent-state` and `Promote`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(harness): agent cards with statements, modes and off switches; root-cause report`.

### Task 9: Docs and browser journeys

**Files:**
- Modify: `README.md` (rows, J23–J24, test count), `../README.md` (link to this plan)
- Test: a browser check, then `npm test`

- [ ] **Step 1:** Update the docs in the existing style.
- [ ] **Step 2:** Run `npm start` and walk the journeys:
  - **J23 (P-002):**
    1. Process Watch's statement reads back.
    2. Turn `request_setpoint_change` off; its proposal is withdrawn.
    3. Turn it back on.
    4. P-002's own Promote is refused.
  - **J24 (P-001):** the F07 alert → Find root cause → F07 local, the plume contributing, DP-2 rejected as too late. "Show me" on the plume opens the Region on it.

  Expected: as stated; take a screenshot of each.
- [ ] **Step 3:** Run `npm test`. Expected: all pass; report the count.
- [ ] **Step 4:** Commit: `docs: agent harness and root-cause agent (Phase 3 project 3a)`. Then run the final whole-branch review.
