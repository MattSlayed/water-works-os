# Job Briefs and Spec Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a person calibrates or tests an asset, give them a short brief. It holds the spec management wants, any change waiting for confirmation, the corrections from earlier jobs and projects, and what went wrong last time. The specs behind the brief are triaged from mail, files, sheets, drawings and chat, and only the site manager confirms them.

**Architecture:**
- **Pure functions** in `src/specs.mjs` find the asset, read the value, convert units, rank the candidates and decide.
- **A default agent, "Spec Triage" (agent 22),** runs them over the synthetic connectors and proposes `update_spec`. The site manager is its named approver.
- **A deterministic `jobBrief`** in `src/brief.mjs` builds the brief from the viewer's own view.
- **At job start:**
  - `start_execution` pins the asset's specs and writes a `Brief` record;
  - `complete_step` checks readings against the pinned spec;
  - Chat Intake sends the brief.

**Tech Stack:** Node 22, zero dependencies, `node:test`, vanilla ES modules, and the in-memory ontology.

**Spec:** `docs/superpowers/specs/2026-10-24-job-brief-spec-triage-design.md` (approved 2026-10-24). This plan argues from it; read both.

## Global Constraints

- **Stack.** Node 22, zero dependencies, `node:test`, offline tests. `npm test` is green after every task.
- **The generator's existing random draws must not move.**
  - All new seed data goes after the 3b "How people work" block in `src/generate.mjs`, with fixed values and no `r()` calls.
  - `src/connectors/engineering.mjs` uses no rng.
- **Clearance.**
  - A brief is built from the viewer's own `ont.view(viewer)`.
  - Source *text* (mail body, file text, sheet cells) is shown only to a viewer who may read that source. That means the connector catalogue's `read` line for their role (`catalogueAllows`), or, for a chat Message, the Message's own audience.
  - Citations (title, kind, date, author) are shown to anyone who can see the Spec.
