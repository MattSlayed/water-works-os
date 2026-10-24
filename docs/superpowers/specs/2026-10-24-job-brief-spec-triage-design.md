# Design: Job briefs and spec triage (Phase 3, project 4)

Status: **draft for Matthew's approval.** The builder check is answered in §15.

## Where this sits

**Phase 3 so far:**
- the plant from its drawings;
- the region map and satellite layer;
- the agent harness and root-cause agent.

These three are merged into `feat/phase2-workforce-intelligence`. The Agent Studio, with its connectors, document
digester and Recommender, is built on `feat/phase3b-agent-studio` (3b) and not merged yet.

**Where this project came from.** It came out of the brainstorm on the remaining platform items,
`../../../../04-PHASE3-VENDOR-RESEARCH.md` §5 items 4–8. Matthew was asked what would have made the biggest difference the
last time something went wrong on a shift. He named something that is not on that list, so it goes first. The other items
wait (§2, non-goals).

## 1. Intent and the why

Matthew's words:

- "the biggest difference wouldve been if the person was better informed or briefed on the project or before the person
  calibrated or tested the asset that was being worked on to the desired specifications of management"
- "the convienience of having a system that can easily access that information as opposed to having to dig through files
  and spreadsheets would be efficient and convienient"
- "having historical correction perhaps from maybe a previous project related to this asset, client or company would
  also help"
- Where management's specs live: "usually a combination of all [a client spec sheet, an email, a drawing, a spreadsheet,
  someone's head], the system could triage those forms of data to also single it down"
- When sources disagree: "it would be automatically updated, with human confirmation"
- Who confirms: "the main site manager changes or updates it"

**The moment this fixes.**
- A fitter or technician is about to calibrate or test an asset.
- What management wants it set to is spread across a signed client spec, an email, a drawing, a spreadsheet and
  somebody's memory, and the sources do not agree.
- Nobody has the record of what went wrong last time, whether on this asset or on an earlier project for the same client
  or contractor.
- So the person tests to the wrong number, or to no number, and the fault is found later.

**What exists today** (all in `water-works-os/`):

- **Bands, but per template.**
  - A Part's `band` (`{measure, lo, hi, unit}`) comes from the SOP for its template (`T[tpl].bands` in `src/generate.mjs`).
  - Every pump of a type gets the same band, so nobody can say "for DP-2, management wants 135 L/h".
  - The band has no source beyond "SOP revision C".
- **Readings checked against the band.**
  - `complete_step` (`src/actions.mjs`) records the value and `inBand` via `bandCheck` (`src/functions.mjs`).
  - First time right fails if any reading is out of band.
- **History, scattered.** Each of these sits on its own screen:
  - executions with their step values;
  - verified Findings (FND-003: the DP-1 suction ball);
  - Issues (ISS-H04: DP-2 has no air-release valve);
  - KnowledgeNotes per step (KN-H07);
  - calibration certificates (Documents of kind `certificate`);
  - the OEM manual and the SOP.
- **Reading documents.**
  - The 3b connectors: Graph mail and driveItems, Gmail, Drive and Sheets. Drive and Sheets are seeded empty.
  - The document digester's grading (`src/digest.mjs`): `EXTRACTED` (read clearly), `INFERRED` (worked out) and
    `AMBIGUOUS` (unsure), each with the line it came from.
- **Approval.**
  - Actions with a `propose` ceiling become Proposals.
  - `resolve` honours a named `approver` (`src/actions.mjs`).
  - Every step goes into the hash-chained audit.
- **Unused pieces.** `request_setpoint_change` writes a `SetpointRequest` that nothing reads.

**What is missing:**
1. A spec per asset, with its sources.
2. Something that reads every source and narrows it to one answer.
3. A record of corrections that outlives the project it was found on.
4. A brief that puts all of it in front of the person before the first step.

## 2. Goals, non-goals, anti-goals

**Goals:**

1. **One spec per asset and measure.** It holds:
   - the confirmed value or band, and its unit;
   - the sources behind it;
   - who confirmed it, and when;
   - every earlier version.
2. **Spec triage.** An agent reads mail, files, sheets, drawings and chat for values that look like a spec for an asset.
   - It grades each one, ties it to the asset, and ranks the candidates.
   - When they differ from the confirmed spec, it proposes a single answer.
   - The proposal is created automatically. **It counts only once the site manager confirms it.**
