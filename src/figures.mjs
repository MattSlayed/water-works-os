// Anatomy figures in the Asset Workbench: crafted isometric pages built outside the repo (riverbend-anatomy/), copied
// into web/figures/ with an index keyed by asset id. Each figure's parts-map.json ties its drawn parts to KG Part ids.
// A figure also serves its sisters: the other assets of its template get a rewritten copy, see sisterPage.
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

// Sister pages only: the page's scripts write to a hidden readout, and only a part's name and id reach the visible one,
// so a failure here shows too little, never the source asset's readings.
const FIGURE_ONLY = "Readings: Telemetry tab";
const SISTER_BRIDGE = `<script>
(()=>{const shown=document.querySelector("[data-corner='readout']"),said=document.querySelector("[data-readout]"),stage=document.querySelector("[role='slider']");
const isPart=(t)=>/\\b(?:PRT|SEN)-|not in the knowledge graph/.test(t||"");
const sync=()=>{if(shown&&said){const t=isPart(said.textContent)?said.textContent:"${FIGURE_ONLY}";if(shown.textContent!==t)shown.textContent=t}if(stage){const t=stage.getAttribute("aria-valuetext");if(!isPart(t)&&t!=="${FIGURE_ONLY}")stage.setAttribute("aria-valuetext","${FIGURE_ONLY}")}};
const watch=new MutationObserver(sync);
if(said)watch.observe(said,{childList:true,characterData:true,subtree:true});
if(stage)watch.observe(stage,{attributes:true,attributeFilter:["aria-valuetext"]});
sync()})();
</script>`;

// The Workbench's colour scheme: white lines on blueprint blue over a drafting grid. Every colour in a figure is one of
// these variables, so the copies recolour here and the geometry stays untouched. Comes after the page's own styles to win.
const BLUEPRINT = `<style>
.iso{--anatomy-page:#0a2e5c;--anatomy-card:#0d3b73;--anatomy-text:#bcd6f2;--anatomy-strong:#f2f8ff;--anatomy-muted:#8fb3d9;
--anatomy-paper:#0d3b73;--anatomy-face:#114681;--anatomy-top:#134c8b;
--anatomy-shade-0:#0b3364;--anatomy-shade-1:#0d3a70;--anatomy-shade-2:#0f407a;--anatomy-shade-3:#114684;
--anatomy-lit-top:#1a5ba3;--anatomy-lit-shade:#15508f;
--anatomy-hi:#eaf4ff;--anatomy-mid:#9cc3ea;--anatomy-lo:#6293c8;--anatomy-faint:#2f6299;--anatomy-lit:#ffffff;
--anatomy-halo:#061f42;--anatomy-halo-opacity:.7;--anatomy-dot:#eaf4ff;
--anatomy-red:#ff9d9d;--anatomy-green:#86efbb;--anatomy-blue:#9fdcff;
--blw-oil:#0a2b55;--hlp-void:#07264d;--hlp-cage:#0b3364;
--dp-wet:#2b78bd;--dp-dry:#07244a;--dp-glass-0:#1a5590;--dp-glass-1:#1d5c99;--dp-glass-2:#2063a2;--dp-glass-3:#236aab;--dp-glass-top:#2a74b8}
.iso .cl{--cl-water:#2a6aa8;--cl-sludge:#1c4f87;--cl-sludge-top:#15457a;--cl-mound:#174a80;--cl-hopper:#0a2f5c;--cl-cut:#114684;--cl-weir:#134c8b;
--cl-hi:#eaf4ff;--cl-mid:#9cc3ea;--cl-lo:#6293c8;--cl-top:#134c8b;--cl-shade:#0f407a}
.iso-plate{background-image:linear-gradient(#ffffff14 1px,transparent 1px),linear-gradient(90deg,#ffffff14 1px,transparent 1px),linear-gradient(#ffffff09 1px,transparent 1px),linear-gradient(90deg,#ffffff09 1px,transparent 1px);background-size:120px 120px,120px 120px,24px 24px,24px 24px}
</style>`;

