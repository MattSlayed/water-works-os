# Design — Workforce Intelligence module for Water Works OS (Phase 2)

Status: approved 2026-10-23 (Matthew). Built as Phase 2 of water-works-os.
`water-works-os/docs/superpowers/specs/2026-10-23-workforce-intelligence-design.md`, then planned with superpowers:writing-plans and built into the demo with the same TDD, ledger and final-review flow as Phase 1.

## 1. Intent and the why

Phase 1 knows who is **allowed** to do a job (competence, clearance, permits). It does not know how the job actually went, what the artisan learned, or what the contractor in the clarifier is up to. That knowledge today lives in WhatsApp groups and in people's heads, and dies at the end of the shift.

The Workforce Intelligence module closes that gap by meeting people in the channel they already use. WhatsApp (and later other messaging platforms) becomes a front door to the ontology: an artisan's photo and voice note become a step completion, a work-order note and a knowledge note on the part; a contractor's daily post becomes a progress claim on the Project; the artisan asks the Technician Copilot by chat, and an agent writes and submits the paperwork on their behalf. From that execution trail the platform can also say how work is going per person and per procedure, which Phase 1 could not.

Inspiration: Augmentir's connected-worker platform (augmentir.ai). Of its modules, Matthew chose four to build: **Knowledge Management, Troubleshooting Assistant, Digitised Work Instructions, Issue Management**, plus **worker performance** and **agent-created documentation**. The remainder are recorded as future integrations (§10). Augmentir's claimed outcomes are reused as the value propositions we solve towards (§2), as hypotheses, not as our claims.

## 2. Value propositions (what we are solving towards)

Borrowed from Augmentir's stated outcomes; each is a hypothesis to test, with the measure the demo makes observable.

| Value proposition | Augmentir claim | Our measure in the demo |
|---|---|---|
| Faster time-to-proficiency | 40% faster for new hires | Time per step for a person vs the procedure baseline, trending over executions |
| Less downtime | 38% reduction | Work-order cycle time from assignment to close; issues that blocked a job |
| Knowledge retained, not lost | "tribal knowledge captured" | Knowledge notes per part and per step; Copilot answers that cite a field note |
| Paperwork that writes itself | content assistant | Documents created by the Scribe agent vs by hand; time from job close to submitted job card |
| Projects visible without chasing | not claimed by Augmentir; Matthew's addition | Days since last contractor report; milestones claimed vs confirmed |

## 3. Goals, non-goals, anti-goals

**Goals**
1. An artisan can do a whole job, from first step to submitted paperwork, without opening the console: by chat, or by the phone view, or mixed.
2. Every message that matters becomes a provenance-carrying object in the ontology, visible to the right clearance and nothing else.
3. The Copilot knows which step the person is on and answers narrowly.
4. A project or contract's progress is read from its group chat and reported without chasing.
5. Worker performance is measured per task from execution data, shown to the worker first.
6. The whole loop runs in the demo with a stub message channel and synthetic chats.

**Non-goals (this phase)**
- Real WhatsApp Business API, Telegram, SMS or SharePoint/Drive connectors. Stubs behind the same interfaces, like ERP and LIMS in Phase 1.
- Authoring work instructions with AI from arbitrary PDFs (Augmentir Procedure Studio). Conversion from the synthetic SOPs is hand-written; a Claude path exists behind the same function when a key is set.
- AR, time-and-motion productivity ranking (True Productivity), LMS courses and quizzes, kanban beyond one board. See §10.

**Anti-goals (would make this a failure even if it works)**
- Artisans feel watched. Performance exists to help the person and the procedure, never to rank people publicly. A number nobody can explain is a failure.
- The bot in the group becomes a nag. One reply per message at most, one question when unsure, one digest a day.
- Chat parsing writes facts. A parsed message is a **claim** until a person confirms it, except for the trivial cases listed in §6.3.
- Paperwork submitted that the person never saw. The Scribe drafts; submission on someone's behalf is a dial setting the person themselves accepted.

