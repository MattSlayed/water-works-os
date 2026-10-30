import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWorks } from "../src/generate.mjs";
import { createOntology } from "../src/ontology.mjs";
import { createTelemetry } from "../src/telemetry.mjs";
import { pulseToken } from "../src/timebase/pulse.mjs";
import { restCall } from "../src/timebase/rest.mjs";
import { connectMcp } from "../src/timebase/mcp.mjs";
import { historianTags } from "../src/timebase/historian-tags.mjs";
import { HISTORIAN_READ } from "../src/timebase/historian-read.mjs";
import { readFileSync } from "node:fs";

const SECRET = "s3cret-value-xyz";
const secretFile = join(mkdtempSync(join(tmpdir(), "tb-")), "x.secret");
writeFileSync(secretFile, SECRET + "\n");
const reply = (status, body, type = "application/json", headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type, ...headers } });
const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

test("token never leaks", async () => {
  const fetch = async () => reply(401, { error: "invalid_client", error_description: `bad ${SECRET} access_token` });
  await assert.rejects(pulseToken({ pulseUrl: "https://p", clientId: "WaterOS", secretFile, fetch }), (e) => {
    assert.match(e.message, /401/);
    assert.match(e.message, /invalid_client/);
    assert.ok(!e.message.includes(SECRET) && !e.message.includes("access_token"));
    return true;
  });
});

test("token is cached until 30 s before exp", async () => {
  let calls = 0, exp = Math.floor(Date.now() / 1000) + 3600;
  const fetch = async (url, init) => {
    calls++;
    assert.ok(url === "https://p/auth/token" || url === "https://p2/auth/token");
    assert.match(String(init.body), /grant_type=client_credentials/);
    return reply(200, { access_token: jwt(exp) });
  };
  const o = { pulseUrl: "https://p", clientId: "WaterOS", secretFile, fetch };
  assert.equal(await pulseToken(o), await pulseToken(o));
  assert.equal(calls, 1);
  exp = Math.floor(Date.now() / 1000) + 10; // inside the 30 s margin, so never reused
  const o2 = { ...o, pulseUrl: "https://p2" };
  await pulseToken(o2); await pulseToken(o2);
  assert.equal(calls, 3);
});

test("rest rejects html", async () => {
  const fetch = async () => reply(200, "<html>login</html>", "text/html");
  await assert.rejects(restCall("https://h", "GET", "/api/x", undefined, { token: "t", fetch }), (e) => e.name === "NotJson");
});

test("rest sends the bearer, manual redirect and a JSON body", async () => {
  let seen;
  const fetch = async (url, init) => { seen = { url, init }; return reply(200, { a: 1 }); };
  const r = await restCall("https://h", "POST", "/api/x", [1], { token: "tok", fetch });
  assert.deepEqual(r, { status: 200, body: { a: 1 } });
  assert.equal(seen.url, "https://h/api/x");
  assert.equal(seen.init.redirect, "manual");
  assert.equal(seen.init.headers.Authorization, "Bearer tok");
  assert.equal(seen.init.body, "[1]");
});

test("mcp parses SSE and JSON", async () => {
  const tools = [{ name: "read_raw", description: "d", inputSchema: { type: "object" } }];
  const run = async (style) => {
    const sessions = [];
    const fetch = async (url, init) => {
      const msg = JSON.parse(init.body);
      sessions.push(init.headers["mcp-session-id"]);
      const send = (o) => style === "sse"
        ? reply(200, `event: message\ndata: {"junk":1}\n\ndata: ${JSON.stringify(o)}\n\n`, "text/event-stream", { "mcp-session-id": "S1" })
        : reply(200, o, "application/json", { "mcp-session-id": "S1" });
      if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: {} } });
      if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "nope" } });
    };
    const c = await connectMcp("https://a", async () => "tok", { fetch });
    return { list: await c.listTools(), sessions, c };
  };
  const a = await run("json"), b = await run("sse");
  assert.deepEqual(a.list, tools);
  assert.deepEqual(b.list, tools);
  assert.equal(a.sessions[0], undefined);
  assert.deepEqual(a.sessions.slice(1), ["S1", "S1"]); // notifications/initialized and tools/list echo the id
  await assert.rejects(b.c.callTool("x", {}), /nope/);
});

const ont = createOntology(generateWorks(7));

test("historian tags", () => {
  const tags = historianTags(ont);
  assert.equal(tags.length, 117);
  assert.equal(new Set(tags.map((t) => t.n)).size, 117);
  const t = tags.find((x) => x.n === "AIT-157");
  assert.equal(t.sensorId, "SEN-F07-turb");
  assert.deepEqual(t.u, { 1: "NTU" });
  assert.deepEqual(t.fl, { Site: "Riverbend WTW", Asset: "F07", Source: "synthetic" });
  assert.equal(t.t, "System.Double");
  const bulk = tags.find((x) => x.sensorId === "SEN-PS1-flow");
  assert.equal(bulk.fl.Asset, "RS-PS1"); // no asset -> process unit id
});

