// Anatomy figures in the Asset Workbench: crafted isometric pages built outside the repo (riverbend-anatomy/), copied
// into web/figures/ with an index keyed by asset id. Each figure's parts-map.json ties its drawn parts to KG Part ids.
// shortcut: the pages are static and unauthenticated, so sync refuses an asset whose zone needs more than technician
// clearance; serve them through /api with the viewer before figuring such an asset.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rank } from "./ontology.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

// Added to the copies only, so a figure stays a page of its own. A click or Enter reports the lit part; hover does not,
// because selecting a part in the Workbench resets the Copilot session. window.anatomySelect is the figure's own hook.
const BRIDGE = `<script>
addEventListener("message",(e)=>{if(e.source===parent&&e.data&&e.data.type==="anatomy:select"&&window.anatomySelect)window.anatomySelect(e.data.part)});
function anatomyReport(){const on=document.querySelector("[data-part][data-on]");if(on)parent.postMessage({type:"anatomy:pick",part:on.dataset.part},"*")}
addEventListener("click",anatomyReport);
addEventListener("keydown",(e)=>{if(e.key==="Enter")anatomyReport()});
</script>`;

function withBridge(html) {
  const at = html.lastIndexOf("</body>");
  return at < 0 ? html + BRIDGE : html.slice(0, at) + BRIDGE + html.slice(at);
}

// Only ids the KG holds for this asset count. Several drawn pieces can share one KG part; a selection lights the plainest
// name ("Motor body", not "Motor foot 1 of 2").
function partLinks(src, ont, assetId) {
  const file = path.join(src, "parts-map.json");
  if (!fs.existsSync(file)) return { parts: {}, lights: {} };
  const mapped = JSON.parse(fs.readFileSync(file, "utf8")).parts.filter((p) => p.kgPartId && ont.get(p.kgPartId)?.assetId === assetId);
  const longestFirst = [...mapped].sort((a, b) => a.label.length - b.label.length).reverse();
  return { parts: Object.fromEntries(mapped.map((p) => [p.figurePart, p.kgPartId])), lights: Object.fromEntries(longestFirst.map((p) => [p.kgPartId, p.figurePart])) };
}

export function syncFigures({ from, to = path.join(WEB, "figures"), ont }) {
  const index = {}, skipped = [];
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const dir of fs.readdirSync(from).sort()) {
    const src = path.join(from, dir), page = `${dir}.html`;
    if (!fs.existsSync(path.join(src, "asset-data.json")) || !fs.existsSync(path.join(src, page))) continue;
    const { asset } = JSON.parse(fs.readFileSync(path.join(src, "asset-data.json"), "utf8"));
    const a = ont.get(asset?.id), zone = a && ont.get(a.zoneId);
    if (!a || a.type !== "Asset") { skipped.push(`${dir}: ${asset?.id} is not an asset in the knowledge graph`); continue; }
    if (zone && rank(zone.clearance) > rank("technician")) { skipped.push(`${dir}: ${a.positionTag} sits in ${zone.id}, which needs ${zone.clearance} clearance`); continue; }
    fs.mkdirSync(path.join(to, dir));
    fs.writeFileSync(path.join(to, dir, page), withBridge(fs.readFileSync(path.join(src, page), "utf8")));
    index[a.id] = { positionTag: a.positionTag, page: `/figures/${dir}/${page}`, ...partLinks(src, ont, a.id) };
  }
  fs.writeFileSync(path.join(to, "index.json"), JSON.stringify(index, null, 1) + "\n");
  return { index, skipped };
}

// The figure for an asset, or null. Read per call: the index is small and a re-sync shows without a restart.
export function figureFor(assetId, dir = path.join(WEB, "figures")) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"))[assetId] || null; } catch { return null; }
}
