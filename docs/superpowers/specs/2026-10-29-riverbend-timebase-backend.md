# Riverbend on Timebase: Atlas as the main backend (amendment)

Status: **approved 2026-10-29.** The spike is done (§4), and Matthew chose go. This amends `2026-10-29-riverbend-knowledge-graph-design.md`, and every
rule in that design still applies unless this document changes it. Vendor docs: `docs/vendor/timebase/`.

## 1. Decision

Timebase is the data backend and the WaterOS harness stays the agent layer. Gage, Timebase's own harness, is
not used.
- **Atlas** is the knowledge graph: typed ontology, instance maps, live and historical binding, Cypher, REST, MCP,
  and Git-backed branches.
- **Historian** is underneath Atlas and stores every reading (free, no tag limits).
- **Pulse** issues identity (OIDC), tokens and certificates.

Atlas won over Historian-only because Historian alone covers just the live layer, and Atlas is what this design
was about to hand-build.

## 2. Architecture

```
 synthetic generator (telemetry.mjs, S1–S7) ──REST write──▶ Historian  (90-day readings, tags AIT-101…)
 crosswalk / layout / scene-meta ──loader──▶ Atlas  (Riverbend domain: ISA-95 + ISA-5.1 library, instance
                                                     maps, bindings → Historian, on a branch)
 docs (P&IDs, SOPs, reports)      ──────────▶ spike (e) decides: Atlas file ingest or keep our Chunks
 alarms / events / anomalies      ──SQL────▶ Postgres table → Atlas Postgres connector (ISA-18.2 types)
 Pulse ── OIDC client-credentials for our harness
 WaterOS harness ──MCP──▶ Atlas MCP (component token = 37 read tools) + Historian MCP
                          + thin WaterOS MCP: documents/read, locate (3D), people gate (POPIA)
 3D overlay (three.js) ── Atlas REST + WebSocket (internal); public website = static export, prepared answers
```

## 3. What changes in the base design

- **Physical layer.** Moves into Atlas. Our crosswalk, tags, layout and scene-meta stay the source of truth, and a
  loader writes them into the Riverbend domain on a branch. GeometryRef becomes a property on each asset.
- **Live layer.** Readings go into Historian and never into the graph. The generator backfills them through the
  Historian REST API.
- **Tools.**
  - Atlas and Historian MCP cover: search, get, neighbours, upstream/downstream, readings, cypher.
  - WaterOS keeps: documents/read, locate, the people gate.
- **Neo4j mirror.** Dropped, because Atlas has Cypher. Matthew confirmed this on 2026-10-29; it replaces his earlier
  "build the mirror" answer.
- **Spike deployment (Matthew, 2026-10-29).** The stack lives at `E:\Timebase`, outside the repo and outside
  OneDrive. It is reachable from this computer only (`localhost`). The Gage AI provider is left for later.
- **In-memory `ontology.mjs`.** Stays for tests and the offline website export. CI never needs Timebase.
- **The steps 0–1 plan** (`plans/2026-10-29-riverbend-canonical-plant.md`) stands as written. Steps 2, 5 and 6
  get re-planned against Atlas once the spike passes.

## 4. Spike (throwaway): six checks

| # | Check | Evidence needed | Result |
|---|---|---|---|
| a | List the Atlas MCP tools for a component token | Tool list output | **pass.** Atlas returns 37 tools, all reads (including `ExecuteCypherQuery`). Historian MCP returns 10 reads. Both include `get_logs`. |
| b | Run a Cypher upstream query on a 5-node slice (RWP-1 → MIX → CL-1 → F07 → RES-2) | Query and result | **pass.** See the notes below. |
| c | Write and read AIT-157 through the Historian REST API, including a 90-day backfill | Request, response and counts | **pass.** See the notes below. |
| d | See an Atlas property bound to a Historian tag show a live value | Subscribe output or screenshot | **pass.** See the notes below. |
| e | Check whether Atlas file ingest yields citable chunks for a PDF SOP | Sample output | **no-go (from the docs).** `data-source-coverage.md`: "No file connector in Atlas or the Collector". None of Connect's 13 plugins reads files. The documents layer stays in WaterOS; Atlas may hold `Document` nodes that link to it. |
| f | Create a read-only Pulse client and confirm a 401/403 on a write | Token claims and the refused call | **no-go as stated.** Pulse has no read-only client. The `WaterOSSpike` token (aud `Atlas`, `Historian`, no roles) created a branch, domain, types and instances, and published its own draft. Read-only access is enforced by giving agents MCP only (§5). |

