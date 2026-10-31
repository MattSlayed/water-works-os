# Riverbend project dashboard and project briefs

Status: built on branch feat/project-dashboard (2026-10-31); live check pending. Approved in chat 2026-10-31 (Matthew: "merge the Site Agent and go ahead with the project dashboard design? yes").
Builds on the Site Agent (`src/site-agent.mjs`, merged 6277617) and the KG tools (`src/kg/tools.mjs`).

## Intent

Maintenance projects run around the works all the time. A manager or supervisor asks the Site Agent "how is the
CL-4 refurbishment going?" and gets:
- a brief, read from the project's progress documents and its live state, with every fact cited;
- the 3D view flown to where the project is;
- four dashboard indicators they can expand: **People**, **Plant & Process**, **Procedures**, **Compliance**.

Same principle as the incident Site Agent: the agent reads, briefs, and points at the place.

**The KG is the source of truth.** Everything here is read from the knowledge graph (the ontology, through
`ont.view` and the KG tools). What the agent produces goes back into the KG as linked objects. The dashboard is a
view of the KG, never a second store.

## Goals

1. **Project data in the KG.** Seed the seven active projects with:
   - weekly progress reports, as documents split into citable chunks;
   - a crew;
   - the procedures in use;
   - permits and isolations;
   - compliance requirements with evidence;
   - links to the plant and zones they touch.

   The data is synthetic, made-up content.
2. **Four indicators per project,** each rated green, amber, red or none, with a one-line summary and expandable
   items. Each item carries a status and a citation.
   - Computed deterministically from the KG at the plant clock.
   - Computed for the asking viewer.
   - Shown with a header: milestones, spend against budget, and days since the last report.
3. **One agent.** The Site Agent answers project questions too.
   - It reads through two KG tools: a new `project_status` tool, and `documents` widened to project documents.
   - It flies to the project's area and returns the indicators with its brief.
   - Without Claude, it briefs from the indicators instead.
4. **Write-back.** Every project answer writes a `ProjectSnapshot` into the KG, linked to the project, and the next
   answer can say what changed since.
5. **The project page shows the same indicator cards.**

## Non-goals

- Loading progress documents, crews or snapshots into Timebase Atlas. They stay in the WaterOS KG, like events do
  today. Atlas carries the physical model.
- Editing projects, crews or requirements from the UI.
- Scheduling: Gantt charts, critical path or baselines.
- Adding project questions to the Claude eval bank.

## Anti-goals (a failure even if it works)

- A person's name or id reaches Claude, Atlas or Historian.
  - The People indicator gives **roles and counts only**. Its items never hold a person id or name.
  - The `people` tool stays withheld from the Site Agent.
- The dashboard shows something the viewer may not see. Indicators are computed through `ont.view(viewer)`, so a
  technician never learns about Z06 work through a project card.
- A snapshot taken by a higher-clearance asker is shown to a lower-clearance viewer.
- Indicator rules hide in the UI. They live in one server-side function, and the UI only renders.

## Constraints

- **Repo conventions:** Node ESM with no new npm dependencies; LF line endings; the suite stays green at every
  commit; the house style is terse code with comments only for the why.
- **Fictional-name rule:** Riverbend WTW only. Never real names, tags or coordinates.
- **POPIA as above.** Person, Presence, Competency, Participant and Execution are people data (the `PEOPLE` set).
  The indicator function reads them server-side through `ont.view` and emits only aggregates and roles.
- **Clearance follows each object's zone,** as `ont.view` already does. A project with no zone is visible to anyone
  who can see projects today. Its zone-bound parts (permits, readings, alerts) are pruned per viewer.
- **Plant clock.** "Now" is `tel.now()`. Seeded dates sit before the plant start (2026-10-14T06:00Z), unless they are
  meant to fall due during the replay.

## Data model added to the KG

| What | How | Notes |
|---|---|---|
| Where a project is | `TARGETS` project→Asset for each asset in `takesOutOfService` and `assetIds`; new `LOCATED_IN` project→Zone | Gives every active project a place on the map. |
| Crew | new `WORKS_ON` Person→Project, link props `{role, planned: true}`; contractor Participants likewise | People data. The link is read only through `ont.view` and never leaves WaterOS. |
| Required competence | Project field `requiredCompetence: [competency keys]`, e.g. `trade:fitter`, `confined-space`, `gas-safety:chlorine` | New key `confined-space`, with Competency records seeded for some crew. Some expire inside the replay, to give amber. |
| Progress reports | `Document{kind:"progress-report", aboutId, at, title}`, chunked by heading into `Chunk`s; `ABOUT` doc→project | 2–3 weekly reports per project, each with sections Summary / Progress / Safety / Next week. |
| Procedures in use | new `USES` project→Procedure | The 5 existing procedures, plus new `PRC-CONFINED_SPACE-v1` and `PRC-HOT_WORK-v1`. The new ones have steps that require a permit or isolation. |
| Procedure progress | `Execution{projectId, procedureId, steps[]}` | Existing type (people data). Seeded part-done on several projects. |
| Permits | `Permit{projectId, assetId?, zoneId, state, opened, expires?, isolations[]}` | Some are open and verified, one has expired, one isolation is applied but not verified. |
| Compliance | `Requirement{framework, criterion, projectId?, dueBy?}`; new `REQUIRES` project→Requirement; `Document{kind:"evidence"|"certificate", validTo}` with new `EVIDENCES` doc→Requirement | Frameworks: OHS Act Construction Regulations 2014, the confined-space regulations, NEM:WA waste manifests, and Blue Drop. |
| Snapshot | `ProjectSnapshot{projectId, at, minClearance, by:"Site Agent", model, areas:{people,plant,procedures,compliance}: {status,summary}, brief, citations[]}`; `ABOUT` snapshot→project | Written on every project answer. Never stores the asker's id. |