- **Who confirms.** Only the person with role `works_manager` (P-001) confirms a spec change or records a Correction. Every other person is refused.
- **The plant doesn't move.** A confirmed Spec never changes telemetry, a setpoint or a `SetpointRequest`.
- **Claude off.** Every flow works with no API key. Claude never chooses a value.
- **The chat brief** is at most 8 lines.
- **No gendered pronouns** for people in any copy: "waits for the site manager", never "waits for her".
- **Commits** end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01W6GcpDnBbSN7KtDkCEEoNC
  ```
- **Patching files.** Python patch scripts write with `newline=''`. Never use `git checkout` to undo a change to an uncommitted file.

## Decisions this plan makes

These are calls of mine, where the spec leaves a choice or its sample copy can't hold. Executors don't re-decide them.

1. **Pronouns.** Spec §7's "waits for her" becomes "waits for the site manager" (Global Constraints).
2. **The Open line** uses the issue title verbatim: `Open: ISS-H04, DP-2 suction line has no air-release valve.` Spec §7 left this to be confirmed against the seed.
3. **Triggers.** Spec Triage runs at server start, on each new plant day, and on demand (`POST /api/assets/:id/recheck-specs`). The synthetic stores don't change during a run, so "new mail" and "file lands" have no event to hang on. A chat message is picked up on the next run.
4. **Who it runs as.** Spec Triage runs as the site manager: `actingUser` is P-001 with role `works_manager`.
   - The catalogue already lets `works_manager` read `m365.mail` and `m365.files`, and `google.sheets` is open to all.
   - So no catalogue line changes, which is how the Recommender runs as each person.
5. **Source f's text** is "we've had DP-2 delivering 125 L/h since the storm", so it carries a unit. The spec's quote had none, and an unknown unit is unsure.
6. **`needsCertificate`** isn't a stored flag. It's `isAnalyser(sensor)`, the predicate Drop Pack already uses (`agents.mjs`, REQ-BD-CAL), moved to `src/functions.mjs` and shared.
7. **Corrections carry two texts:** a chat one-liner `line` (100 characters at most) and the full `text`.
8. **The chat start reply.**
   - When the brief has any section line, the reply to "start" is the brief. Step 1 comes on the next "start" (spec footer: `"start step 1"`), because Chat Intake already answers "start" during a running job with the current step.
   - With an empty brief, the old reply stays as it was.
   - The J8 test's step-1 assertion moves to that second reply.
9. **Ticking a source as wrong** calls the new human action `record_correction` after Confirm, not inside `resolve`. It is the same action the spec uses for corrections written from an issue or finding.
10. **Two-asset ties.** "Two assets close together" (spec §5) means a *name-only* fuzzy match that ties. A source naming several assets by tag or KKS (source b: "DP-1 and DP-2 …") gives one candidate per named asset.
11. **`PRJ-H2025-DOSE`** has `state: "closed"` and no footprint. The Region payload and the Projects side tab skip closed projects (one filter at `src/regionview.mjs:68`).

## Review Focus

1. **A rerun duplicates work.** Running Spec Triage twice, or on every plant day, must not create a second candidate for the same source and asset, nor a second open proposal for the same spec and value. *(Task 4: `triage is idempotent`)*
2. **A rejected value comes back.** After the site manager rejects a proposal, the next run doesn't propose the same value from the same source. A *different* value from that source still can. *(Task 4: `reject memory`)*
3. **A technician sees what they shouldn't.** P-032 sees "mail from Precious Sithole, 13 Oct" in the brief, the specs API and the Brief record, but never the mail's body text. *(Task 7: `a technician sees citations, not source text`)*
4. **A job moves under the person.** A spec confirmed while a job runs must not change that job's band. Old executions keep the version they were held to. *(Task 6: `a mid-job change does not move the job`)*
5. **A closed project leaks onto the map.** The historical `PRJ-H2025-DOSE` must not appear on the Region map or its Projects tab, and must not break the projects list. *(Task 2: `a closed project stays off the region`)*

---

### Task 1: Engineering sources in the synthetic connectors

**Files:**
- Create: `src/connectors/engineering.mjs`
- Modify: `src/connectors/index.mjs`
- Test: `test/specs-sources.test.mjs`

**Interfaces:**
- Produces:
  - `WORKS_MAILBOX = "works@riverbend.example"` and `DOSE_SHEET = "Coagulant dose calc!A1:F20"` (exported from `engineering.mjs`).
  - `seedEngineering() -> { messages[], files[], attachments: Map, sheets: { [range]: string[][] } }`.
  - `connectors.m365.mail.list(WORKS_MAILBOX)` returns the works messages. Each has `body: { contentType: "text", content }` and `from.emailAddress.address`.
  - `connectors.m365.files.list("Engineering")` returns the engineering driveItems. Each has an extra `attachmentId`.
  - `connectors.attachment("ATT-ENG-0n")` returns `{ id, name, contentType, quality, textLayer, createdDateTime }`.
  - `connectors.google.sheets.values(DOSE_SHEET)` returns `{ range, majorDimension: "ROWS", values }`.

**Exact seed (fixed values; the spec §7 table maps to these):**

| Spec row | Store and id | Content |
|---|---|---|
| b | file `DRV-ENG-01` `Riverbend coagulant dosing spec rev B.pdf` in `Engineering/Specs`, attachment `ATT-ENG-01` | textLayer lines: `RIVERBEND WATER BOARD` / `Coagulant dosing specification, revision B` / `Date: 2026-03-02` / `Signed: J. Molefe, for the owner` / `DP-1 and DP-2 delivery at 60% stroke: 120 L/h ±5%` / `Coagulant: polyaluminium chloride` |
| c | sheet `DOSE_SHEET` | rows `["Pump","Design dose mg/L","Flow ML/d","Delivery L/h","Updated","By"]`, `["DP-1","4.0","60","110","2025-06-10","P-002"]`, `["DP-2","4.0","60","110","2025-06-10","P-002"]` |
| d | file `DRV-ENG-02` `13QCA10 dosing data sheet.pdf` in `Engineering/Drawings`, attachment `ATT-ENG-02` | `INSTRUMENT AND EQUIPMENT DATA SHEET` / `Drawing: RB-P-130 rev 2` / `Date: 2024-11-20` / `Tag: 13QCA10AP001 design delivery 100 L/h` / `Tag: 13QCA10AP002 design delivery 100 L/h` |
| e | message `M365-WRK-001`, from `precious.sithole@riverbend.example` (Precious Sithole), subject `Coag dosing after the storm`, received `2026-10-13T16:40:00Z` | body `Team, run DP-2 at 135 L/h ±5% until raw turbidity settles. Precious` |
| — | message `M365-WRK-002`, from `noreply@riverbend.example`, subject `Canteen closed on Friday`, received `2026-10-12T08:00:00Z` | body `The canteen is closed on Friday for maintenance.` |
| g | file `DRV-ENG-03` `IMG_4410.jpg` in `Engineering/Site photos`, attachment `ATT-ENG-03`, quality `photo`, createdDateTime `2026-10-12T14:20:00Z` | textLayer `DP-2 delivery 1?5 L/h` |

Source f is a chat Message seeded in Task 2.

- [ ] **Step 1: Write the failing test**

```js
// test/specs-sources.test.mjs
test("the works mailbox, engineering folders and dose sheet hold the DP-2 sources", () => {
  const c = createConnectors({ nowIso: "2026-10-14T06:00:00Z" });
  const mail = c.m365.mail.list("works@riverbend.example");
  assert.deepEqual(mail.map((m) => m.id), ["M365-WRK-002", "M365-WRK-001"]);
  assert.match(mail[1].body.content, /run DP-2 at 135 L\/h ±5%/);
  assert.deepEqual(c.m365.files.list("Engineering").map((f) => f.attachmentId), ["ATT-ENG-01", "ATT-ENG-02", "ATT-ENG-03"]);
  assert.match(c.attachment("ATT-ENG-03").textLayer, /1\?5/);
  assert.equal(c.google.sheets.values("Coagulant dose calc!A1:F20").values[2][3], "110");
  assert.deepEqual(c.m365.mail.list("accounts@riverbend.example").length, createConnectors({ nowIso: "2026-10-14T06:00:00Z" }).m365.mail.list("accounts@riverbend.example").length);
});
test("the accounts mailbox and filing log are unchanged by the engineering seed", () => { /* accounts mail count 48, moves 57, as before */ });
```

The second test pins the counts the 3b tests already use. Read them from `test/connectors.test.mjs`, and don't invent new ones.

- [ ] **Step 2: Run** `node --test test/specs-sources.test.mjs`. **Expected:** FAIL. The works mailbox returns `[]`.

- [ ] **Step 3: Implement `seedEngineering()`** with the exact table. Wire it into `createConnectors`:
  - `mail.list` serves both mailboxes, sorted by `receivedDateTime`;
  - the engineering driveItems are added to `files`, without entering `moves`;
  - `attachment()` falls back to the engineering map;
  - `sheets.values(range)` returns the seeded rows for `DOSE_SHEET`, and `[]` otherwise.

- [ ] **Step 4: Run** `npm test`. **Expected:** all pass.

- [ ] **Step 5: Commit** with `feat(connectors): engineering sources for spec triage (works mailbox, specs and drawings folders, dose sheet)`.

---

### Task 2: Seed specs, corrections, organisations and the 2025 project

**Files:**
- Modify: `src/generate.mjs` (the new block after "How people work"), `src/functions.mjs`, `src/agents.mjs` (Drop Pack uses `isAnalyser`), `src/regionview.mjs:68`
- Test: `test/specs-seed.test.mjs`; update counts in `test/generate.test.mjs` if it counts all objects or types

**Interfaces:**
- Produces:
  - **`isAnalyser(sensor) -> boolean`** in `src/functions.mjs`: `!!s.processUnitId && /turb|cl|ph/.test(s.key) && !s.id.startsWith("SEN-RAW")`.
  - **`Spec`** with id `SPC-<positionTag>-<key>`:
    ```
    { type: "Spec", assetId, partName, step, key, measure, unit, lo, hi, target, condition, version, state: "confirmed",
      sourceRefs: [{ kind, id, title, at, authorId }], confirmedBy, confirmedAt, reason, history: [] }
    ```
    - `key` is the slug of the measure. For the delivery measure it is `delivery`.
    - `step` is the procedure step whose reading it governs, and `partName` is the Part the Reading targets.
  - **`Correction`** (`COR-H0n`):
    ```
    { type: "Correction", line, text, wrongSourceRef, wrongValue, rightValue, scope: { assetId } | { template } | { orgId },
      fromId, by: "P-001", at }
    ```
  - **`Organisation`:** `ORG-OWNER` "Riverbend Water Board" (owner), `ORG-SYNCON` "Synthetic Contractor (Pty) Ltd" (contractor), `ORG-DOSATEC` "Dosatec" (oem).
  - **Every Project** gains `clientOrgId: "ORG-OWNER"`. Projects with a `contractorEmployer` also gain `contractorOrgId: "ORG-SYNCON"`.

**Seed values:**

- **Spec v1 from today's bands.** One per Part with a `band`:
  - id `SPC-<tag>-<slug(band.measure)>`, with `partName`, the `step` that records it (from the procedure's `requires.reading.partName`), `lo`/`hi`/`unit`/`measure` from the band, and `target: null`;
  - `sourceRefs: [{ kind: "Document", id: <the SOP doc id>, title: "SOP revision C", at: "2025-02-01", authorId: "P-001" }]`;
  - `confirmedBy: "P-001"`, `confirmedAt: "2025-02-01T00:00:00Z"`, `reason: "From SOP revision C"`.
- **The DP-1 and DP-2 delivery specs** (`SPC-DP-1-delivery`, `SPC-DP-2-delivery`): `partName: "Dosing head"`, `step: 2`, `measure: "Delivery at 60% stroke"`, `unit: "L/h"`.
  - **Version 2, current:** `lo: 114`, `hi: 126`, `target: 120`.
    - `sourceRefs: [{ kind: "m365.files", id: "ATT-ENG-01", title: "owner spec rev B", at: "2026-03-02", authorId: null }]`;
    - `confirmedBy: "P-001"`, `confirmedAt: "2026-03-05T09:00:00Z"`, `reason: "Owner specification revision B"`.
  - **Version 1, in `history`:** `{ version: 1, lo: 100, hi: 140, target: null, sourceRefs: [SOP rev C], confirmedBy: "P-001", confirmedAt: "2025-02-01T00:00:00Z", reason: "From SOP revision C" }`.
- **`PRJ-H2025-DOSE`:**
  - "Coagulant dosing upgrade", `kind: "contract"`, `state: "closed"`;
  - `start: "2025-04-01"`, `end: "2025-07-31"`, `ownerId: "P-004"`;
  - `assetIds: [DP-1.id, DP-2.id]`, `assetId: DP-1.id`;
  - `clientOrgId: "ORG-OWNER"`, `contractorOrgId: "ORG-SYNCON"`, `contractorEmployer: "Synthetic Contractor (Pty) Ltd"`;
  - `milestones: []`, `channelId: null`, `autoSubmit: false`, no footprint.
- **COR-H01:**
  - scope `{ template: "dosing_pump" }`, `fromId: "PRJ-H2025-DOSE"`, `at: "2025-07-20T10:00:00Z"`;
  - line `Same model: check delivery by draw-down, never from the DM 400 table (40 Hz drives).`;
  - text: the spec §7 sentence;
  - `wrongSourceRef: { kind: "Document", id: "DOC-OEM-DOSING_PUMP" }`, `wrongValue: null`.
- **COR-H02:**
  - scope `{ orgId: "ORG-SYNCON" }`, `fromId: "PRJ-H2025-DOSE"`, `at: "2025-07-22T10:00:00Z"`;
  - line `Synthetic Contractor sheets give mL/min: ×0.06 for L/h.`;
  - `wrongValue: null`.
- **COR-H03:**
  - scope `{ assetId: DP-1.id }`, `fromId: "FND-003"`, `at: "2026-05-19T16:00:00Z"`;
  - line `loss of prime was the suction ball. Check it first.`;
  - `wrongValue: null`.
- **Source f:** a Message `MSG-H-SPEC1` in `CHN-P-010`, `direction: "in"`, `from: "P-010"`, `at: "2026-10-13T23:15:00Z"`, text `we've had DP-2 delivering 125 L/h since the storm`, `audience` the channel's.

