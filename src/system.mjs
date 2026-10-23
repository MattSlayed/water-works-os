// Wires the works together: ontology, telemetry, audit, actions, agents.
import { generateWorks } from "./generate.mjs";
import { createOntology } from "./ontology.mjs";
import { createTelemetry } from "./telemetry.mjs";
import { createAudit } from "./audit.mjs";
import { createActionService } from "./actions.mjs";
import { createRuntime } from "./agents.mjs";

export function createSystem({ seed = 7 } = {}) {
  const ont = createOntology(generateWorks(seed));
  const tel = createTelemetry({ ont, seed, start: "2026-10-01T00:00:00Z" });
  const audit = createAudit();
  const actions = createActionService({ ont, audit });
  const runtime = createRuntime({ ont, tel, actions });
  return { seed, ont, tel, audit, actions, runtime };
}
