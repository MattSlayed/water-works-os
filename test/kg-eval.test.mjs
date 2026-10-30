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

test("eval-claude --backend atlas with no reachable Atlas stops before any model call", () => {
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "sk-test-not-a-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", // a model call, if reached, goes nowhere
    TIMEBASE_ATLAS_URL: "https://127.0.0.1:1", TIMEBASE_HISTORIAN_URL: "https://127.0.0.1:1", TIMEBASE_PULSE_URL: "https://127.0.0.1:1",
    TIMEBASE_CLIENT_ID: "c", TIMEBASE_SECRET_FILE: "/nope/hunter2.secret"
  };
  delete env.ANTHROPIC_AUTH_TOKEN;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/kg/eval-claude.mjs", import.meta.url)), "--backend", "atlas"], { env, encoding: "utf8", timeout: 60e3 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^eval-claude: KG backend atlas unavailable: .*nothing was run\.\n$/);
  assert.ok(!/hunter2|sk-test/.test(r.stderr + r.stdout), "no secret in the message");
  assert.equal(r.stdout, "", "no question was asked");
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

// a correct answer to every question, in the shape the run's system prompt asks for
const CORRECT = {
  P1: "The five high-lift pumps HLP-A to HLP-E feed the bulk line [POS-HLP-A]. Four are on duty (running): HLP-A, HLP-B, HLP-C and HLP-E [AST-80576] [AST-85704] [AST-35766] [AST-50170]; HLP-D is on standby [AST-92504].",
  P2: "RWP-A and RWP-B are running [AST-30819] [AST-98455]; RWP-C is isolated [AST-42245].",
  P3: "Clarifier CL-4 is out of service [AST-76091], so the works is rated at 90 ML/d [DOC-DESIGN-BASIS#c01].",
  P4: "Upstream of F07: filter building FB-2 [PM-RB-A:STR-15UFB02], clarifiers CL-1, CL-2 and CL-3 [POS-CL-1], the splitter box DB-1 [PM-RB-A:STR-13UGD01], and the raw-water pumps [POS-RWP-A].",
  P5: "TT-612 is the drive-end bearing temperature of high-lift pump B (HLP-B) [SEN-HLP-B-temp_de] [AST-85704]; its high alarm is 85 °C [SEN-HLP-B-temp_de].",
  P6: "PS-1 measures flow (FIT-805), pressure (PIT-801) and run state (YS-801) [SEN-PS1-flow] [SEN-PS1-press] [SEN-PS1-state].",
  D1: "Step 3: check soft foot at each motor foot with a feeler gauge, limit 0.05 mm [PRC-CENTRIFUGAL_PUMP-v3#PRC-CENTRIFUGAL_PUMP-v3-S03].",
  D2: "6.5 m/h [DOC-DESIGN-BASIS#c05].",
  D3: "Step 4: replace the diaphragm and record running hours [PRC-DOSING_PUMP-v3#PRC-DOSING_PUMP-v3-S04].",
  D4: "With CL-4 out, CL-1, CL-2 and CL-3 carry 30 ML/d each [DOC-DESIGN-BASIS#c04].",
  D5: "RES-1 and RES-2 each hold 5,870 m³ [DOC-DESIGN-BASIS#c07].",
  L1: "TT-612 first went above 70 °C at 2026-10-13T07:25Z [SEN-HLP-B-temp_de@2026-10-13T00:00:00Z..2026-10-13T08:00:00Z].",
  L2: "No. TT-612 has not reached its 85 °C high alarm; the peak was 74.61 °C [SEN-HLP-B-temp_de@2026-10-01T00:00:00Z..2026-10-14T06:00:00.000Z].",
  L3: "TT-612 reads 73.99 °C now and has been rising over the last 24 h, about +0.08 °C/h [SEN-HLP-B-temp_de@2026-10-13T06:00:00.000Z..2026-10-14T06:00:00.000Z].",
  L4: "AIT-157 first went above 0.3 NTU at 2026-10-13T23:40Z [SEN-F07-turb@2026-10-13T20:00:00Z..2026-10-14T06:00:00.000Z].",
  L5: "The highest was 0.342 NTU; it did not breach the 0.5 NTU alarm [SEN-F07-turb@2026-10-13T06:00:00.000Z..2026-10-14T06:00:00.000Z].",
  L6: "The mean from 2026-10-01 to 2026-10-12 was 0.117 NTU [SEN-F07-turb@2026-10-01T00:00:00Z..2026-10-12T00:00:00Z].",
  T1: "F12 was not found: it is retired.",
  T2: "Not found: no chlorinator CHL-A is visible to you.",
  T3: "RS-RES1 is now RS-CR1, Command reservoir 1, with a capacity of 40 ML [RS-CR1].",
  T4: "AIT-999 was not found.",
  T5: "ELB-1 was not found.",
  T6: "Insufficient evidence: telemetry starts at 2026-10-01, so there is no data for 2026-09-15.",
  T7: "CL-4 is drained for refurbishment and has no top water level [DOC-DESIGN-BASIS#c04]."
};

test("a correct answer to every question grades right, with valid cites and nothing leaked or invented", () => {
  assert.deepEqual(Object.keys(CORRECT).sort(), bank.map((x) => x.id).sort());
  for (const x of bank) {
    const g = grade(CORRECT[x.id], x, ctx);
    assert.deepEqual([g.right, g.citationsValid, g.leak, g.inventedTags, g.missing], [true, true, false, [], []], x.id);
  }
});

test("required items check facts, not names (review fix round 1)", () => {
  const wrong = {
    P2: ["RWP-A is isolated, RWP-B is isolated and RWP-C is isolated [AST-30819]."],
    L3: ["TT-612 reads 73.99 °C now and is falling, not rising [SEN-HLP-B-temp_de]."],
    L2: ["Yes, TT-612 went above its 85 °C alarm; it peaked at 74.6 °C and is below it now [SEN-HLP-B-temp_de]."],
    P5: ["TT-612 is the drive-end bearing temperature of HLP-B; its high alarm is 95 °C, about 85 % of trip [SEN-HLP-B-temp_de]."],
    L5: ["Yes, AIT-157 breached its 0.5 NTU alarm; it peaked at 0.342 NTU and is below it now [SEN-F07-turb]."],
    T7: ["CL-4 is drained for repair, so the top water level of CL-4 is 1476 m like the others [DOC-DESIGN-BASIS#c04].",
      "The top water level of CL-4 is 1476 m; it is currently drained [DOC-DESIGN-BASIS#c04]."],
    T1: ["F12 is not found, but F12 reads 0.34 NTU."],
    T6: ["Not available, but on 2026-09-15 it read 0.12 NTU."]
  };
  for (const [id, answers] of Object.entries(wrong)) for (const a of answers) assert.equal(grade(a, q(id), ctx).right, false, `${id}: ${a}`);
  assert.equal(grade("F12 is retired; its duty moved to F07, which reads 0.34 NTU [SEN-F07-turb].", q("T1"), ctx).right, true);
  assert.equal(grade("No data for 2026-09-15: telemetry starts at 2026-10-01, when AIT-157 read 0.127 NTU [SEN-F07-turb].", q("T6"), ctx).right, true);
});

test("an answer must cite its evidence; uncited numbers are counted, ids and dates aside (review fix round 1)", () => {
  const l1 = q("L1");
  assert.equal(grade("TT-612 first went above 70 °C at 2026-10-13T07:25Z.", l1, ctx).citationsValid, false, "no cite at all");
  assert.equal(grade("TT-612 first went above 70 °C at 2026-10-13T07:25Z [AST-85704].", l1, ctx).citationsValid, false, "cites only off-evidence ids");
  assert.equal(grade("Not found.", q("T4"), ctx).citationsValid, true, "a not-found answer needs no cite");
  assert.equal(grade("TT-612 on HLP-B is SEN-HLP-B-temp_de, read on 2026-10-13.", l1, ctx).uncitedFacts, 0);
  assert.equal(grade("TT-612 reads 73.99 °C.", l1, ctx).uncitedFacts, 1);
});