- [ ] **Step 1: Write the failing tests**

```js
test("every banded part has a version 1 spec from the SOP", () => { /* count of Spec with version 1 and reason "From SOP revision C" === count of Part with band; SPC-HLP-A-de-bore-diameter lo 110 hi 110.035 */ });
test("DP-2 delivery is at version 2 from the owner spec, with version 1 in its history", () => {
  const s = createSystem(), sp = s.ont.get("SPC-DP-2-delivery");
  assert.deepEqual([sp.version, sp.lo, sp.hi, sp.step, sp.sourceRefs[0].title, sp.history[0].lo], [2, 114, 126, 2, "owner spec rev B", 100]);
});
test("the chlorinators get no delivery spec", () => { assert.equal(createSystem().ont.list("Spec", (x) => x.key === "delivery").length, 2); });
test("the 2025 dosing project, its corrections and the organisations are seeded", () => { /* PRJ-H2025-DOSE assetIds has DP-2; COR-H01..03 scopes as above; 3 Organisations; every Project has clientOrgId */ });
test("a closed project stays off the region", () => { /* regionPayload(sys, managerViewer).projects has no PRJ-H2025-DOSE; /api/projects still lists it */ });
test("Drop Pack's calibration gap is unchanged by isAnalyser", () => { /* dropPackEvidence REQ-BD-CAL detail equals the value before the refactor: hard-code the string read from the current run */ });
```

Before writing the HLP-A id, check the exact slug against the band's measure ("DE bore diameter" gives `de-bore-diameter`).

- [ ] **Step 2: Run** `node --test test/specs-seed.test.mjs`. **Expected:** FAIL, with no Spec objects.

