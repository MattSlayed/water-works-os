# Design: The agent harness, the root-cause agent and the Agent Studio (Phase 3, project 3 of 3)

Status: **draft for Matthew's approval**, after the builder check.

Phase 3 so far:

1. Plant from its drawings.
2. Region map and satellite layer.

Both are built and merged into `feat/phase2-workforce-intelligence`.

This document is project 3, the agents.

Research behind it: `../../../../05-HUMBLEOPS-RESEARCH.md`, a fact-checked scan of HumbleOps; sections 5 and 6 are the agent studio takeaways. Also `../../../../04-PHASE3-VENDOR-RESEARCH.md` (Tulip Composable Agents, Cognite Atlas, and the MCP permission tiers).

## 1. Intent and the why

What Matthew asked for, in his words:

- "While having default agents, I'd like there to be a space where users can design or even be recommended agents based off insights from their work and how they work."
- "This should prioritise the harness around the agent."
- **Who builds:** "a non technical person, familiar with low code tools. He would describe what he wants out of the agent, and the agent studio would build the agent based off of the connected tools that he would normally have access to (Microsoft 365, Google Workspace, the ERP system or CMMS)."
- **Who controls access:** "Perhaps parts of this would be authorised by the IT team for role based access."
- **The first likely agent:** "situational, but they would want an agent that could visually digest images, PDFs like invoices using OCR and place them in the right place."
- **Where the root cause comes from (from the Phase 3 brainstorm):** analysis "by actually understanding the blueprint of the plant", across data, telemetry, geospatial and the drawings.

**What exists today.** 19 agents, each with:

- name, purpose, trigger, tools, and autonomy per tool;
- an autonomy dial (`read` / `draft` / `notify` / `propose` / `act`), with ceilings set per action;
- evals per agent;
- a hash-chained audit log;
- proposals that a person approves, edits or rejects;
- reversal.

**What is missing:**

- **A full harness.** An agent today is a JavaScript function with a manifest. Nothing records who approves its proposals, what it may read, how fresh its evidence must be, how it earns more autonomy, or how it is switched off.
- **A way for a non-technical person to make one.**
- **A way for the system to suggest one.**
- **The root-cause agent itself.**

**Why "harness first".** The prompt is the least interesting part of an agent. What makes it safe to hand to a non-technical builder is the frame around it: what starts it, what it can read, what it can do alone, what it must ask about, who answers, how it proves itself before it acts, and how it is stopped. HumbleOps' clearest material, its October 2026 articles, is exactly this, and none of the vendors researched recommends agents from a user's own work. That gap is ours to fill.

## 2. Goals, non-goals, anti-goals

**Goals**

- **H. The harness: an agent is a decision statement.** Every agent, default or built, is described by one record with these fields:
  - trigger;
  - evidence contract: what it reads, at most the builder's clearance, with a freshness limit per source;
  - tools, each with an autonomy level under its action ceiling;
  - hard constraints that are inherited and cannot be removed;
  - approver and backup, escalation route and timeout fallback;
  - exclusions;
  - mode: shadow → assisted → bounded;
  - promotion criteria, fixed when the agent is created;
  - eval cases;
  - owner;
  - kill switch.

  The 19 existing agents are restated in this form, with no change in behaviour.
- **R. Root-cause agent (agent 20).** Given an incident, it builds a ranked, evidenced causal chain across telemetry, the plant model's process graph, the region (scenes, detections, plume timing), work history and chat. It shows counter-evidence and the hypotheses it rejected. It ends with an outcome check: did the corrective action hold?
  - **On the seeded data** it must reach "storm plume (contributing) + F07 media (local); DP-2 real but not causal".
- **S. Agent Studio.** A person describes an agent in their own words. The studio:
  - first decides whether this should be a **rule, an agent, or stay with a person**;
  - then composes a decision statement only from registered tools and connectors that the builder's role may use (set by IT);
  - shows that statement back in plain language for editing;
  - replays it against past history;
  - starts it in shadow.

  Promotion needs evidence and a second person.