// LF because the repo is, and a figure's sources may not be.
function withBridge(html, extra = "") {
  const at = html.lastIndexOf("</body>"), bridge = BLUEPRINT + BRIDGE + extra;
  return (at < 0 ? html + bridge : html.slice(0, at) + bridge + html.slice(at)).replace(/\r\n/g, "\n");
}

// Only ids the KG holds for this asset count; a sister's come from the source's parts by name. Several drawn pieces can
// share one KG part; a selection lights the plainest name ("Motor body", not "Motor foot 1 of 2").
function partLinks(src, ont, source, asset = source) {
  const file = path.join(src, "parts-map.json");
  if (!fs.existsSync(file)) return { parts: {}, lights: {} };
  const named = new Map(ont.list("Part", (p) => p.assetId === asset.id).map((p) => [p.name, p.id]));
  const mapped = JSON.parse(fs.readFileSync(file, "utf8")).parts.flatMap((p) => {
    const kg = p.kgPartId && ont.get(p.kgPartId), id = kg?.assetId === source.id && named.get(kg.name);
    return id ? [{ ...p, kgPartId: id }] : [];
  });
  const longestFirst = [...mapped].sort((a, b) => a.label.length - b.label.length).reverse();
  return { parts: Object.fromEntries(mapped.map((p) => [p.figurePart, p.kgPartId])), lights: Object.fromEntries(longestFirst.map((p) => [p.kgPartId, p.figurePart])) };
}

// Everything on a page that names the source asset, mapped to the sister's own: parts by name, sensors and specs by key.
function swapsFor(ont, from, to) {
  const swaps = new Map([[from.positionTag, to.positionTag], [from.name, to.name], [from.id, to.id]]);
  for (const [type, field] of [["Part", "name"], ["Sensor", "key"], ["Spec", "key"]]) {
    const own = new Map(ont.list(type, (x) => x.assetId === to.id).map((x) => [x[field], x]));
    for (const x of ont.list(type, (y) => y.assetId === from.id)) {
      const twin = own.get(x[field]);
      if (twin) { swaps.set(x.id, twin.id); if (x.tag) swaps.set(x.tag, twin.tag); }
    }
  }
  return swaps;
}

// shortcut: these are the status phrases a page's scripts can show outside the readout today; a rebuilt page with new
// status wording needs its phrase added here.
const STATUS_WORDS = [
  [" The drive-end bearing is lit: its vibration is over the alarm band.", ""],
  ["Space switches between the drive as last running and today, out of service.", "Space stops and starts the drive."],
  ["Space: today", "Space: stop or start"]
];

