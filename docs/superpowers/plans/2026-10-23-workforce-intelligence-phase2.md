# Workforce Intelligence (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add digitised work instructions, a chat front door (stub WhatsApp), troubleshooting in the flow of a job, issues, knowledge notes, project progress from group chats, agent-written paperwork and per-task performance to Water Works OS.

**Architecture:** Everything is new object types in the existing ontology, new typed actions in the existing `ACTIONS` table (so the autonomy dial, audit, Decisions, reversal and clearance pruning apply unchanged), four new agents in `AGENT_SPECS`, and one new service (`src/channels.mjs`) that turns inbound chat into agent runs. A rule parser stands in for Claude when no key is set.

**Tech Stack:** Node 22, zero dependencies, `node:test`, vanilla ES modules web UI, three.js 0.160.0 (unchanged).

**Spec:** `docs/superpowers/specs/2026-10-23-workforce-intelligence-design.md`

## Global Constraints

- No new dependencies. `@anthropic-ai/sdk` stays optional; every test runs without a key.
- Every write goes through `actions.invoke` (people and agents alike), except inbound Message ingestion by the channel stub, which is a connector write with `prov.source = "CHANNEL-STUB"`.
- Plant time (`tel.now()`) stamps every new object. Wall-clock stays only for audit entries and AgentRun start/end.
- Ids: `PRC-<TEMPLATE>-v<n>`, `EXE-nnnnn`, `ISS-nnnnn`, `KN-nnnnn`, `CHN-…`, `MSG-nnnnn`, `PAR-nnn`, `PRJ-CL3`, `PCL-nnnnn` (`nextId` in actions.mjs for runtime objects; fixed ids in the seed).
- Copy: the bot sends at most one reply per inbound message; it never sends to a group except Project Watch's weekly status and the listening notice.
- Performance is never ranked or sorted by person in any view or API.
- `npm test` stays green after every task; Phase 1's 95 tests may only change where a task below says so.

## Review Focus

1. A person sends "done" with no execution running → bot asks one question ("Which job? Reply *start* first."), writes nothing. Test in Task 7.
2. A Participant (contractor) message tries to complete a step or mention our asset state → never written as fact; becomes a ProgressClaim or nothing. Test in Task 7.
3. A technician fetches another person's one-to-one channel, messages, or performance → 404/403. Tests in Tasks 3 and 9.
4. "yes" arrives with nothing awaiting → treated as off-topic, dropped, no write. Test in Task 6.
5. Starting a job on a work order whose procedure was superseded mid-job → the running Execution keeps its pinned version; new starts get the new one. Test in Task 2.

---

### Task 1: Plant clock that runs past the telemetry window; actions stamped in plant time

**Files:**
- Modify: `src/telemetry.mjs` (tick, latest, history), `src/actions.mjs` (`createActionService` signature, `now`), `src/system.mjs`
- Test: `test/telemetry.test.mjs` (change test "replay starts part-way … ends at the full window"), `test/actions.test.mjs`

**Interfaces:**
- Produces: `tel.tick(n)` no longer caps; `tel.latest(id)` / `tel.history(id, n)` read at `Math.min(cursor, v.length - 1)`. `createActionService({ ont, audit, clock })` with `clock: () => string` (default wall-clock); `createSystem` passes `clock: tel.now`.

