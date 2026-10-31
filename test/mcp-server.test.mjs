// WaterOS as an MCP server: the clearance-filtered KG tools over POST /mcp (JSON replies, hand-written JSON-RPC).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer, kgToolsFor } from "../src/server.mjs";

const CLB = "PM-RB-A:STR-16UHC01"; // the chlorine house, zone Z06 (supervisor and above)
let srv, base, sys;
before(async () => {
  sys = createSystem({ seed: 7 });
  srv = createServer(sys);
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

const personWith = (c) => sys.ont.list("Person", (p) => p.clearance === c)[0].id;
const rpc = async (msg, { as = personWith("technician"), raw } = {}) => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...(as ? { "x-acting-user": as } : {}) }, body: raw ?? JSON.stringify({ jsonrpc: "2.0", ...msg }) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};
const call = async (name, args, opts) => {
  const r = await rpc({ id: 1, method: "tools/call", params: { name, arguments: args } }, opts);
  return { ...r, result: r.json?.result, data: r.json?.result && JSON.parse(r.json.result.content[0].text) };
};

test("initialize then list: a technician gets 12 tools and no cypher", async () => {
  const init = await rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal(init.status, 200);
  assert.ok(init.headers.get("mcp-session-id"));
  assert.equal(init.json.id, 1);
  assert.deepEqual(init.json.result.capabilities, { tools: {} });
  assert.ok(init.json.result.protocolVersion && init.json.result.serverInfo.name);
  const note = await rpc({ method: "notifications/initialized" });
  assert.equal(note.status, 202);
  assert.equal(note.json, null);
  const list = await rpc({ id: 2, method: "tools/list" });
  const names = list.json.result.tools.map((t) => t.name);
  assert.equal(names.length, 12);
  assert.ok(!names.includes("cypher"));
  for (const t of list.json.result.tools) assert.ok(t.description && t.inputSchema.type === "object");
});

test("call search returns cited items", async () => {
  const { result, data } = await call("search", { q: "HLP-B" });
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.ok(data.items.length > 0);
  for (const i of data.items) assert.ok(i.cite);
});

test("no or unknown viewer is 401", async () => {
  assert.equal((await rpc({ id: 1, method: "tools/list" }, { as: null })).status, 401);
  assert.equal((await rpc({ id: 1, method: "tools/list" }, { as: "P-999" })).status, 401);
});

test("clearance holds over MCP", async () => {
  assert.deepEqual((await call("get", { id: CLB })).data, { found: false });
  assert.equal((await call("get", { id: CLB }, { as: personWith("supervisor") })).data.found, true);
});

test("protocol errors: unknown method, malformed JSON, unknown or hidden tool, bad arguments", async () => {
  assert.equal((await rpc({ id: 1, method: "nope/nothing" })).json.error.code, -32601);
  assert.equal((await rpc(null, { raw: "{not json" })).json.error.code, -32700);
  assert.equal((await rpc(null, { raw: "[]" })).json.error.code, -32600);
  const unknown = await rpc({ id: 1, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
  assert.equal(unknown.json.error.code, -32602);
  // a tool the viewer cannot see (cypher is manager-only and off by default) answers exactly like an unknown one
  const hidden = await rpc({ id: 1, method: "tools/call", params: { name: "cypher", arguments: { query: "MATCH (n) RETURN n" } } });
  assert.deepEqual(hidden.json.error, { ...unknown.json.error, message: unknown.json.error.message.replace("no_such_tool", "cypher") });
  assert.equal((await rpc({ id: 1, method: "tools/call", params: { arguments: {} } })).json.error.code, -32602);
});

test("a throwing tool comes back as isError with a short message, no stack", async () => {
  const boom = { name: "boom", description: "d", inputSchema: { type: "object" }, run: async () => { throw new Error("secret detail at C:\\x\y.mjs:1"); } };
  const s2 = createServer(sys, { kgTools: [boom] });
  await new Promise((r) => s2.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${s2.address().port}/mcp`, { method: "POST", headers: { "x-acting-user": personWith("technician") }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom" } }) });
    const { result } = await res.json();
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, "boom failed");
  } finally { s2.close(); }
});

test("a body over 1 MB is 413", async () => {
  const r = await rpc(null, { raw: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1.1e6) }) });
  assert.equal(r.status, 413);
});

test("GET /mcp is 405", async () => {
  const res = await fetch(`${base}/mcp`, { headers: { "x-acting-user": personWith("technician") } });
  assert.equal(res.status, 405);
});

test("WWOS_KG_BACKEND=atlas that cannot connect logs one line without secrets and falls back to memory", async () => {
  const lines = [], orig = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  let tools;
  try { tools = await kgToolsFor(sys, { WWOS_KG_BACKEND: "atlas", TIMEBASE_CLIENT_ID: "c", TIMEBASE_SECRET_FILE: "/nope/hunter2.secret" }); } finally { console.error = orig; }
  assert.equal(lines.length, 1);
  assert.ok(!/hunter2/.test(lines[0]));
  assert.equal((await tools.find((t) => t.name === "get").run({ id: CLB }, { id: personWith("supervisor"), clearance: "supervisor" })).found, true);
});

test("/mcp refuses a foreign Origin (DNS rebinding), allows its own and none, and ignores ?as=", async () => {
  const port = new URL(base).port, who = personWith("manager");
  const post = (headers, qs = "") => fetch(`${base}/mcp${qs}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
  assert.equal((await post({ origin: "http://evil.example", "x-acting-user": who })).status, 403);
  assert.equal((await post({ origin: `http://evil.example:${port}`, "x-acting-user": who })).status, 403);
  assert.equal((await post({ origin: `http://localhost:${port}`, "x-acting-user": who })).status, 200);
  assert.equal((await post({ origin: `http://127.0.0.1:${port}`, "x-acting-user": who })).status, 200);
  assert.equal((await post({ "x-acting-user": who })).status, 200, "no Origin: a CLI client");
  assert.equal((await post({}, `?as=${who}`)).status, 401, "?as= is not a credential on /mcp");
});
