# Project Dashboard and Project Briefs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Site Agent answers "how is project X going?". It briefs from the project's KG data with citations, flies
the 3D view to the project, and returns four expandable indicators (People, Plant & Process, Procedures,
Compliance). Each answer is written back into the KG as a `ProjectSnapshot`.

**Architecture:**
- **Seeding.** A seeder adds the project data to the ontology: crews, reports, procedures, permits, requirements and
  links.
- **Indicators.** One pure function computes the indicators for a viewer from `ont.view`.
- **Agent.** A new KG tool exposes the indicators. The Site Agent calls it and writes snapshots, and the UI renders
  shared cards.
- **Reuse.** The existing `documents` tool already finds chunks linked `ABOUT` an object, so progress reports become
  reachable by seeding those links.

**Tech Stack:** Node 22 ESM, `node:test`, the in-memory ontology (`src/ontology.mjs`), vanilla JS UI (`web/app.js`).

**Spec:** `docs/superpowers/specs/2026-10-31-project-dashboard-design.md` (read it; it is the authority).

## Global Constraints

- **Repo rules:**
  - No new npm dependencies.
  - LF line endings.
  - `npm test` green at every commit; it was 579 tests at plan time.
  - Terse house style, with comments only for the why.
- **Fictional names only.** Riverbend WTW; invent no real people, companies, places or tags. People names come only
  from existing seeded Person records. The contractor is "Synthetic Contractor (Pty) Ltd".
- **POPIA:**
  - People items in indicators hold roles and counts only, never a person id or name.
  - The `people` tool stays withheld from the Site Agent.
  - Person, Competency, Presence, Participant, Execution and WORKS_ON never reach Atlas or Historian.
- **Clearance:**
  - Everything is computed through `ont.view(viewer)`.
  - Seeded project objects (reports, chunks, permits, evidence) carry the project's `zoneId`, so `ont.view` prunes
    them per viewer.
  - A snapshot carries `minClearance` = the asker's clearance (`ont.view` enforces it at `src/ontology.mjs:91`).
- **Plant clock** = `tel.now()`, which starts at 2026-10-14T06:00:00.000Z. Seeded history sits before it.
- **Project zones** (`LOCATED_IN`), fixed:

  | Project | Zone(s) |
  |---|---|
  | PRJ-CL4 | Z04 |
  | PRJ-RWM | Z13 |
  | PRJ-RES2 | Z07 |
  | PRJ-FMR | Z05 |
  | PRJ-INT | Z01 |
  | PRJ-SLG | Z08 |
  | PRJ-PS2 | Z14 and Z15 (Z15 needs supervisor clearance) |

  PRJ-H2025-DOSE is closed and is left untouched.
- **New rels:** `LOCATED_IN` (Project→Zone), `WORKS_ON` (Person→Project, props `{role, planned}`), `USES`
  (Project→Procedure), `REQUIRES` (Project→Requirement), `EVIDENCES` (Document→Requirement). Reused rels: `TARGETS`,
  `ABOUT`, `HAS_CHUNK`.
- **Every seeder step is idempotent:** use `linkOnce` and `upsert`, as `src/kg/seed.mjs` does.
- **Do not disturb the KG eval's answers.**
  - No new permit or isolation on the raw-water pumps (AST-30819, AST-98455, AST-42245).
  - No new alerts.
  - CL-4's state stays as it is.

## Review Focus

1. A technician asks about PRJ-PS2. Its Z15 MCC permits, evidence and report chunks must not appear in the
   indicators, the brief or the citations. They see only the Z14 parts. Test in Task 3.
2. A question that names no project, or two projects, must not fabricate a dashboard.
   - With Claude, `project` is whatever `project_status` was last called with.
   - In the fallback, a question that matches two projects briefs the first by start date and lists the others in
     one line.
   - Test in Task 4.