## 4. Constraints

- Built on Phase 1 as it stands: in-memory ontology, typed actions with the autonomy dial, hash-chained audit, clearance pruning, 14 agents, Copilot, SSE, vanilla web UI, zero dependencies, Node 22, `node:test`.
- "Apply no gate restrictions" stands: NOVACORE doctrine (no person scores, no agent memory about a person, T4-absent) is not enforced. Each departure is listed in §11 for Matthew's decision, as in BRD Appendix D.
- POPIA still applies in the design: only numbers on Person records are attributed by name; contractor numbers become pseudonymous Participants; off-topic chat is dropped at parse time; every group carries a listening notice; performance is visible to the person it is about.
- Claude is optional. With `ANTHROPIC_API_KEY`, parsing and Copilot answers use `claude-opus-5-5` through `llm.mjs`; without it, deterministic parsers handle the synthetic chats. Tests run without a key.

## 5. The loop (what the user experiences)

**J8 — Job by chat.** Millwright P-028 is scheduled on WO for HLP-B. At 07:05 the works number sends: "WO-0931 HLP-B bearing replacement, 14 steps, permit PTW-0419 open, isolation verified. Reply *start* when you're at the pump." P-028 replies "start". The platform sends step 1. Each step that needs a reading says so; "step 6 done 110.06" records the reading against the part and runs the band check (existing Copilot logic). Step 9 (strip housing) stays locked until the permit and isolation exist; they do, so it opens. At step 11 P-028 sends a photo and "the sleeve is scored too, not on the job". The Copilot replies with the fault-tree branch, FND-002 from March, and stock for the sleeve, and offers "raise an issue?" P-028: "yes". ISS-0007 opens on the board, linked to the WO and the part. Job ends; the platform asks: "What would you tell the next person?" P-028's voice note becomes a Knowledge note on the DE bearing housing and on step 11 of SOP v3. The Scribe drafts the job card from the step log and sends P-028 a one-screen summary: "Submit as is?" "yes" submits it.

**J9 — Contract in the group.** Group "CL-3 refurb" has the contractor's site agent (Participant, pseudonymous), two of their fitters, planner P-004 and supervisor P-009. The contractor posts photos and "scraper arms off, bearings out, weld repair tomorrow". The platform records a ProgressClaim against milestone M2 of PRJ-CL3 with the photos as evidence. Nothing in the group changes. Friday 15:00 Project Watch posts the weekly status to the group: milestones, open issues, days since last report. P-004 confirms M2 from the console; the Project moves. Tuesday the group goes quiet for three days; Project Watch notifies P-004 and P-001.

**J10 — Manager asks.** P-001 on the console, or in their own chat: "where is the CL-3 refurb". Answer: contract end date, milestones claimed and confirmed, open issues, last report, with links.

**J11 — Performance, seen by the person first.** P-028 opens their own view (phone or console): jobs this month, time per step against the procedure baseline, first-time-right, issues raised, knowledge notes contributed. The reliability engineer sees the same per procedure: which steps take longest across everyone, which have the most notes and issues, which need rewriting. The manager sees crew-level rollups. No leaderboard.

**J12 — Living SOP.** Engineer P-002 opens SOP "centrifugal pump: inspection and overhaul" v3, sees step 11 has three knowledge notes and two issues, edits the step with the current version side by side, and proposes v4 with a reason. Manager P-001 releases it. The source document record is flagged "SharePoint copy behind v4" until someone updates it. Open work orders keep v3; new ones get v4.

## 6. Ontology additions

### 6.1 New object types

