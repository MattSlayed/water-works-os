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
  const { pts } = HISTORIAN_READ.page(fixture);
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
  assert.throws(() => HISTORIAN_READ.page(asResult(JSON.stringify(text.replace("56 point(s)", "57 point(s)")))), /parsed 56 of 57 points/);
  assert.throws(() => HISTORIAN_READ.page(asResult(text.replace("q=192", "q=bad"))), /parsed 55 of 56 points/);
  assert.throws(() => HISTORIAN_READ.page(asResult(text.replace("v=0.109", "v=abc"))), /non-finite/);
  assert.throws(() => HISTORIAN_READ.page(asResult(text.replace("- 2026-10-08T00:00:00.0000000Z", "- 2026-10-08T00:00:00.0000000"))), /parsed 55 of 56 points/);
  assert.throws(() => HISTORIAN_READ.page(asResult("Tag not found")), /no point\(s\) header/);
  assert.throws(() => HISTORIAN_READ.page({ content: [] }), /no point\(s\) header/);
});

test("historian adapter: a 0 point(s) reply is an empty series", () => {
  assert.deepEqual(HISTORIAN_READ.page(asResult("Data for 1 tag(s) in dataset 'Riverbend' (a .. b):\n## AIT-157 - 0 point(s)\n")).pts, []);
});

test("load-atlas refuses any branch but riverbend before a network call", async () => {
  const { spawnSync } = await import("node:child_process");
  const env = { ...process.env, TIMEBASE_CLIENT_ID: "c", TIMEBASE_SECRET_FILE: "/nope", TIMEBASE_ATLAS_URL: "https://127.0.0.1:1", TIMEBASE_PULSE_URL: "https://127.0.0.1:1" };
  for (const br of ["main", "spike-riverbend"]) {
    const r = spawnSync(process.execPath, ["scripts/timebase/load-atlas.mjs", br], { env, encoding: "utf8", timeout: 30e3 });
    assert.notEqual(r.status, 0, br);
    assert.match(r.stderr, /Refusing branch .*riverbend. only/, br);
  }
});

// The live tool's shape: at most 100 points listed, then "... and N more point(s)", and the header counts the whole window.
const replyFor = (minutes, fromMin = 0) => {
  const shown = minutes.filter((m) => m >= fromMin), lines = shown.slice(0, 100).map((m) => `- ${new Date(Date.UTC(2026, 9, 14, 0, m)).toISOString().replace("Z", "0000Z")}  v=${m}  q=192`);
  if (shown.length > 100) lines.push(`- ... and ${shown.length - 100} more point(s) (showing first 100).`);
  return asResult(`Data for 1 tag(s) in dataset 'Riverbend'\n\n## FIT-805 - ${shown.length} point(s)\n${lines.join("\n")}`);
};

test("historian read walks a long window page by page and misses no point", async () => {
  const minutes = Array.from({ length: 250 }, (_, i) => i), calls = [];
  const callTool = async (tool, args) => {
    calls.push(args.startTime);
    assert.equal(tool, "GetDataForMultipleTags");
    assert.equal(args.endTime, "2026-10-14T04:10:00.001Z", "the end is exclusive, so a point at toIso is still read");
    return replyFor(minutes, (Date.parse(args.startTime) - Date.UTC(2026, 9, 14)) / 60000);
  };
  const pts = await HISTORIAN_READ.read(callTool, "FIT-805", "2026-10-14T00:00:00.000Z", "2026-10-14T04:10:00.000Z");
  assert.deepEqual(pts.map((p) => p.v), minutes);
  assert.equal(calls.length, 3);
  assert.equal(calls[1], "2026-10-14T01:39:00.000Z");
  assert.deepEqual(await HISTORIAN_READ.read(async () => replyFor([1, 2]), "FIT-805", "2026-10-14T00:00:00.000Z", "2026-10-14T01:00:00.000Z").then((p) => p.map((x) => x.v)), [1, 2]);
});

test("historian read throws rather than return a short window", async () => {
  // a page that promises more but lists nothing must not loop forever
  await assert.rejects(HISTORIAN_READ.read(async () => asResult("## T - 5 point(s)\n- ... and 5 more point(s) (showing first 100)."), "T", "2026-10-14T00:00:00Z", "2026-10-14T01:00:00Z"), /no new ones/);
  // the window shrinks between pages: the total no longer matches the first reply's count
  let n = 0;
  await assert.rejects(HISTORIAN_READ.read(async () => (n++ ? replyFor([]) : replyFor(Array.from({ length: 150 }, (_, i) => i))), "T", "2026-10-14T00:00:00.000Z", "2026-10-14T03:00:00.000Z"), /got 100 of 150/);
  // a listed-points count that does not add up still throws
  assert.throws(() => HISTORIAN_READ.page(asResult("## T - 150 point(s)\n- ... and 49 more point(s) (showing first 100).")), /parsed 0 of 150/);
});
