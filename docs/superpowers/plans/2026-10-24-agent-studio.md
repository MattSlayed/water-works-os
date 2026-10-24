# Agent Studio, Connectors, Document Digester and Recommendations Implementation Plan (3b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-technical person describe an agent in words and get a safe, readable, replayed agent built only from connectors IT lets their role use. The first agent is the document digester. A Recommender (agent 21) suggests agents from how each person works.

**Architecture:**
- **`src/connectors/`** (new) holds synthetic Microsoft 365, Google Workspace and ERP stores with the real APIs' resource shapes, seeded deterministically. The CMMS is the existing ontology.
- **`Connector` records** in the ontology are IT's catalogue: per action, the roles, the highest level and whether IT sign-off is needed.
- **`src/digest.mjs`** (new) is the deterministic digester: extract graded cells from a document's text layer, three-way match, duplicate and bank-change checks, and the filing destination learnt from history.
- **`src/studio.mjs`** (new):
  - the rule / agent / person screen;
  - the keyword planner for the five templates;
  - validating a statement against the catalogue;
  - read-back that round-trips;
  - replay over 14 days.
- **`src/templates.mjs`** (new) holds the run logic for each template.
- **`src/recommend.mjs`** (new) holds the Recommender's signals.
- Studio agents are `AgentSpec` records (plan 3a) with a `builderId`. They run as their builder and are gated by plan 3a's harness inside `actions.invoke`.

**Tech Stack:** Node 22, zero runtime dependencies, `node:test`, vanilla ES modules.

**Spec:** `docs/superpowers/specs/2026-10-24-agent-harness-studio-design.md` (§2 goals S, C, D, E and anti-goals; §6–§10; §11 J25–J28; §14 calls 1–10; §14a; §16)

## Global Constraints

