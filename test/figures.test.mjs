import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createSystem } from "../src/system.mjs";
import { rank } from "../src/ontology.mjs";
import { syncFigures, figureFor } from "../src/figures.mjs";

const { ont } = createSystem({ seed: 7 });
const hlpb = ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
const [kg1, kg2] = ont.list("Part", (p) => p.assetId === hlpb.id);
const restricted = ont.list("Asset", (a) => rank(ont.get(a.zoneId)?.clearance) > rank("technician"))[0];

function figure(root, dir, assetId, parts, html = "<html><body><svg></svg></body></html>") {
  fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, dir, "asset-data.json"), JSON.stringify({ asset: { id: assetId } }));
  fs.writeFileSync(path.join(root, dir, `${dir}.html`), html);
  if (parts) fs.writeFileSync(path.join(root, dir, "parts-map.json"), JSON.stringify({ parts }));
}

function synced() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figures-"));
  const from = path.join(root, "from"), to = path.join(root, "to");
  fs.mkdirSync(from);
  figure(from, "pump", hlpb.id, [
    { figurePart: "foot", label: "Motor foot 1 of 2", kgPartId: kg1.id },
    { figurePart: "body", label: "Motor body", kgPartId: kg1.id },
    { figurePart: "cowl", label: "Motor cowl", kgPartId: kg1.id },
    { figurePart: "seal", label: "Seal", kgPartId: kg2.id },
    { figurePart: "plinth", label: "Plinth", kgPartId: null },
    { figurePart: "ghost", label: "Ghost", kgPartId: "PRT-NOT-IN-KG" }
  ]);
  figure(from, "nope", "AST-NOPE");
  figure(from, "secret", restricted.id);
  fs.mkdirSync(path.join(from, "shots"));
  return { to, ...syncFigures({ from, to, ont }) };
}

test("figures: a sync copies the page with the bridge before </body>, and indexes it by asset id", () => {
  const { to, index } = synced();
  const f = index[hlpb.id];
  assert.equal(f.page, "/figures/pump/pump.html");
  assert.equal(f.positionTag, "HLP-B");
  const html = fs.readFileSync(path.join(to, "pump", "pump.html"), "utf8");
  assert.match(html, /anatomy:pick[\s\S]*<\/script><\/body>/);
  assert.ok(html.lastIndexOf("--anatomy-card:#0d3b73") > html.lastIndexOf("</head>"), "the blueprint colours come after the page's own, so they win");
  assert.deepEqual(figureFor(hlpb.id, to), f);
  assert.equal(figureFor("AST-NOPE", to), null);
  assert.equal(figureFor(hlpb.id, path.join(to, "missing")), null);
});

test("figures: only ids the KG holds for this asset link; a shared KG part lights its plainest name", () => {
  const f = synced().index[hlpb.id];
  assert.deepEqual(f.parts, { foot: kg1.id, body: kg1.id, cowl: kg1.id, seal: kg2.id });
  assert.deepEqual(f.lights, { [kg1.id]: "body", [kg2.id]: "seal" });
});

test("figures: a sync refuses a non-asset and a zone above technician, because the pages are unauthenticated", () => {
  const { to, index, skipped } = synced();
  const pumps = ont.list("Asset", (a) => a.template === hlpb.template).map((a) => a.id);
  assert.deepEqual(Object.keys(index).sort(), pumps.sort(), "the pump page serves its template and nothing else");
  assert.ok(skipped.some((s) => s.startsWith("nope:")));
  assert.ok(!fs.existsSync(path.join(to, "nope")));
  assert.ok(skipped.some((s) => s.startsWith("secret:") && s.includes("clearance")));
  assert.ok(!fs.existsSync(path.join(to, "secret")));
});

test("figures: a sister gets its own tag, part ids and sensors, none of the source's readings, and keeps the clearance refusal", () => {
  const tagged = (tag) => ont.list("Asset", (a) => a.positionTag === tag)[0];
  const motor = (a) => ont.list("Part", (p) => p.assetId === a.id && p.name === "Motor")[0].id;
  const dp1 = tagged("DP-1"), dp2 = tagged("DP-2");
  const page = `<html><head><title>DP-1 dosing pump</title></head><body><div role="slider" aria-label="DP-1 pump" aria-valuetext="59.6 percent"><svg><g class="iso-solid" data-lit=""></g><text>DP-1</text></svg></div>
<span class="iso-plate-corner" data-corner="readout" data-readout>181 L/h</span><span class="sr" data-live-region></span><figcaption class="iso-legend">DP-1 reads 181 L/h on FIT-202. Over alarm.</figcaption>
<script>const PARTS = { motor: ["Motor", "${motor(dp1)}"], gauge: ["Gauge PIT-201", "sensor SEN-DP-1-press"], meter: ["FIT-202", null] };</script></body></html>`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "figures-")), from = path.join(root, "from"), to = path.join(root, "to");
  fs.mkdirSync(from);
  figure(from, "dp", dp1.id, [{ figurePart: "motor", label: "Motor", kgPartId: motor(dp1) }], page);
  const { index, skipped } = syncFigures({ from, to, ont });

  const f = index[dp2.id];
  assert.equal(f.page, "/figures/dp/dp-2.html");
  assert.deepEqual(f.parts, { motor: motor(dp2) }, "a click in the figure selects the sister's own part");
  assert.deepEqual(f.lights, { [motor(dp2)]: "motor" });
  const html = fs.readFileSync(path.join(to, "dp", "dp-2.html"), "utf8"), markup = html.slice(0, html.indexOf("<script"));
  assert.ok(!html.includes("DP-1"));
  assert.match(html, /<title>DP-2 dosing pump<\/title>/);
  assert.ok(html.includes(motor(dp2)) && html.includes("SEN-DP-2-press") && html.includes("Gauge PIT-202"));
  assert.match(html, /"FIT-201", null/, "FIT-202 is DP-2's FIT-201");
  assert.ok(!/181|59\.6|Over alarm|data-lit/.test(markup), "the source's readings and status are not on the sister's page");
  assert.match(markup, /data-corner="readout">Readings: Telemetry tab<\/span><span hidden data-readout><\/span>/);
  assert.match(html, /MutationObserver[\s\S]*<\/script><\/body>/, "and it still has the bridge");

  assert.ok(fs.readFileSync(path.join(to, "dp", "dp.html"), "utf8").includes("181 L/h"), "the source's own page keeps its readings");
  for (const tag of ["CHL-A", "CHL-B"]) {
    assert.equal(index[tagged(tag).id], undefined);
    assert.ok(skipped.some((s) => s.includes(`${tag} sits in`) && s.includes("clearance")));
    assert.ok(!fs.existsSync(path.join(to, "dp", `${tag.toLowerCase()}.html`)));
  }
});

test("figures: every synced page's scripts parse, because one clash leaves a figure drawn but dead", () => {
  const web = fileURLToPath(new URL("../web", import.meta.url));
  let index = {};
  try { index = JSON.parse(fs.readFileSync(path.join(web, "figures", "index.json"), "utf8")); } catch { /* the hosted copy has no figures */ }
  for (const f of Object.values(index)) {
    for (const [, code] of fs.readFileSync(path.join(web, f.page), "utf8").matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(code), f.page);
  }
});

test("figures: the Workbench frames them sandboxed, so a figure never reaches the app's origin", () => {
  const app = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /<iframe class="figure"[^>]*sandbox="allow-scripts"/);
  assert.ok(!app.includes("allow-same-origin"));
  assert.match(app, /e\.source === \$\("\.figure"\)\?\.contentWindow/);
});