- [ ] **Step 3: Implement the seed block** with fixed values, `isAnalyser`, Drop Pack's use of it, and the closed-project filter in `regionview.mjs`.

- [ ] **Step 4: Run** `npm test`. **Expected:** all pass. If a test counts objects or types, update its count and ledger it.

- [ ] **Step 5: Commit** with `feat(specs): seed specs from the bands, DP-2 delivery v2, organisations and the 2025 dosing corrections`.

---

### Task 3: Triage functions

**Files:**
- Create: `src/specs.mjs`
- Test: `test/specs.test.mjs`

**Interfaces:**
- Produces (all pure, no ontology writes):
  - **`tokens(text) -> string[]`:** lowercased matches of `/\p{L}+|[0-9]+/gu`.
  - **`matchAssets(text, assets) -> { assetId, matchedBy: "tag"|"kks"|"name", tie: boolean }[]`**
    - `assets` is `[{ id, positionTag, kks, name }]`.
    - **Tag:** the tag's token sequence appears contiguously (`dp`, `2`). Each tag or KKS hit gives its own row with `tie: false`.
    - **Name:** with no tag or KKS hit, the name is scored by token overlap ≥ 0.75. If the top two names score within 0.05 of each other, both get `tie: true`.
  - **`readValue(text, { measureKeys }) -> { key, lo, hi, target, unit, grade, condition, line } | null`**
    - Finds a number, or a `?`-bearing number, with a unit from `UNITS`, and optionally `± n` or `± n%`.
    - **Grade:** `AMBIGUOUS` if the number holds `?` or the unit is unknown. `INFERRED` if the measure was found only through a synonym. Otherwise `EXTRACTED`.
    - `condition` is the text after `until` up to the sentence end.
    - Returns null when no number sits within 6 tokens after the asset tag or measure word.
  - **`MEASURES = { delivery: { exact: ["delivery", "delivering"], synonyms: ["run at", "run", "dose rate", "output"] } }`.**
  - **`UNITS`** maps a unit to `{ to: canonical unit, factor }`: `"L/h": ["L/h", 1]`, `"mL/min": ["L/h", 0.06]`, `"mm": ["mm", 1]`, `"bar": ["bar", 1]`, `"NTU": ["NTU", 1]`, `"h": ["h", 1]`, `"%": ["%", 1]`.
  - **`AUTHORITY = ["client-spec", "oem", "drawing", "spreadsheet", "report"]`** runs from highest to lowest. `"manager"` is handled by rule 1 of `rank`.
  - **`authorityOf(source, people) -> "manager"|"client-spec"|"oem"|"drawing"|"spreadsheet"|"report"`.**
    - **manager:** mail or chat from the `works_manager`. Mail is matched by `from.emailAddress.address` against the person's name as `first.last@riverbend.example`.
    - **client-spec:** an `Engineering/Specs` file whose text has `^Signed:`.
    - **oem:** a Document of kind `manual`.
    - **drawing:** an `Engineering/Drawings` file.
    - **spreadsheet:** a sheet.
    - **report:** anything else (chat, notes, photos).
  - **`rank(candidates, { confirmed, corrections, rejected }) -> { winner, passedOver: [{ candidateId, reason }] }`.** The algorithm:
    1. Drop `AMBIGUOUS` candidates (reason `"unsure"`) and blocked ones (reason `"blocked by <COR id>"`).
       - **Blocked:** a value correction (`wrongValue != null`) whose scope covers the asset and whose `wrongSourceRef.id === c.source.id` and `wrongValue === (c.target ?? c.lo)`.
       - **Rejected:** a candidate matching `rejected` (`{ sourceId, lo, hi }`) is also dropped, reason `"rejected before"`.
    2. Let M be the newest `manager` candidate. Let T be the best of the others, by `AUTHORITY` index and then the newest `at`.
    3. The winner is M if `M.at > T.at` (or T is missing), and T otherwise.
    4. Reasons for the rest:
       - T loses to M: `"older than the site manager's instruction"`;
       - authority below T's: `"lower authority"`;
       - same authority as the winner but older (including older manager candidates): `"older"`.
  - **`decide(winner, confirmed, { ratedRange }) -> { kind: "agrees"|"propose", lo, hi, target, flag }`.**
    - **agrees:** the winner's target, or its midpoint, lies in `[confirmed.lo, confirmed.hi]`, and the winner has no band of its own or its band equals the confirmed one (rounded to 2 decimal places).
    - **A single value with no tolerance** takes the confirmed spec's relative half-width.
    - **flag:** `"outside the maker's rated range (0–400 L/h)"` when `ratedRange` is given and the band falls outside it.

- [ ] **Step 1: Write the failing tests** (the strings are the Task 1 seed texts):