| Type | Key fields | Notes |
|---|---|---|
| **Procedure** | id, documentId (source Document), title, version, state (draft/released/superseded), steps[], releasedBy, releasedAt, sourceRef {system: sharepoint/drive, url, revision}, sourceBehind:boolean | The digitised SOP. One Procedure per Document version. |
| **Step** (inline on Procedure) | n, text, requires: {reading?: {partRef, unit, band}, photo?, signoff?, permit?, isolation?}, expectedMinutes, hazard? | Locks come from `requires.permit/isolation`, checked the way the Copilot's "next checks" are gated today. |
| **Execution** | id, procedureId, procedureVersion, workOrderId, personId, startedAt, finishedAt, steps: [{n, state, at, readingId?, photoId?, note?, minutes}] | The job as it happened. Source of performance and of the job card. |
| **Issue** | id, title, state (open/triaged/in_work/done/dropped), raisedBy, assetId?, partId?, workOrderId?, projectId?, procedureId?, stepN?, evidence[], assigneeId?, spawned[] | The board. |
| **KnowledgeNote** | id, text, authorId, partId?, assetId?, procedureId?, stepN?, executionId?, messageId?, verified, verifiedBy | Supersedes nothing; Phase 1 `Finding` stays for verified engineering findings. A note can be promoted to a Finding by an engineer. |
| **Channel** | id, kind (whatsapp/telegram/sms/stub), address, groupName?, projectId?, members: [personId or participantId], noticePosted:boolean, minClearance | A one-to-one chat or a group. |
| **Message** | id, channelId, from (personId or participantId), at, text, media[], transcript?, parsed: {kind, confidence, refs[]}, outcome (recorded/proposed/dropped/asked) | Provenance for everything parsed. Off-topic messages are not stored (outcome dropped is logged in audit only, without text). |
| **Participant** | id, channelIds[], label ("Contractor site agent"), employer | Pseudonymous. No name, no number stored beyond a hash. |
| **Project** | id, title, kind (contract/internal), contractorEmployer?, assetIds[], start, end, milestones: [{id, title, due, claimedAt?, confirmedAt?, confirmedBy?}], channelId?, ownerId | |
| **ProgressClaim** | id, projectId, milestoneId?, messageId, by, at, text, evidence[], confirmed:boolean | Claim, not fact, until confirmed. |
| **Performance** (derived, not stored) | per person: executions, minutes per step vs expectedMinutes, firstTimeRight, issuesRaised, notesContributed; per procedure: per-step median minutes, notes, issues | Computed by a function, cached per tick. **Matthew's decision:** an individual's numbers are visible to the person themselves, *their own* supervisor (new `supervisorId` on Person in the synthetic HR data), engineers and the manager. Other supervisors see crew rollups only. No leaderboard. |

### 6.2 New actions (through the existing `ACTIONS` table and dial)

| Action | Ceiling | Human-only | minClearance | Targets validated |
|---|---|---|---|---|
| `start_execution` | act | no | technician | workOrderId, procedureId |
| `complete_step` | act | no | technician | executionId; reading goes through existing `record_reading` |
| `raise_issue` | act | no | technician | assetId/partId/workOrderId/projectId optional |
| `update_issue` | act | no | supervisor (technician for own) | issueId; PATCHABLE whitelist |
| `add_knowledge_note` | act | no | technician | partId/procedureId |
| `verify_knowledge_note` | act | yes | engineer | noteId |
| `propose_procedure_version` | propose | yes | engineer (authoring competence `c-author`) | procedureId |
| `release_procedure` | act | yes | manager | procedureId |
| `record_progress_claim` | act | no | — (system from parsed message) | projectId |
| `confirm_milestone` | act | yes | supervisor | projectId |
| `send_message` | notify→act | no | — | channelId; outbound to a channel, rate-limited one reply per inbound message |
| `submit_document` | propose→act | no | technician | documentId; **per-person consent flag** (`autoSubmit`) required for an agent to act on their behalf |

Phase 1 actions reused: `record_reading`, `tag_part`, `raise_deviation`, `draft_document`, `create_work_order`, `notify`, `raise_alert`.

### 6.3 Parse-to-write rules