test("series matches history, clipped to the window", () => {
  const start = "2026-10-01T00:00:00Z";
  const tel = createTelemetry({ ont, start, minutes: 600, startCursorMin: 600 });
  const id = "SEN-F07-turb";
  const s = tel.series(id, start, "2026-10-01T00:10:00Z");
  assert.equal(s.length, 11);
  assert.equal(s[0].t, "2026-10-01T00:00:00.000Z");
  assert.equal(s[10].t, "2026-10-01T00:10:00.000Z");
  assert.deepEqual(s.map((p) => p.v), tel.history(id, 601).slice(0, 11));
  assert.equal(tel.series(id, "2026-09-30T00:00:00Z", "2026-10-01T00:00:00Z").length, 1);
  assert.equal(tel.series(id, "2027-01-01T00:00:00Z", "2027-01-02T00:00:00Z").length, 0);
  assert.equal(tel.series("nope", start, start).length, 0);
});

test("pulse token call never follows redirects", async () => {
  let init;
  const fetch = async (u, i) => { init = i; return new Response(null, { status: 307, headers: { location: "https://evil/x" } }); };
  await assert.rejects(pulseToken({ pulseUrl: "https://p3", clientId: "WaterOS", secretFile, fetch }), /307/);
  assert.equal(init.redirect, "manual");
});

test("rest returns a null body for an empty 204", async () => {
  const fetch = async () => new Response(null, { status: 204 });
  assert.deepEqual(await restCall("https://h", "DELETE", "/api/x", undefined, { token: "t", fetch }), { status: 204, body: null });
});

test("mcp fails on a non-MCP content type", async () => {
  const fetch = async () => reply(200, "<html>login</html>", "text/html");
  await assert.rejects(connectMcp("https://a", async () => "tok", { fetch }), /unexpected reply type/);
});

test("telemetry exposes its own window", () => {
  const tel = createTelemetry({ ont, start: "2026-10-01T00:00:00Z", minutes: 600 });
  assert.equal(tel.minutes, 600);
  assert.equal(tel.end, "2026-10-01T10:00:00.000Z");
  assert.equal(tel.series("SEN-F07-turb", tel.start, tel.end).length, 601);
});

test("historian adapter", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/historian-read.json", import.meta.url), "utf8"));
  const a = HISTORIAN_READ.args("AIT-157", "2026-10-08T00:00:00Z", "2026-10-08T01:00:00Z");
  assert.equal(HISTORIAN_READ.tool, "GetDataForMultipleTags");
  assert.deepEqual(a, { datasetName: "Riverbend", tagNamesJson: '["AIT-157"]', startTime: "2026-10-08T00:00:00Z", endTime: "2026-10-08T01:00:00Z" });
  const pts = HISTORIAN_READ.points(fixture);
  // The Historian drops consecutive repeated values, so one hour of 1-minute data holds fewer than 60 points (56 captured).
  assert.ok(pts.length >= 50 && pts.length <= 61, `got ${pts.length}`);
  assert.equal(pts.length, Number(/(\d+) point\(s\)/.exec(fixture.content[0].text)[1]));
  for (const p of pts) {
    assert.match(p.t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(Number.isFinite(p.v) && p.q === 192);
  }
  assert.ok(pts.every((p, i) => i === 0 || p.t > pts[i - 1].t));
});

test("an isError tool result throws", async () => {
  const fetch = async (url, init) => {
    const m = JSON.parse(init.body);
    if (m.method === "notifications/initialized") return new Response(null, { status: 202 });
    return reply(200, { jsonrpc: "2.0", id: m.id, result: m.method === "tools/call" ? { isError: true, content: [{ type: "text", text: "no such dataset" }] } : {} });
  };
  const c = await connectMcp("https://a", async () => "tok", { fetch });
  await assert.rejects(c.callTool("GetDataForMultipleTags", {}), /no such dataset/);
});

const fixtureText = () => JSON.parse(readFileSync(new URL("./fixtures/historian-read.json", import.meta.url), "utf8")).content[0].text;
const asResult = (text) => ({ content: [{ type: "text", text }] });

test("historian adapter throws when the reply does not add up", () => {
  const text = JSON.parse(fixtureText());
  assert.throws(() => HISTORIAN_READ.points(asResult(JSON.stringify(text.replace("56 point(s)", "57 point(s)")))), /parsed 56 of 57 points/);
  assert.throws(() => HISTORIAN_READ.points(asResult(text.replace("q=192", "q=bad"))), /parsed 55 of 56 points/);
  assert.throws(() => HISTORIAN_READ.points(asResult(text.replace("v=0.109", "v=abc"))), /non-finite/);
  assert.throws(() => HISTORIAN_READ.points(asResult(text.replace("- 2026-10-08T00:00:00.0000000Z", "- 2026-10-08T00:00:00.0000000"))), /parsed 55 of 56 points/);
  assert.throws(() => HISTORIAN_READ.points(asResult("Tag not found")), /no point\(s\) header/);
  assert.throws(() => HISTORIAN_READ.points({ content: [] }), /no point\(s\) header/);
});

test("historian adapter: a 0 point(s) reply is an empty series", () => {
  assert.deepEqual(HISTORIAN_READ.points(asResult("Data for 1 tag(s) in dataset 'Riverbend' (a .. b):\n## AIT-157 - 0 point(s)\n")), []);
});