```js
test("matching: tag, KKS, two named assets, and a name-only tie", () => {
  const A = [{ id: "A1", positionTag: "DP-1", kks: "13QCA10AP001", name: "Coagulant dosing pump 1" }, { id: "A2", positionTag: "DP-2", kks: "13QCA10AP002", name: "Coagulant dosing pump 2" }];
  assert.deepEqual(matchAssets("run DP-2 at 135 L/h", A).map((m) => [m.assetId, m.matchedBy]), [["A2", "tag"]]);
  assert.deepEqual(matchAssets("DP-1 and DP-2 delivery at 60% stroke: 120 L/h ±5%", A).map((m) => m.assetId), ["A1", "A2"]);
  assert.deepEqual(matchAssets("Tag: 13QCA10AP002 design delivery 100 L/h", A).map((m) => m.matchedBy), ["kks"]);
  assert.ok(matchAssets("the coagulant dosing pump is noisy", A).every((m) => m.tie));
});
test("reading values at every grade", () => {
  assert.deepEqual(pick(readValue("run DP-2 at 135 L/h ±5% until raw turbidity settles.", { measureKeys: ["delivery"] })), { lo: 128.25, hi: 141.75, target: 135, unit: "L/h", grade: "INFERRED", condition: "raw turbidity settles" });
  assert.equal(readValue("DP-1 and DP-2 delivery at 60% stroke: 120 L/h ±5%", {}).grade, "EXTRACTED");
  assert.equal(readValue("DP-2 delivery 1?5 L/h", {}).grade, "AMBIGUOUS");
  assert.equal(readValue("DP-2 delivery 125 gal/h", {}).grade, "AMBIGUOUS");
  assert.equal(readValue("Canteen closed on Friday", {}), null);
});
test("units: mL/min converts to L/h", () => { assert.equal(readValue("delivery 2000 mL/min", {}).target, 120); });
test("ranking: the site manager's newest word wins; the rest get their reasons", () => {
  /* candidates b(client-spec, 2026-03-02, 114–126), c(spreadsheet, 2025-06-10, 110), d(drawing, 2024-11-20, 100),
     e(manager, 2026-10-13T16:40, 128.25–141.75), f(report, 2026-10-13T23:15, 125), g(AMBIGUOUS) */
  assert.equal(r.winner.id, "e");
  assert.deepEqual(Object.fromEntries(r.passedOver.map((p) => [p.candidateId, p.reason])), { b: "older than the site manager's instruction", c: "lower authority", d: "lower authority", f: "lower authority", g: "unsure" });
});
test("ranking without a manager instruction: authority, then the newest", () => { /* b, c, d → winner b; c and d "lower authority" */ });
test("a value correction blocks one value from one source; a new value from it takes part again", () => { /* COR scope {assetId:"A2"}, wrongSourceRef c, wrongValue 110 → c "blocked by COR-1"; c with 112 → not blocked */ });
test("decide: agrees within the band, proposes otherwise, flags outside the rated range", () => { /* 120 vs 114–126 → agrees; 135±5% → propose 128.25–141.75; 450 with ratedRange [0,400] → flag */ });
```

- [ ] **Step 2: Run** `node --test test/specs.test.mjs`. **Expected:** FAIL (module not found).

- [ ] **Step 3: Implement `src/specs.mjs`** to the interfaces above.

- [ ] **Step 4: Run** `node --test test/specs.test.mjs` and then `npm test`. **Expected:** both pass.

- [ ] **Step 5: Commit** with `feat(specs): triage functions (asset matching, values, units, ranking, decide)`.

---

### Task 4: `update_spec`, `record_correction` and the Spec Triage agent

**Files:**
- Modify: `src/actions.mjs`, `src/agents.mjs`, `src/harness.mjs` (`specFromManifest`), `src/evals.mjs`, `src/server.mjs`
- Test: `test/spec-triage.test.mjs`. Change the counts in `test/agents.test.mjs:11`, `test/rca.test.mjs:94` and `test/recommend.test.mjs:79` from 21 to 22.

**Interfaces:**
- Consumes: Task 3's `matchAssets`, `readValue`, `authorityOf`, `rank` and `decide`. Task 1's connectors. Task 2's seed.
- Produces:
  - **`update_spec`:** `def("act", "propose", ["specId", "lo", "hi"], apply, "manager")`.
    - Params: `{ specId, lo, hi, target, unit, condition, candidateId, why, passedOver: [{ candidateId, title, value, reason }] }`.
    - Apply needs `confirmer = ctx.approvedBy || actorId(ctx)` with role `works_manager`. Otherwise it throws `only the site manager confirms a spec`.
    - It writes `version + 1`, pushes the old version onto `history`, and sets `sourceRefs` to the winning candidate's source, `confirmedBy` to the confirmer and `reason` to `why`.
    - It marks the candidate `approved`.
    - Revert restores the previous version.
  - **`record_correction`:** `def("act", "human", ["line", "scope"], apply)`.
    - Params: `{ line, text, scope, wrongSourceRef, wrongValue, rightValue, fromId }`.
    - Same site-manager check, error `only the site manager records a correction`.
    - Creates `COR-<n>` through `nextId("COR")`.
  - **`SpecCandidate`**, id `SCD-<source id>-<positionTag>`:
    ```
    { type: "SpecCandidate", subject, specId, key, lo, hi, target, unit, condition,
      source: { kind, id, line, at, authorId, title, text }, authority, grade, matchedBy,
      status: "suggested"|"approved"|"rejected", minClearance: "engineer" }
    ```
    `source.text` is the matched line only.
  - **The manifest:**
    ```js
    v({ name: "Spec Triage", purpose: "Read mail, files, sheets, drawings and chat for asset specs; propose one answer for the site manager to confirm",
        trigger: { kind: "schedule", every: "each plant day" }, tools: ["update_spec"], autonomy: { update_spec: "propose" },
        approver: "P-001", reads: [{ source: "connector:m365.mail" }, { source: "connector:m365.files" }, { source: "connector:google.sheets" }] })
    ```
    `specFromManifest` takes `m.approver` (defaulting to `{ clearanceOf: "action" }`) and appends `m.reads` to the default reads.
  - **The logic** runs over `scope.assetId` when given, otherwise over every asset with a Spec.
    - It gathers candidates from the works mail bodies, the `Engineering` files' text layers, the dose sheet rows (the header gives measure and unit; the row's first cell is the tag) and the chat Messages it can see.
    - It upserts candidates by id.
    - For each spec it ranks the candidates and decides. On `propose`, it calls `ctx.act("update_spec", …)` unless an open proposal for that `specId` with the same `lo`/`hi` exists.
    - It records `rejected` from Proposals of `update_spec` in state `rejected` (`{ sourceId, lo, hi }`).
    - `ratedRange` is the `range` of the asset's Sensor whose unit equals the spec's unit.
  - **The server** runs it as the site manager after `recommendAll()` at start, and again with `recommendAll()` on each new plant day:
    ```js
    runtime.run("Spec Triage", { actingUser: { id: sm.id, kind: "person", clearance: sm.clearance, role: sm.role }, chain: false, trigger: { kind: "schedule" } })
    ```
    It also adds `POST /api/assets/:id/recheck-specs`, which runs it with `scope: { assetId }` and returns `{ runId, proposals }`.

- [ ] **Step 1: Write the failing tests**