- **Recorded directly** (confidence high, low consequence): step done, reading in band, plain knowledge note, progress claim text with photo, issue raised by a known person.
- **Proposed for confirmation**: reading out of band (existing deviation path), milestone complete, anything that would change an asset state or a work-order state, any message from a Participant that implies a fact about our assets.
- **Asked back** (one question): ambiguous asset or work order, number without a unit, two open WOs for the sender.
- **Dropped**: off-topic, no work reference, or sender unknown to the channel. Audit logs "dropped" with message id only.

### 6.4 Functions

- `parseMessage(message, ctx)` → `{kind, refs, confidence, fields}`. Deterministic rule parser over the synthetic chats; Claude path behind the same signature in `llm.mjs`.
- `performanceFor(personId | procedureId, executions, procedures)`.
- `projectStatus(project, claims, issues, messages)` → days since report, milestones, open issues.
- `procedureFromDocument(document)` → steps (hand-written for the four synthetic SOP templates; Claude path for arbitrary text).

## 7. Agents (added to `AGENT_SPECS`, with eval cases each)

| Agent | Trigger | Tools | Default autonomy |
|---|---|---|---|
| **Chat Intake** | event: inbound Message | parse, start_execution, complete_step, record_reading, raise_issue, add_knowledge_note, record_progress_claim, send_message | act for §6.3 "recorded" cases, propose for the rest |
| **Scribe** | event: Execution finished, Issue done, weekly for projects | draft_document (job card, PTW application, contractor daily diary, incident report, timesheet), submit_document, send_message | draft; submit only where the person's `autoSubmit` consent is on, else propose to them by chat |
| **Project Watch** | schedule: daily; weekly status | projectStatus, send_message, notify, raise_alert | act for digests and quiet-project notifications; milestone confirmation never |
| **Procedure Steward** | schedule: weekly | performanceFor, notify | notify engineers about steps with ≥3 notes/issues or step time ≥1.5× baseline |
| **Technician Copilot** (existing) | event: question in chat or console | existing, plus step context | unchanged |

Chaining: Chat Intake → Copilot (question) · Chat Intake → Scribe (job finished) · Issue done → Scribe.

## 8. Channel stub and synthetic chats

- `src/channels.mjs`: `createChannels(sys)` with `inbound(channelId, from, text, media)` and `outbound` listeners. The stub is the only transport in this phase; the WhatsApp adapter is a file with the same two functions, not written.
- Synthetic data: 1 works number; one-to-one channels for every Person; group "CL-3 refurb" with project PRJ-CL3 (contract, 6 milestones, 2 claimed, 1 confirmed, quiet for 3 days at CLOCK); 5 days of seeded chat history across both; one Execution in progress for P-028 on HLP-B at step 10; 4 Procedures converted from the 4 SOP templates; 6 Issues in various states; 9 KnowledgeNotes; 12 closed Executions across 5 artisans for performance.
- API: `POST /api/channels/:id/inbound` (demo transport; `x-acting-user` is the sender), `GET /api/channels`, `/api/messages`, `/api/executions`, `/api/issues`, `/api/procedures`, `/api/projects`, `/api/performance/:scope/:id`, plus actions through the existing `/api/actions`.

## 9. Web UI additions (NOVATEK design system, same vanilla modules)

- **Chat** view: the works number as a chat pane, one channel at a time, with the parsed outcome shown under each message (recorded / proposed / asked / dropped). A text box sends as the acting user. This is the demo's WhatsApp.
- **Procedure runner** on the phone layout: current step, requirements, lock state, "done" with reading or photo, Copilot button carrying step context.
- **Issues** board: four columns, drag or button to move, filters by asset, project, procedure.
- **Projects** view: milestones with claimed/confirmed, claim trail with evidence, issues, last report, Confirm button for supervisors.
- **Procedures** view: list and version history; editor side-by-side with current version (engineers); notes and issues per step; "source behind" flag.
- **My work** view: the person's own performance and the knowledge notes they contributed; supervisor and engineer rollups on the existing Console.
- Mobile Copilot design (canvas artboard) extended with the procedure runner; add Chat and Issues artboards to the Design canvas after the build.

