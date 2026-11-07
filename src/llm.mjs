// Optional Claude call for Copilot and Ask answers. Returns null when no credentials are configured, the SDK is not
// installed, the request fails, or the model declines; callers then use their deterministic answer.
// Inference is cross-border and disclosed under POPIA s72 (NVT-PROJ-BBR-ARC-001 §4).
// Two routes to Claude: the first-party API (a key, local runs) or Google Vertex AI (WWOS_LLM_PROVIDER=vertex, the
// service account on Cloud Run, no key).

export const MODEL = "claude-opus-5-5";
const clients = new Map();

export function claudeProvider(env = process.env) {
  if (env.WWOS_LLM_PROVIDER === "vertex" && env.WWOS_VERTEX_PROJECT) return "vertex";
  return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.WWOS_LLM === "1" ? "anthropic" : null;
}

export const llmEnabled = (env = process.env) => claudeProvider(env) !== null;

export const llmModel = (env = process.env) => env.WWOS_LLM_MODEL || MODEL;

// Vertex AI serves neither server-side fallbacks nor that beta.
export const requestExtras = (provider) => provider === "anthropic" ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};

// One client per provider|project|region|model; null when off or the SDK is not installed.
export async function claudeClient(env = process.env) {
  const provider = claudeProvider(env);
  if (!provider) return null;
  const model = llmModel(env), key = [provider, env.WWOS_VERTEX_PROJECT, env.WWOS_VERTEX_REGION, model].join("|");
  if (!clients.has(key)) {
    try {
      if (provider === "vertex") {
        const { AnthropicVertex } = await import("@anthropic-ai/vertex-sdk");
        clients.set(key, new AnthropicVertex({ projectId: env.WWOS_VERTEX_PROJECT, region: env.WWOS_VERTEX_REGION }));
      } else {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        clients.set(key, new Anthropic());
      }
    } catch (error) {
      // a missing region or SDK must be visible, not a silent fall back; the message carries no secret
      console.warn(`[llm] cannot build the ${provider} client: ${error.message}; using the deterministic answer`);
      return null;
    }
  }
  return { client: clients.get(key), model, provider };
}

// content, when given, is the user turn as content blocks (an image and its instructions, say) instead of context + question.
export async function askClaude({ system, context, question, content }) {
  const c = await claudeClient();
  if (!c) return null;
  try {
    const response = await c.client.beta.messages.create({
      model: c.model,
      max_tokens: 16000,
      ...requestExtras(c.provider),
      output_config: { effort: "medium" },
      system,
      messages: [{ role: "user", content: content || `Context from the works ontology (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${question}` }]
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return text || null;
  } catch (error) {
    // API errors carry a status in both SDKs; the message can echo request detail, so only the status is logged
    if (error.status === 429) console.warn("[llm] rate limited; using the deterministic answer");
    else if (error.status === 401) console.warn("[llm] credentials rejected; using the deterministic answer");
    else if (error.status) console.warn(`[llm] API error ${error.status}; using the deterministic answer`);
    else console.warn(`[llm] ${error.message}; using the deterministic answer`);
    return null;
  }
}