- **C. Connectors and IT control.** There are synthetic connectors for Microsoft 365 (Outlook mail, SharePoint files, Teams), Google Workspace (Gmail, Drive, Sheets), the ERP (purchase orders, goods receipts, invoices, suppliers) and the CMMS (the existing work orders).
  - **IT owns a connector catalogue.** It says which roles may use which connector and action, and which actions always need IT sign-off.
  - **An agent can never do more than its builder.** It runs as its builder, cut down to its evidence contract.
- **D. The first studio agent: the document digester.**
  - **What it reads:** photos and PDFs from a mailbox, a Drive or SharePoint folder, or chat, such as supplier invoices, delivery notes and job-card photos.
  - **What it extracts:** graded fields (read clearly / worked out / unsure), reusing project 1's cell grading and review screen.
  - **Matching:** it matches each document to the purchase order and goods receipt in the ERP.
  - **Filing:** it files the document where similar ones went before.
  - **Money:** anything that moves money is approval-only.
- **E. Recommendations.** The studio watches how people work and offers ready-made decision statements, each with its evidence ("why we suggest this"). They always start in shadow. The person accepts, edits or dismisses each one, and dismissals are remembered.

**Non-goals**

- Agents that write arbitrary code or tools. The studio composes only registered actions, functions and connector actions.
- Real Microsoft 365, Google or ERP connections. The connectors are synthetic, with the real APIs' shapes, behind one interface, ready to swap.
- Real OCR or vision without an API key. With `ANTHROPIC_API_KEY` set, the digester reads documents with Claude's vision. Without it, synthetic documents carry an embedded text layer.
- "Fixes become procedures automatically." Knowledge written by any agent goes through the existing review gates.
- Trust based on elapsed time ("ran for 14 days, so promote"). Promotion is on evidence only.

**Anti-goals.** Each of these would make it a failure even if it works:

1. **Approval theatre.** A generic approve button, notify-after-write, or silence counted as consent.
2. **An agent with more reach than its builder.** Or a studio that lets someone route around IT.
3. **A black box.** If a non-technical builder cannot read back what their agent will do, in their words, it is a failure.
4. **Recommendation spam.** A suggestion with no evidence, or the same suggestion again after a dismissal.

## 3. Constraints

- **Stack.** Node 22, zero runtime dependencies, `node:test`, vanilla ES modules. Claude is optional through the existing `src/llm.mjs`.
- **AI-optional.** Every agent runs deterministically with the AI switched off. Claude improves extraction and wording; it is never required. This matters for South African connectivity, and HumbleOps makes the same point.
- **POPIA.** Documents and chats sent to Claude are cross-border inference, already disclosed under POPIA s72 (ARC-001 §4). The studio says so on any agent that uses Claude.
- **Existing machinery, reused:**
  - `ACTIONS` with ceilings;
  - `actions.invoke` / `resolve` / `reverse`;
  - the autonomy dial;
  - `runEvals`;
  - the audit log;
  - the review grid from project 1;
  - the process graph and `travelWindow` from project 1;
  - the Region read models from project 2.
- **Server and doctrine.** The server stays on localhost; NOVATEK doctrine gates are waived; departures go in BRD Appendix D.

## 4. The harness

### 4.1 The decision statement

Each agent gets one `AgentSpec` record in the ontology. A spec for the 19 existing agents is generated from `AGENT_SPECS`.

| Field | Meaning |
|---|---|
| `id`, `name`, `version`, `owner` | owner is a person; default agents are owned by the reliability engineer |
| `purpose` | the builder's own words, kept verbatim |
| `trigger` | `schedule` (cron-like), `event` (an ontology event type plus a filter), `manual`, or `connector` (a new mail or file) |
| `reads` | the evidence contract: `[{ source: type or connector, filter, fields, freshnessMin }]` |
| `tools` | `[{ action, level }]`, each level ≤ the action's ceiling and ≤ what the builder's role allows |
| `constraints` | hard constraints: the inherited list (§4.4) plus any the builder adds |
| `approver`, `backup`, `escalateAfterMin`, `onTimeout` | who answers proposals, and what happens when nobody does: `hold` or `drop`, **never** `apply` |
| `exclusions` | what it must leave alone (assets, zones, suppliers, amounts) |
| `mode` | `shadow` / `assisted` / `bounded` |
| `promotion` | criteria fixed at creation: minimum cases seen, agreement with people (%), zero constraint breaches, evidence freshness failures under a limit |
| `evals` | eval cases, including cases learnt from overrides |
| `state` | `draft`, `shadow`, `live`, `paused`, `retired` |
| `killedAt`, `killedBy` | the off switch |