3. A project with no crew, no procedures or no requirements shows that area as `none`, not green, and renders a "no
   data" card. Test in Tasks 2 and 5.
4. People item text must never contain a person name or id, even though the function reads Person records. Test in
   Task 2: assert against every seeded Person name and `P-\d+`.
5. Asking twice must give `changed: []` on the second ask, not phantom changes. A snapshot written by a higher
   clearance must not be diffed against for a lower-clearance asker. Test in Task 4.

---

### Task 1: Seed project data into the KG

**Files:**
- Create: `data/riverbend/projects.json`
  - Authored content: per project, the crew roles, required competence, reports (markdown), procedures used,
    permits, requirements and evidence.
- Create: `src/kg/projects-seed.mjs`
- Modify: `src/kg/seed.mjs`
  - `seedKg` calls `seedProjects(ont)` last.
- Test: `test/projects-seed.test.mjs`

**Interfaces:**
- Produces: `seedProjects(ont): void` (idempotent).
- **Projects:** each active project gets these fields:
  - `requiredCompetence: string[]`;
  - `zoneIds: string[]`, the same as its `LOCATED_IN` targets, kept as a field for cheap reads.
- **Reports:** `Document{id:"DOC-PR-<PRJ>-<yyyymmdd>", kind:"progress-report", aboutId, at, title, zoneId, body}`.
  - Chunks come from `chunkByHeading(docId, body)`, each with `zoneId` added.
  - Links: `HAS_CHUNK` doc→chunk, `ABOUT` doc→project and `ABOUT` chunk→project.
  - Each body has `## Summary`, `## Progress`, `## Safety` and `## Next week`.
  - 2–3 reports per active project. The latest is dated within 7 days before 2026-10-14, except PRJ-RWM, which is
    left quiet (last report 10 days before).
- **Procedures:** `PRC-CONFINED_SPACE-v1` and `PRC-HOT_WORK-v1`, shaped like the existing procedures (`steps[]` with
  `id`, `step`, `text`, `intrusive`, `hazard`).
  - New step booleans `requiresPermit` and `requiresIsolation`, used on the new procedures.
  - Existing steps whose hazard is LOTO count as `requiresIsolation`.
- **Executions:** `Execution{id:"EXE-PRJ-<n>", projectId, procedureId, personId, state:"in-progress"|"done", steps:[{step, state, at}]}`.
- **Permits:** `Permit{id:"PTW-PRJ-<n>", projectId, zoneId, kind, state, opened, expires, isolations:[{point, state, appliedBy, verifiedBy}]}`.
- **Requirements:** `Requirement{id:"REQ-PRJ-<n>", framework, criterion, projectId, zoneId, dueBy}`.
- **Evidence:** `Document{id:"DOC-EV-<n>", kind:"evidence"|"certificate", title, zoneId, validTo, body}`, with
  `EVIDENCES` to its requirement, plus one chunk (heading "Evidence") linked `ABOUT` the project.
- **Crew:** `WORKS_ON` from existing Person ids (technicians and contractors), with
  `{role:"fitter"|"millwright"|"electrician"|"contractor"|…, planned:true}`. Extra Competency records use the key
  `confined-space`. Extra Presence records place on-site crew in the project zone.
- **Seed outcomes the spec pins:**
  - PRJ-RES2 has an expired confined-space permit, with an Execution step on it within the last 24 h.
  - Some project has a crew competence expiring within 14 days of 2026-10-14.
  - Some project has a done `requiresIsolation` step with no verified isolation.
  - PRJ-SLG has every requirement evidenced, valid, and every procedure step done.

