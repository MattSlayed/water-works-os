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