Notes on (b):
- Upstream of RES-2 returns F07, CL-1, MIX and RWP-1 with their KKS codes. Downstream of CL-1 returns F07 and RES-2.
- Writes went into a per-client draft branch (`v2-draft/waterosspike-…`). Only an explicit publish moved them to `spike-riverbend`. `main` stayed empty.
- Beta bugs: a property POST without `attachToTypes`, or an instance POST with short type names, returns a 500 instead of a 400. Instance writes need full URNs for type, property keys and edge endpoints. Edges need an `instanceId`.
- **Cypher trap, confirmed live:** a type on the far end of a traversal is silently ignored. `(p:PumpStation)-[:feeds*]->(f:Filter)` returned MIX, CL-1, F07 and RES-2. The harness must lint Cypher (far-end labels → `WHERE f:Filter`; inline maps; `.Label` and `.entityId`).
- Only `atlas-common` and `atlas-core` ship. `isa95-common` is named in the docs but absent, so the Riverbend vocabulary is ours to author.

Notes on (d):
- **Source.** Connect source `historian-rb` (`con_596069`) reads `Timebase.Historian` at `historian:4512` over TLS. It authenticates with the `Connect` client and serves dataset entry `Riverbend/Filters` → `Riverbend`.
- **Binding.** F07 `Turbidity` (TVQ) is bound to `historian-rb/Riverbend/AIT-157`.
- **Result.** A feeder wrote one point a minute. Atlas returned 0.721 at 20:31:35, the same second the feeder wrote it.
- **One query, graph plus live value.** `MATCH (r:Reservoir)<-[:feeds*1..10]-(u) … RETURN u.Label, u.kks, u.Turbidity` returns the upstream chain with KKS codes and F07's live TVQ.
- **Traps for the loader and harness:**
  - (1) `PATCH …/instance-maps/instances/{id}` **replaces** the whole `properties` map, so a partial patch silently deletes the other properties. Always send the full set.
  - (2) The first read after a compile can return an empty TVQ (`0001-01-01`, `Quality 0`) until the subscription warms. Treat that as no data, not as a zero reading.
  - (3) Unknown `/api/v1/...` routes return `200 text/html` (the web app). Assert `Content-Type`.

Notes on (c):
- Dataset `Riverbend` was created with `lda` = 120. 2 × 129,601 one-minute points (AIT-157 and PDT-157) were written oldest-first: all accepted, no points rejected.
- Read-back: AIT-157 stored 123,324 points (unchanged values are skipped). Day 1 reads 0.09–0.16 NTU, the fault day 0.69–0.76.
- The multi-tag read returns `{s, e, tl:[{t, d}]}`, and the range end looks exclusive.
- The current generator puts the F07 fault on day 12 of any window. The step-3 generator rework (S1–S7) fixes that.

### Deployment (2026-10-29)

The stack is installed at `E:\Timebase` with images `2.0-gc4`. All seven components run, and all six component
secrets are accepted by Pulse. Every runbook check passed (Phases 1–8). The Pulse root CA is trusted on this PC,
and the Administrator password has been changed. The Gage catalog shows only the seeded `anthropic/claude`, with
no key set, which is expected. Total memory use is about 0.7 GB.

Notes from the install:
- Python on this PC cannot verify Docker Hub's TLS ("certificate has expired"). The chain Docker Hub serves is
  valid, so the likely cause is an expired certificate in the Windows store. I ran the runbook's tag lookup on
  JSON fetched with curl instead, which still verified TLS.