- [ ] **Step 1: Write the failing tests** in `test/projects-seed.test.mjs`. Each runs on
  `createSystem({ seed: 7 })`.
  - `"projects seed: every active project has a zone, a crew, 2+ progress reports with chunks, and USES/REQUIRES links"`
    - Every active project has ≥1 `LOCATED_IN`, ≥1 `WORKS_ON`, ≥1 `USES` and ≥1 `REQUIRES`.
    - Every active project has ≥2 `progress-report` documents ABOUT it, each with ≥4 chunks linked ABOUT the
      project.
  - `"projects seed: report chunks and permits carry the project zone, so a technician cannot see PRJ-PS2's Z15 parts"`
    - Assert `ont.view({id:"P-028",clearance:"technician"})` lists no Permit, Document or Chunk with
      `zoneId:"Z15"`.
  - `"projects seed: running seedProjects twice changes nothing"`
    - Object count and link count are the same after a second `seedProjects(ont)`.
  - `"projects seed: no new permit or isolation on the raw-water pumps"`
    - No `Permit` with `projectId` has an `assetId` in AST-30819, AST-98455 or AST-42245.
  - `"projects seed: projects.json names no person"`
    - The file text matches no seeded Person `name`, and no `P-\d+` outside `crew[].personId` fields.

- [ ] **Step 2: Run them to verify they fail.** Run `node --test test/projects-seed.test.mjs`. Expected: FAIL, because
  the module was not found.

- [ ] **Step 3: Implement `seedProjects(ont)` and author `data/riverbend/projects.json`,** then call it from
  `seedKg`. The JSON holds content only; ids, links and zone stamping happen in code.

- [ ] **Step 4: Run the full suite.** Run `npm test`. Expected: all pass.
  - If an existing test counted Procedures, Permits, Competencies, Documents or Presence, update its expected number
    and say so in the report.
  - If any eval-fixture test (`test/kg-eval.test.mjs`) fails, stop and report it; do not change the eval bank.

- [ ] **Step 5: Commit.**
  ```bash
  git add data/riverbend/projects.json src/kg/projects-seed.mjs src/kg/seed.mjs test/projects-seed.test.mjs
  git commit -m "feat(kg): seed project crews, progress reports, procedures, permits and compliance"
  ```

### Task 2: Indicator function

**Files:**
- Create: `src/project-indicators.mjs`
- Test: `test/project-indicators.test.mjs`

**Interfaces:**
- Consumes: Task 1's objects and links; `projectStatus` (`src/functions.mjs:141`); `spendAt`
  (`src/regionview.mjs:12`).
- Produces: `projectIndicators(ont, tel, viewer, projectId) -> null | { id, title, at, header, areas }`. It returns
  `null` when the viewer cannot see the project.
  - `header`: `{ milestones:{total,claimed,confirmed,overdue:[ids]}, spendZar, budgetZar, lastReportAt, daysSinceReport }`.
  - `areas`: `{ people, plant, procedures, compliance }`, each `{ status:"green"|"amber"|"red"|"none", summary:string, items:[{ status, text, cite }] }`.
- Produces: `worst(statuses: string[]) -> status`, where red > amber > green, and `none` only when the list is empty.

- [ ] **Step 1: Write the failing tests** in `test/project-indicators.test.mjs`. Use `createSystem({seed:7})` and a
  manager viewer, and assert the spec's seed outcomes:
  - `"indicators: RES-2 compliance is red for the expired confined-space permit"`
    - `areas.compliance.status === "red"`, and an item cites the expired permit's id.
  - `"indicators: SLG is green across people, procedures and compliance"`
  - `"indicators: a competence expiring within 14 days makes people amber, with role text and no person name or id"`
    - For every project, no `areas.people.items[].text` contains any seeded Person `name` or matches `/\bP-\d+\b/`.
    - No people item `cite` starts with `P-`.
  - `"indicators: a done isolation step with no verified isolation makes procedures red"`
  - `"indicators: an area with no data is none with an empty items list"`
    - Strip one project's `USES` links on a fresh system and assert `procedures.status === "none"`.
  - `"indicators: header reuses projectStatus milestones and spendAt"`
    - For PRJ-CL4, compare against `projectStatus(...)` and `spendAt(p, tel.now())` directly.
  - `"indicators: a technician gets null for nothing and no Z15 item for PRJ-PS2"`
    - The technician gets a result for PRJ-PS2, but no item cites an object with `zoneId:"Z15"`.
  - `"worst: red beats amber beats green; empty is none"`