## 10. Future integrations (parked, not designed)

Augmentir modules not in scope, recorded for later: True Productivity opportunity ranking, Augmented Reality guidance, Industrial Collaboration across plants and languages, Reporting & Dashboards beyond what the Console has, LMS-style courses and quizzes, AI Agent Studio (no-code agent builder), Procedure Studio (AI authoring from arbitrary PDFs and video), SharePoint/Drive/ERP/CMMS/HCM connectors, real WhatsApp Business API, Telegram and SMS transports.

## 11. Doctrine departures introduced by this phase (for Matthew's decision, like BRD Appendix D)

1. Per-person performance measures exist (NAB-003 forbids person scores). Mitigation: visible to the person first, explained per step, no ranking.
2. Agents act on a person's behalf (submit documents) when consented (T4-absent rule). Mitigation: per-person consent flag, every submission reversible via existing `reverse`.
3. Group chats are read and stored (people tracking). Mitigation: listening notice, Participants pseudonymous, off-topic dropped at parse time and never stored.
4. Claude processes chat text cross-border when a key is set (POPIA s72 disclosure already in README; chat adds message content to it).

## 12. Calls made after the builder check (mine, not Matthew's; check these)

1. **J8 runs the permit live, not seeded.** HLP-B keeps no permit in the seed (Phase 1's J4 Copilot demo and `copilot.test.mjs` depend on it). The seeded Execution for P-028 sits at step 8. In J8 step 9 is locked; the Copilot says why; supervisor P-009 opens PTW-0419 with the existing `open_permit` and records the isolation; step 9 unlocks. Better demo, no Phase 1 test touched.
2. **`Procedure` replaces `ProcedureStep`.** One source of truth. The Copilot's next checks, `assetInsight`, Work Pack and `/api/assets/:id/model` read the released Procedure for the asset's template. A work order pins `procedureVersion` when its Execution starts, so open WOs keep v3 while new ones get v4. Phase 1 tests that read `ProcedureStep` migrate.
3. **Participants act under a fixed low actor.** The inbound route takes the sender as `x-channel-sender` (a Person id, or a Participant id resolved from the hashed number); `x-acting-user` is not used for inbound. Chat Intake runs as the sending Person when there is one; for a Participant it runs as `PARTICIPANT_USER` (clearance technician) whose only permitted actions are `record_progress_claim`, `raise_issue` on that channel's project, and `send_message` back to that channel. Decisions and Messages carry the channel's `minClearance`, the way Phase 1 Decisions carry the strictest target zone.
4. **The plant clock is freed from the telemetry window.** `tel.now()` keeps advancing past the end of the 14-day series; `latest()` and `history()` clamp to the last sample. Executions, Messages and agent schedules use plant time, so a live J8 step takes ~1 plant minute per 2 s and performance numbers are meaningful. Project Watch's weekly post and the three-quiet-days notice are present in the seeded history and also fire when the plant clock crosses them. Tests keep using `CLOCK`.

## 13. Left to the builder

- Exact step lists for the four synthetic SOPs and their expected minutes.
- The rule parser's vocabulary (asset tags, WO ids, "done", numbers with units, "issue", "note").
- Baseline for "first-time-right" (no issue raised and no reading out of band on the execution).
- Whether the Issues board reuses the Proposals view's layout.

## Verification

- `npm test`: existing 95 pass plus new suites for channels, parse rules (every §6.3 class), executions and locks, issues, knowledge notes, project claims and confirmation, performance function, Scribe consent, clearance pruning of channels and messages, and agent evals for the four new agents.
- Browser (Playwright) as P-028: run J8 end to end from the Chat view; as P-004: J9 confirm a milestone; as P-001: J10; as P-002: J12.
- Final fresh reviewer pass with the review-fixes pattern from Phase 1.