- Atlas logs "Failed to install Pulse Root CA to OS trust store". This is harmless: the container runs as a
  non-root user and trusts Pulse within its own process.

### Finding from the docs (bears on check f)

Atlas's `/api/v1` and `/i3x/v1` accept any Pulse bearer whose `aud` includes `Atlas`. **No scope and no role
are checked on the machine plane, and that includes the routes that change the model**
(`developer/rest-api/api-authentication-and-versioning.md` Part 3). Only MCP narrows a component token to the
37 read tools. Pulse has no read-only client, so read-only access is enforced by *which interface* an agent is
given, not by the token.

### Go/no-go by layer (spike result, 2026-10-29)

**Decision (Matthew, 2026-10-29): go, on the terms below.** The canonical-plant plan (steps 0–1) is built
subagent-driven. The step 2/5/6 plan is then written against Atlas.

| Layer | Verdict | Basis |
|---|---|---|
| Physical (assets, process flow, KKS) | **Go: Atlas** | (b). We author our own Riverbend vocabulary, because no ISA-95 library ships. The loader writes full URNs and full property sets, works in a draft, and publishes to a non-main branch. |
| Live (readings) | **Go: Historian + Connect binding** | (c) and (d). The 90-day backfill works, and bound properties track live writes. |
| Documents (SOPs, P&IDs, reports) | **No-go in Atlas. Stays in WaterOS** | (e). There is no file connector. Atlas may hold `Document` nodes that link to WaterOS passages by id. |
| Identity and access | **Go, with conditions** | (a) and (f). Pulse handles service auth well, but no read-only client exists. Agents use MCP only (37 reads). The POPIA people gate stays in WaterOS. |
| Alarms, events, anomalies | **Not yet tested** | Planned via a Postgres table and Connect's Postgres plugin. Test it in the step 2/5/6 plan. |

**Spike state left running (throwaway):**
- Atlas: branch `spike-riverbend` with domain `riverbend` (5 assets, 4 edges).
- Historian: dataset `Riverbend` (AIT-157, PDT-157).
- Connect: source `historian-rb`.
- Pulse: client `WaterOSSpike`, whose secret is in `E:\Timebase\secrets\`.
- Spike scripts: in the session scratchpad, not in the repo.

### Status (2026-10-30)

Steps 2, 5 and 6 are built (plan `2026-10-30-riverbend-atlas-physical-tools.md`). Live verification is partly blocked.

- **Historian: done.** `scripts/timebase/backfill.mjs` loaded 117 tags and 2,358,837 points into dataset `Riverbend`, with 0 rejected.
- **Atlas: loaded, not compiled.** `scripts/timebase/load-atlas.mjs` wrote the model and published it to branch `riverbend`. The compile is refused by the unlicensed install's Instances entitlement: the limit enforced is 500 against 1,000 documented, and the model counts 5,814 instances including property strategies. Until the install is licensed, the Atlas backend cannot be read live; the memory backend serves the same tools.
- **New quirk:** `[word...]` in a static string is read as a placeholder, and there is no escape. The loader must avoid it in labels and descriptions.
- The alarms row above is unchanged.

## 5. Protect rules (in addition to the base design)

- Harness agents reach Atlas **only through MCP** with a component token. They never get the raw token or REST
  access. Only the loader and generator scripts use REST, and they write to a non-main branch or to the
  synthetic Historian dataset.

- Timebase 2.0 is a beta. It runs on this machine against synthetic data only and never points at a control
  system. Nothing built in the beta is expected to migrate.
- Agents get Pulse component (client-credentials) tokens only, which means Atlas read tools only. Model writes
  happen on a branch, through the loader, and a human promotes them.
- No Bridge target is configured. Person, Presence and Channel data never enters Atlas or Historian.
- Fictional-name rule: only Riverbend ids and tags are loaded. Nothing from the hidden reference site goes in.
- Secrets never enter the repo, logs or agent context. This follows the vendor runbook's rules 5, 9 and 10.
