import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createSystem } from "../src/system.mjs";
import { saveState, loadState, snapshotOf } from "../src/state.mjs";

const file = () => path.join(mkdtempSync(path.join(tmpdir(), "wwos-state-")), "state.json");
const raise = (sys, title) => sys.actions.invoke({ action: "raise_issue", params: { title, projectId: "PRJ-RES2" }, actor: { kind: "person", id: "P-004", clearance: sys.ont.get("P-004").clearance } });

test("a restart resumes people's changes, the audit chain, runs, autonomy and the clock", () => {
  const a = createSystem({ seed: 7 });
  const issue = raise(a, "Kept across a restart").decision.objects[0];
  const spec = a.runtime.specs().find((s) => s.tools.length && s.autonomy[s.tools[0]] !== "draft");
  a.runtime.setAutonomy(spec.name, spec.tools[0], "draft");
  a.runtime.run("Process Watch", { actingUser: { id: "SYSTEM", kind: "person", clearance: "manager", role: "system" } });
  a.tel.tick(30);
  const f = file();
  saveState(f, a);

  const b = createSystem({ seed: 7, state: loadState(f, 7) });
  assert.equal(b.ont.get(issue).title, "Kept across a restart");
  assert.equal(b.audit.all().length, a.audit.all().length);
  assert.ok(b.audit.verify(), "the saved hash chain still verifies");
  assert.equal(b.tel.cursor(), a.tel.cursor());
  assert.deepEqual(b.runtime.runs().map((r) => r.id), a.runtime.runs().map((r) => r.id));
  assert.equal(b.runtime.spec(spec.name).autonomy[spec.tools[0]], "draft");
  assert.equal(b.ont.list().length, a.ont.list().length, "the seed's start-of-shift events are not added twice");

  const linkCount = (s) => s.ont.list().reduce((n, o) => n + s.ont.links(o.id, { dir: "out" }).length, 0);
  assert.equal(linkCount(b), linkCount(a), "saved links come back once");
  const saved = snapshotOf(a).ont.objects;
  assert.ok(saved.some((o) => o.id === issue));
  assert.ok(!saved.some((o) => o.type === "Part"), "untouched seed objects are not saved, so a redeploy's seed fixes show");

  // A real restart is a new process, where the id counters start at 0: new ids must continue past the saved ones.
  const child = `import { createSystem } from ${JSON.stringify(new URL("../src/system.mjs", import.meta.url).href)};
    import { loadState } from ${JSON.stringify(new URL("../src/state.mjs", import.meta.url).href)};
    const s = createSystem({ seed: 7, state: loadState(${JSON.stringify(f)}, 7) });
    const r = s.actions.invoke({ action: "raise_issue", params: { title: "After the restart", projectId: "PRJ-RES2" }, actor: { kind: "person", id: "P-004", clearance: s.ont.get("P-004").clearance } });
    const run = s.runtime.run("Process Watch", { actingUser: { id: "SYSTEM", kind: "person", clearance: "manager", role: "system" } });
    console.log(JSON.stringify({ next: r.decision.objects[0], kept: s.ont.get(${JSON.stringify(issue)}).title, run: run.id, ok: s.audit.verify() }));`;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim().split("\n").pop());
  assert.equal(a.ont.get(r.next), null, `new id ${r.next} overwrote a saved object`);
  assert.equal(r.kept, "Kept across a restart");
  assert.ok(!a.runtime.runs().some((x) => x.id === r.run), `run id ${r.run} reused`);
  assert.ok(r.ok);
});

test("nothing saved means a fresh start; another seed or format is refused", () => {
  const f = file();
  assert.equal(loadState(f, 7), null);
  writeFileSync(f, JSON.stringify({ v: 1, seed: 8 }));
  assert.throws(() => loadState(f, 7), /seed 8/);
  writeFileSync(f, JSON.stringify({ v: 99, seed: 7 }));
  assert.throws(() => loadState(f, 7), /format 99/);
});
