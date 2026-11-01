# Ask page: the answer, its evidence graph and its timeline

Status: approved in chat 2026-11-01. Matthew picked mock-up B5 ("lets go with B5") from the design canvas
"Riverbend control room variations", page "Palantir & Glean ideas". B5 combines the Glean-style ask-first home (B3)
with the Gotham-style link graph and timeline (B2). Builds on the Site Agent (`src/site-agent.mjs`) and project
indicators (`src/project-indicators.mjs`).

## Intent

A manager asks one question and sees three things in one place:
- the Site Agent's answer, with numbered citations;
- a graph of the records the answer rests on;
- when those records fall due.

Picking a citation, a graph card or a timeline event lights up that same source in all three places.

**The KG is the source of truth.** Every answer is written back into the KG as an `Answer` linked to its sources,
and the page reads only what the API returns.

## Goals

1. **Sources for an answer.** `answerEvidence(ont, tel, viewer, citations)` lives in `src/answer-evidence.mjs`.
   For each citation, in order, it returns `{n, id, type, title, status, note, area, dates[]}`:
   - **Status and note** come from the project indicators the viewer can see. A record cited by an indicator item
     takes that item's status, text and area; if several items cite it, the worst one wins. A project takes its
     worst area, and its note is its milestone count. An alert with no indicator item maps its severity
     (high → red, medium → amber, low → green). Anything else is `none`.
   - **Dates** come from the record itself:
     - Project: each milestone's due date (done = confirmed).
     - Permit: opened, and expiry.
     - Requirement: due date, and its latest valid evidence date.
     - Alert: raised at.
     - Document: its date. A Chunk uses its document's date.
2. **Write-back.** Every Site Agent answer upserts
   `Answer{at, minClearance, by: "Site Agent", model, answer, citations}`, with a `CITES` link to each cited
   record. It stores the asker's clearance, never the asker and never the question text, because a question can
   name a person. `ont.view` already hides it from lower clearances.
3. **API.** `POST /api/plant/ask` gains `sources` and `answerId`. Old callers (the Plant panel) ignore them.
4. **Page `#/ask`,** first in the rail, following B5's layout in the house design system (`web/styles.css` tokens):
   - **Ask:** an ask bar, three suggested questions, and a one-line note that answers only use records your role
     can read.
   - **Answer:** bullets with numbered citation buttons; "Show on plant" when the answer has a focus.
   - **Selected source:** type, title, cite link, status word, note, dates.
   - **Evidence graph:** the answer in the middle, with the sources in two columns around it. Each card shows its
     number, type, title and status. The edge label is the area, or "cited".
   - **Timeline:** lanes by record type (Programme, Permits, Requirements, Plant, Documents), with month ticks and
     a today line. Labels are packed so they never overlap. Sources with no date are listed below.
   - **Deep link:** `#/ask/<question>` asks on load.

## Non-goals

- Changing how the agent answers, or the Plant panel.
- Two-hop expansion, editing records from the page, or a "For you" feed.

## Anti-goals

- **A person in the evidence.** `citationsIn` already drops Person-type cites; `answerEvidence` reads indicator
  items, which hold roles and counts only.
- **A record the viewer may not see.** Everything is read through `ont.view(viewer)`.
- **Colour alone.** Every status shows its word.

## Constraints

Node ESM, no new dependencies, LF line endings, suite green at every commit, fictional names only.

## Verification

- **Unit tests for `answerEvidence`:**
  - RES-2's permit, requirement, project and alert statuses and dates.
  - An unknown cite gives `none`.
  - A technician gets nothing from Z06.
- **Site Agent test:** an answer writes an `Answer` with `CITES` links and the asker's clearance. A lower
  clearance cannot see it. The response carries `sources` and `answerId`.
- **Web test:** the route and the nav are wired.
- `npm test` stays green.