- [ ] **Step 1: Failing tests**
```js
test("clock runs past the window while readings hold the last sample", () => {
  const t = createTelemetry({ ont, seed: 7, start: "2026-10-01T00:00:00Z" });
  t.tick(1e6); const a = t.latest("SEN-HLP-B-vib_de"); t.tick(60);
  assert.ok(t.now() > "2026-10-15T00:00:00Z");
  assert.equal(t.latest("SEN-HLP-B-vib_de").value, a.value);
});
// actions.test.mjs
test("actions stamp objects with the system clock", () => {
  const sys = createSystem({ seed: 7 });
  const r = sys.actions.invoke({ action: "raise_alert", params: { targetId: "SEN-FW-turb", title: "t" }, actor: mgr });
  assert.equal(sys.ont.get(r.decision.objects[0]).at, sys.tel.now());
});
```
The old "ends at the full window" assertion becomes: after `tick(1e9)`, `latest()` equals the value at the last index.
- [ ] **Step 2:** `npm test` → the two new tests FAIL.
- [ ] **Step 3:** Implement. `now` inside actions.mjs becomes the injected clock (module-level `now()` calls move inside `createActionService`; `ACTIONS[...].apply` gets it via `ctx.now()`).
- [ ] **Step 4:** `npm test` → all pass.
- [ ] **Step 5:** Commit `feat: plant clock beyond the replay window; actions stamped in plant time`.

### Task 2: Procedures replace ProcedureStep; versioning; seed changes for people

**Files:**
- Modify: `src/generate.mjs`, `src/agents.mjs:48` (`assetInsight`), `src/server.mjs:132`, `src/actions.mjs`, `src/functions.mjs`
- Test: `test/generate.test.mjs:48`, new `test/procedures.test.mjs`

