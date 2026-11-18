// Wires the works together: ontology, telemetry, audit, actions, agents.
import { generateWorks } from "./generate.mjs";
import { createOntology } from "./ontology.mjs";
import { createTelemetry } from "./telemetry.mjs";
import { createAudit } from "./audit.mjs";
import { createActionService, actionIds } from "./actions.mjs";
import { createRuntime } from "./agents.mjs";
import { createCopilot } from "./copilot.mjs";
import { createChannels, channelIds } from "./channels.mjs";
import { seedPlant, createPlantService } from "./plant.mjs";
import { seedKg } from "./kg/seed.mjs";
import { createTrackers } from "./trackers.mjs";
import { createConnectors } from "./connectors/index.mjs";
import { overlay, trackChanges } from "./state.mjs";

// state: a saved snapshot (src/state.mjs), laid over a fresh seed so a redeploy's new seed objects still appear.
// The start-of-shift events at the end are already in it, so they run only on a fresh start.
export function createSystem({ seed = 7, state = null } = {}) {
  const ont = createOntology(generateWorks(seed));
  seedPlant(ont);
  seedKg(ont);
  const changes = trackChanges(ont);
  if (state) { overlay(ont, state.ont); actionIds.reserve(state.ids.actions); channelIds.reserve(state.ids.channels); }
  const tel = createTelemetry({ ont, seed, start: "2026-10-01T00:00:00Z", startCursorMin: state?.cursor });
  const trackers = createTrackers({ ont, seed, start: "2026-10-01T00:00:00Z", minutes: 14 * 24 * 60 });
  const audit = createAudit(state?.audit);
  const connectors = createConnectors({ seed, nowIso: tel.now });
  trackers.syncTo(ont, tel.cursor(), audit);
  const actions = createActionService({ ont, audit, clock: tel.now, tel, connectors });
  const runtime = createRuntime({ ont, tel, actions, audit, connectors, state: state?.runtime });
  const copilot = createCopilot({ ont, tel, actions, runtime });
  const channels = createChannels({ ont, tel, actions, runtime, copilot, audit });
  const plant = createPlantService({ ont, tel, actions, audit });
  if (state) return { seed, ont, changes, tel, trackers, connectors, audit, actions, runtime, copilot, channels, plant };
  // the clerk photographed a paper invoice at the stores counter and sent it on the works chat (plan 3b Task 1)
  const cp = connectors.chatPhoto;
  ont.upsert({ id: "MSG-CHAT-PHOTO", type: "Message", channelId: cp.channelId, direction: "in", from: "P-043", at: cp.at, text: "Invoice from the stores counter, photo attached", media: [cp.attachmentId], audience: ont.get(cp.channelId).audience,
    prov: { source: "CHANNEL-STUB", source_uri: "synth://channel-stub/MSG-CHAT-PHOTO", source_version: "v1", extracted_at: cp.at, confidence: 1 } });
  ont.link("MSG-CHAT-PHOTO", "IN", cp.channelId);
  // the RES-2 contractor's open issue, raised through the action service so it has its audit entry (Region design §4.4)
  actions.invoke({ action: "raise_issue", params: { title: "Liner seam test failed on panel 14: re-weld before the cure", projectId: "PRJ-RES2" }, actor: { kind: "person", id: "P-004", clearance: ont.get("P-004").clearance } });
  // scenes already processed when the shift starts have been through Geo Watch (Region design §5.4)
  runtime.run("Geo Watch", { actingUser: { id: "SYSTEM", kind: "person", clearance: "manager", role: "system" }, trigger: { kind: "event", on: "Scene ingested" }, chain: false });
  return { seed, ont, changes, tel, trackers, connectors, audit, actions, runtime, copilot, channels, plant };
}