```js
const SM = { id: "P-001", kind: "person", clearance: "manager", role: "works_manager" };
const triage = (s, scope) => s.runtime.run("Spec Triage", { actingUser: SM, chain: false, scope });
test("J29: triage proposes DP-2 delivery 128.25–141.75 from the mail and passes over four", () => {
  const s = createSystem(); triage(s);
  const p = s.ont.list("Proposal", (x) => x.action === "update_spec" && x.state === "open");
  assert.deepEqual(p.map((x) => [x.params.specId, x.params.lo, x.params.hi, x.approver]), [["SPC-DP-2-delivery", 128.25, 141.75, "P-001"]]);
  assert.deepEqual(p[0].params.passedOver.map((x) => x.reason).sort(), ["lower authority", "lower authority", "lower authority", "older than the site manager's instruction"]);
  assert.equal(s.ont.get("SCD-ATT-ENG-03-DP-2").grade, "AMBIGUOUS");
});
test("DP-1 agrees with its owner spec, so it gets no proposal", () => { /* no open update_spec for SPC-DP-1-delivery */ });
test("triage is idempotent", () => { /* triage twice → still one open proposal, candidate count unchanged */ });
test("only the site manager confirms; a supervisor and another manager are refused", () => {
  /* resolve as P-008 → refused "insufficient clearance"; as a second manager-clearance person (upsert a temp Person with role "works_planner", clearance "manager") → refused "waiting for P-001";
     as P-001 approve → Spec v3 lo 128.25, confirmedBy P-001, history length 2, condition "raw turbidity settles" */
});
test("reject memory: a rejected value is not proposed again; a different value from the same source is", () => { /* reject with reason; triage → no open proposal; change the mail body value to 130 (fixture) → proposal again */ });
test("record_correction is the site manager's alone and blocks the sheet's 110 on DP-2", () => { /* as P-008 refused; as P-001 with scope {assetId: DP-2}, wrongSourceRef {kind:"google.sheets", id:"Coagulant dose calc!A1:F20#3"}, wrongValue 110 → COR-1; next triage passes over c with "blocked by COR-1" */ });
test("evals for Spec Triage pass", async () => { /* runEvals(createSystem, "Spec Triage") all pass */ });
```

The sheet row's source id is `<range>#<row number, 1-based>`. For DP-2 that is `Coagulant dose calc!A1:F20#3`. The reject-memory test changes the mail body through a fixture connector made with `createConnectors` overrides. If the 3b tests have no override hook, add a `sources` option to `seedEngineering(over)`, used only by tests, and ledger it.

**Evals** go in `EVALS["Spec Triage"]`, rule-graded:
- proposes 135 ±5% for DP-2;
- the photo never becomes a proposal;
- a blocked source never wins;
- a name-only tie goes to review (a candidate with grade AMBIGUOUS, and no proposal);
- it never confirms its own proposal (`resolve` as `{ kind: "agent", id: "Spec Triage" }` is refused).

- [ ] **Step 2: Run** `node --test test/spec-triage.test.mjs`. **Expected:** FAIL, with an unknown agent.

- [ ] **Step 3: Implement** the actions, the manifest and logic, `specFromManifest`, the evals and the server runs and route.

- [ ] **Step 4: Run** `npm test`. **Expected:** all pass. Ledger the 21 → 22 count changes.

- [ ] **Step 5: Commit** with `feat(specs): Spec Triage agent 22, update_spec for the site manager, corrections and reject memory`.

---

### Task 5: `jobBrief`

**Files:**
- Create: `src/brief.mjs`
- Test: `test/brief.test.mjs`

**Interfaces:**
- Consumes: Task 2's Spec, Correction and Organisation; Task 4's open `update_spec` Proposals.
- Produces:
  - **`correctionsFor(view, asset, workOrder) -> Correction[]`.** Scope reach follows spec §4.5:
    - the asset;
    - its template;
    - an org of any Project whose `assetIds` includes the asset, or of the work order's project;
    - `ORG-OWNER`.

    Sorted by asset, then template, then org; newest first within each.
  - **`jobBrief(view, workOrderId, { now }) -> { lines: string[], full: { target, corrections, lastTime, open, watchOuts, changed }, specVersions: [{ specId, version }], correctionIds: string[] }`.**
    - Each `full` section is `[{ text, refs: string[] }]`.
    - `lines` is empty when every section is empty.
    - **Chat lines, in order:**
      1. header `${wo.id} ${wo.title}. Before you start:`;
      2. one target line (the first spec the procedure records);
      3. up to two correction lines;
      4. one last-time line;
      5. one open line;
      6. one watch-out line;
      7. the footer `Reply "brief" for the full brief, "start step 1" to begin.`
  - **Target line, confirmed:** `Target: ${lowerFirst(measure)} ${lo}–${hi} ${unit} (${source title}, confirmed by ${name}).`
    - When an open `update_spec` exists for that spec, it adds ` A newer value, ${target ?? lo–hi} ${unit}, waits for the site manager.`
    - The full brief adds the pending source and date.
    - Numbers are printed as stored, with no rounding.
  - **Last-time line:**
    - With a last Execution: `Last time: ${date} by ${name}, ${n} reading(s), ${first time right | not first time right}.`
    - Otherwise, from the newest closed WorkOrder: `Last time: ${wo.id} ${lowerFirst(title before ":")} in ${Month}, no readings.`
    - Either way, it adds ` On ${sister tag}, ${line of the Correction whose fromId is that Finding, else the Finding text}` for the newest verified Finding on a sister asset.
  - **Open line:** `Open: ${issue.id}, ${issue.title}.` (the newest open issue on the asset). Analyser certificates come in only through `isAnalyser` sensors on the asset.
  - **Watch-out line:** `Step ${n}: ${lowerFirst(text without the final ".")} (${note.id}).`
    - This asset's notes come first, then the same template's.
    - A note on a sister asset is dropped when the Finding or Correction already shown has the same `assetId` and `partId`.
  - **Source text** is never put in `lines` or `full`. Only titles, dates and names are.

- [ ] **Step 1: Write the failing tests**