3. **Corrections that carry over.**
   - When the site manager confirms a change, they can mark a passed-over source as *wrong*, not just older.
   - That becomes a Correction, scoped to the asset, the make and model, or the organisation (client or contractor).
   - Later briefs inherit it, and so do later projects for the same organisation.
4. **The job brief.** A short brief before step 1, in chat and on the work order. It shows:
   - the target spec and its source;
   - any change waiting for confirmation;
   - corrections that apply;
   - what happened on the last jobs;
   - open issues and watch-outs.
5. **Test to the brief.**
   - Readings during the job are checked against the asset's confirmed spec, not the template band.
   - The execution records which spec version it was held to.

**Non-goals (this project):**

- **The other platform items.**
  - asset states and downtime reasons;
  - operator rounds and watch debounce;
  - the general review queue for machine-made links, with the historian-tag matcher;
  - the MCP server;
  - the SOP-to-procedure reviewer.

  Spec candidates use the review queue's shape (§4.2), so item 6 can absorb them later.
- **Real OCR and real connections.** No real Microsoft, Google or drawing-system connections. Sources are synthetic,
  with a text layer, as in 3b.
- **Writing back to the sources.** No fixing the spreadsheet, replying to the email, or revising the drawing.
- **A client-facing portal, or client sign-off.**
- **Specs for whole process units or the plant**, such as target turbidity or chlorine residual. Specs here belong to an
  asset and a measure.
- **Changing a live setpoint on the plant.** A confirmed spec says what a job tests against. It does not move the PLC.

**Anti-goals (a failure even if it works):**

- **Silently picking a value.** When sources disagree, the brief shows the conflict or the confirmed decision, never a
  number with no source.
- **A brief nobody reads.**
  - In chat it fits a phone screen: at most 8 lines before step 1, with the rest one reply away.
  - No paragraphs of history.
- **False confidence.**
  - An unsure reading of a source is never proposed as the answer.
  - A pending change is never shown as if it were confirmed.
  - A stale certificate is shown as stale.
- **Digging anyway.** If the person has to open three screens to find what the brief was meant to tell them, it failed.
- **A spec changed by no one.** Every confirmed spec names the site manager who confirmed it.

## 3. Constraints

- **Stack.** Node 22, zero dependencies, `node:test`, vanilla ES modules, offline tests, and an in-memory store rebuilt
  from the seed.
- **The generator's existing random draws must not move.**
  - New seed data is appended after all draws, as in 3b.
  - Today's 407 tests stay green, except where a count deliberately changes.
- **Clearance.** Clearance, zone and audience views apply to everything here. A brief is built from the viewer's own view.
- **Works without Claude.**
  - Extraction is pattern-based on the text layer.
  - With Claude on, it also reads images (the 3b `visionFields` hook) and may phrase the brief.
  - Claude never chooses the value.
- **Wording.** The NOVACORE wording gate is waived. Departures go in BRD Appendix D.
- **Existing machinery.**
  - The action machinery: `def`, ceilings, Proposals, the named approver, `resolve`, audit and reversal.
  - The 3a harness, for the new agent.

## 4. The model

### 4.1 Spec

`Spec` (`SPC-<asset tag>-<measure key>`):

```
{ assetId, partName?, measure, unit, lo, hi, target?, method?, version, state: "confirmed",
  sourceRefs[], confirmedBy, confirmedAt, reason, supersedes }
```

- **Seeded from today's bands.**
  - Every Part with a band gets a version 1 Spec whose source is the SOP (revision C).
  - Its `confirmedBy` is P-001 and its `reason` is "From SOP revision C".
  - Nothing behaves differently until triage finds something newer.