- Zero runtime dependencies. Every flow works without `ANTHROPIC_API_KEY`. With it, Claude only drafts statements and reads document images, both validated against closed schemas. The studio says "Claude is off" when it is.
- Connectors are synthetic and never touch the network. Tests never touch the network.
- **An agent can never do more than its builder.** A studio agent runs as its builder, whoever triggers it, and reads only the sources in its `reads`.
- **Shadow by default.** Every studio and recommended agent starts in `shadow`. Promotion is on evidence and needs a second person, never on elapsed time.
- **Money is `propose` at most** (plan 3a's `money-propose`). A bank-detail change always goes to a person.
- **IT sign-off:** one IT administrator (`itAdmin: true` on Person, independent of clearance) approves a catalogue line. A studio agent cannot be promoted out of shadow while any of its tools waits for sign-off.
- **People are never ranked or compared.** A suggestion is seen by its person only, plus that person's supervisor for approval-delay signals. What a person views is never recorded.
- **Dismissal** suppresses that signal for that person for 30 days.
- **Replay** looks back 14 days. **Three-way match tolerance:** 2% by default, set by the builder.
- Nothing persists to disk. The server stays on localhost. Python patch scripts write with `newline=''`.
- Commits end with the two attribution lines.
- **New people go at the end of `generateWorks`, after every seeded random draw,** so no existing seeded value moves:
  - P-043 Lerato Khumalo, `accounts_clerk`, clearance operator;
  - P-044 Thandi Mokoena, `finance_officer`, clearance supervisor;
  - P-045 Ayanda Mthembu, `it_admin`, clearance operator, `itAdmin: true`.

  Each gets a `CHN-P-04x` chat channel, as other people have.

## Review Focus

1. **A manager triggers the clerk's agent.** Expected: it still reads and writes only as the clerk would. No intake from a mailbox the clerk cannot use appears. Owner: Task 7.
2. **An invoice with changed bank details that otherwise matches its PO perfectly.** Expected: never filed or posted. An issue goes to the finance officer. Owner: Task 4.
3. **A read-back sentence edited into something the catalogue forbids** (for example "It may post invoice match without asking"). Expected: refused with the catalogue's reason, and the statement unchanged. Owner: Task 6.
4. **A dismissed suggestion whose signal grows the next day.** Expected: still suppressed until 30 days after the dismissal. Owner: Task 8.
5. **A mail with no attachment, or an attachment with no text layer while AI is off.** Expected: no crash. Every field is graded `AMBIGUOUS` with the reason "no text layer", and the document goes to review. Owner: Task 3.

---

### Task 1: Synthetic connectors

**Files:**
- Create: `src/connectors/index.mjs` (`createConnectors`), `src/connectors/seed.mjs` (the seeded mail, files and ERP data)
- Modify: `src/system.mjs` (`sys.connectors`)
- Test: `test/connectors.test.mjs` (new)

**Interfaces:**
- Produces: `CONNECTOR_KINDS = ["m365.mail", "m365.files", "m365.teams", "google.mail", "google.drive", "google.sheets", "erp", "cmms"]`.
- Produces: `createConnectors({ seed, start, nowIso }) -> connectors`, with these stores:
  - `m365.mail.list(mailbox, { since }) -> Graph message[]`. A message is `{ id, subject, from: { emailAddress: { address, name } }, receivedDateTime, hasAttachments, attachments: [{ id, name, contentType, size, textLayer, quality }] }`. `quality` is `"clean" | "photo" | "smudged"`; `textLayer` is a string, or null for an image with no text layer.
  - `m365.files.list(path) -> driveItem[]` (`{ id, name, parentReference: { path }, createdBy: { user: { id } }, createdDateTime, file: { mimeType } }`), `m365.files.copy(attachmentId, path, { by, at }) -> driveItem`, `m365.files.remove(itemId)`, and `m365.files.moves() -> [{ itemId, path, by, at, sourceId }]` (the filing log).
  - `m365.teams.post(channel, text)` and `google.mail.list`, `google.drive.list`, `google.sheets.values(range)`: thin stores with the real shapes and little or no seed data.
  - `erp.purchaseOrders()`, `erp.goodsReceipts()`, `erp.invoices()`, `erp.suppliers()`, `erp.postMatch({ invoice, poId, by, at }) -> SupplierInvoice`, `erp.unpost(id)`.
  - `attachment(id) -> attachment | null` across sources. A chat photo is an attachment whose id appears in a `Message.media` entry. One is seeded: a photographed invoice from P-043 on `CHN-P-043` two days before the clock.
  - `traps -> { duplicate, smudged, noPo, overPo, bankChange }` (message ids).
- **Seed** (deterministic per seed, ending at the clock 2026-10-14T06:00Z), with mailbox `accounts@riverbend.example`:
  - **8 suppliers**, each with `bank: { account, branch }`.
  - **40 POs** `PO-2026-0301`…`PO-2026-0340`, with goods receipts for 36 of them.
  - **48 mails over 30 days:** 38 invoices (PDF or photo), 6 delivery notes and 4 irrelevant messages.
  - **The 14 days before the clock** hold 25 invoices, all filed by P-043:
    - the **duplicate** (same supplier, number and total as an earlier invoice);
    - the **smudged photo** (total unreadable);
    - **no PO number**;
    - **a total 6% over its PO**.
  - **Days 15–30** hold 13 invoices. Twelve were filed by P-043. The **bank-change** invoice (new account number) was not filed; it has an open Issue "Supplier query: bank details changed".
  - **SharePoint** holds `Accounts/Supplier invoices/<supplier>/2026-09/` with 20 September invoices, plus the 37 October filings in the move log (`by: "P-043"`).

- [ ] **Step 1: Write the failing tests** (`test/connectors.test.mjs`):
  - Every kind in `CONNECTOR_KINDS` except `cmms` has a store.
  - The accounts mailbox has 48 messages, every one with `receivedDateTime <= 2026-10-14T06:00:00Z`.
  - The 14-day window holds exactly 25 invoices, and `m365.files.moves().filter(in window)` has 25 entries by P-043.
  - Each of the five traps can be found by its marker (`connectors.traps.duplicate`, `.smudged`, `.noPo`, `.overPo`, `.bankChange` hold the message ids). The smudged attachment's `quality` is `"smudged"`; the bank-change attachment's `textLayer` carries an account number different from `erp.suppliers()`.
  - Seeds 7 and 7 give deep-equal mail; seeds 7 and 8 differ.
  - `createConnectors` never calls `fetch` (the test stubs `globalThis.fetch` to throw).
- [ ] **Step 2:** `node --test test/connectors.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** with the repo's seeded random generator (the one `generate.mjs` uses), and a text-layer format the digester parses line by line:
  - `Supplier: …`, `Invoice No: INV-…`, `Date: yyyy-mm-dd`, `PO: PO-2026-03xx` (absent for the no-PO trap);
  - one line per item, `Item: <desc> | <qty> | <unit price>`;
  - `VAT: R …`, `Total: R …`, `Bank: <account> / <branch>`.

  For the smudged photo, the total's digits are replaced with `?`.
- [ ] **Step 4:** `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(connectors): synthetic Microsoft 365, Google Workspace and ERP with seeded accounts history`.

### Task 2: People, the IT catalogue and agents that run as their builder

**Files:**
- Modify: `src/generate.mjs` (P-043..P-045 and their channels; the `Connector` records), `src/actions.mjs` (`set_catalogue_line`, `sign_off_catalogue_line`; `record_reading` stores `by`), `src/agents.mjs` (runtime: run as builder; `ctx.connector`), `test/generate.test.mjs` (42 → 45 people)
- Test: `test/catalogue.test.mjs` (new)

**Interfaces:**
- Produces: the `Connector` records, with ids `CON-m365-mail`, `CON-m365-files`, `CON-m365-teams`, `CON-google-mail`, `CON-google-drive`, `CON-google-sheets`, `CON-erp` and `CON-cmms`.
  - Each record is `{ kind, lines: [{ op, action, roles, maxLevel, itSignOff, signedOff: { [role]: { by, at } } }] }`.
  - The seeded lines that matter:

    | Connector | op | action | roles | maxLevel | itSignOff |
    |---|---|---|---|---|---|
    | m365.mail | read | null | accounts_clerk, finance_officer, works_manager | read | no |
    | m365.files | write | file_document | accounts_clerk, finance_officer | act | **yes** |
    | erp | read | null | accounts_clerk, finance_officer, planner, works_manager | read | no |
    | erp | post | post_invoice_match | accounts_clerk, finance_officer | propose | no |
    | cmms | read / write | null / the existing typed actions | every role | read / act | no |
    | m365.teams, google.* | send / read | send_message / null | every role | notify / read | no |

- Produces: `catalogueAllows(ont, { kind, op, role, level }) -> { ok, reason, locked }`. `locked` is true when a sign-off is needed and is missing for that role.
- Produces these actions:
  - **`set_catalogue_line`** `{ kind, op, patch }`, ceiling `human`. Refused unless `ont.get(actor).itAdmin` ("IT administrators only").
  - **`sign_off_catalogue_line`** `{ kind, op, role }`, ceiling `human`, IT administrators only. It is audited, and its revert removes that role's sign-off.
- Produces in the runtime:
  - **Running as the builder:** when `specFor(name).builderId` is set, `run` uses the builder as `actingUser`, whoever calls it. The run records `triggeredBy`.
  - **`ctx.connector(kind)`:** refused unless the spec's `reads` lists `connector:<kind>` and `catalogueAllows(... role: builder.role, op: "read")`. It returns that store's read functions only.

- [ ] **Step 1: Write the failing tests:**
  - `Person` count is 45. P-045 has `itAdmin: true`. Every person in P-001..P-042 deep-equals the same person from the generator before this change (compare against a frozen JSON of `{ id, name, role, clearance }` written into the test).
  - P-001 (manager, not IT) calling `sign_off_catalogue_line` is refused with `/IT administrators only/`. P-045 signing off `m365.files write` for `accounts_clerk` returns `done`, and `catalogueAllows(... level: "act")` becomes `{ ok: true, locked: false }`. Reversing it locks the line again.
  - Before the sign-off, `catalogueAllows({ kind: "m365.files", op: "write", role: "accounts_clerk", level: "act" })` is `{ ok: true, locked: true }`. For `role: "millwright"` it is `ok: false`.
  - Review Focus 1: a registered test agent whose spec has `builderId: "P-043"` and `reads: [{ source: "connector:m365.mail" }]`, run with `actingUser` P-001, records `actingUserId: "P-043"` and `triggeredBy: "P-001"`. The same agent calling `ctx.connector("erp")` without `connector:erp` in `reads` throws `/not in its evidence contract/`.
  - `record_reading` stores `by` (the person behind the action).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm test`. Expected: PASS, after updating 42 → 45 in `test/generate.test.mjs`.
- [ ] **Step 5:** Commit: `feat(studio): IT connector catalogue, accounts and IT people, agents run as their builder`.

### Task 3: The digester's core

**Files:**
- Create: `src/digest.mjs`
- Test: `test/digest.test.mjs` (new)

**Interfaces:**
- Produces: `extractFields(attachment, { erp, history }) -> { cells, fields }`.
  - `cells`: project 1's shape, `{ key, value, grade: "EXTRACTED" | "INFERRED" | "AMBIGUOUS", region, reasoning, reviewed: null }`, for `supplier`, `invoiceNo`, `date`, `poNo`, `lines`, `vat`, `total` and `bank`. `region` is `{ line }`, the text-layer line the value came from.
  - **EXTRACTED** means read cleanly from the text layer.
  - **INFERRED** means worked out. For example, a missing PO resolved from supplier and amount to the single open PO within tolerance.
  - **AMBIGUOUS** covers a `?` in the value, two candidate POs, or no text layer (reason "no text layer").
- Produces: `matchInvoice(fields, { erp, tolerancePct = 2, seen }) -> { po, receipt, ok, issues: [{ kind: "no-po" | "over-tolerance" | "no-receipt" | "duplicate" | "bank-change", detail }] }`.
  - A duplicate is the same supplier, number and total as an entry in `seen` or in `erp.invoices()`.
  - A bank change is a `bank` field that differs from `erp.suppliers()`.
- Produces: `destinationFor(fields, history) -> { path, basis }`. The path is `Accounts/Supplier invoices/<supplier>/<yyyy-mm>`, learnt from the most common parent of earlier filings for that supplier. `basis` names the earlier item ids. With no history it falls back to that pattern with basis `"pattern"`.
- Produces: `digestVerdict({ cells, match }) -> "file" | "review" | "person"`.
  - `person` for a bank change.
  - `review` for any AMBIGUOUS cell, a duplicate, `over-tolerance` or `no-receipt`.
  - otherwise `file`.

- [ ] **Step 1: Write the failing tests**, one per trap, on Task 1's seeded attachments:
  - **Clean invoice:** every cell EXTRACTED, `match.ok`, verdict `file`, and a destination equal to the clerk's actual filing for it.
  - **No PO:** `poNo` INFERRED with reasoning naming the PO it chose, and verdict `file`.
  - **Over PO:** issue `over-tolerance` with `detail` matching `/6(\.\d)?%/`, verdict `review`. With `tolerancePct: 10` it is `file`.
  - **Duplicate:** issue `duplicate`, verdict `review`.
  - **Smudged:** the `total` cell is AMBIGUOUS, verdict `review`.
  - **Bank change** (Review Focus 2): issue `bank-change`, verdict `person`, even though the PO, receipt and total all match.
  - **Review Focus 5:** `extractFields({ textLayer: null, quality: "photo" })` gives every cell AMBIGUOUS with reasoning "no text layer", and does not throw. `digestVerdict` gives `review`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** as pure functions with no ontology access.
- [ ] **Step 4:** `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(digest): graded extraction, three-way match, duplicates, bank changes and learnt filing`.

### Task 4: Digester actions and the digester template

**Files:**
- Modify: `src/actions.mjs` (`digest_document`, `file_document`, `post_invoice_match`, `review_intake_cells`; `post_invoice_match` tagged `money: true`), `src/harness.mjs` (`EFFECTS` for the new actions)
- Create: `src/templates.mjs` (`TEMPLATES.digester.run(ctx)`)
- Test: `test/digester.test.mjs` (new)

**Interfaces:**
- Consumes: `extractFields`, `matchInvoice`, `destinationFor` and `digestVerdict` (Task 3); `ctx.connector` (Task 2).
- Produces these actions:
  - **`digest_document`** `{ attachmentId, source }`, needs `draft`, ceiling `act`. It creates `DocumentIntake { id: "DIN-…", attachmentId, messageId, cells, fields, match, verdict, destination, audience: [builder, approver], state: "digested" }`.
  - **`file_document`** `{ intakeId, path }`, needs `act`, ceiling `act`.
    - Refused when the intake's verdict is not `file` ("needs review" / "goes to a person").
    - Calls `m365.files.copy`; the revert calls `files.remove`.
  - **`post_invoice_match`** `{ intakeId, poId }`, needs `act`, ceiling `propose`, `money: true`. Calls `erp.postMatch`; the revert calls `erp.unpost`.
  - **`review_intake_cells`** `{ intakeId, marks: [{ key, verdict: "accept" | "correct", value? }] }`, ceiling `human`. After the review the verdict is recomputed, and the revert is relative.
- Produces: `visionFields(attachment) -> Promise<cells | null>`. With `llmEnabled()`, Claude reads an attachment that has no text layer, against a closed field schema. A cell is graded EXTRACTED only at high confidence; otherwise INFERRED or AMBIGUOUS. `digest_document` takes `cells` that the server route pre-computes this way. It is not unit-tested against the network; with AI off the text layer is the only reader.
- Produces the digester template's sources: `params.source` is `{ kind: "m365.mail", mailbox }`, `{ kind: "m365.files", path }` or `{ kind: "chat", channelId }`. For chat, it reads `Message.media` entries that resolve through `connectors.attachment`.
- Produces the digester template's run logic: for each new attachment in the spec's source since its last run:
  1. `digest_document`;
  2. if the verdict is `file`, `file_document` to the destination;
  3. then `post_invoice_match` (always a proposal);
  4. if the verdict is `person`, `raise_issue` "Supplier query: bank details changed" for the approver.

  The run never files or posts a `review` or `person` document.

- [ ] **Step 1: Write the failing tests:**
  - A bounded test agent from the digester template (builder P-043, approver P-044, with `m365.files write` signed off) runs over the window and gives:
    - 23 `file_document` decisions;
    - `post_invoice_match` only as Proposals (`money-propose`), none applied;
    - no decision of any kind for the duplicate, the smudged photo or the bank-change invoice;
    - one Issue for the bank change (Review Focus 2), assigned to P-044.
  - The same agent without the sign-off is refused on `file_document` with `/needs IT sign-off/`.
  - The `DocumentIntake` audience is `["P-043", "P-044"]`, so a technician's view does not see it.
  - `review_intake_cells` correcting the smudged total moves its verdict to `file`; reversing the review moves it back.
  - Reversing a `file_document` decision removes the copied driveItem.
  - A digester with `params.source: { kind: "chat", channelId: "CHN-P-043" }` digests the seeded chat photo into one intake.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** `invoke` also checks the catalogue for agent actors on any action bound to a catalogue line. A missing sign-off refuses with "needs IT sign-off: <kind> <op>". Above `maxLevel`, it caps.
- [ ] **Step 4:** `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(digest): digester actions, review, and the digester template`.

### Task 5: The rule / agent / person screen and the keyword planner

**Files:**
- Create: `src/studio.mjs` (`screen`, `planFromText`, `validateStatement`, `composeWithClaude`)
- Modify: `src/templates.mjs` (the watch, weekly-report, chaser and data-tidy templates)
- Test: `test/studio.test.mjs` (new)

**Interfaces:**
- Produces: `screen(text, answers = {}) -> { verdict: "rule" | "agent" | "person", reason, questions: [{ id: "judgement" | "frequency" | "cost", text }] }`.
  - **person:** the text names interlocks, setpoints or compliance sign-off ("compliance", "Blue Drop submission", "interlock", "setpoint"). The reason names which.
  - **agent:** messy inputs (invoice, photo, PDF, scan, email body, delivery note), or `answers.judgement === "yes"`.
  - **rule:** otherwise, for example a threshold and a notify.
- Produces: `planFromText(text, { builder, ont }) -> { template, spec } | { template: null, reason }`. The template is one of `digester`, `watch`, `weekly-report`, `chaser`, `data-tidy`, found by keywords. The spec is an `AgentSpec` draft with:
  - `builderId`, `owner: builder`, `mode: "shadow"`, `state: "live"`, `template`, `params`;
  - `reads`, `tools` (levels capped by `catalogueAllows`, with `locked` lines flagged), `approver`, `backup`, `escalateAfterMin` and `onTimeout: "hold"`.
- Produces: `validateStatement(spec, { ont }) -> { ok, problems: [string] }`. It fails when:
  - an action is not in `ACTIONS` or a template's tool list;
  - a level is above the action's ceiling or the catalogue's `maxLevel` for the builder's role;
  - a read is not allowed for the builder's role;
  - the approver is not a Person;
  - `onTimeout` is not `hold` or `drop`.
- Produces: `composeWithClaude(text, { builder, ont }) -> Promise<spec | null>`. It returns null when `llmEnabled()` is false, and its output always passes through `validateStatement`; on any problem it falls back to `planFromText`. It is not unit-tested against the network.

- [ ] **Step 1: Write the failing tests:**
  - **J25 text:** "When a supplier invoice comes into the accounts inbox, read it, check it against the PO and file it in the right supplier folder." `screen` gives `agent`. `planFromText` for P-043 gives:
    - `template: "digester"`;
    - `trigger: { kind: "schedule", every: "weekdays at 07:00" }`, with `params.source: { kind: "m365.mail", mailbox: "accounts@riverbend.example" }` and `params.tolerancePct: 2`;
    - `reads` including `connector:m365.mail` and `connector:erp`;
    - tools `digest_document` act, `file_document` act with `locked: true`, and `post_invoice_match` propose;
    - `approver: "P-044"` (the finance officer, found by role), `backup: "P-001"`, `escalateAfterMin: 240`, `mode: "shadow"`.
  - "Tell me when HLP-B bearing temperature goes above 80" gives `rule` and `template: "watch"`.
  - "Submit the Blue Drop compliance pack every month" gives `person`, with a reason matching `/compliance/`.
  - **Checks for a millwright:** a planned digester for P-028 fails `validateStatement` with `/m365.mail.*not allowed/`. A spec with `post_invoice_match: "act"` fails with `/above/`. `onTimeout: "apply"` fails.
  - "Remind people about open supplier queries older than 5 days" gives `template: "chaser"` with `params.olderThanDays: 5`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** Template run logic for the other four (each only through `ctx.act`):
  - **watch:** `ctx.latest(params.sensorId)` against `params.above` or `below`, then `notify` the builder.
  - **weekly-report:** counts from the listed types, then `draft_document`, then `send_message` (needs approval).
  - **chaser:** open Issues assigned to the builder older than N days, then `send_message` to each assignee.
  - **data-tidy:** ERP suppliers whose names match after normalising, then `draft_document` listing the pairs.
- [ ] **Step 4:** `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(studio): rule/agent/person screen, keyword planner, statement validation`.

### Task 6: Read-back that round-trips

**Files:**
- Modify: `src/harness.mjs` (`statementSentences` covers the studio fields; new `statementFromSentences`)
- Test: `test/studio.test.mjs`

**Interfaces:**
- Produces: `statementSentences(spec, ont)`, extended:
  - **schedule:** "Every weekday at 07:00 it reads new mail in the Accounts inbox."
  - **named approver:** "It asks Thandi Mokoena before it will post invoice match."
  - **escalation:** "If Thandi Mokoena does not answer in 4 hours it asks Precious Sithole; if nobody answers it does nothing."
  - **locked line:** "It may file document without asking, once IT signs it off."
  - **mode:** "It is in shadow: it records what it would do and changes nothing." Assisted is "It asks before every change." This also fixes 3a's deferred minor that the statement ignored the mode.
- Produces: `statementFromSentences(sentences, spec, ont) -> { spec, problems }`. It parses only the editable sentence kinds:
  - the trigger schedule;
  - a tool's level ("without asking" is act, "asks … before" is propose, "only drafts" is draft, "only notifies" is notify);
  - the approver's name;
  - the escalation hours and backup name;
  - the `onTimeout` sentence.

  An edited result goes through `validateStatement`, and on problems the original spec is returned.

- [ ] **Step 1: Write the failing tests:**
  - **Round trip:** for the J25 spec and for three default agents, `statementFromSentences(statementSentences(s), s).spec` deep-equals `s` on `trigger`, `tools`, `approver`, `backup`, `escalateAfterMin` and `onTimeout`.
  - **An edit:** changing "If Thandi Mokoena does not answer in 4 hours" to "in 2 hours" gives `escalateAfterMin: 120`.
  - **Review Focus 3:** editing the post sentence to "It may post invoice match without asking." returns `problems` matching `/above propose/`, and a spec still at `propose`.
  - The statement of a shadow spec includes "it records what it would do and changes nothing", and never "without asking" for an act tool unless the mode is `bounded`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(studio): read-back that round-trips, with mode, named approvers and escalation`.

### Task 7: Studio lifecycle: create, replay, IT gate and promotion

**Files:**
- Modify: `src/actions.mjs` (`create_studio_agent`; `promote_agent` lets a supervisor who is the spec's approver promote, and refuses while any tool is locked), `src/agents.mjs` (register studio agents with template logic), `src/studio.mjs` (`replay`)
- Test: `test/studio.test.mjs`

**Interfaces:**
- Produces: **`create_studio_agent`** `{ spec }`, ceiling `human`.
  - Requires `validateStatement(spec).ok` and `spec.builderId === actor.id`.
  - Upserts the AgentSpec with `mode: "shadow"` forced, then calls `runtime.register(manifestFromSpec(spec), TEMPLATES[spec.template].run)`.
  - The revert retires it (`state: "retired"`).
- Produces: `replay(sys, spec, { days = 14 }) -> { cases, agreed, differed, missed, unsure, caught, stale, constraintHits }`.
  - It runs the template over the past `days` against connector history, in shadow, and writes `ShadowAction`s with `replay: true` and `status` already matched to what people did. For the digester, a match is the clerk's filing to the same path.
  - `unsure` counts verdict `review` from AMBIGUOUS cells. `caught` counts duplicates and bank changes the clerk filed or queried.
- Produces: `manifestFromSpec(spec) -> { name, version, owner, purpose, trigger, tools: [action], autonomy: { [action]: level } }`. It is the runtime manifest for a studio AgentSpec, the inverse of 3a's `specFromManifest`.
- Produces: `dueStudioAgents(ont, nowIso, lastIso) -> [name]`. These are live studio agents whose schedule fell between the last tick and now: `"weekdays at HH:MM"`, `"every N min"`, `"daily at HH:MM"`. The server tick runs each one (as its builder).
- Produces: `promotionGap(ont, spec)` adds "needs IT sign-off: <kind> <op>" while a tool is locked.
- Produces: **`promote_agent`** minimum clearance becomes `supervisor`. A promoter below engineer must be the spec's named approver; otherwise it is refused ("engineer clearance or the agent's approver").

- [ ] **Step 1: Write the failing tests:**
  - **J25:** P-043 creates the digester from Task 5's plan, which gives `done`, mode `shadow`, and an agent listed by `runtime.specs()`. `replay` gives `{ cases: 25, agreed: 23, unsure: 1, caught: 1 }`, and `shadowRecord` gives `agreePct` 92.
  - **J26:** P-044 promoting to assisted is refused with `/needs IT sign-off: m365.files write/`. After P-045 signs off, P-044 promoting is `done`. P-043 promoting their own agent is refused with `/own agent/`. P-028 is refused.
  - **Review Focus 1:** P-001 (manager) running the clerk's agent gives a run with `actingUserId: "P-043"`. Every intake it writes has the audience `["P-043", "P-044"]`. A ShadowAction reading `CON-erp` purchase orders exists only because the clerk's role may read the ERP: remove `accounts_clerk` from the erp read line and the run refuses with `/not allowed/`.
  - `create_studio_agent` with a spec for another builder is refused, and with an invalid spec is refused with the validator's problems.
  - `dueStudioAgents` gives the clerk's digester for a tick from Monday 06:59 to 07:00, and nothing for Saturday 07:00.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm test`. Expected: PASS. Plan 3a's promotion tests still pass (an engineer may still promote any agent they did not build).
- [ ] **Step 5:** Commit: `feat(studio): create in shadow, 14-day replay, IT sign-off before promotion, approver promotes`.

### Task 8: Recommendations (agent 21)

**Files:**
- Create: `src/recommend.mjs` (`signalsFor`)
- Modify: `src/agents.mjs` (Recommender spec and logic), `src/actions.mjs` (`accept_suggestion`, `dismiss_suggestion`), `src/generate.mjs` (seeded history for the signals, appended after the people), `src/server.mjs` (run the Recommender once per plant day), `src/evals.mjs`, `test/agents.test.mjs` (20 → 21)
- Test: `test/recommend.test.mjs` (new)

**Interfaces:**
- Produces this seeded history, deterministic and appended at the end of `generateWorks`:
  - 10 mornings of `Reading` by P-028 on HLP-B (`measure: "bearing temp"`, 07:00–07:20, with `by: "P-028"`);
  - 5 Scheduler Proposals rejected by P-004 with the Feedback "artisan on leave";
  - 6 night-shift `start_sampling_round` Proposals approved after 150–210 min by the C-shift supervisor;
  - 4 Issues "Supplier query: …" assigned to P-043.

  The clerk's 37 filings are in Task 1's move log.
- Produces: `signalsFor(ont, connectors, personId, nowIso) -> [{ signal, key, title, evidence: [ids], template, params, savedMinPerWeek }]`.
  - It reads only `ont.view(person)` and, for connectors, only what the person's role may read.
  - It never reads views, page opens or search history; none of those are recorded.
  - The signals and their thresholds:

    | `signal` | Fires when (over the last 30 days unless stated) |
    |---|---|
    | `repeated-action` | at least 10 file moves by the person, or the same action at least 10 times |
    | `repeated-check` | readings on the same target on at least 5 different days |
    | `slow-decision` | median approval wait for one action type above 120 min; the person here is the approver |
    | `repeated-override` | at least 3 rejections by the person with the same reason |
    | `long-step` | a Procedure Steward notification to the person |
    | `exceptions-to-one` | at least 3 open issues of one kind assigned to the person |

  - `savedMinPerWeek` comes from the measured history: items per week × the median minutes between the item's arrival and the person's action, or 3 min per item when no arrival time exists. The basis is stated in the suggestion.
- Produces: `Suggestion { id: "SUG-…", personId, signal, key, title, evidence, statement: AgentSpec draft in shadow, savedMinPerWeek, basis, state: "open", audience }`.
  - The audience is `[personId]`, plus the person's supervisor only for `slow-decision`.
- Produces: the Recommender (`AGENT_SPECS` 21) with trigger `{ kind: "schedule", every: "each plant day" }`. It runs for each person as that person, and upserts suggestions, skipping any `(personId, key)` dismissed within 30 days or already open.
- Produces these actions:
  - **`accept_suggestion`** `{ suggestionId }`: only its person. It returns the draft spec for the studio and sets the state to `accepted`.
  - **`dismiss_suggestion`** `{ suggestionId, reason? }`: only its person. It sets the state to `dismissed` and records `dismissedAt`.

- [ ] **Step 1: Write the failing tests:**
  - Each of the six signals produces its suggestion from seeded history for the right person:
    - P-043 `repeated-action`, with title matching `/37 invoices/`;
    - P-028 `repeated-check` on HLP-B, with a `watch` statement in shadow (J27);
    - P-004 `repeated-override` matching `/artisan on leave/`;
    - the C-shift supervisor `slow-decision`;
    - an engineer `long-step`, after Procedure Steward has run;
    - P-043 `exceptions-to-one`.
  - **Nobody sees another's:** P-028's view lists no suggestion of P-043's. P-043's supervisor sees none of P-043's, because no `slow-decision` belongs to P-043.
  - **J27:** P-028 dismisses with "I like to look myself". The Recommender runs on the next plant day (`tel.tick(1440)`) with two more readings added, and makes no new `repeated-check` suggestion for P-028. Review Focus 4: still none after `tick(29 * 1440)`; one appears after `tick(31 * 1440)` from the dismissal.
  - Every suggestion has non-empty `evidence`, and each id in it resolves in the person's view.
  - `AGENT_SPECS.length` is 21, and the Recommender evals pass.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** On a plant-day change the server tick runs the Recommender with `actingUser` set to each person in turn (`chain: false`).
- [ ] **Step 4:** `npm test`. Expected: PASS. Update the counts other tests assert (Feedback, Proposal, Reading, Issue) if any.
- [ ] **Step 5:** Commit: `feat(recommend): suggestions from how each person works, private, with evidence and 30-day dismissals`.

### Task 9: Routes

**Files:**
- Modify: `src/server.mjs`
- Test: `test/studio-api.test.mjs` (new)

**Interfaces:**
- Produces these routes. Everything is pruned through the viewer's view:
  - `POST /api/studio/plan` `{ text, answers? }` → `{ screen, plan, sentences, problems, claude: "on" | "off" }`. It uses `composeWithClaude` when on, `planFromText` otherwise.
  - `POST /api/studio/sentences` `{ spec, sentences }` → `{ spec, sentences, problems }`.
  - `POST /api/studio/replay` `{ spec }` → the replay counts plus up to 10 example cases. It never writes outside `ShadowAction` and is run as the viewer only when the viewer is the builder.
  - `POST /api/actions/create_studio_agent`, `sign_off_catalogue_line`, `set_catalogue_line`, `accept_suggestion` and `dismiss_suggestion` go through the existing action route.
  - `GET /api/catalogue` → the Connector records. A 403 unless the viewer has `itAdmin` or is the works manager (read-only for the manager).
  - `GET /api/suggestions` → the viewer's open suggestions.
  - `GET /api/intakes` and `GET /api/intakes/:id` → `DocumentIntake` records in the viewer's view, with the attachment's text layer and quality for the preview.

- [ ] **Step 1: Write the failing tests:**
  - P-043 posting the J25 text to `/api/studio/plan` gets `screen.verdict: "agent"`, `plan.template: "digester"`, and `claude: "off"` (no API key in tests).
  - P-028 posting it gets `problems` matching `/not allowed/`.
  - P-001 `GET /api/catalogue` is 200. P-028 gets 403.
  - P-028 `GET /api/suggestions` lists only P-028's.
  - `GET /api/intakes/:id` for a technician is 404.
  - `POST /api/studio/replay` by P-043 returns `{ cases: 25, agreed: 23 }`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(studio): studio, catalogue, suggestion and intake routes`.

### Task 10: Screens

**Files:**
- Modify: `web/app.js` (`views.studio`, `views.catalogue`, `views.intakes`; nav), `web/index.html` (nav entries), `web/styles.css`
- Test: `test/web.test.mjs`

**Interfaces:**
- Produces: **Studio** (`#/studio`). Its steps follow spec §6.1:
  1. Describe: one textarea, plus an optional example document picked from the viewer's intakes.
  2. Rule, agent or person: the verdict with its reason; the questions appear only when the planner is unsure.
  3. Read back: each sentence editable in place, re-sent to `/api/studio/sentences`; locked lines show "needs IT approval".
  4. Replay: the counts and example cases.
  5. Start in shadow: `create_studio_agent`.

  "Suggested for you" lists suggestions with their evidence links, Accept (which pre-fills the studio) and Dismiss (with an optional reason). When Claude is off, a line says so.
- Produces: **IT catalogue** (`#/catalogue`, IT administrators edit; the manager reads). A table per connector of op, action, roles, max level and sign-off, with "Sign off for <role>" buttons.
- Produces: **Documents** (`#/intakes`). The intakes list. Each intake shows the text-layer preview (the document "image": the text layer drawn as a page, with `?` marks highlighted for a smudged photo) beside project 1's review grid of its cells: accept or correct an unsure cell.

- [ ] **Step 1: Write the failing test:** `app.js` includes `async studio(`, `async catalogue(`, `async intakes(`, `Rule, agent or person`, `Start in shadow`, `Suggested for you`, `needs IT approval`, `Claude is off` and `data-sentence`. `index.html` has nav links to `#/studio` and `#/intakes`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** in the existing view style. Listeners attach to elements rendered by the view, never to `#view` itself (3a's lesson).
- [ ] **Step 4:** `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(studio): studio, suggestions, IT catalogue and document review screens`.

### Task 11: Docs and browser journeys

**Files:**
- Modify: `README.md` (rows, J25–J28, test count), `../README.md` (link to this plan), `../02-BRD-*.md` Appendix D (a row for synthetic connectors with real API shapes, and the IT flag outside clearance)
- Test: a browser check, then `npm test`

- [ ] **Step 1:** Update the docs in the existing style.
- [ ] **Step 2:** Run `npm start` and walk:
  - **J25 (P-043):** Studio → the J25 text → agent → read back:
    - file is locked "needs IT approval";
    - the approver is Thandi Mokoena;
    - escalation after 4 hours to Precious Sithole.

    Replay: 23 of 25 agree, 1 unsure, 1 duplicate caught. Start in shadow.
  - **J26 (P-045 then P-044):** the catalogue → sign off m365.files write for accounts_clerk; P-044 then promotes the clerk's agent to assisted.
  - **J27 (P-028):** "Suggested for you" shows the HLP-B watch agent with its evidence. Dismiss with "I like to look myself"; tick a day; it does not come back.
  - **J28:** with no API key, J25 works and the studio says "Claude is off".

  Expected: as stated, with a screenshot of each. If the server is stopped for memory, report it and do not restart it unasked.
- [ ] **Step 3:** `npm test`. Expected: all pass; report the count.
- [ ] **Step 4:** Commit: `docs: agent studio, connectors, digester and recommendations (Phase 3 project 3b)`. Then run the final whole-branch review.