**Seed outcomes to aim for** (so the demo has a mix):
- CL-4: amber (an overdue milestone, M2 claimed but not confirmed).
- RES-2: red on Compliance (the confined-space permit has expired while work continues).
- Sludge lagoon: green, nearly done.
- At least one project: amber on People (a competence expiring within 14 days).
- At least one project: a Procedures item that is red (a step needing an isolation is done without a verified one).

## Indicator rules (one function: `projectIndicators(ont, tel, viewer, projectId)`)

**Overall status** is the worst of the items: red > amber > green. An area with no items is `none`.

- **People.**
  - Planned crew (WORKS_ON with `planned`) against crew present in the project's zones (Presence).
  - For each crew member: is each `requiredCompetence` held and valid at the plant clock?
    - Missing, or expired, while present: red.
    - Expiring within 14 days: amber.
  - Item text names the role and the gap, e.g. "Fitter (contractor): confined-space expires 2026-10-20". No ids.
- **Plant & Process.**
  - Out-of-service items active now, with the capacity impact text: amber when it cuts capacity.
  - Active alerts on targeted assets or zones: a high alert is red, a medium one amber.
  - The latest reading of each sensor on a targeted asset against its alarm band: outside the band is red.
- **Procedures.**
  - For each `USES` procedure: steps done out of steps total, from the project's Executions.
  - A done or active step that needs a permit or isolation, without an open permit with a verified isolation:
    red.
  - Steps outstanding past the next milestone's due date: amber.
- **Compliance.**
  - Each `REQUIRES` requirement is met when it has evidence valid at the plant clock.
    - Expiring within 14 days: amber.
    - Missing, with `dueBy` passed: red.
  - Each project permit:
    - Expired while project work is active (an Execution step in the last 24 h): red.
    - An isolation applied but not verified: amber.

**Header:**
- milestones total / claimed / confirmed / overdue (reuse `projectStatus`);
- spend against budget (reuse `spendAt`);
- the last progress report date and days since.

Every item carries a `cite`: the object id the item rests on. People items cite the project or the requirement,
never a person.

## Agent and tools

**New KG tool `project_status {projectId}`** returns `projectIndicators` for the viewer. It is scrubbed like every
tool, and holds no people ids by construction.

**`documents` is widened:**
- `aboutId` = a project finds that project's progress reports and evidence.
- `q` searches their chunks too.

**Site Agent:**
- **Prompt:** for a question about a project, call `project_status` and read the latest progress report, call
  `show_on_map` with the project's assets or zones, then brief. The brief covers progress against milestones, then
  each area that is not green, then what to check first. At most eight sentences.
- **Response** gains `project: {id, title, header, areas}` when the agent called `project_status` (the last call
  wins).
- **The fallback** (no Claude) recognises a project question with the existing `projectsAsked` matcher. It briefs
  from the indicators: the header line and one line per non-green area.
- **Snapshot:** after any answer with `project`, the agent writes a `ProjectSnapshot` and links it. If a previous
  snapshot is visible to this viewer, the response includes `changed: [{area, from, to}]`.

**Focus:** `plantFocus` over the project's TARGETS assets, LOCATED_IN zones and `takesOutOfService` ids.

## UI

- **Plant view, Site Agent panel.** Under the brief, four cards in a 2×2 grid, each with:
  - a colour dot and the area name;
  - the summary;
  - a `<details>` that expands to its items, each with a status dot, the text and the cite.

  Above the cards sits the header line. Each card's colour also has a text label, never colour alone.
- **Project page `#/project/<id>`.** The same cards, loaded from a new
  `GET /api/projects/:id/indicators`, plus a "Snapshots" list (time, overall statuses, what changed).
- **Rendering:** one shared `indicatorCards(p)` render function in `web/app.js`.

## Snapshot visibility

A snapshot stores the asker's clearance (not the asker) as `minClearance`, which `ont.view` already enforces
(`src/ontology.mjs:91`). A lower-clearance viewer therefore never sees a higher-clearance snapshot through any route
or KG tool, with no extra code.

## Left to the builder

- The exact seeded report wording, crew sizes and dates, within the outcome mix above.
- Card styling within the existing tokens in `web/styles.css`.
- How the Snapshots list is laid out.

## Verification

- Unit tests for each indicator rule (green, amber and red cases).
- Tests that People items hold no person id or name, under any clearance.
- A test that a technician's indicators omit Z06 permits, readings and alerts.
- A snapshot write and read test, covering the visibility rule.
- An agent test with a fake client: `project_status` is offered, the `project` and `changed` fields are filled,
  and a snapshot is linked.
- A live check against the API: a manager and a technician each ask about CL-4 and RES-2.
- `npm test` stays green.
