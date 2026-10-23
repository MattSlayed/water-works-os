import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createSystem } from "../src/system.mjs";
import { createServer } from "../src/server.mjs";

let srv, base;
before(async () => { srv = createServer(createSystem({ seed: 7 })); await new Promise((r) => srv.listen(0, r)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv.close());

test("web assets are served with the right types", async () => {
  for (const [p, type] of [["/", "text/html"], ["/app.js", "javascript"], ["/twin.js", "javascript"], ["/styles.css", "text/css"], ["/fonts/Syne-Variable.woff2", "font/woff2"]]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type"), new RegExp(type), p);
  }
});

test("index wires the app, the nav and the three.js import map", async () => {
  const html = await (await fetch(base + "/")).text();
  for (const s of ['src="/app.js"', 'data-nav="console"', 'data-nav="agents"', 'data-nav="proposals"', "three@0.160.0", 'id="role"', 'data-nav="chat"', 'data-nav="issues"', 'data-nav="projects"', 'data-nav="procedures"', 'data-nav="mywork"']) assert.ok(html.includes(s), s);
});

test("static files cannot escape the web folder", async () => {
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fsrc/server.mjs"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
  }
});

test("every view the app routes to exists in app.js", async () => {
  const js = await (await fetch(base + "/app.js")).text();
  for (const v of ["console", "map", "assets", "asset", "work", "agents", "run", "proposals", "knowledge", "compliance", "ontology", "search", "object", "audit", "chat", "issues", "projects", "project", "procedures", "procedure", "mywork"]) assert.ok(js.includes(`async ${v}(`), v);
});

test("three.js 0.160.0 is vendored: served locally, no CDN in the import map, addon imports resolve", async () => {
  const fs = await import("node:fs"), path = await import("node:path"), { fileURLToPath } = await import("node:url");
  const r = await fetch(base + "/vendor/three@0.160.0/three.module.js");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /javascript/);
  assert.ok((await r.text()).includes("REVISION = '160'")); // read the body so the socket closes
  const html = await (await fetch(base + "/")).text();
  assert.ok(!html.includes("cdn.jsdelivr"));
  assert.ok(html.includes('"three": "/vendor/three@0.160.0/three.module.js"') && html.includes('"three/addons/": "/vendor/three@0.160.0/addons/"'));
  const root = new URL("../web/vendor/three@0.160.0/", import.meta.url);
  const addons = ["controls/OrbitControls.js", "renderers/CSS2DRenderer.js", "lines/Line2.js", "lines/LineMaterial.js", "lines/LineSegments2.js", "lines/LineSegmentsGeometry.js", "lines/LineGeometry.js", "utils/BufferGeometryUtils.js", "objects/Sky.js", "environments/RoomEnvironment.js"];
  for (const a of addons) {
    const file = new URL(`addons/${a}`, root);
    assert.ok(fs.existsSync(file), a);
    for (const [, spec] of fs.readFileSync(file, "utf8").matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (spec === "three") continue;
      assert.ok(fs.existsSync(path.resolve(path.dirname(fileURLToPath(file)), spec)), `${a} imports ${spec}`);
    }
  }
});

test("plant view: route, nav and module are wired", async () => {
  const html = await (await fetch(base + "/")).text();
  assert.ok(html.includes('data-nav="plant"'));
  const app = await (await fetch(base + "/app.js")).text();
  assert.ok(app.includes("async plant("));
  const r = await fetch(base + "/plant.js");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /javascript/);
  const src = await r.text();
  for (const s of ["export function mountPlant", "flyTo", "highlight", "setMode", "setStates", "dispose", "forceContextLoss", "__plant"]) assert.ok(src.includes(s), s);
});

test("blueprint mode and the plant model review view are wired", async () => {
  const app = await (await fetch(base + "/app.js")).text();
  for (const s of ["async plantmodels(", "Show upstream", "Ingest received drawings", "Accept extracted", "release_plant_model"]) assert.ok(app.includes(s), s);
  const src = await (await fetch(base + "/plant.js")).text();
  for (const s of ["setMode(m)", "buildBlueprint", "LineSegments2", "setOption", "caption("]) assert.ok(src.includes(s), s);
});
