// WaterOS as an MCP server: Streamable HTTP, JSON replies only, hand-written JSON-RPC 2.0 (no SDK, no sessions to keep).
// The viewer is resolved by the caller; tools are filtered by clearance and run through their own `run`, which prunes.
import { randomUUID } from "node:crypto";
import { toolsFor } from "./kg/tools.mjs";

const MAX_BODY = 1e6;
const PROTOCOL = "2025-03-26";
const reply = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(obj === undefined ? "" : JSON.stringify(obj));
};
const fail = (res, status, id, code, message) => reply(res, status, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// An oversized body is drained unread (not destroyed) so the 413 can still reach the client.
const readBody = (req) => new Promise((resolve, reject) => {
  let data = "", big = false;
  req.on("data", (c) => { if (!big) data += c; if (data.length > MAX_BODY) { big = true; data = ""; } });
  req.on("end", () => (big ? reject(Object.assign(new Error("too large"), { status: 413 })) : resolve(data)));
  req.on("error", reject);
});

export async function handleMcp(req, res, { tools, viewer }) {
  if (req.method !== "POST") return reply(res, 405, { error: "POST only" }, { allow: "POST" });
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch (e) {
    return e.status === 413 ? reply(res, 413, { error: "body too large" }) : fail(res, 400, null, -32700, "Parse error");
  }
  // shortcut: no JSON-RPC batches (removed from later MCP revisions); send one message per POST
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") return fail(res, 400, msg?.id, -32600, "Invalid request");
  const { id, method, params } = msg;
  if (id === undefined) return reply(res, 202); // a notification (notifications/initialized and any other) is accepted, never answered
  const ok = (result, headers) => reply(res, 200, { jsonrpc: "2.0", id, result }, headers);

  if (method === "initialize") return ok({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "wateros", version: "0.1.0" } }, { "mcp-session-id": randomUUID() });
  if (method === "ping") return ok({});
  const visible = toolsFor(tools, viewer);
  if (method === "tools/list") return ok({ tools: visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === "tools/call") {
    const tool = typeof params?.name === "string" && visible.find((t) => t.name === params.name);
    // a tool the viewer may not see answers exactly like one that does not exist
    if (!tool) return fail(res, 200, id, -32602, `Unknown tool: ${String(params?.name).slice(0, 80)}`);
    try {
      return ok({ content: [{ type: "text", text: JSON.stringify(await tool.run(params.arguments ?? {}, viewer)) }] });
    } catch (e) {
      console.error(`mcp tool ${tool.name} failed: ${String(e?.message).slice(0, 200)}`); // never the request body
      return ok({ content: [{ type: "text", text: `${tool.name} failed` }], isError: true });
    }
  }
  return fail(res, 200, id, -32601, "Method not found");
}
