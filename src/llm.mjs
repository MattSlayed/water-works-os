// Optional Claude call for Copilot and Ask answers. Returns null when no credentials are configured, the SDK is not
// installed, the request fails, or the model declines; callers then use their deterministic answer.
// Inference is cross-border and disclosed under POPIA s72 (NVT-PROJ-BBR-ARC-001 §4).

export const MODEL = "claude-opus-5-5";
let client = null;

export const llmEnabled = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.WWOS_LLM === "1");

export async function askClaude({ system, context, question }) {
  if (!llmEnabled()) return null;
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    return null;
  }
  try {
    client ??= new Anthropic();
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system,
      messages: [{ role: "user", content: `Context from the works ontology (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${question}` }]
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return text || null;
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) console.warn("[llm] rate limited; using the deterministic answer");
    else if (error instanceof Anthropic.AuthenticationError) console.warn("[llm] credentials rejected; using the deterministic answer");
    else if (error instanceof Anthropic.APIError) console.warn(`[llm] API error ${error.status}; using the deterministic answer`);
    else console.warn(`[llm] ${error.message}; using the deterministic answer`);
    return null;
  }
}
