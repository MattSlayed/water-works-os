import { test } from "node:test";
import assert from "node:assert/strict";
import { MODEL, claudeProvider, claudeClient, requestExtras, llmEnabled, askClaude } from "../src/llm.mjs";

const VERTEX = { WWOS_LLM_PROVIDER: "vertex", WWOS_VERTEX_PROJECT: "p", WWOS_VERTEX_REGION: "europe-west1" };

test("requestExtras: first-party keeps the server-side fallback, Vertex sends none", () => {
  assert.deepEqual(requestExtras("anthropic"), { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  assert.deepEqual(requestExtras("vertex"), {});
});
test("claudeProvider: Vertex needs a project; a key means first-party; nothing means off", () => {
  assert.equal(claudeProvider({ WWOS_LLM_PROVIDER: "vertex", WWOS_VERTEX_PROJECT: "p" }), "vertex");
  assert.equal(claudeProvider({ WWOS_LLM_PROVIDER: "vertex" }), null);
  assert.equal(claudeProvider({ ANTHROPIC_API_KEY: "k" }), "anthropic");
  assert.equal(claudeProvider({}), null);
});
test("llmEnabled takes an env and follows claudeProvider", () => {
  assert.equal(llmEnabled(VERTEX), true);
  assert.equal(llmEnabled({}), false);
});
test("claudeClient builds AnthropicVertex with the project, region and model", async () => {
  const c = await claudeClient({ ...VERTEX, WWOS_LLM_MODEL: "m" });
  assert.equal(c.provider, "vertex"); assert.equal(c.model, "m"); assert.equal(c.client.constructor.name, "AnthropicVertex");
  assert.equal(c.client.projectId, "p"); assert.equal(c.client.region, "europe-west1");
});
test("claudeClient: default model, one client per project/region/model, null when off", async () => {
  const a = await claudeClient(VERTEX), b = await claudeClient({ ...VERTEX });
  assert.equal(a.model, MODEL);
  assert.equal(a.client, b.client);
  assert.notEqual(a.client, (await claudeClient({ ...VERTEX, WWOS_VERTEX_REGION: "us-east5" })).client);
  assert.equal(await claudeClient({}), null);
});
test("claudeClient: a key gives the first-party client", async () => {
  const c = await claudeClient({ ANTHROPIC_API_KEY: "sk-test-not-a-key" });
  assert.equal(c.provider, "anthropic"); assert.equal(c.client.constructor.name, "Anthropic");
});
test("Vertex without a region: one warn line, null client, and askClaude falls back", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  delete process.env.CLOUD_ML_REGION; // the SDK would take its region from here
  const env = { WWOS_LLM_PROVIDER: "vertex", WWOS_VERTEX_PROJECT: "p" };
  assert.equal(await claudeClient(env), null);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^\[llm\] cannot build the vertex client: .*region/i);
  Object.assign(process.env, env);
  assert.equal(await askClaude({ system: "s", context: {}, question: "q" }), null);
  assert.equal(warn.mock.callCount(), 2);
});
