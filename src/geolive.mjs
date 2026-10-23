// Optional live mode (Region design §5.5, GEO_LIVE=1): Sentinel-2 L2A index statistics over a user-supplied area from
// Microsoft Planetary Computer, with Node's built-in fetch and no login. Only the area's polygon leaves the server, and the
// result is shown as its own "Live: <name>" area, never mixed into the synthetic works. Tests inject fetch; they never go live.

const STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
const STATS = "https://planetarycomputer.microsoft.com/api/data/v1/item/statistics";
export const EXPRESSIONS = { ndti: "(B04-B03)/(B04+B03)", ndwi: "(B03-B08)/(B03+B08)", ndci: "(B05-B04)/(B05+B04)" };

export async function liveStats({ aoi, fetch = globalThis.fetch, timeoutMs = 10000, now = new Date() } = {}) {
  const fail = (reason) => ({ ok: false, reason: `live data unavailable: ${reason}` });
  const geometry = aoi && (aoi.geometry || aoi), name = (aoi && aoi.properties && aoi.properties.name) || "live area";
  if (!geometry || geometry.type !== "Polygon") return fail("the area file needs a Polygon");
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error(`timed out after ${timeoutMs} ms`)); }, timeoutMs); });
  const post = async (url, body) => {
    const r = await Promise.race([fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }), timeout]);
    if (!r.ok) throw new Error(`${new URL(url).pathname} answered ${r.status}`);
    return Promise.race([r.json(), timeout]);
  };
  try {
    const from = new Date(now.getTime() - 30 * 86400000).toISOString();
    const found = await post(STAC, { collections: ["sentinel-2-l2a"], intersects: geometry, datetime: `${from}/${now.toISOString()}`, sortby: [{ field: "eo:cloud_cover", direction: "asc" }], limit: 1 });
    const item = found && Array.isArray(found.features) && found.features[0];
    if (!item) return fail("no Sentinel-2 scene over the area in the last 30 days");
    const q = new URLSearchParams({ collection: "sentinel-2-l2a", item: item.id, expression: Object.values(EXPRESSIONS).join(";"), asset_as_band: "true" });
    const res = await post(`${STATS}?${q}`, { type: "Feature", properties: {}, geometry });
    const st = res && res.properties && res.properties.statistics;
    const stats = st && Object.fromEntries(Object.entries(EXPRESSIONS).map(([k, e]) => [k, st[e]]));
    if (!stats || Object.values(stats).some((s) => !s || !Number.isFinite(s.mean))) return fail("malformed statistics");
    return { ok: true, name, scene: { id: item.id, acquiredAt: item.properties.datetime, cloudPct: item.properties["eo:cloud_cover"] }, stats, note: "index, not calibrated" };
  } catch (e) {
    return fail(e.message);
  } finally {
    clearTimeout(timer);
  }
}