### 4.2 Modes

- **Shadow.** Every action the agent would take is recorded as a `ShadowAction` and **never invoked**. When a person later does or decides the same thing, the shadow action is matched to it: agreed, differed, or missed.
- **Assisted.** Proposals only. Every tool is capped at `propose`, whatever its level.
- **Bounded.** Tools run at their levels, inside the constraints.

**Promotion** happens one step at a time, needs four eyes, and is refused unless the promotion criteria are met on the shadow record. The same person cannot promote what they built. A promotion is an action, so it is audited.

**Demotion is automatic** back to assisted when any of these happens:
- a hard constraint is hit;
- evidence goes stale more often than the stated limit;
- people override it more often than the stated rate.

### 4.3 The evidence contract and freshness

- The runtime gives an agent a reader cut to its `reads`, inside its builder's view. It is not the builder's whole view.
- **Every read records** its source id, the source's own time, and the read time.
- **Before any write,** the cited evidence is checked against its freshness limit. Stale evidence refuses the write with "evidence stale: <source> <age>". This generalises project 1's stale-hash check.

### 4.4 Hard constraints

These are inherited by every agent and cannot be removed:
- no control-system writes (PRD BR-06);
- no chlorine dosing change beyond `propose`;
- no action on an asset under an open permit unless the action is the permit's own;
- Reg. 3630 cover rules;
- anything that moves money is `propose` at most;
- confirming a geo detection, releasing a plant model and releasing a procedure stay human-only, as today.

The list is shown in the studio, read-only.

### 4.5 Approval that means something

Each proposal card shows:
- the action and its target;
- the evidence with its age;
- the constraints that were checked;
- the expected effect;
- the alternatives the agent rejected.

Approving needs the approver (or the backup after `escalateAfterMin`). Every rejection or override asks for a reason. Override reasons become eval cases and recommendation signals.

### 4.6 Off switch and revocation

- **Off switches.** One per agent, and one per tool on an agent. Pausing cancels the agent's open proposals and queued shadow actions.
- **Undo.** Reversing an agent's decision never overwrites a later human edit. This is the existing relative-revert rule, applied everywhere.

### 4.7 Audit

Every run records:
- the spec version;
- its mode;
- what it read and how fresh it was;
- what it intended;
- the result;
- the alternatives it rejected;
- the outcome, once known.

## 5. The root-cause agent (agent 20)

**Trigger:** manual (pick an alert, a detection or a time window), or event: an alert ranked high.

**Method**, all deterministic, with Claude only to word the summary:

