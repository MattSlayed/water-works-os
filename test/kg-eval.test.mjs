// The KG eval bank checked through the tools (no API key), and the rule grader on hand-written answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSystem } from "../src/system.mjs";
import { createKgTools } from "../src/kg/tools.mjs";
import { createMemoryBackend } from "../src/kg/backend-memory.mjs";
import { grade, citeContext, viewerOf } from "../src/kg/grade.mjs";

const sys = createSystem({ seed: 7 });
const crosswalk = JSON.parse(readFileSync(new URL("../data/crosswalk.json", import.meta.url), "utf8"));
const bank = JSON.parse(readFileSync(new URL("../data/eval-questions.json", import.meta.url), "utf8"));
const tools = createKgTools({ backend: createMemoryBackend(sys), ont: sys.ont, tel: sys.tel, crosswalk });
const get = (id, asker) => tools.find((t) => t.name === "get").run({ id }, viewerOf(sys.ont, asker));
const ctx = citeContext(sys.ont, crosswalk);
const q = (id) => bank.find((x) => x.id === id);

test("the bank holds the planned 24 questions", () => {
  const count = (k) => bank.filter((x) => x.kind === k).length;
  assert.deepEqual([bank.length, count("physical"), count("document"), count("live"), count("trap")], [24, 6, 5, 6, 7]);
  assert.equal(new Set(bank.map((x) => x.id)).size, bank.length);
  for (const x of bank) {
    assert.match(x.asker, /^P-\d{3}$/, x.id);
    assert.ok(sys.ont.get(x.asker)?.type === "Person", `${x.id}: asker is a Person`);
    assert.ok(["answer", "not_found", "insufficient"].includes(x.expect), x.id);
    assert.ok(x.required.length && x.evidence.length, `${x.id}: required and evidence`);
    for (const r of x.required) if (r.pattern) new RegExp(r.pattern, "i");
  }
});

test("evidence is reachable for the asker", async () => {
  for (const x of bank.filter((x) => x.expect !== "not_found"))
    for (const id of x.evidence) assert.equal((await get(id, x.asker)).found, true, `${x.id}: ${id} for ${x.asker}`);
});

test("traps are traps", async () => {
  const traps = bank.filter((x) => x.expect === "not_found");
  assert.ok(traps.length >= 4);
  for (const x of traps) for (const id of x.evidence) assert.equal((await get(id, x.asker)).found, false, `${x.id}: ${id} for ${x.asker}`);
});

test("eval-claude without credentials says so and runs nothing", () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/kg/eval-claude.mjs", import.meta.url))], { env, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.*nothing was run/);
});

test("grader", () => {
  const l1 = q("L1");
  const good = grade("TT-612, the HLP-B drive-end bearing, first went above 70 °C at 2026-10-13T07:25Z [SEN-HLP-B-temp_de@2026-10-13T06:00:00Z..2026-10-13T08:00:00Z].", l1, ctx);
  assert.deepEqual(good, { right: true, citationsValid: true, uncitedFacts: 0, leak: false, inventedTags: [], missing: [] });
  const vague = grade("TT-612 has been climbing since the bearing started to fail [SEN-HLP-B-temp_de].", l1, ctx);
  assert.equal(vague.right, false);
  assert.deepEqual(vague.missing, l1.required.map((r) => r.label));
  assert.equal(grade("It crossed 70 °C at 2026-10-13T12:00Z [SEN-HLP-B-temp_de].", l1, ctx).right, false, "outside the tolerance");
  assert.equal(grade("It crossed 70 °C at 2026-10-13T07:25Z.", l1, ctx).uncitedFacts, 1);

  const chl = q("T2");
  assert.equal(sys.ont.get(chl.asker).clearance, "technician");
  assert.equal(grade("Not found: no chlorinator CHL-A is visible to you.", chl, ctx).right, true);
  const leak = grade("CHL-A doses at 12 L/h [SEN-CHL-A-flow].", chl, ctx);
  assert.deepEqual([leak.leak, leak.citationsValid, leak.right], [true, true, false]);

  assert.deepEqual(grade("TT-612 tracks AIT-999 [SEN-HLP-B-temp_de].", l1, ctx).inventedTags, ["AIT-999"]);
  assert.deepEqual(grade("Not found: AIT-999 does not exist.", q("T4"), ctx).inventedTags, [], "a tag the question names is not invented");
  assert.deepEqual(grade("See drawing RB-GA-001.", l1, ctx).inventedTags, [], "the tail of a drawing number is not a tag");
  assert.equal(grade("F12 is not found [F12].", q("T1"), ctx).citationsValid, false);
  assert.equal(grade("Step 3, soft foot under 0.05 mm [PRC-CENTRIFUGAL_PUMP-v3#PRC-CENTRIFUGAL_PUMP-v3-S03] [DOC-DESIGN-BASIS#c05].", q("D1"), ctx).citationsValid, true);
  assert.equal(grade("x [PRC-CENTRIFUGAL_PUMP-v3#S99]", q("D1"), ctx).citationsValid, false);
});
