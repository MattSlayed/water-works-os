import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSystem } from "../src/system.mjs";
import { rank } from "../src/ontology.mjs";
import { syncFigures, figureFor } from "../src/figures.mjs";

const { ont } = createSystem({ seed: 7 });
const hlpb = ont.list("Asset", (a) => a.positionTag === "HLP-B")[0];
const [kg1, kg2] = ont.list("Part", (p) => p.assetId === hlpb.id);
const restricted = ont.list("Asset", (a) => rank(ont.get(a.zoneId)?.clearance) > rank("technician"))[0];

function figure(root, dir, assetId, parts) {
  fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, dir, "asset-data.json"), JSON.stringify({ asset: { id: assetId } }));
  fs.writeFileSync(path.join(root, dir, `${dir}.html`), "<html><body><svg></svg></body></html>");
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
  assert.deepEqual(Object.keys(index), [hlpb.id]);
  assert.ok(skipped.some((s) => s.startsWith("nope:")));
  assert.ok(!fs.existsSync(path.join(to, "nope")));
  assert.ok(skipped.some((s) => s.startsWith("secret:") && s.includes("clearance")));
  assert.ok(!fs.existsSync(path.join(to, "secret")));
});

test("figures: the Workbench frames them sandboxed, so a figure never reaches the app's origin", () => {
  const app = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /<iframe class="figure"[^>]*sandbox="allow-scripts"/);
  assert.ok(!app.includes("allow-same-origin"));
  assert.match(app, /e\.source === \$\("\.figure"\)\?\.contentWindow/);
});