- [ ] **Step 2: Run them to verify they fail.** Run `node --test test/project-indicators.test.mjs`. Expected: FAIL,
  because the module was not found.

- [ ] **Step 3: Implement it,** following the spec's "Indicator rules" exactly: the 14-day expiry window, "active
  work" meaning an Execution step in the last 24 h, and so on.
  - Read everything through `const view = ont.view(viewer)`.
  - Read people data only to count and to name roles (from the `WORKS_ON` link's `role`).

- [ ] **Step 4: Run them to verify they pass.** Run `node --test test/project-indicators.test.mjs`, then `npm test`.
  Expected: all pass.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/project-indicators.mjs test/project-indicators.test.mjs
  git commit -m "feat: project indicators for people, plant and process, procedures and compliance"
  ```

### Task 3: KG tool `project_status`, with project documents reachable

**Files:**
- Modify: `src/kg/tools.mjs`
  - Add the tool to the list.
  - The KG tools receive `tel` already. If `createKgTools` does not, thread it through.
- Test: `test/kg-tools.test.mjs` (append)

**Interfaces:**
- Consumes: `projectIndicators` (Task 2).
- Produces: a tool `{ name:"project_status", description, inputSchema:{projectId:string, required}, run({projectId}, viewer) }`.
  - It returns `{ found:false }` or `{ found:true, ...indicators, cite: projectId }`.
  - `projectId` goes through the existing `resolve(view, id)`, so a title tag or id both work. Also resolve an exact
    project title case-insensitively.
  - It is scrubbed like every non-people tool.

- [ ] **Step 1: Write the failing tests** (appended):
  - `"kg tools: project_status returns the four areas for PRJ-CL4 and found:false for an unknown id"`
  - `"kg tools: documents with aboutId PRJ-RES2 returns its progress-report chunks, newest report first"`
    - The `documents` items include chunk ids starting with `DOC-PR-PRJ-RES2-`.
  - `"kg tools: a technician's project_status and documents for PRJ-PS2 hold nothing from Z15"`
    - Every cited id the technician gets resolves to an object whose zone is not Z15.
  - `"kg tools: project_status output holds no person id at any depth"`
    - JSON-stringify the output for every active project as a manager, and assert no `/\bP-\d+\b/` match.

- [ ] **Step 2: Run them to verify they fail.** Run `node --test test/kg-tools.test.mjs`. Expected: the new tests
  fail.

- [ ] **Step 3: Implement it.** If "newest report first" does not already hold, sort `documents` chunk results with
  the same `aboutId` by their document's `at` descending, then by `order`. Keep the existing sort for other
  documents.

- [ ] **Step 4: Run them to verify they pass.** Run `npm test`. Expected: all pass. The site agent tests pass the KG
  tools through `toolsFor`, so check `project_status` has no `minClearance`.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/kg/tools.mjs test/kg-tools.test.mjs
  git commit -m "feat(kg): project_status tool; project progress reports reachable through documents"
  ```

### Task 4: Site Agent answers project questions and writes snapshots

**Files:**
- Modify: `src/site-agent.mjs`
- Modify: `src/agents.mjs`
  - Export the existing `projectsAsked` (`src/agents.mjs:88`), unchanged.
- Create: `src/project-snapshot.mjs`
- Test: `test/site-agent.test.mjs` (append)

**Interfaces:**
- Consumes: the `project_status` tool (Task 3); `projectIndicators` and `worst` (Task 2); `plantFocus` (already in
  `src/site-agent.mjs`); `projectsAsked(ctx, q)`, where `ctx` needs `list` (pass `ont.view(viewer)`).
- Produces: `writeSnapshot(ont, viewer, indicators, { brief, citations, model, at }) -> { snapshot, changed }`.
  - It upserts `ProjectSnapshot{ id:"PSN-<projectId>-<n>", projectId, at, minClearance: viewer.clearance, by:"Site Agent", model, areas:{key:{status,summary}}, brief, citations }`.
  - It links `ABOUT` → project.
  - `changed`: `[{area, from, to}]` against the newest earlier snapshot of that project visible through
    `ont.view(viewer)`.
- Produces: `ask()` now returns
  `{ answer, citations, focus, model, project?: { id, title, header, areas }, changed?: [...] }`.
- **Focus for a project:** `plantFocus(ont, viewer, [...TARGETS asset ids, ...zoneIds, ...takesOutOfService ids])`.
  When Claude calls `show_on_map`, its ids win.
- **Claude path:**
  - Append to the system prompt: "For a question about a maintenance project: call project_status and read its
    latest progress report with documents (aboutId = the project), call show_on_map with the project's assets or
    zones, then brief: progress against milestones, each area that is not green, and what to check first. At most
    eight sentences."
  - `project` = the result of the last successful `project_status` call (`found:true`).
- **Fallback:**
  - When `projectsAsked(view, question)` matches, brief from the indicators. The first line is the header ("<title>:
    M confirmed of N milestones, K overdue; R <spend> of <budget>; last report D days ago [<projectId>]"). Then one
    line per area that is not green: "<Area>: <summary> [<first item cite>]".
  - With more than one match, brief the first by `start`, and add a last line, "Also matching: <titles>."
- A snapshot is written after every answer that has `project` set. Skip it when `found` is false.

- [ ] **Step 1: Write the failing tests** (appended). Each `createSiteAgent` gets the real KG tools, from
  `createKgTools({ backend: createMemoryBackend(sys), ont, tel, crosswalk })` as in `test/kg-tools.test.mjs`.
  - `"site agent: fallback project brief for 'how is the clarifier 4 refurbishment project going?' has the header line, project, and a linked snapshot"`
    - `r.project.id === "PRJ-CL4"`.
    - The answer starts with the header.
    - `ont.links(snapshotId, {rel:"ABOUT"})` reaches PRJ-CL4.
    - The focus includes `PM-RB-A:MCH-CL-4`.
  - `"site agent: asking the same project twice gives changed: []"`
  - `"site agent: a technician never diffs against a manager's snapshot"`
    - Ask as a manager, then as a technician. The technician's `changed` is computed only against snapshots with
      `minClearance` technician, so it is `[]` on their first ask.
  - `"site agent: with Claude, project_status is offered, its result fills project, and a snapshot is written"`
    - Fake client: turn 1 calls `project_status {projectId:"PRJ-RES2"}`, turn 2 calls `show_on_map
      {ids:["AST-RES-2"]}`, turn 3 ends with text citing `[PRJ-RES2]`.
    - Assert `calls[0].tools` includes `project_status` and excludes `people`.
    - Assert `r.project.areas.compliance.status === "red"`.
    - Assert one `ProjectSnapshot` about PRJ-RES2 with `model: true`.
  - `"site agent: a question naming no project returns no project and writes no snapshot"`
    - Use the turbidity question from the existing test.

- [ ] **Step 2: Run them to verify they fail.** Run `node --test test/site-agent.test.mjs`. Expected: the new tests
  fail.

- [ ] **Step 3: Implement it.** Keep the incident path unchanged; the existing 6 site-agent tests must still pass.

- [ ] **Step 4: Run them to verify they pass.** Run `npm test`. Expected: all pass.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/site-agent.mjs src/project-snapshot.mjs src/agents.mjs test/site-agent.test.mjs
  git commit -m "feat: Site Agent briefs on projects with indicators and writes ProjectSnapshots to the KG"
  ```

### Task 5: API routes and indicator cards in the UI

**Files:**
- Modify: `src/server.mjs`
  - Add `GET /api/projects/:id/indicators` and `GET /api/projects/:id/snapshots`, next to the existing
    `/api/projects/:id` routes (around `src/server.mjs:531-542`).
- Modify: `web/app.js`
  - A shared `indicatorCards(p)` render function.
  - Use it in the plant Site Agent panel (after the brief, when `r.project` is set) and on the `project(id)` page.
  - A "Snapshots" list on the project page.
- Modify: `web/styles.css`
  - Card grid and status dots, using the existing tokens (`--green`/`--amber`/`--red`, or the nearest existing
    ones).
- Test: `test/server.test.mjs` (append)

**Interfaces:**
- Consumes: `projectIndicators` (Task 2) and the `ProjectSnapshot` objects (Task 4).
- **`/indicators`:** returns the `projectIndicators(...)` result, or 404 when it is null.
- **`/snapshots`:** returns the visible snapshots of the project, newest first:
  `[{id, at, model, areas:{key:{status}}, changedFrom?}]`. Any field may be absent; do not compute diffs here.
- **`indicatorCards(p)`** returns an HTML string:
  - a header line;
  - a 2×2 grid of four `<section>` cards, in the order People, Plant & Process, Procedures, Compliance;
  - each card: a status dot plus the status word in text (never colour alone), the area name and the summary;
  - each card has a `<details><summary>N items</summary>` list. Each item has a status word, its text, and the cite
    in `.cite`;
  - an area with status `none` shows "No data in the KG for this area" and no `<details>`;
  - all text goes through `esc()`.
- **Changes since the last snapshot:** when `r.changed` is non-empty, the panel shows "Changed since last snapshot:
  People amber → red, …" above the cards.

- [ ] **Step 1: Write the failing tests** (appended to `test/server.test.mjs`):
  - `"GET /api/projects/PRJ-CL4/indicators returns four areas; unknown is 404"`
  - `"GET /api/projects/PRJ-PS2/indicators as a technician cites nothing in Z15"`
  - `"GET /api/projects/:id/snapshots lists newest first and hides a manager snapshot from a technician"`
    - Seed two snapshots with `writeSnapshot`, one as a manager and one as a technician.

- [ ] **Step 2: Run them to verify they fail.** Run `node --test test/server.test.mjs`. Expected: the new tests fail.

- [ ] **Step 3: Implement the routes and the UI.** For the UI:
  - `node --check web/app.js` must pass.
  - Render the cards in the plant panel under the brief, and on the project page above the milestones table.

- [ ] **Step 4: Run them to verify they pass.** Run `npm test`, then `node --check web/app.js`. Expected: all pass,
  with no syntax error.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/server.mjs web/app.js web/styles.css test/server.test.mjs
  git commit -m "feat: project indicator cards in the Site Agent panel and on the project page"
  ```

### Task 6: Docs and live check

**Files:**
- Modify: `README.md`
  - A short "Project briefs and dashboard" subsection under the Site Agent / knowledge graph sections: what to ask,
    the four areas, and that snapshots are KG objects.
- Modify: `docs/superpowers/specs/2026-10-31-project-dashboard-design.md`
  - A status note at the top: "Built on branch feat/project-dashboard; live check <date>".

- [ ] **Step 1: Update the README and the spec status.** Docs only, so there is no test.
- [ ] **Step 2: Run `npm test`.** Expected: all pass.
- [ ] **Step 3: Commit.**
  ```bash
  git add README.md docs/superpowers/specs/2026-10-31-project-dashboard-design.md
  git commit -m "docs: project briefs and dashboard"
  ```
- **Live check (the controller runs it, not the implementer).**
  - Run `npm start`.
  - A manager and a technician each ask the Site Agent in the plant view about CL-4 and about RES-2, using the
    `.env` key.
  - Check the cards, the fly-to and the snapshots, and record the results in the ledger.