// The source page rewritten for a sister: the same machine under the sister's own tag and part ids, without what the
// source page says about the source asset (caption, readings, status accent). The sister's own state is in the Workbench.
function sisterPage(html, ont, from, to) {
  const swaps = swapsFor(ont, from, to);
  const names = [...swaps.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const caption = `${to.positionTag}, ${to.name}: ${/^[aeiou]/i.test(to.make) ? "an" : "a"} ${to.make} ${to.model}. This figure shows how the machine works and where its parts are, not this asset's condition. The motion, dials and bright parts are not readings or alarms; those are in the Telemetry tab.`.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const worded = STATUS_WORDS.reduce((page, [was, now]) => page.replaceAll(was, now), html);
  // one pass, whole tags only: on some sisters one sensor's new tag is another's old one, and IT-602 sits inside FIT-602
  const retagged = worded.replace(new RegExp(`(?<![\\w-])(?:${names})(?![\\w-])`, "g"), (k) => swaps.get(k));
  const at = retagged.indexOf("<script"), split = at < 0 ? retagged.length : at;
  const markup = retagged.slice(0, split)
    .replace(/<figcaption class="iso-legend">[\s\S]*?<\/figcaption>/, () => `<figcaption class="iso-legend"><span class="iso-caption">${caption}</span></figcaption>`)
    .replace(/(<span[^>]*data-corner="readout") data-readout>[^<]*<\/span>/, `$1>${FIGURE_ONLY}</span><span hidden data-readout></span>`)
    .replace(/aria-valuetext="[^"]*"/g, `aria-valuetext="${FIGURE_ONLY}"`)
    .replace(/<(\w+)([^<>]*\bdata-live-(?:region|text)\b)/g, "<$1 hidden$2")
    .replace(/(<g class="iso-solid[^"]*") data-lit(?:="")?/g, "$1")
    .replace(/>Fig \d+</, ">Fig 1<");
  return markup + retagged.slice(split);
}

// Why a sister cannot use this page, or null. Fails closed: a page that still names the source or shows its readout is not written.
function sisterProblem(page, from, to) {
  if (to.make !== from.make || to.model !== from.model) return `${to.make} ${to.model} is not the ${from.make} ${from.model} drawn`;
  if (page.includes(from.positionTag)) return `its page would still say ${from.positionTag}`;
  if (/<[^>]*data-readout>[^<]/.test(page)) return "its page would still show the source's readout";
  return null;
}

export function syncFigures({ from, to = path.join(WEB, "figures"), ont }) {
  const index = {}, skipped = [], drawn = [];
  const aboveTechnician = (a) => { const zone = ont.get(a.zoneId); return zone && rank(zone.clearance) > rank("technician") ? `${a.positionTag} sits in ${zone.id}, which needs ${zone.clearance} clearance` : null; };
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const dir of fs.readdirSync(from).sort()) {
    const src = path.join(from, dir), page = `${dir}.html`;
    if (!fs.existsSync(path.join(src, "asset-data.json")) || !fs.existsSync(path.join(src, page))) continue;
    const { asset } = JSON.parse(fs.readFileSync(path.join(src, "asset-data.json"), "utf8"));
    const a = ont.get(asset?.id);
    if (!a || a.type !== "Asset") { skipped.push(`${dir}: ${asset?.id} is not an asset in the knowledge graph`); continue; }
    const refused = aboveTechnician(a);
    if (refused) { skipped.push(`${dir}: ${refused}`); continue; }
    const html = fs.readFileSync(path.join(src, page), "utf8");
    fs.mkdirSync(path.join(to, dir));
    fs.writeFileSync(path.join(to, dir, page), withBridge(html));
    index[a.id] = { positionTag: a.positionTag, page: `/figures/${dir}/${page}`, ...partLinks(src, ont, a) };
    drawn.push({ a, dir, src, html });
  }
  // After every own figure, so an asset's own always beats a sister's.
  for (const { a, dir, src, html } of drawn) {
    if (!a.template) continue;
    for (const b of ont.list("Asset", (x) => x.template === a.template && !index[x.id])) {
      const refused = aboveTechnician(b);
      if (refused) { skipped.push(`${dir}: ${refused}`); continue; }
      const page = sisterPage(html, ont, a, b), problem = sisterProblem(page, a, b);
      if (problem) { skipped.push(`${dir}: ${b.positionTag}: ${problem}`); continue; }
      const file = `${b.positionTag.toLowerCase()}.html`;
      fs.writeFileSync(path.join(to, dir, file), withBridge(page, SISTER_BRIDGE));
      index[b.id] = { positionTag: b.positionTag, page: `/figures/${dir}/${file}`, ...partLinks(src, ont, a, b) };
    }
  }
  fs.writeFileSync(path.join(to, "index.json"), JSON.stringify(index, null, 1) + "\n");
  return { index, skipped };
}

// The figure for an asset, or null. Read per call: the index is small and a re-sync shows without a restart.
export function figureFor(assetId, dir = path.join(WEB, "figures")) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"))[assetId] || null; } catch { return null; }
}