- **New measure for the demo, per asset.**
  - The coagulant pumps DP-1 and DP-2 gain a Spec for "Delivery at 60% stroke" in L/h, recorded at step 2 ("calibration
    column draw-down"). Its version 1 comes from the SOP: 100–140 L/h.
  - The template's bands do not change. A step asks for a reading when the Part has a band **or** the asset has a Spec
    for that step's measure. So the chlorinators CHL-A and CHL-B, which share the template, are untouched.
  - Seed history must not shift (§3).
- **History stays.**
  - A new version supersedes the old one.
  - Older versions stay readable.
  - Old executions point at the version they were held to.
- **Both forms accepted.** `target ± tolerance` and `lo–hi` are both stored as `lo`/`hi`, plus `target` when one was given.

### 4.2 Spec candidate

`SpecCandidate` (`SCD-…`) has the review-queue shape (C1):

```
{ subject: assetId, measure, unit, lo, hi, target, source: { kind, id, line, at, authorId, title },
  authority, grade, matchedBy, confidence, status: "suggested" | "approved" | "rejected", resolvedBy }
```

- **`matchedBy`** says how the source was tied to the asset: the position tag in the text, the KKS code, the asset's
  name, or the drawing tag.
- **`grade`** uses the digester's three grades.
- **An `AMBIGUOUS` candidate is never proposed.** It waits in the site manager's queue for a person to read.

**Who sees what** (my call):
- **Specs and pending changes.** Anyone who can see the asset sees its Spec values, and the value and date of a pending
  change. The point of the brief is that the person doing the job knows the target.
- **Citations.** Every citation shows the source's title, kind, date and author, for example "mail from Precious Sithole,
  13 Oct".
- **Source text.** The quoted text and the link to the mail, file or sheet itself are shown only to a viewer who may read
  that source: the connector catalogue's role lines, or the object's own clearance and audience.
- **Candidates and the Spec changes queue.** The site manager, and engineers and above.

### 4.3 Spec change

A spec change is a Proposal of the new action `update_spec`:
- ceiling `propose`, `minClearance` manager;
- the named approver is the **site manager** (role `works_manager`, P-001 Precious Sithole);
- **no backup** (my call, because Matthew named the site manager). While it waits, the brief says so (§6).

The proposal carries:
- `specId`, `from` and `to`;
- the winning candidate;
- `passedOver[]`, each with its reason: older, lower authority, unsure, or blocked by a correction;
- a one-line `why`.

**On approve or edit,** a new Spec version is written.

**On reject,** the reason is kept, and the same source never proposes the same value again.

**Who may confirm.** Anyone other than the site manager is refused. A supervisor fails `resolve`'s clearance check first
("insufficient clearance"). A manager other than P-001 gets "waiting for P-001".

**Temporary instructions** (my call): a spec stays until the next confirmed change. When the source carries a condition,
such as "until raw turbidity settles", it is stored as `condition` on the Spec and quoted in the brief. Nothing lapses on
its own.

### 4.4 Correction

`Correction` (`COR-…`):

```
{ text, wrongSourceRef, wrongValue, rightValue?,
  scope: { assetId } | { template } | { orgId },
  fromId (spec change, issue or finding), by, at }
```

- **Made by the site manager**, in two ways:
  - by ticking "this source is wrong" when confirming a change;
  - directly, from an issue or a verified finding (for example ISS-H06, "Wrong gasket size on the HLP-A drawing").
- **Scope.** `template` means the same make and model (`Dosatec DM 400`). `orgId` means an organisation.
- **Two kinds** (my call):
  - **A value correction** has a `wrongSourceRef` and a `wrongValue`. It blocks only that value from that source,
    within its scope. When the sheet later changes to a new value, the new value takes part again. Triage passes over a
    blocked candidate and says why.
  - **A guidance correction** has no `wrongValue`, for example "check by draw-down, never from the table". It is brief
    text only. Triage does not act on it, and does not convert units because of it.

### 4.5 Organisation

`Organisation` (`ORG-…`): `{ name, kind: "owner" | "contractor" | "oem" }`.

**Seeded:**
- the works' owner, a synthetic "Riverbend Water Board": the client whose specs the works follows;
- Synthetic Contractor (Pty) Ltd;
- Dosatec, the OEM.

**Projects** gain `clientOrgId` and `contractorOrgId`. The existing `contractorEmployer` string stays.

**How an organisation's corrections reach a job** (my call). A job's brief carries an organisation's corrections when any
of these holds:
1. The asset was in `assetIds` of any project, past or present, run by that organisation or for it. This is how
   "a previous project related to this … client or company" is found.
2. The work order belongs to a project of that organisation.
3. The organisation is the works' owner. The owner's corrections apply to every job at the works.

`PRJ-H2025-DOSE` lists DP-1 and DP-2 in `assetIds`. So WO-26044, which has no project, still inherits Synthetic
Contractor's corrections through DP-2.

### 4.6 Brief

`Brief` (`BRF-…`): `{ executionId, workOrderId, assetId, personId, at, specVersions[], correctionIds[], lines[] }`.

- **Written at job start.** It records what the person was told, so a root-cause analysis can later ask "was the person
  briefed, and against which spec?"
- **Audience:** the person, their supervisor, and the site manager.

## 5. Spec triage (agent 22)

Spec triage is a default agent in `AGENT_SPECS`, under the 3a harness.

- **Mode: bounded.** Its tools are read-only, plus `update_spec` at `propose`. It never writes a Spec itself.
- **Approver:** the site manager.

**Triggers:**
- at start-up, over the seeded sources;
- when new mail arrives in the works mailbox;
- when a file lands in the engineering folders;
- when the dose sheet changes;
- when a chat message states a value for an asset;
- on demand for one asset ("Re-check sources" on the asset's Specs tab).

**What it reads**, through `sys.connectors` (synthetic):
- the works mailbox, `works@riverbend.example`;
- the Drive and Files folders `Engineering/Specs` and `Engineering/Drawings`;
- the Sheets range `Coagulant dose calc!A1:F20`;
- the OEM manual and SOP Documents;
- chat messages.

The IT catalogue gets read lines for these sources, with the role `works_manager`.

**Steps:**

1. **Find the asset.**
   - Tokenise with `\p{L}+|[0-9]+`.
   - Score the tokens against each asset's position tag (`DP-2`), KKS code (`13QCA10AP002`), name ("Coagulant dosing
     pump 2") and drawing tag.
   - Below a threshold, no candidate is made. When two assets score close together, the candidate is `AMBIGUOUS`.
   - This is a narrow, asset-only version of the C2 matcher.
2. **Read the value.**
   - Patterns look for a measure word, a number or range, `±` with a tolerance (absolute or %), and a unit.
   - Grades follow the digester. A `?` or a smudge gives `AMBIGUOUS`. A measure word matched by synonym ("dose rate",
     "delivery" and "output" all mean delivery) gives `INFERRED`.
3. **Normalise units** from a small table: mL/min ↔ L/h, % of rated, mm, bar, NTU and h. An unknown unit gives
   `AMBIGUOUS`.
4. **Rank** (my call). The confirmed Spec is the baseline the winner is compared against. It is not a candidate.
   1. **The site manager's own word wins when it is newest.** A written instruction from the site manager (mail, or a
      chat message from P-001) beats every other candidate dated before it. Matthew: "the main site manager changes or
      updates it".
   2. **Otherwise, authority first, then the newest date.** Highest first:
      1. a signed client or owner specification;
      2. the OEM manual or datasheet;
      3. the drawing or its data sheet;
      4. a spreadsheet;
      5. a person's report in chat, or a field note.

   A candidate blocked by a value correction drops out. An `AMBIGUOUS` candidate is never ranked. Each passed-over
   candidate gets one reason: "older than the site manager's instruction", "lower authority", "older", "unsure" or
   "blocked by COR-…".
5. **Decide.**
   - If the top candidate agrees with the confirmed spec (within its tolerance), it is added as a supporting source. No
     proposal is made.
   - If it differs, triage proposes `update_spec`, listing every passed-over candidate with its reason.
   - A value outside the OEM's rated range is still proposed, but flagged "outside the maker's rated range (0–400 L/h)".

**Evals** (3a harness):
- The DP-2 case proposes 135 L/h ±5% and passes over the other four with the right reasons: b "older than the site
  manager's instruction"; c, d and f "lower authority"; g "unsure".
- The smudged note never becomes a proposal.
- A blocked source never wins.
- A source that matches two assets goes to review.
- The agent never confirms its own proposal.

## 6. The job brief

**Where it appears:**
- in chat, between "start" and step 1 (the short version);
- on the work order page and the asset page, as a Brief panel holding everything. A planner, or the person, can read it
  the day before;
- in the Copilot, on "brief me on DP-2".

**Built by a function, not an agent.**
- `jobBrief(view, workOrderId)` returns `{ lines[], full }`, deterministically.
- Claude, when on, may only shorten the wording of `lines`.

**Contents, in order.** These rules are the test oracle; the §7 text is what they give on the seed. The chat version is
exactly: a header line; then at most one line per section 1, 3, 4 and 5, and at most two for section 2; then the footer.
That is 8 lines at most, and an empty section takes no line. Section 6 appears only in the full brief.

1. **Target.** For each measure this procedure records: the confirmed band, its source, and who confirmed it.
   - Example: "Delivery at 60% stroke: 128.3–141.8 L/h (135 ±5%), site manager's instruction 13 Oct, confirmed by Precious
     Sithole."
   - **When a change is pending:** "A newer value is waiting for the site manager: 135 L/h (mail, 13 Oct). Test to the
     confirmed 114–126 L/h until then."
2. **Corrections that apply.**
   - The most specific come first: the asset, then the make and model, then the organisation.
   - Newest first within each.
   - At most 3 lines, then "and N more".
3. **Last time.**
   - The last job on this asset: the newest Execution, or, when there is none, the newest closed work order, giving its
     date, who did it, the readings against the spec at the time, and whether it was first time right.
   - The newest verified Finding on the asset or its sister assets (same template). In chat, the Finding takes the line
     when the last job recorded no reading.
4. **Open now.** Open issues on the asset (ISS-H04). Also, certificates that are expired or missing, but only for
   sensors flagged `needsCertificate`: the analysers named in a Requirement such as REQ-BD-CAL. DP-2's flow, pressure
   and stroke sensors are not flagged, so they raise no line.
5. **Watch-outs.** Knowledge notes on this procedure's steps: this asset first, then the same make and model. A note
   that repeats a Finding or Correction already shown is dropped.
6. **Changed since the last job here.** Spec versions, new issues and new notes.

**Sources and the record.**
- Each line links its source object on the page.
- In chat, the last line is `Reply "brief" for the full brief, "start step 1" to begin.`
- The brief is written as a `Brief` record (§4.6) before step 1 is sent.

**During the job.**
- The step prompt names the target: `Reply "done" with the delivery in L/h (target 128.3–141.8).`
- `complete_step` checks the reading against the confirmed Spec for that asset and measure, falling back to the Part
  band. It records `specId` and `specVersion` on the step.
- A change confirmed mid-job does not move the job. The job says once that the spec changed, and keeps the version it
  started with.

## 7. The seeded DP-2 case (synthetic data)

**The demo.** Musa Pretorius (P-032, fitter) is on WO-26044, "DP-2 losing prime intermittently". The job includes the
step 2 draw-down.

**Sources about DP-2 delivery**, all appended to the seed:

| # | Source | Says | Date | Authority | Grade |
|---|---|---|---|---|---|
| a | SOP rev C (Spec v1) | 100–140 L/h | 2025-02 | (the version 1 spec) | — |
| b | Drive: `Engineering/Specs/Riverbend coagulant dosing spec rev B.pdf`, signed by the owner | DP-1 and DP-2 delivery 120 L/h ±5% at 60% stroke | 2026-03-02 | client spec | EXTRACTED |
| c | Sheets: `Coagulant dose calc`, row DP-2 | 110 L/h | 2025-06-10 | spreadsheet | EXTRACTED |
| d | Drawing data sheet, tag 13QCA10AP002 | design 100 L/h | 2024-11 | drawing | EXTRACTED |
| e | Mail from P-001 to the works mailbox, "Coag dosing after the storm" | "run DP-2 at 135 L/h, ±5%, until raw turbidity settles" | 2026-10-13 | site manager instruction | INFERRED ("run at" means delivery) |
| f | Chat from the C-shift supervisor | "we've had DP-2 on 125 since the storm" | 2026-10-13 | person's report | EXTRACTED |
| g | Photo of a handwritten tag on the skid | "DP-2 1?5 L/h" | 2026-10-12 | person's report | AMBIGUOUS |

**Seed state:**
- **Spec v2 is already confirmed.** Before the seed's clock starts, the site manager confirmed b as Spec v2 (114–126
  L/h). The brief therefore has a real confirmed value with a real source.