```js
const P032 = { id: "P-032", kind: "person", clearance: "technician", role: "fitter" };
test("J30: the DP-2 brief before confirmation is exactly the spec's eight lines", () => {
  const s = createSystem(); triage(s);
  assert.deepEqual(jobBrief(s.ont.view(P032), "WO-26044", { now: s.tel.now() }).lines, [
    "WO-26044 DP-2 losing prime intermittently. Before you start:",
    "Target: delivery at 60% stroke 114–126 L/h (owner spec rev B, confirmed by Precious Sithole). A newer value, 135 L/h, waits for the site manager.",
    "Same model: check delivery by draw-down, never from the DM 400 table (40 Hz drives).",
    "Synthetic Contractor sheets give mL/min: ×0.06 for L/h.",
    "Last time: WO-26013 planned inspection in May, no readings. On DP-1, loss of prime was the suction ball. Check it first.",
    "Open: ISS-H04, DP-2 suction line has no air-release valve.",
    "Step 2: air collects at the high point of the suction line; bleed it there (KN-H08).",
    "Reply \"brief\" for the full brief, \"start step 1\" to begin."
  ]);
});
test("without a pending change the target line has no waiting clause", () => { /* no triage run → line 2 ends "confirmed by Precious Sithole)." */ });
// each test file defines its own triage(s) helper, as in Task 4
test("the full brief holds all sections and refs, and caps corrections at three plus a count", () => { /* add 3 template corrections → full.corrections has 3 items and a 4th "and 2 more" */ });
test("after a confirmation the full brief lists what changed since the last job", () => { /* approve v3 → full.changed has an item whose refs include "SPC-DP-2-delivery" and text matching /v3/ */ });
test("an asset with nothing to say gives an empty brief", () => { /* a work order on a filter (no template) → lines [] */ });
test("a technician's brief never holds source text", () => { assert.ok(!JSON.stringify(jobBrief(view, "WO-26044", {}).full).includes("Team, run DP-2")); });
```

- [ ] **Step 2: Run** `node --test test/brief.test.mjs`. **Expected:** FAIL (module not found).

- [ ] **Step 3: Implement `src/brief.mjs`.**

- [ ] **Step 4: Run** `npm test`. **Expected:** all pass.

- [ ] **Step 5: Commit** with `feat(brief): jobBrief — target, corrections, last time, open, watch-outs`.

---

### Task 6: Specs at job start and on each step; the brief in chat

**Files:**
- Modify: `src/actions.mjs` (`start_execution`, `complete_step`, `openExecution` if the pins belong there), `src/agents.mjs` (Chat Intake), `src/parse.mjs`
- Test: `test/spec-jobs.test.mjs`, and update `test/channels.test.mjs` J8's first assertions

**Interfaces:**
- Consumes: Task 5's `jobBrief`; Task 2's Spec.
- Produces:
  - **`Execution.specPins: [{ specId, version, step, partName, measure, unit, lo, hi }]`**, written at start from the asset's Specs.
  - **`readingNeed(ont, ex, procStep) -> { partName, measure, unit, lo, hi, specId, specVersion } | null`** in `src/brief.mjs`.
    - It uses the pin for `procStep.step` first.
    - It falls back to `procStep.requires.reading` with the Part band (`specId: null`).
  - **`complete_step`** uses `readingNeed`. It checks `bandCheck({ band: { lo, hi, measure, unit } }, value)` and records `specId` and `specVersion` on the step.
  - **The Brief record.** `start_execution` writes a `Brief` (`BRF-<n>`):
    ```
    { executionId, workOrderId, assetId, personId, at, specVersions, correctionIds, lines,
      audience: [person, supervisorId, "P-001"] }
    ```
    It is built from `ont.view(person)` and returned in `objects`.
  - **The spec notice.** When `complete_step` first finds a confirmed Spec newer than a pin, it sets `Execution.specNotice = { specId, from, to, atStep }`, once.
  - **Chat Intake.**
    - **On "start":** if `jobBrief(...).lines.length`, it says the lines joined by `\n`. Otherwise it keeps today's reply.
    - **Step prompts** with a need say `Reply "done" with the ${measure} in ${unit} (target ${lo}–${hi}).`
    - **New kind `brief`:** `parse.mjs` adds `^brief\b` to `COMMAND` and `hit("brief", 0.9)`. It replies with every `full` item's text, one per line, or `No job is running. Reply "start" first.`
    - **The notice.** After a "done" whose step equals `specNotice.atStep`, it adds ` The spec for ${measure} changed to v${to} after you started; this job keeps v${from}.`

- [ ] **Step 1: Write the failing tests**

```js
test("J30 in chat: start sends the brief; start step 1 then gives step 1 with the target", async () => {
  /* P-032 chat "start WO-26044" → replies[0].text split by \n equals Task 5's 8 lines;
     a Brief exists for the execution with specVersions [{specId:"SPC-DP-2-delivery",version:2}] and audience ["P-032","P-008","P-001"];
     permit + isolation for DP-2 as J8 does; "start step 1" → /Step 1\/4/; after step 1 "done", the step 2 prompt matches /target 114–126/ */
});
test("J32: after confirmation a new job tests to v3 and 127 L/h is out of band", async () => {
  /* triage, approve as P-001, start a new WO on DP-2 for P-032 (create_work_order + assign), step 2 "done 127" →
     reply matches /1\.25 L\/h under the band 128\.25–141\.75/; step.specVersion === 3 */
});
test("a mid-job change does not move the job", async () => {
  /* start on v2, approve v3 mid-job, step 2 "done 120" → inBand true against 114–126, step.specVersion 2, reply includes "changed to v3 after you started; this job keeps v2" */
});
test("old executions keep the version they were held to", () => { /* the J32 execution's step still says specVersion 3 after a v4 is confirmed */ });
test("a step with no spec falls back to the part band", () => { /* HLP-A step 7 reading checked against PRT band; specId null — or the v1 Spec: assert whichever readingNeed returns and that inBand matches bandCheck */ });
test("brief in chat with no job running", async () => { /* "brief" → No job is running */ });
```

In J8 (`test/channels.test.mjs:26-27`), assert the brief on `replies[0]`, then `await t.say("start")` and assert `Step 1/11` and `permit` on that reply. Ledger the change.

