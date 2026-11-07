# ADR 0001: Production stack. Timebase at the edge, a lean GCP core

Status: **proposed 2026-11-06.** This narrows `docs/superpowers/specs/2026-10-29-riverbend-timebase-backend.md` (see §1 there).

## Context

Three sources describe the stack, and they disagree:

- **ARC-001 and the PRD** (`../ARCHITECTURE-CANONICAL.md`, `../03-PRD-Water-Works-OS.md`): Neo4j, Graphiti, Qdrant and TimescaleDB on GCP `africa-south1`, with Claude on Vertex AI.
- **The repo decision** (2026-10-29 Timebase backend spec): Timebase Atlas and Historian are the data backend.
- **What runs today:** an in-memory ontology (`src/ontology.mjs`) on Cloud Run in `africa-south1` (`docs/CLOUD-RUN.md`), with Claude through the Anthropic API (`src/llm.mjs`). Timebase is used only from a local machine, through `WWOS_KG_BACKEND=hybrid`.

The candidates assessed were:

- **Flow Software:** Timebase Historian and Atlas AI.
- **GCP:** Spanner Graph or Neo4j Aura, Vertex AI (Gemini and GraphRAG), Pub/Sub, Dataflow, Apigee, and GKE or Cloud Run.

## Evidence

- **Scale today.**
  - About 1k ontology objects and 5,814 Atlas instances.
  - 117 tags and 2,358,837 historian points.
  - The PRD target (NFR-02) is 50k tags at 1 s, 200 users and 10k agent runs a day per tenant. None of this is built.
- **Timebase spike** (spec §4):
  - Checks a to d pass: MCP, Cypher upstream, the 90-day backfill and Historian binding.
  - Check e is no-go: Atlas has no file connector.
  - Check f is no-go: Atlas REST checks no role or scope, including on the routes that change the model.
  - The full model cannot compile unlicensed (500 instance and 100 type caps).
  - The Pulse grace period ends **12 Nov 2026**.
  - The beta runs on one PC at 127.0.0.1, and the vendor says nothing built in the beta is expected to migrate (`docs/vendor/timebase/`).
- **Code shape.**
  - Queries are Cypher: `lintCypher` and `ATLAS_QUERIES` in `src/kg/`.
  - Retrieval is cited tool calls (`src/kg/tools.mjs`, with `answerEvidence`) and lexical search, with no embeddings.
  - The model is Claude only.
  - Control writes are forbidden (`HARD_CONSTRAINTS` in `src/harness.mjs`, BR-06).
- **Constraints.**
  - Storage and processing stay in `africa-south1`, and inference is disclosed as cross-border under POPIA s72.
  - OT sites may be offline, which brings the 72 h edge buffer requirement.
  - The PRD requires SSO, MFA and IEC 62443 conduits.
  - `POST /mcp` currently trusts the `x-acting-user` header.

## Decision

| Layer | Pick | Rejected or deferred |
|---|---|---|
| Plant edge (OT) | **Timebase Historian and Collectors** (OPC UA/MQTT) on site. The cloud reads only. | Condition: a GA build, not the beta. Readers already exist (`HISTORIAN_READ`, `historianTags`). |
| Ontology / KG | **Neo4j Community, self-hosted in `africa-south1`** (a GCE VM, or a GKE Autopilot StatefulSet), one per tenant as ARC-001 says. Keep the in-memory store for the pilot. | **Atlas: on hold** until it is GA, has RBAC and has a licence. **Neo4j Aura:** no `africa-south1` region found (2026-11-06), so residency fails. **Spanner Graph:** Enterprise edition appears to be sold in Johannesburg, but it carries a cost floor, uses GQL while our code is Cypher, and its scale is not needed at about 10⁴ nodes per tenant. |
| AI | **Claude on Vertex AI**: the same model, under GCP IAM, billing and VPC-SC. The cited KG tools *are* the graph retrieval. | **Vertex GraphRAG** is a reference pattern; our tools already do it deterministically. **Gemini** only if the Applied AI programme requires it, or Document AI for PDF ingest (not built). **Atlas AI / Gage:** not used, as already decided. |
| Streaming | **Pub/Sub** (edge to cloud, outbound only), then a Cloud Run subscriber, then **BigQuery** for rollups and the 10-year retention | **Dataflow:** deferred until sustained thousands of messages a second need windowing. **TimescaleDB:** Cloud SQL can't run it, so it would mean self-hosted operations for no gain. |
| API edge | **Cloud Run with IAP or Identity Platform** (SSO and MFA), plus Cloud Armor if it goes public | **Apigee:** no third-party API product to manage, and costly. The real gap is replacing the trust in `x-acting-user`. |
| Compute | **Cloud Run**, one service per tenant | **GKE** only if Neo4j is self-hosted on it. There is no GPU and it is one Node process. |

## Consequences

- **Before 12 Nov 2026:** license Pulse, or treat `hybrid` as the only Timebase mode.
- **Deltas for ARC-001 and the PRD** (outside this repo, not edited here):
  - TimescaleDB is replaced by Historian at the edge and BigQuery in the cloud.
  - Neo4j is self-hosted, not Aura.
  - Qdrant is deferred, because there are no embeddings in v1.
- **Separate tasks:** real authentication in front of `/mcp`, the Pub/Sub ingest, and a Neo4j adapter behind the `src/ontology.mjs` API.

## Open checks

- **Aura region.** Re-check the Aura region list in the console before ruling it out for good. The public docs found list no African GCP region.
- **Spanner Graph.** Confirm it in `regional-africa-south1`, but only if the Neo4j choice is revisited.
- **Timebase GA.** Confirm the GA release date and the licence price before committing the edge layer.