- **At start-up, triage proposes v3:** 135 ±5%, from e. It passes over:
  - b: older, though higher authority. **My call:** a site manager's later written instruction outranks the older client
    spec, because the site manager is the one who confirms. The proposal says so.
  - c: lower authority, and older;
  - d: lower authority, and older;
  - f: lower authority;
  - g: unsure, so it goes to review.

**Earlier history.** A closed project, `PRJ-H2025-DOSE`, "Coagulant dosing upgrade" (2025), run by Synthetic Contractor
for the owner, left three corrections:
- **COR-H01** (scope `template` dosing_pump, Dosatec DM 400): "The DM 400 manual's stroke-to-delivery table is for 50 Hz;
  our drives run at 40 Hz. Check delivery by draw-down, never from the table."
- **COR-H02** (scope `orgId` Synthetic Contractor): "Their commissioning sheets give delivery in mL/min. Convert (×0.06)
  before comparing with L/h."
- **COR-H03** (scope `assetId` DP-1, from FND-003): "Loss of prime was the suction check-valve ball. Check the ball before
  the diaphragm." It reaches DP-2's brief as a sister-asset finding, not as a DP-2 correction.

**Expected brief for P-032 before confirmation** (chat, 8 lines or fewer):

> WO-26044 DP-2 losing prime intermittently. Before you start:
> Target: delivery at 60% stroke 114–126 L/h (owner spec rev B, confirmed by Precious Sithole). A newer value, 135 L/h, waits for her.
> Same model: check delivery by draw-down, never from the DM 400 table (40 Hz drives).
> Synthetic Contractor sheets give mL/min: ×0.06 for L/h.
> Last time: WO-26013 planned inspection in May, no readings. On DP-1, loss of prime was the suction ball. Check it first.
> Open: ISS-H04, no air-release valve on the DP-2 suction line.
> Step 2: air collects at the high point of the suction line; bleed it there (KN-H08).
> Reply "brief" for the full brief, "start step 1" to begin.