- [ ] **Step 2: Run** `node --test test/spec-jobs.test.mjs`. **Expected:** FAIL. The start reply has no brief.

- [ ] **Step 3: Implement** the pins, `readingNeed`, the step checks, the Brief record, the spec notice, the Chat Intake changes and the parse kind.

- [ ] **Step 4: Run** `npm test`. **Expected:** all pass.

- [ ] **Step 5: Commit** with `feat(brief): the brief at job start, specs pinned per job, readings tested to the confirmed spec`.

---

### Task 7: API and screens

**Files:**
- Modify: `src/server.mjs`, `web/app.js`, `web/styles.css`
- Test: `test/specs-api.test.mjs`; add the string checks in the style of `test/web.test.mjs`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces (routes):
  - **`GET /api/workorders/:id/brief`** returns `{ lines, full }` from `jobBrief(ont.view(v), id)`. A work order the viewer can't see gives 404.
  - **`GET /api/assets/:id/specs`** returns `{ specs: [{ ...spec, pending, sources }], corrections, candidates }`.
    - `sources` and `candidates` carry `text` only when `canReadSource(v, source)` allows it. It is the 3b check from `src/actions.mjs`, extended with chat Messages, which use their audience.
    - `candidates` are visible to engineer and above only, because the objects' `minClearance` is engineer.
  - **`GET /api/projects/:id`** adds `corrections`. These are the Corrections scoped to its orgs, or to its assets, marked `inheritedFrom` when `fromId` is another project.
- `POST /api/copilot/:id/ask` answers a question matching `/^brief me on (S+)/i` with the brief for that asset's newest open work order (`lines` joined), from the asker's view.
- **Screens in `web/app.js`:**
  - **Brief panel** on the asset page (for the newest open work order on the asset) and on a WorkOrder's object page. Each `full` section is a list with linked refs, and the pending clause is marked `class="amber"`.
  - **Specs tab** on the asset page. For each spec it shows the band, version, who confirmed it, the sources with their grades, the history and any pending change, plus a **Re-check sources** button that calls the Task 4 route.
  - **Spec changes** at the top of `views.proposals`, for `update_spec` proposals. Each shows the winner beside the passed-over candidates (with source text where the API sent it).
    - **Confirm** calls resolve with approve.
    - **Edit value** calls resolve with edit, `lo`/`hi` and a reason.
    - **Reject** needs a reason.
    - For each passed-over source there is a "this source is wrong" checkbox with a scope `<select>` (this asset / this make and model / this organisation) and a one-line note. On Confirm, each ticked row posts `record_correction`.
    - Only P-001 sees the buttons. Others see the section read-only.
    - "Read these yourself" lists the AMBIGUOUS candidates.
  - **Console count:** "Spec changes waiting: N", shown to managers.
  - **Corrections list** on the asset and project pages, with inherited ones marked "from PRJ-H2025-DOSE".

- [ ] **Step 1: Write the failing tests**

```js
test("a technician sees citations, not source text", async () => {
  /* as P-032 (x-acting-user): GET /api/assets/<DP-2>/specs → specs[0].pending.sourceTitle "Coag dosing after the storm", no "Team, run DP-2" anywhere; candidates [] ;
     as P-001 the same route includes the mail body line */
});
test("the brief route follows the viewer's view", async () => { /* P-032 gets 8 lines for WO-26044; a WO in a zone above technician → 404 */ });
test("recheck runs triage for one asset", async () => { /* POST /api/assets/<DP-2>/recheck-specs → proposals length 1 */ });
test("the project page lists its inherited corrections", async () => { /* GET /api/projects/PRJ-H2025-DOSE → corrections ids include COR-H01, COR-H02 */ });
test("J33: a new Synthetic Contractor project on DP-1 inherits COR-H02", async () => { /* upsert a Project with contractorOrgId ORG-SYNCON, assetIds [DP-1] → GET /api/projects/<id> corrections include COR-H02 with inheritedFrom "PRJ-H2025-DOSE" */ });
test("the Copilot answers brief me on DP-2", async () => { /* open a copilot session as P-032, ask "brief me on DP-2" → answer includes "Target: delivery at 60% stroke" */ });
test("screens: brief panel, specs tab, spec changes with wrong-source ticks", () => {
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  for (const s of ["/brief", "/specs", "recheck-specs", "record_correction", "Read these yourself", "this make and model", "Spec changes waiting"]) assert.ok(app.includes(s), s);
});
```

- [ ] **Step 2: Run** `node --test test/specs-api.test.mjs`. **Expected:** FAIL (404 on the new routes).

- [ ] **Step 3: Implement** the routes and screens.

- [ ] **Step 4: Run** `npm test`. **Expected:** all pass.

- [ ] **Step 5: Commit** with `feat(web): brief panel, specs tab, spec changes for the site manager, corrections lists`.

---

### Task 8: Docs, and the browser walk

**Files:**
- Modify: `README.md` (feature rows, journeys J29–J34, test count), `../README.md` (plan link), `../02-BRD-Water-Works-OS.md` (v0.6, Appendix D rows 24–25)

**What to write:**
- **README journeys:** J29–J34, as spec §9 gives them, with the Task 6 copy ("waits for the site manager").
- **BRD Appendix D, row 24:** specs, triage and corrections are kept per asset in the ontology, and triaged from synthetic sources with a site-manager-only confirmation. Before, bands were per SOP template.
- **BRD Appendix D, row 25:** the job brief is a deterministic summary in chat and on the work order, recorded per job. Before, there was no pre-job brief.
- **Plan link:** add this plan's row to the `../README.md` plan table.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run** `npm test`, and put the real count into README.
- [ ] **Step 3: Browser walk.** Start `node src/server.mjs 8830` and walk J29–J34 with Playwright. Take viewport screenshots into `../.playwright-mcp/`, and fix what the walk finds, each fix with a test. Then stop the server.
- [ ] **Step 4: Commit** with `docs: job briefs and spec triage (Phase 3, project 4)`.