**Interfaces:**
- Produces: object `Procedure { id: "PRC-CENTRIFUGAL_PUMP-v3", type, template, documentId, title, version: 3, state: "released"|"draft"|"superseded", steps: Step[], releasedBy, releasedAt, reason }` where `Step = { id: "<procId>-S01", step, text, intrusive, partNames, hazard, documentId, requires: { permit: boolean, isolation: boolean, reading: { partName, measure, unit } | null }, expectedMinutes }`. (`step` keeps the Phase 1 field name instead of the spec's `n`, so Copilot code is unchanged.) SOP revision "C" → version 3.
- `requires.permit = requires.isolation = intrusive || /permit to work/i.test(text)`; `requires.reading` set when `text` contains "against the band" or "measure the OD" and a part of that name has a `band`. `expectedMinutes`: 10 non-intrusive, 25 intrusive, 45 when `hazard === "Heavy lift"`.
- Document SOPs gain `sourceRef: { system: "sharepoint", url: "https://riverbend.sharepoint.example/sops/<TPL>.pdf", revision: "C" }`, `sourceBehind: false`.
- `functions.mjs`: `stepLock(step, { permit, isolated }) -> { locked: boolean, reason: string|null }`; `currentProcedure(list, template) -> Procedure|null` (released one).
- Actions: `propose_procedure_version` (needs act, ceiling "human", minClearance engineer; required `procedureId, steps, reason`; actor must hold a valid `c-author` Competency, else throws "needs the c-author competence") creates `Procedure` version n+1 state "draft". `release_procedure` (ceiling "human", minClearance manager; required `procedureId`) sets the draft released, the previous released superseded, and the source Document `sourceBehind: true`.
- Seed: Competency `c-author` level 1 valid to 2028-12-31 for both reliability engineers; Person `supervisorId` (millwrights → second shift supervisor `P-009`; other trade artisans → `P-008`); Person `autoSubmit: false` for all, `true` for `P-030` (to demo consent); the open PM "HLP-B: 6-monthly vibration survey" gets `assigneeId` = first millwright (`P-028`).
- `assetInsight` reads `currentProcedure(...).steps` in place of `ProcedureStep`; server `/api/assets/:id/model` returns the same `procedure` array from it plus `procedureId`.

- [ ] **Step 1: Failing tests** (`test/procedures.test.mjs`)
```js
test("every SOP template has a released v3 procedure with locks and readings", () => {
  const p = sys.ont.get("PRC-CENTRIFUGAL_PUMP-v3");
  assert.equal(p.state, "released"); assert.equal(p.steps.length, 11);
  assert.equal(p.steps[0].requires.permit, true);          // "Confirm the permit to work…"
  assert.equal(p.steps[1].requires.permit, false);
  assert.deepEqual(p.steps[6].requires.reading.partName, "Bearing housing");
});
test("stepLock withholds a permit step until permit and isolation exist", () => {
  const s = sys.ont.get("PRC-CENTRIFUGAL_PUMP-v3").steps[2];
  assert.equal(stepLock(s, { permit: null, isolated: false }).locked, true);
  assert.equal(stepLock(s, { permit: { id: "x" }, isolated: true }).locked, false);
});
test("engineer with c-author proposes v4; manager releases; SOP flagged behind", () => { /* invoke both as persons P-002 then P-001; assert v3 superseded, v4 released, DOC-SOP-CENTRIFUGAL_PUMP.sourceBehind === true */ });
test("operator without c-author cannot propose a version", () => { /* refused, reason matches /clearance|c-author/ */ });
test("Copilot next checks read the released procedure", () => { /* copilot.open on HLP-B; ask "what next" → checks non-empty, withheld mentions permit */ });
```
Change `generate.test.mjs:48` to `ofType("Procedure").some((p) => p.steps.some((s) => s.intrusive))`.
- [ ] **Step 2:** `npm test` → new tests FAIL.
- [ ] **Step 3:** Implement as in Interfaces. Remove `ProcedureStep` generation and its `PART_OF` links; link `Procedure -PART_OF-> Document` instead.
- [ ] **Step 4:** `npm test` → all pass (Phase 1 copilot, agents and evals unchanged).
- [ ] **Step 5:** Commit `feat: versioned Procedures from SOPs replace ProcedureStep`.

### Task 3: Per-person audience in the ontology view

**Files:** Modify `src/ontology.mjs` (`view`). Test `test/ontology.test.mjs`.

**Interfaces:** Produces: an object with `audience: string[]` is visible only to viewers whose `id` is in it, or whose clearance is `manager`. `view(viewer)` now reads `viewer.id` as well as `viewer.clearance`.

- [ ] **Step 1: Failing test**
```js
test("audience limits an object to named viewers and the manager", () => {
  const o = createOntology({ objects: [{ id: "M1", type: "Message", audience: ["P-028"] }] });
  assert.ok(o.view({ id: "P-028", clearance: "technician" }).get("M1"));
  assert.equal(o.view({ id: "P-029", clearance: "engineer" }).get("M1"), null);
  assert.ok(o.view({ id: "P-001", clearance: "manager" }).get("M1"));
});
```
- [ ] **Step 2:** Run → FAIL. **Step 3:** One added line in `visible`. **Step 4:** `npm test` → pass. **Step 5:** Commit `feat: per-person audience in ontology views`.

### Task 4: Executions, issues and knowledge notes as actions; shared band check

**Files:** Modify `src/actions.mjs`, `src/functions.mjs`, `src/copilot.mjs`. Test new `test/execution.test.mjs`.

**Interfaces:**
- `functions.mjs`: `bandCheck(part, value) -> { inBand: boolean, side: "over"|"under"|null, by: number, finding: string }` (the arithmetic now inline in `copilot.ask`; copilot switches to it, behaviour unchanged).
- Actions (all `def(needs "act", ceiling "act", …, minClearance "technician")` unless stated); `TARGET_TYPES` gains `executionId: ["Execution"], procedureId: ["Procedure"], issueId: ["Issue"], noteId: ["KnowledgeNote"], projectId: ["Project"], channelId: ["Channel"], documentId: ["Draft"]`.
  - `start_execution {workOrderId, personId}` → `Execution { id, workOrderId, assetId, personId, procedureId, procedureVersion, startedAt, finishedAt: null, state: "running", steps: [{ step, state: "todo"|"done", at, minutes, value, readingId }] }`; procedure = released one for the asset's template; refuses if a running Execution exists for the WO; sets WO state "in_progress". Revert: Execution state "cancelled".
  - `complete_step {executionId, step, value?, note?}` → refuses when `stepLock` is locked (reason = lock reason) or the step is not the next "todo"; `minutes` = plant minutes since previous step (or start); when the step requires a reading and `value` is given, also writes a `Reading` (same shape as `record_reading`); last step done → Execution `state: "done", finishedAt`. Revert restores the previous steps array.
  - `raise_issue {title, assetId?, partId?, workOrderId?, projectId?, procedureId?, step?, evidence?, raisedBy}` → `Issue { state: "open", … }`.
  - `update_issue {issueId, patch}` with patchable `state, assigneeId, title`; minClearance technician, but apply throws "only the raiser or a supervisor" when `ctx.actor.clearance` < supervisor and `issue.raisedBy !== ctx.actor.id`.
  - `add_knowledge_note {text, authorId, partId?, assetId?, procedureId?, step?, executionId?, messageId?}` → `KnowledgeNote { verified: false }`.
  - `verify_knowledge_note {noteId}` ceiling "human", minClearance engineer → `verified: true, verifiedBy`, and creates a verified `Finding` from it (`promotedTo` on the note).
- `assetInsight` adds `notes` (KnowledgeNotes on the asset or its parts) so Copilot answers can cite them.

- [ ] **Step 1: Failing tests** — `test/execution.test.mjs`:
  - "start pins the released version and moves the WO to in_progress" (P-028 on the HLP-B PM; `procedureVersion === 3`).
  - "step 1 is locked without a permit; P-009 opens permit and isolation; step 1 completes" (refusal reason matches `/permit/`; then `open_permit` + `record_isolation` as P-009; complete_step done).
  - "out-of-order step is refused" (complete step 3 before 2 → refused).
  - "reading step writes a Reading and bandCheck flags 110.065 mm as 0.03 over" (step 7, `bandCheck(part, 110.065).by === 0.03`).
  - "superseded procedure mid-job keeps the pinned version" (release v4 after start; Execution still v3; a new start on another WO gets v4). *(Review Focus 5)*
  - "a technician cannot move someone else's issue; a supervisor can".
  - "engineer verifies a note and it becomes a Finding".
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm test` → all pass incl. Phase 1 copilot band tests. **Step 5:** Commit `feat: executions, issues and knowledge notes`.

### Task 5: Channels, participants, projects; claims, milestones, messages, submission; synthetic history

**Files:** Modify `src/generate.mjs`, `src/actions.mjs`. Test new `test/projects.test.mjs`, extend `test/generate.test.mjs`.

**Interfaces:**
- Seed objects:
  - `Channel` per Person: `CHN-<personId>`, `kind: "whatsapp"`, `address: "+27 60 000 0<nnn>"` (synthetic), `members: [personId]`, `audience: [personId]`.
  - Group `CHN-GRP-CL3`, `groupName: "CL-3 refurb"`, `projectId: "PRJ-CL3"`, members `PAR-001` (site agent), `PAR-002`, `PAR-003` (contractor fitters), `P-004`, `P-009`; `audience` = same; `noticePosted: true`.
  - `Participant PAR-001..003 { label, employer: "Synthetic Contractor (Pty) Ltd", numberHash }` (sha256 of the synthetic number; no number stored).
  - `Project PRJ-CL3 { title: "Clarifier 3 scraper drive refurbishment", kind: "contract", contractorEmployer, assetIds: [CL-3 asset], start: "2026-09-28", end: "2026-11-06", ownerId: "P-004", channelId: "CHN-GRP-CL3", autoSubmit: false, milestones: M1..M6 }` with M1 confirmed, M2 claimed not confirmed, M3–M6 open.
  - 5 days of `Message` history (2026-10-07…10-11) in the group (last contractor message 2026-10-11T16:40Z → quiet ≥3 days at the plant clock) and in `CHN-P-028`; `ProgressClaim`s for M1 and M2 referencing their messages.
  - 12 closed `Execution`s across 5 artisans on the four procedures (minutes deterministic from the seeded PRNG, one artisan consistently ≥1.5× on step 6 of the pump SOP so Procedure Steward has something to flag), 6 `Issue`s (states spread across open/triaged/in_work/done), 9 `KnowledgeNote`s (3 on pump step 8 "shaft sleeve").
- Actions:
  - `record_progress_claim {projectId, milestoneId?, messageId, by, text, evidence?}` ceiling act → `ProgressClaim { confirmed: false }`; sets milestone `claimedAt` if given.
  - `confirm_milestone {projectId, milestoneId}` ceiling "human", minClearance supervisor → milestone `confirmedAt, confirmedBy`, linked claims `confirmed: true`.
  - `send_message {channelId, text, awaiting?}` needs "notify", ceiling act → outbound `Message { from: "WORKS", direction: "out", at, text, awaiting, audience: channel.audience }`; apply refuses a second outbound to the same channel with the same `inReplyTo` (one reply per inbound).
  - `submit_document {documentId, onBehalfOf}` ceiling act → Draft `state: "submitted", submittedBy, submittedFor`; when `ctx.actor.kind === "agent"` and the `onBehalfOf` Person/Project lacks `autoSubmit`, throws "no consent to submit on their behalf".

- [ ] **Step 1: Failing tests** (`test/projects.test.mjs`): seed shape (counts above, PRJ-CL3 milestones 1 confirmed / 2 claimed); a Person never sees `CHN-P-028` unless it is theirs (technician P-029 → `null`); `confirm_milestone` as P-009 confirms M2 and its claim; as agent → refused human-only; `submit_document` as agent for P-028 → refused "no consent", for P-030 → done; second `send_message` with the same `inReplyTo` → refused.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm test` → all pass. **Step 5:** Commit `feat: channels, projects, claims and consent-gated submission`.

### Task 6: Message parser

**Files:** Create `src/parse.mjs`. Test new `test/parse.test.mjs`.

**Interfaces:** `parseMessage({ text, media = [] }, { group: boolean, awaiting: object|null, execution: Execution|null }) -> { kind, confidence: number, fields }`. Kinds and rules, checked in this order:
1. `awaiting` set: "yes|y|ok|submit" → `yes`; "no|n" → `no`; any other text when `awaiting.kind === "note"` → `note {text}`.
2. `^start\b` → `start {workOrderId?}` (WO id pattern `WO-[\w-]+`).
3. `^(step\s*(\d+)\s*)?done\b` with optional number+unit → `done {step?, value?, unit?}`. A number with no unit when the step needs a reading is accepted (the step defines the unit).
4. A bare number `^\d+(\.\d+)?\s*(mm|mm\/s|°C|bar|A)?$` with an execution → `done {value, unit}`; with no execution → `ask {question: "Which job is that reading for?"}`.
5. `^issue[:\s]` → `issue {title}`.
6. ends with `?` or starts with what/how/why/where/which/can/should → `question {text}`.
7. contains worn|scored|broken|leak|crack|wrong|missing|seized → `observation {text}`.
8. `group` and contains a work word (off|out|removed|fitted|installed|welded|painted|tested|complete|done|delivered|started|tomorrow|today) → `progress {text, milestoneHint}` where `milestoneHint` is the first milestone keyword match (scraper|bearing|weld|gearbox|paint|commission).
9. otherwise → `offtopic`.
`confidence`: 0.9 for rules 1–5, 0.7 for 6–8, 0.3 for offtopic.

- [ ] **Step 1: Failing tests:** one assertion per rule above, plus *(Review Focus 4)* `parseMessage({text:"yes"}, {awaiting:null}).kind === "offtopic"` and "Braai at mine on Saturday" in a group → `offtopic`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `feat: rule parser for inbound chat`.

### Task 7: Channel service and the Chat Intake agent

**Files:** Create `src/channels.mjs`. Modify `src/agents.mjs` (spec + logic), `src/copilot.mjs` (step context), `src/system.mjs`, `src/evals.mjs`. Test new `test/channels.test.mjs`.

**Interfaces:**
- `createChannels({ ont, tel, actions, runtime, copilot, audit }) -> { inbound(channelId, senderId, { text, media }): Promise<{ message: Message|null, outcome, replies: Message[] }>, on(fn) }`. `system.mjs` adds `channels`.
- `inbound`: refuses (throws "not a member") when `senderId` is not in `channel.members`; computes `parsed` with `parseMessage` (awaiting = last outbound in channel with `awaiting`; execution = sender's running Execution); `offtopic` → no Message stored, `audit.append({ action: "message", outcome: "dropped", ref: <generated id> })`, outcome "dropped"; else stores `Message { direction: "in", from: senderId, at: tel.now(), text, media, parsed, audience: channel.audience, prov: { source: "CHANNEL-STUB" } }`, then runs `runtime.run("Chat Intake", { actingUser, scope: { messageId }, chain: true })`. `actingUser` = the Person (id, clearance) or, for a Participant, `{ id: <PAR id>, kind: "person", clearance: "technician", participant: true }`.
- After the run, for each run output `{ kind: "question", assetId, partId, text }` it opens/reuses a Copilot session for the sender at that asset/part (passing `step` from the running Execution) and sends the Copilot answer with `send_message` as agent "Technician Copilot". Emits `{ kind: "message", channelId, id }`.
- Agent spec **Chat Intake**: trigger `{ kind: "event", on: "Inbound message" }`, tools `start_execution, complete_step, record_reading, raise_issue, add_knowledge_note, record_progress_claim, send_message, raise_deviation`, autonomy all "act" except `raise_deviation: "propose"`.
- Chat Intake logic, by `parsed.kind` (Person senders): `start` → sender's assigned open WO (if 0 → reply "No job assigned to you."; if >1 and none named → reply listing ids, outcome "asked"); `start_execution`; reply with step 1 text and lock reason if locked. `done` → `complete_step`; refused for a lock → reply the lock reason; on success reply the next step; out-of-band reading → `raise_deviation` (proposal) and say so; last step → reply "Job done. What would you tell the next person?" with `awaiting: { kind: "note", executionId }`. `note` → `add_knowledge_note` on the Execution's asset, procedure and last step with a reading or the last step; then the Scribe is chained (`return [{ agent: "Scribe", scope: { executionId } }]`). `observation` → `output({ kind: "question" … })` and reply offer "Raise an issue? (yes/no)" with `awaiting: { kind: "issue", title }`. `yes` with awaiting issue → `raise_issue`; with awaiting submit → `submit_document` is done by the **person**, so Chat Intake outputs `{ kind: "submit", draftId }` and the channel service invokes `submit_document` with the sender as a person actor. `question` → output question. `issue` → `raise_issue`.
- Participant senders: only `progress` (→ `record_progress_claim` with `milestoneHint` matched to the project's milestone titles, evidence = media) and `issue` (→ `raise_issue` with `projectId`); every other kind → no write, no reply. *(Review Focus 2)*
- Copilot: `open({ …, step })` stores `step`; `nextChecks` puts that step first when present.

- [ ] **Step 1: Failing tests** (`test/channels.test.mjs`), each on a fresh system:
  - "J8: start → locked step 1 → permit → done… → reading out of band → deviation proposed" (drive `inbound("CHN-P-028","P-028",…)` through start, done; P-009 opens permit and isolation via actions; done ×5; "step 7 done 110.065" → a Proposal for `raise_deviation` exists; reply text contains "0.03").
  - "observation → copilot answer cites FND-002 and offers an issue; yes raises ISS". 
  - "done with no execution asks once and writes nothing" *(Review Focus 1)*.
  - "contractor progress becomes a claim on M3 with photo evidence; contractor 'done' writes nothing" *(Review Focus 2)*.
  - "non-member sender is refused"; "off-topic is not stored and audit records dropped".
  - "one reply per inbound" (outbound messages for the inbound ≤ 1, excluding the Copilot answer which replaces the bot reply for questions).
  - Evals for Chat Intake (3 cases) in `src/evals.mjs`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm test` → pass. **Step 5:** Commit `feat: chat front door with Chat Intake agent`.

### Task 8: Scribe, Project Watch, Procedure Steward; performance and project status

**Files:** Modify `src/agents.mjs`, `src/functions.mjs`, `src/evals.mjs`. Test `test/agents.test.mjs` (catalogue test now lists 18 agents), new `test/workforce.test.mjs`.

**Interfaces:**
- `performanceFor(scope: { personId } | { procedureId }, executions, procedures, issues, notes) -> { executions: number, steps: [{ step, text, expected, median, ratio }], firstTimeRight: number|null, issuesRaised: number, notesContributed: number }`. First-time-right = share of done executions with no out-of-band reading and no issue linked to their WO. `ratio = median / expected`, rounded to 2.
- `projectStatus(project, claims, issues, messages, now) -> { daysSinceReport, quiet: daysSinceReport >= 3, milestones: { total, claimed, confirmed }, openIssues, lastReportAt }`.
- **Scribe** (event: Execution finished / Issue done / weekly project): tools `draft_document, submit_document, send_message`, autonomy `draft_document: act, submit_document: act, send_message: act`. Execution scope → job card Draft (`kind: "job-card"`, body lists every step with minutes and readings, the issue ids, the note) and `data.onBehalfOf = personId`; if the person has `autoSubmit` → `submit_document`; else `send_message` to their channel "Job card ready: <summary>. Submit as is? (yes/no)" with `awaiting: { kind: "submit", draftId }`. Project scope → weekly report Draft, submitted if `project.autoSubmit`. Issue scope (chained from `update_issue` to `done` via the channel service or the API) → `kind: "issue-closeout"` Draft, never submitted.
- **Ask** gains a Project branch: a question naming a project title word or `PRJ-` id answers with `projectStatus` (end date, milestones claimed/confirmed, open issues, last report) and cites the project and claims (J10).
- **Project Watch** (schedule: daily; weekly Friday ≥ 15:00 plant time): tools `send_message, notify`, autonomy act. For each Project: `quiet` → `notify` owner and P-001 once per plant day (skip if a Notification about the project exists for today); weekly → `send_message` to the group with milestones and open issues, once per ISO week.
- **Procedure Steward** (schedule: weekly): tools `notify`, autonomy act; notifies both engineers about steps with `notes + issues >= 3` or `ratio >= 1.5`, naming procedure and step only (no person).
- Evals: 3 cases each.

- [ ] **Step 1: Failing tests:** `performanceFor({procedureId:"PRC-CENTRIFUGAL_PUMP-v3"})` flags step 6 `ratio >= 1.5`; `projectStatus` of the seed → `quiet: true`, `claimed: 2`, `confirmed: 1`; Scribe for P-028 (no consent) drafts and asks, for P-030 submits; Project Watch notifies once per day (run twice → one Notification); Procedure Steward notification text contains "step 8" and no `P-0`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm test` → pass. **Step 5:** Commit `feat: Scribe, Project Watch and Procedure Steward agents`.

### Task 9: API routes and the daily schedule

**Files:** Modify `src/server.mjs`. Test `test/server.test.mjs` (new cases).

**Interfaces:**
- `POST /api/channels/:id/inbound` — handled **before** `viewerOf`; sender from header `x-channel-sender` (Person or Participant id); body `{ text, media }`; 403 when not a member. `// shortcut: header-trusted sender, like x-acting-user; a real WhatsApp webhook verifies Meta's signature.`
- `GET /api/channels`, `/api/channels/:id/messages`, `/api/executions?personId=`, `/api/issues`, `/api/procedures`, `/api/projects`, `/api/projects/:id` (adds `status` from `projectStatus` and its claims) — all through `ont.view(v)`.
- `GET /api/performance/person/:id` → 200 when `v.id === id`, `v.id === person.supervisorId`, or clearance ≥ engineer; else 403 "only the person, their supervisor, engineers and the manager". `GET /api/performance/procedure/:id` (engineer+). `GET /api/performance/crew` (supervisor+): aggregates over all artisans, no person ids in the payload.
- Tick: when the plant date changes, run Project Watch and (on Mondays) Procedure Steward as `SYSTEM_USER`; startup runs Project Watch once. SSE broadcasts channel `message` events through the existing per-viewer filter (ref = message id).

- [ ] **Step 1: Failing tests:** inbound as P-028 to `CHN-P-028` → 200 with replies; as P-029 → 403; P-029 GET `/api/channels/CHN-P-028/messages` → 404; performance of P-028 as P-028 / P-009 / P-002 → 200, as P-008 → 403, as P-029 → 403; crew payload has no `"P-0"` substrings.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Pass. **Step 5:** Commit `feat: workforce API, inbound chat route and daily agents`.

### Task 10: Web views

**Files:** Modify `web/index.html` (nav), `web/app.js`, `web/styles.css`. Test `test/web.test.mjs` (add views to the list).

**Interfaces:** new views `chat`, `issues`, `projects`, `project`, `procedures`, `procedure`, `mywork`; nav links `data-nav="chat" | "issues" | "projects" | "procedures" | "mywork"`.
- **chat**: channel list (the acting person's channels), message pane styled as a phone chat, each inbound message shows its outcome pill (recorded / proposed / asked / dropped); a composer that POSTs to the inbound route with `x-channel-sender: state.user`; beside it a **Job** card (running Execution: current step, lock reason, Done with value input — it posts the same chat text "done <value>" so both paths share Chat Intake). Phone layout: chat first, job card above the composer.
- **issues**: four columns (open, triaged, in_work, done) with move buttons (`update_issue`), filters by asset/project.
- **projects / project**: milestones with claimed/confirmed pills, claim trail with evidence and message links, open issues, status line from `projectStatus`, Confirm button (supervisor+).
- **procedures / procedure**: list with version and "SharePoint copy behind" pill; per-step notes and issues counts and median vs expected; for engineers an editor showing current text beside an editable copy and a reason field → `propose_procedure_version`; for the manager a Release button on drafts.
- **mywork**: the acting person's performance (steps vs expected as a small bar per step, first-time-right, notes they contributed); crew rollup for supervisors; no other names.
- [ ] **Step 1:** Extend the web test's view list → FAIL. **Step 2:** Implement with existing helpers (`api`, `esc`, `num`, `pill`, `link`, `toast`). **Step 3:** `npm test` → pass. **Step 4:** Browser check at 1280 and 390 px as P-028 (chat J8) and P-002 (procedure edit). **Step 5:** Commit `feat: chat, issues, projects, procedures and my-work views`.

### Task 11: Docs, end-to-end check, final review

**Files:** Modify `README.md`, `../02-BRD-Water-Works-OS.md` Appendix D (add the four departures from spec §11), `../README.md` (link the spec).
- [ ] **Step 1:** README: Phase 2 rows in the coverage table, the stub-channel note, new roles to try (P-028 chat, P-009 permit, P-004 project, P-002 procedure, P-030 auto-submit).
- [ ] **Step 2:** `npm test` → all pass; record the count.
- [ ] **Step 3:** Playwright: J8 (P-028 + P-009), J9 (contractor message via inbound route, P-004 confirms M2), J10 (P-001 asks Ask agent "where is the CL-3 refurb" — Ask logic adds a Project branch), J11 (P-028 my work), J12 (P-002 proposes v4, P-001 releases).
- [ ] **Step 4:** Fresh reviewer over `git diff feat/phase1-mvp...HEAD`; fix findings test-first in `test/review-fixes-2.test.mjs`.
- [ ] **Step 5:** Commit `docs: Phase 2 README, BRD departures` and the fixes.