The builder confirms the last-job line against the seed; WO-26013's date and the absence of an Execution on DP-2 were
checked when this was written. KN-H07 is dropped because it repeats FND-003.

## 8. Screens

- **Brief panel**, on the work order and asset pages: the full brief, with its sources linked and the pending change
  marked in amber.
- **Specs tab**, on the asset page. For each measure it shows:
  - the confirmed band, its version, and who confirmed it;
  - its sources, with their grades;
  - its history;
  - any pending change;
  - a **Re-check sources** button.
- **Spec changes**, for the site manager: a section at the top of Proposals, plus a count on the console. Only P-001 can
  act on it. Each change shows:
  - the winning candidate beside every passed-over one, with the source text and its line;
  - **Confirm**, **Edit value** and **Reject (reason)**;
  - for each passed-over source, a "this source is wrong" tick with a scope picker (this asset, this make and model, or
    this organisation) and a one-line note. Ticking it makes a Correction.

  Unsure candidates sit underneath, under "Read these yourself".
- **Corrections list**, on the asset page and the project page. Inherited ones are marked "from PRJ-H2025-DOSE".

## 9. Journeys

- **J29, triage (P-001).**
  - Proposals → Spec changes shows "DP-2 delivery: 114–126 → 128.3–141.8 L/h".
  - The mail is the winner, and four sources are passed over with their reasons.
  - The handwritten tag is under "Read these yourself".
