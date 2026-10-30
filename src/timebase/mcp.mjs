// Streamable HTTP MCP client: initialize -> notifications/initialized (with mcp-session-id) -> tools/list | tools/call.
// Replies are plain JSON or SSE `data:` lines; the last message wins.
export async function connectMcp(baseUrl, getToken, { fetch: f = fetch } = {}) {
  let id = 0, session;
  const post = async (msg) => {
    const r = await f(`${baseUrl}/mcp`, {
      method: "POST", redirect: "manual",
      headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify(msg)
    });
    if (!r.ok) throw new Error(`MCP ${msg.method}: ${r.status}`);
    session = r.headers.get("mcp-session-id") || session;
    const text = await r.text();
    if (!text.trim()) return null;
    const type = r.headers.get("content-type") || "";
    const json = type.includes("application/json") ? JSON.parse(text)
      : type.includes("text/event-stream") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).pop()
      : (() => { throw new Error(`MCP ${msg.method}: unexpected reply type`); })();
    if (json?.error) throw new Error(`MCP ${msg.method}: ${json.error.message || json.error.code}`);
    return json?.result;
  };
  await post({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "wateros", version: "0" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    listTools: async () => ((await post({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} }))?.tools ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    callTool: async (name, args) => {
      const r = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
      if (r?.isError) throw new Error(`MCP tool ${name} failed: ${String(r.content?.find((c) => c.type === "text")?.text ?? "").slice(0, 200)}`);
      return r;
    }
  };
}
