import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveStats } from "../src/geolive.mjs";
import { generateWorks } from "../src/generate.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const aoi = JSON.parse(readFileSync(new URL("../data/geo/live-aoi.geojson", import.meta.url)));
const reply = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => (typeof body === "string" ? JSON.parse(body) : body) });
const fixtureFetch = (url) => reply(String(url).includes("/stac/v1/search") ? fx("pc-search.json") : fx("pc-stats.json"));

test("live: the captured Planetary Computer responses give the three indices for the least cloudy scene", async () => {
  const calls = [];
  const r = await liveStats({ aoi, fetch: (url, opts) => { calls.push({ url: String(url), body: opts && opts.body }); return fixtureFetch(url); } });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.name, /Rietvlei Dam/);
  assert.equal(r.scene.id, fx("pc-search.json").features[0].id);
  assert.deepEqual(Object.keys(r.stats).sort(), ["ndci", "ndti", "ndwi"]);
  const synthetic = generateWorks(7).objects.find((o) => o.id === "S2-20261012").stats["AOI-DAM"].ndti;
  assert.deepEqual(Object.keys(r.stats.ndti).sort(), Object.keys(synthetic).sort());
  assert.equal(r.note, "index, not calibrated");
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((c) => /Riverbend|PRJ-|SEN-/.test(c.body || "")), "only the area's polygon leaves the server");
});

test("live: a failed, hung or malformed response gives a reason, never a throw", async () => {
  const rejecting = await liveStats({ aoi, fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) });
  assert.equal(rejecting.ok, false);
  assert.match(rejecting.reason, /ENOTFOUND/);
  const hung = await liveStats({ aoi, fetch: () => new Promise(() => {}), timeoutMs: 50 });
  assert.equal(hung.ok, false);
  assert.match(hung.reason, /timed out/);
  const junk = await liveStats({ aoi, fetch: () => reply("not json") });
  assert.equal(junk.ok, false);
  const http = await liveStats({ aoi, fetch: () => reply({}, 503) });
  assert.deepEqual([http.ok, /503/.test(http.reason)], [false, true]);
});

test("live: the synthetic works is the same whether or not live mode is on", () => {
  const before = JSON.stringify(generateWorks(7));
  process.env.GEO_LIVE = "1";
  try { assert.equal(JSON.stringify(generateWorks(7)), before); } finally { delete process.env.GEO_LIVE; }
});