- **J30, the brief before confirmation (P-032).**
  - In chat, "start" gives the brief above, showing the confirmed 114–126 and the waiting 135.
  - Step 2 asks for the delivery, with target 114–126.
- **J31, confirm with a correction (P-001).**
  - Confirm, and tick the dose sheet (c) as wrong for this asset: "still the 2025 figure".
  - Spec v3 is written, and Correction COR-1 appears on DP-2.
  - As P-008 (supervisor), Confirm is refused.
- **J32, tested to the spec (P-032).**
  - A new job on DP-2 shows target 128.3–141.8, and COR-1.
  - Reporting 127 L/h at step 2 is out of band: "1.25 L/h under the band 128.25–141.75"; the screen may round to one decimal.
  - The execution records Spec v3.
- **J33, the next project inherits (P-001).** A new project for Synthetic Contractor on DP-1 shows COR-H02 on its page,
  and the brief for its first job carries it.
- **J34, Claude off.** J29–J32 work on text layers. The photo (g) stays unsure.

## 10. Build order

**One plan, on a new branch off `feat/phase3b-agent-studio`.** My call: this work uses the 3b connectors and the digester's
grading, and 3b is not merged yet.

1. **Model and seed.**
   - Spec, SpecCandidate, Correction, Organisation and Brief;
   - Spec v1 from the bands, plus the new delivery measure;
   - the DP-2 sources and the 2025 project history.