1. **Symptom.** The object and the change onset, using `onsetMinute` with the cycle removed (for example the filters' 30 h period).
2. **Candidates upstream.** `upstreamOf` on the released plant model, with shares and travel windows (project 1). Region inputs come in where the intake connects: raw-water turbidity, the Sentinel scenes, plume detections and the timing of the trucks and boat (project 2).
3. **Timing test.** For each candidate with its own onset: is it inside the travel window before the symptom? If it is too late, it is rejected and the reason is shown.
4. **Breadth test.** How many siblings show the same symptom? One weak unit suggests a local cause; many suggest a common cause.
5. **History.** Past work orders, findings and field notes on the symptom asset and its siblings.
6. **The chain.** Ranked causes (contributing or local), each with evidence and its age, plus the rejected hypotheses with their reasons.
7. **Outcome check.** After a corrective action, it watches an observation window and grades the result: Effective, Partially effective, Ineffective, or Insufficient evidence.

**Output:** an `RcaReport` draft with a "show me" link for each cause. Each link opens the region, the plant upstream view, or a trend.

**Evals.** The seeded F07 case returns:
- F07 media local;
- the storm plume contributing;
- DP-2 rejected as too late, with its timing.

A case with no upstream onset returns "Insufficient evidence", never a guess.

## 6. The Agent Studio

### 6.1 Flow

1. **Describe.** One text box: "What do you want it to do?" The builder may attach an example document.
2. **Rule, agent or person** (HumbleOps' screen). The studio asks up to three plain questions: does it need judgement on messy inputs, how often does it happen, and what does it cost if wrong. Then it recommends one of three:
   - a deterministic **rule**: a trigger plus actions, no AI;
   - an **agent**;
   - **leave it with a person**, with the reason why.

   Anything that touches interlocks, setpoints beyond `propose`, or compliance sign-off is never an agent.
3. **Compose.** The studio turns the description into a draft decision statement, using only the connectors and actions the builder's role may use. Where IT sign-off is required, the action is shown locked with "needs IT approval".
   - **With Claude:** Claude drafts the statement against a closed schema of the available tools.
   - **Without Claude:** a keyword planner covers the documented templates (§6.3).
4. **Read back.** The statement shown as plain sentences, for example:
   - "Every weekday at 07:00 it reads new mail in the Accounts inbox…";
   - "It may file to SharePoint without asking";
   - "It asks Thandi before posting an invoice to the ERP";
   - "If Thandi does not answer in 4 hours it asks Sipho; if nobody answers it does nothing."

   Every sentence can be edited, and edits round-trip to the statement.
5. **Replay.** The statement runs against the past 14 days of history in shadow. The studio shows what it would have done, set against what people actually did:
   - agreements;
   - differences;
   - missed cases;
   - stale evidence;
   - constraint hits.
6. **Start in shadow.** The agent goes live in shadow. Its card shows its mode, its shadow record against its promotion criteria, and the off switch.

### 6.2 IT's connector catalogue

A `Connector` record has a kind (m365.mail, m365.files, m365.teams, google.mail, google.drive, google.sheets, erp, cmms), its actions, and per action:
- the roles that may use it;
- the highest level allowed;
- whether IT sign-off is needed before an agent may use it.

An IT administrator role edits the catalogue; this is a new clearance-independent role on Person, `itAdmin: true`. A studio agent that needs a signed-off action stays in draft until IT approves that line. IT approval is a separate four-eyes action, recorded in the audit.

### 6.3 Templates the studio knows without AI

- **Document digester:** a connector source, then extract, match, file.
- **Watch and alert:** a sensor, function or threshold, then notify or propose.
- **Weekly report:** queries, then a draft, then a send needing approval.
- **Follow-up chaser:** open items older than N days, then a reminder by chat.
- **Data tidy:** match records, then a suggestion queue.

With Claude, the studio can compose outside these templates, but only from registered tools.

## 7. Connectors (synthetic)

`src/connectors/` holds synthetic Microsoft 365, Google Workspace and ERP stand-ins, with the real APIs' resource shapes:
- Graph `message`, `driveItem` and `channelMessage`;
- Gmail `message`;
- Drive `file`;
- Sheets `values`;
- ERP `PurchaseOrder`, `GoodsReceipt`, `SupplierInvoice` and `Supplier`.

The CMMS is the existing ontology (work orders, assets).

**Seed data:**
- **Accounts inbox:** 30 days of supplier mail. Invoices arrive as PDFs; some are phone photos of paper invoices; there are delivery notes and a few irrelevant messages.
- **ERP:** 40 purchase orders, with goods receipts.
- **SharePoint:** an "Accounts / Supplier invoices / <supplier> / <yyyy-mm>" folder tree holding last month's filed invoices. This is the history the digester learns "the right place" from.

The traps are deliberate:
- an invoice with no PO number;
- a total that differs from the PO;
- a duplicate invoice;
- a smudged photo;
- a supplier who has changed bank details. This one always goes to a person, as a fraud signal.

**My call, because Matthew had no answer for today's invoice flow:**
1. Invoices reach the works' shared Accounts inbox, or arrive as photos in chat.
2. The stores and admin clerk files each one into the supplier's SharePoint folder for the month.
3. The clerk matches it to the PO and goods receipt in the ERP.
4. Finance approves payment.

The digester automates steps 2 and 3 and drafts the match. Step 4 always stays with a person.

## 8. The document digester (the first studio agent)

1. **Read.** A new item in the connected source (mail attachment, folder, or chat photo).
2. **Extract fields,** each graded:
   - supplier, invoice number, date, PO number, lines, VAT and total, and bank details;
   - **read clearly** (from the text layer, or Claude vision at high confidence);
   - **worked out** (for example the PO from supplier and amount);
   - **unsure** (smudged figures, two candidate POs).

   Cells use project 1's `{key, value, grade, region, reasoning, reviewed}` shape. Unsure cells go to the existing review grid.
3. **Match.**
   - **Three-way match:** PO, goods receipt and invoice, within tolerance (the builder sets it; 2% by default).
   - **Duplicates:** the same supplier, number and total is flagged.
   - **Bank details:** a change in bank details always goes to a person.
4. **File.** It proposes a destination learnt from history: this supplier's folder for the month, the same name pattern. Filing a copy is `act` once the agent is bounded.
5. **Post.** It drafts an ERP invoice match against the PO. **Posting or flagging for payment is `propose`, always**, because it moves money (§4.4).
6. **Audit.** Every field records its source region in the document.

## 9. Recommendations

A nightly **Recommender** (agent 21) reads, for each person, only what that person's own view allows. It looks for these signals:

| Signal | Where it is read | Example suggestion |
|---|---|---|
| The same manual action, repeated with the same shape | audit log, decisions, file moves in the connector | "You filed 23 invoices into supplier folders by hand last month: a document digester could draft these" |
| Repeated checks | reading history, runs of Ask | "You open F07 head loss every morning: a watch agent could tell you only when it moves" |
| Slow decisions | event-to-approval time per owner and shift | "Sampling rounds wait 3 h for approval on night shift: add a backup approver" |
| Repeated overrides with similar reasons | feedback | "You rejected Scheduler's proposal 5 times for 'artisan on leave': add leave to its evidence" |
| Steps that run long or collect notes | Procedure Steward's findings | "Step 6 runs 60% over: a pre-job check agent" |
| Exceptions that keep landing on one person | issue assignment | "Supplier queries always go to you: a chaser agent" |

**What each suggestion carries:**
- the evidence, with links;
- a draft decision statement, from a template, in shadow mode;
- an estimate of the time saved, taken from the measured history.

**What happens next:**
- **Accept** opens it in the studio.
- **Dismiss** asks why (optional) and suppresses that signal for 30 days.
- **People are never ranked or compared.** Suggestions go to the person themselves, plus that person's supervisor only for approval-delay signals. This follows the Phase 2 performance rule: "names steps, never people".

## 10. Screens

- **Agents (existing view): the harness.** Each agent card shows its decision statement as sentences, its mode, its shadow record against its promotion criteria, its approver, and its off switches. Promote and Demote need four eyes.
- **Studio (new).** Describe → rule/agent/person → read back and edit → replay → start in shadow.
- **Suggestions (new, inside the Studio).** "Suggested for you", each with its evidence.
- **IT catalogue (new; IT administrators only).** Connectors, actions, roles, levels, and sign-off.
- **RCA.** From an alert, a detection or the Plant view, **Find root cause** opens the RCA report. Each cause links into the Region, the Plant upstream view, or a trend.
- **Document review.** The digester's unsure cells appear in the project 1 review grid, with the document image beside them.

## 11. Journeys

- **J23, the harness (P-002).** Agents → Process Watch.
  - Its decision statement reads back; its approver is P-004.
  - Turn `request_setpoint_change` off for this agent; its open proposal is withdrawn.
  - Turn it back on.
- **J24, root cause (P-001).** The F07 alert → **Find root cause**. The report ranks:
  1. F07 media (local);
  2. the storm plume (contributing; detection confirmed; raw-water onset 2.2 h before F07, inside the travel window).

  DP-2 is rejected as too late. "Show me" on the plume opens the Region on the plume.
- **J25, the studio (an accounts clerk, a new synthetic role).** The clerk types: "When a supplier invoice comes into the accounts inbox, read it, check it against the PO and file it in the right supplier folder."
  - The studio recommends an **agent** and composes a digester statement: file at `act` (locked until IT signs it off), ERP match at `propose`, approver the finance officer.
  - Replay over 14 days: 23 of 25 filings agree with what the clerk did, 1 unsure total, 1 duplicate caught.
  - Start in shadow.
- **J26, IT (an IT administrator).** The catalogue → approve "m365.files write" for the accounts clerk role → the clerk's agent can now be promoted by the finance officer (four eyes).
- **J27, suggestions (P-028).** The studio suggests a watch agent for the HLP-B bearing checks P-028 does each morning, with the evidence. Dismiss it, giving "I like to look myself"; it does not come back.
- **J28, AI off.** With no API key, J25 still works on the text-layer documents and the keyword planner. The studio says Claude is off.

## 12. Build order (two plans)

- **3a: the harness and the root-cause agent.** Goals H and R:
  - the decision statement;
  - the modes, shadow actions, promotion and demotion;
  - freshness;
  - constraints;
  - off switches;
  - better approval cards;
  - the RCA agent with its evals.

  This changes how every existing agent is governed, so it goes first.
- **3b: the studio, connectors, the digester and recommendations.** Goals S, C, D and E, together with the IT catalogue.

Each gets its own plan, a TDD build, a browser check and a final review, as in projects 1 and 2.

## 13. Theirs: confirmed with Matthew

1. **Builder:** a non-technical person, low-code literate, who describes the agent in their own words.
2. **Tools:** built from connectors the builder already uses (Microsoft 365, Google Workspace, ERP, CMMS); IT authorises by role.
3. **First agent:** the document digester (images, PDFs and invoices, filed to the right place).
4. **Priority:** the harness first; default agents kept; a space to design agents; recommendations from how people work.
5. **Today's invoice flow:** no answer; my default is stated in §7.

## 14. My calls (Matthew to check while reading)

1. **Shadow by default** for every studio and recommended agent; promotion on evidence and four eyes; never on time.
2. **The rule / agent / person screen** comes first in the studio.
3. **Money is propose-only,** always. Bank-detail changes always go to a person.
4. **Connectors are synthetic** with real API shapes. Real Microsoft Graph, Google and ERP connections come later behind the same interface.
5. **An IT administrator** is a new flag on Person (`itAdmin`), separate from clearance.
6. **Recommendations go only to the person themselves.** People are never compared. Dismissals are suppressed for 30 days.
7. **Two plans:** 3a (harness and RCA), then 3b (studio, connectors, digester, recommendations).
8. **The root-cause agent is deterministic**, with Claude only for wording. It must reproduce the F07 answer and say "Insufficient evidence" when it can't.
9. **Accounts roles:** a synthetic accounts clerk and finance officer are added to the people.
10. **AI-optional:** every flow works without an API key, and the studio says when Claude is off.

## 15. Left to the builder

- The exact `AgentSpec` storage and how the 19 manifests map into it.
- The synthetic document set: the layout of invoice PDFs and photos, which must carry a text layer.
- Keyword planner rules for the templates.
- The ShadowAction matching rule. It must be deterministic and documented.
- Promotion thresholds per template, chosen sensibly and shown to the user.
- Card layouts within the NOVATEK design system.

## 16. Verification

- **Unit tests:**
  - the decision statement round-trips (sentences ↔ record);
  - an agent never exceeds its builder's view or role;
  - stale evidence refuses a write;
  - hard constraints cannot be removed;
  - `onTimeout` never applies;
  - shadow actions are never invoked;
  - matching rules;
  - promotion refused without its criteria or without four eyes;
  - automatic demotion;
  - the off switch withdraws proposals;
  - relative revert.
- **RCA evals:** the F07 case, the "insufficient evidence" case, and a case with a local fault and no plume.
- **Studio:** the planner turns the J25 text into the expected statement; IT locks hold; replay counts match the seeded history.
- **Digester:** grading on the five seeded traps; duplicates and bank changes are never auto-filed; money actions are propose-only.
- **Recommender:** each signal produces its suggestion from seeded history; a dismissal suppresses it; nobody sees another person's suggestions.
- **Browser:** journeys J23 to J28. Then a final whole-branch review per plan.