2. **Triage functions:** asset matching, value reading, units, ranking and deciding.
3. **Approval and the agent.**
   - `update_spec` and its approval;
   - Corrections from a confirmation;
   - reject memory;
   - agent 22, with its evals.
4. **The brief:** `jobBrief`, the Brief record, and the chat brief at start.
5. **Steps:** checked against the Spec, with the target in the step prompt.
6. **Screens:** the Brief panel, the Specs tab, Spec changes, and the Corrections list.
7. **Docs:** README journeys J29–J34, and BRD Appendix D rows.

## 11. Theirs: confirmed with Matthew

1. **First:** a briefing before calibration or testing, ahead of the other platform items.
2. **Sources:** all of them: client spec, email, drawing, spreadsheet and people. The system triages them down to one
   answer.
3. **Update:** automatic, with human confirmation.
4. **Who confirms:** the site manager.
5. **History:** corrections from previous projects on the same asset, client or company.

## 12. My calls (Matthew to check while reading)

1. **The authority ladder** in §5, including that a site manager's later written instruction outranks an older client
   spec.
2. **No backup confirmer.** While the site manager is away, a change waits, and the brief says so.
3. **"Wrong" versus "older".** Only a source the site manager marks wrong becomes a Correction. Being passed over is not
   enough.
4. **Correction scopes:** the asset, the make and model, or the organisation.
5. **A confirmed spec does not move the plant.** It sets what jobs test against.
6. **Brief length:** at most 8 chat lines, with the full brief one reply away.
7. **The demo** is the DP-2 coagulant pump, tied to the storm story the root-cause agent already tells.
8. **A Brief record for each job,** so root cause can ask what the person was told.
9. **The branch** comes off 3b, which is unmerged.
10. **Ranking:** the site manager's newest word wins; otherwise authority, then date (§5).
11. **Who sees what:** spec values and citations for anyone who can see the asset; source text only for those allowed to
    read the source (§4.2).
12. **Organisation corrections** reach an asset through any past project that touched it, and the owner's reach every job
    (§4.5).
13. **Value corrections block one value from one source; guidance corrections are brief text only** (§4.4).
14. **The delivery measure is per asset** (DP-1 and DP-2), so the chlorinators on the same template are untouched (§4.1).
15. **Temporary instructions do not lapse.** The condition is quoted in the brief (§4.3).

## 13. Left to the builder

- The exact text patterns for reading values, the unit table, and the asset-match threshold. They must be deterministic,
  and tested on the seeded sources.
- The synthetic text layers of the spec PDF, the drawing data sheet, the mail, the sheet rows and the photo.
- How `update_spec` stores `passedOver` on the Proposal.
- Card layouts within the NOVATEK design system.
- Which counts change in existing tests, ledgered.

## 14. Verification

**Unit tests:**
- asset matching: tag, KKS and name, and a two-asset tie giving unsure;
- value reading at every grade;
- unit conversion;
- the ranking ladder, and recency;
- a correction blocking its source;
- reject memory;
- only the site manager confirms;
- Spec versions and their history;
- a mid-job change does not move the job;
- `complete_step` against the Spec, and the fallback to the band;
- the brief: its order, its 8-line cap, the pending-change line, and clearance (a viewer never sees a source they cannot
  see).

**Other checks:**
- **Evals for agent 22,** as in §5.
- **Browser:** J29–J34.
- **Final review:** a whole-branch review as a workflow, as before.

## 15. Builder check: answered as my calls

A fresh builder read this document against the code. All seven questions were settled from the conversation and the
code, so none went back to Matthew:

1. **§5 and §7 disagreed on ranking.** Settled as call 10.
2. **How an organisation's corrections reach a job with no project.** Settled as call 12.
3. **What a technician may see.** Settled as call 11.
4. **The rules in §6 did not produce the text in §7.** §6 is now the oracle, with:
   - a line budget;
   - the last-job fallback;
   - certificates only for flagged sensors;
   - dedup of watch-outs.

   §7 was recomputed from those rules.
5. **What a correction blocks.** Settled as call 13.
6. **The chlorinators share the template.** Settled as call 14.
7. **Temporary instructions.** Settled as call 15.

Also noted: `resolve` checks clearance before the named approver, so a supervisor's refusal reads "insufficient
clearance" (§4.3).
