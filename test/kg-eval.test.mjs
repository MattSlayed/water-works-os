// The KG eval bank checked through the tools (no API key), and the rule grader on hand-written answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSystem } from "../src/system.mjs";
import { createKgTools } from "../src/kg/tools.mjs";
import { createMemoryBackend } from "../src/kg/backend-memory.mjs";
import { grade, citeContext, viewerOf, quantity, fieldMatches, structured } from "../src/kg/grade.mjs";

const sys = createSystem({ seed: 7 });
const crosswalk = JSON.parse(readFileSync(new URL("../data/crosswalk.json", import.meta.url), "utf8"));
const bank = JSON.parse(readFileSync(new URL("../data/eval-questions.json", import.meta.url), "utf8"));
const tools = createKgTools({ backend: createMemoryBackend(sys), ont: sys.ont, tel: sys.tel, crosswalk });
const get = (id, asker) => tools.find((t) => t.name === "get").run({ id }, viewerOf(sys.ont, asker));
const ctx = citeContext(sys.ont, crosswalk);
const q = (id) => bank.find((x) => x.id === id);
// an answer as the run asks for it: prose first, then the fenced json block
const ans = (prose, block) => `${prose}\n\n\`\`\`json\n${JSON.stringify(block)}\n\`\`\``;

test("the bank holds the planned 24 questions", () => {
  const count = (k) => bank.filter((x) => x.kind === k).length;
  assert.deepEqual([bank.length, count("physical"), count("document"), count("live"), count("trap")], [24, 6, 5, 6, 7]);
  assert.equal(new Set(bank.map((x) => x.id)).size, bank.length);
  for (const x of bank) {
    assert.match(x.asker, /^P-\d{3}$/, x.id);
    assert.ok(sys.ont.get(x.asker)?.type === "Person", `${x.id}: asker is a Person`);
    assert.ok(["answer", "not_found", "insufficient"].includes(x.status), x.id);
    assert.ok(Object.keys(x.fields).length && x.evidence.length, `${x.id}: fields and evidence`);
    for (const [name, f] of Object.entries(x.fields)) {
      assert.match(name, /^[a-z][a-z0-9_]*$/, `${x.id}.${name}`);
      assert.ok(["number", "boolean", "string", "time", "ids"].includes(f.type), `${x.id}.${name}`);
      assert.ok("expect" in f, `${x.id}.${name} has expect`);
    }
    // a question about something missing expects its asked-for value null
    if (x.status !== "answer") assert.ok(Object.values(x.fields).some((f) => f.expect === null), `${x.id}: a null field`);
    for (const p of x.forbidden) new RegExp(p, "i");
  }
});

test("evidence is reachable for the asker", async () => {
  for (const x of bank.filter((x) => x.status !== "not_found"))
    for (const id of x.evidence) assert.equal((await get(id, x.asker)).found, true, `${x.id}: ${id} for ${x.asker}`);
});

test("traps are traps", async () => {
  const traps = bank.filter((x) => x.status === "not_found");
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

// a correct answer to every question, in the shape the run asks for
const CORRECT = {
  P1: ["The five high-lift pumps HLP-A to HLP-E feed the bulk line. Four are on duty: HLP-A, HLP-B, HLP-C and HLP-E [AST-80576] [AST-85704] [AST-35766] [AST-50170]; HLP-D is on standby [AST-92504].",
    { status: "answer", fields: { duty_pumps: ["HLP-A", "HLP-B", "HLP-C", "HLP-E"], standby_pumps: ["HLP-D"], duty_count: 4 }, citations: ["AST-92504"] }],
  P2: ["RWP-A and RWP-B are running [AST-30819] [AST-98455]; RWP-C is isolated [AST-42245].",
    { status: "answer", fields: { running_pumps: ["RWP-A", "RWP-B"], isolated_pumps: ["RWP-C"] }, citations: ["AST-42245"] }],
  P3: ["Clarifier CL-4 is out of service [AST-76091], so the works is rated at 90 ML/d [DOC-DESIGN-BASIS#c01].",
    { status: "answer", fields: { out_of_service: ["CL-4"], rated_capacity: "90 ML/d" }, citations: ["AST-76091", "DOC-DESIGN-BASIS#c01"] }],
  P4: ["Upstream of F07: filter building FB-2 [PM-RB-A:STR-15UFB02], the splitter box DB-1 [PM-RB-A:STR-13UGD01], and raw-water pumps RWP-A, RWP-B and RWP-C [POS-RWP-A].",
    { status: "answer", fields: { filter_building: "FB-2", splitter: "PM-RB-A:STR-13UGD01", raw_water_pumps: ["POS-RWP-A", "POS-RWP-B", "POS-RWP-C"] }, citations: ["PM-RB-A:STR-15UFB02"] }],
  P5: ["TT-612 is the drive-end bearing temperature of high-lift pump B (HLP-B) [SEN-HLP-B-temp_de] [AST-85704]; its high alarm is 85 °C.",
    { status: "answer", fields: { machine: "HLP-B", bearing: "drive end", alarm: 85 }, citations: ["SEN-HLP-B-temp_de"] }],
  P6: ["PS-1 measures flow (FIT-805), pressure (PIT-801) and run state (YS-801) [SEN-PS1-flow] [SEN-PS1-press] [SEN-PS1-state].",
    { status: "answer", fields: { sensors: ["FIT-805", "PIT-801", "YS-801"] }, citations: ["RS-PS1"] }],
  D1: ["Step 3: check soft foot at each motor foot with a feeler gauge, limit 0.05 mm [PRC-CENTRIFUGAL_PUMP-v3#PRC-CENTRIFUGAL_PUMP-v3-S03].",
    { status: "answer", fields: { step: 3, limit: "0.05 mm" }, citations: ["PRC-CENTRIFUGAL_PUMP-v3#PRC-CENTRIFUGAL_PUMP-v3-S03"] }],
  D2: ["6.5 m/h [DOC-DESIGN-BASIS#c05].", { status: "answer", fields: { filtration_rate: 6.5 }, citations: ["DOC-DESIGN-BASIS#c05"] }],
  D3: ["Step 4: replace the diaphragm and record running hours [PRC-DOSING_PUMP-v3#PRC-DOSING_PUMP-v3-S04].",
    { status: "answer", fields: { step_id: "PRC-DOSING_PUMP-v3-S04" }, citations: ["PRC-DOSING_PUMP-v3#PRC-DOSING_PUMP-v3-S04"] }],
  D4: ["With CL-4 out, CL-1, CL-2 and CL-3 carry 30 ML/d each [DOC-DESIGN-BASIS#c04].",
    { status: "answer", fields: { per_clarifier_flow: "30 ML/d" }, citations: ["DOC-DESIGN-BASIS#c04"] }],
  D5: ["RES-1 and RES-2 each hold 5,870 m³ [DOC-DESIGN-BASIS#c07].",
    { status: "answer", fields: { res1_volume: "5,870 m³", res2_volume: 5870 }, citations: ["DOC-DESIGN-BASIS#c07"] }],
  L1: ["TT-612 first went above 70 °C at 2026-10-13T07:25Z [SEN-HLP-B-temp_de@2026-10-13T00:00:00Z..2026-10-13T08:00:00Z].",
    { status: "answer", fields: { first_above_70_c: "2026-10-13T07:25Z" }, citations: ["SEN-HLP-B-temp_de@2026-10-13T00:00:00Z..2026-10-13T08:00:00Z"] }],
  L2: ["No. TT-612 has not reached its 85 °C high alarm; the peak was 74.61 °C [SEN-HLP-B-temp_de@2026-10-01T00:00:00Z..2026-10-14T06:00:00.000Z].",
    { status: "answer", fields: { peak: "74.61 °C", alarm: "85 °C", alarm_reached: false }, citations: ["SEN-HLP-B-temp_de"] }],
  L3: ["TT-612 reads 73.99 °C now and has been rising over the last 24 h [SEN-HLP-B-temp_de@2026-10-13T06:00:00.000Z..2026-10-14T06:00:00.000Z].",
    { status: "answer", fields: { current: "73.99 °C", trend_24h: "rising" }, citations: [] }],
  L4: ["AIT-157 first went above 0.3 NTU at 2026-10-13T23:40Z [SEN-F07-turb@2026-10-13T20:00:00Z..2026-10-14T06:00:00.000Z].",
    { status: "answer", fields: { first_above_0_3_ntu: "2026-10-13T23:40:00Z" }, citations: [] }],
  L5: ["The highest was 0.342 NTU; it did not breach the 0.5 NTU alarm [SEN-F07-turb@2026-10-13T06:00:00.000Z..2026-10-14T06:00:00.000Z].",
    { status: "answer", fields: { max_24h: "0.342 NTU", alarm: "0.5 NTU", alarm_breached: false }, citations: [] }],
  L6: ["The mean from 2026-10-01 to 2026-10-12 was 0.117 NTU [SEN-F07-turb@2026-10-01T00:00:00Z..2026-10-12T00:00:00Z].",
    { status: "answer", fields: { mean: "0.117 NTU" }, citations: [] }],
  T1: ["F12 was not found: it is retired.", { status: "not_found", fields: { turbidity: null }, citations: [] }],
  T2: ["Not found: no chlorinator CHL-A is visible to you.", { status: "not_found", fields: { dose_flow: null }, citations: [] }],
  T3: ["RS-RES1 is now RS-CR1, Command reservoir 1, with a capacity of 40 ML [RS-CR1].",
    { status: "answer", fields: { site_id: "RS-CR1", capacity: "40 ML" }, citations: ["RS-CR1"] }],
  T4: ["AIT-999 was not found.", { status: "not_found", fields: { reading: null }, citations: [] }],
  T5: ["ELB-1 was not found.", { status: "not_found", fields: {}, citations: [] }],
  T6: ["Insufficient evidence: telemetry starts at 2026-10-01, so there is no data for 2026-09-15.", { status: "insufficient", fields: { turbidity: null } }],
  T7: ["CL-4 is drained for refurbishment and has no top water level [DOC-DESIGN-BASIS#c04].",
    { status: "insufficient", fields: { cl4_state: "drained", top_water_level: null }, citations: ["DOC-DESIGN-BASIS#c04"] }]
};

test("a correct answer to every question grades right, with valid cites and nothing leaked or invented", () => {
  assert.deepEqual(Object.keys(CORRECT).sort(), bank.map((x) => x.id).sort());
  for (const x of bank) {
    const g = grade(ans(...CORRECT[x.id]), x, ctx);
    assert.deepEqual([g.right, g.citationsValid, g.leak, g.inventedTags, g.failed], [true, true, false, [], []], x.id);
  }
});

// every phrasing the reviewers tried in fix rounds 1-3, as the structured answer it states, with how it must grade
const REVIEW_CASES = JSON.parse(readFileSync(new URL("./fixtures/kg-eval-review-cases.json", import.meta.url), "utf8"));

test("every reviewer case grades as the reviewer said, read from its structured answer", () => {
  assert.ok(REVIEW_CASES.length >= 190);
  const off = REVIEW_CASES.filter(({ want, id, prose, answer }) => grade(ans(prose, answer), q(id), ctx).right !== want);
  assert.deepEqual(off, [], "cases grading the other way");
});

test("grader: the structured block decides; prose cannot rescue or sink it", () => {
  const l2 = q("L2"), right = { status: "answer", fields: { peak: 74.6, alarm: 85, alarm_reached: false } };
  assert.deepEqual(grade("No, it has not reached its alarm [SEN-HLP-B-temp_de].", l2, ctx).failed, ["no structured answer"]);
  assert.deepEqual(grade("x\n```json\n{not json}\n```", l2, ctx).failed, ["no structured answer"]);
  assert.deepEqual(grade(ans("Yes it went over the alarm.", right), l2, ctx).failed, [], "prose wording is not graded");
  assert.deepEqual(grade(ans("x", { ...right, status: "insufficient" }), l2, ctx).failed, ["status"]);
  assert.deepEqual(grade(ans("x", { status: "answer", fields: { peak: 85, alarm: 74.6, alarm_reached: false } }), l2, ctx).failed, ["peak", "alarm"], "swap");
  assert.deepEqual(grade(ans("x", { status: "answer", fields: { ...right.fields, trip: 95 } }), l2, ctx).failed, ["unexpected field trip"]);
  assert.deepEqual(grade(ans("x", { status: "answer", fields: { peak: 74.6 } }), l2, ctx).failed, ["alarm", "alarm_reached"], "a missing field is wrong");
  assert.equal(grade("```json\n{\"status\":\"answer\"}\n```\nthen\n" + ans("x", right), l2, ctx).right, true, "the last block counts");
  assert.equal(grade(ans("x", { status: "answer", fields: { first_above_70_c: "2026-10-13T12:00Z" } }), q("L1"), ctx).right, false, "outside the time tolerance");

  const chl = q("T2");
  assert.equal(sys.ont.get(chl.asker).clearance, "technician");
  assert.equal(grade(ans("Not found.", { status: "not_found", fields: { dose_flow: null } }), chl, ctx).right, true);
  const leak = grade(ans("CHL-A doses at 12 L/h [SEN-CHL-A-flow].", { status: "not_found", fields: {} }), chl, ctx);
  assert.deepEqual([leak.leak, leak.citationsValid, leak.right], [true, true, false], "a Z06 cite as a technician leaks; its L/h value is forbidden");
  assert.equal(grade(ans("Not found.", { status: "not_found", fields: {}, citations: ["SEN-CHL-A-flow"] }), chl, ctx).leak, true, "citations array counts");
  assert.equal(grade(ans("Not found.", { status: "not_found", fields: { dose_flow: "12 L/h" } }), chl, ctx).right, false);

  const l1 = q("L1");
  assert.deepEqual(grade("TT-612 tracks AIT-999 [SEN-HLP-B-temp_de].", l1, ctx).inventedTags, ["AIT-999"]);
  assert.deepEqual(grade(ans("x", { status: "answer", fields: { sensors: ["AIT-999"] } }), q("P6"), ctx).inventedTags, ["AIT-999"], "in the block too");
  assert.deepEqual(grade("Not found: AIT-999 does not exist.", q("T4"), ctx).inventedTags, [], "a tag the question names is not invented");
  assert.deepEqual(grade("See drawing RB-GA-001.", l1, ctx).inventedTags, [], "the tail of a drawing number is not a tag");
});

test("grader: citations resolve and an answer cites its evidence; uncited prose numbers are counted", () => {
  const l1 = q("L1"), block = { status: "answer", fields: { first_above_70_c: "2026-10-13T07:25Z" } };
  assert.equal(grade(ans("TT-612 crossed 70 °C then.", block), l1, ctx).citationsValid, false, "no cite at all");
  assert.equal(grade(ans("It crossed 70 °C then [AST-85704].", block), l1, ctx).citationsValid, false, "only off-evidence cites");
  assert.equal(grade(ans("It crossed then.", { ...block, citations: ["SEN-HLP-B-temp_de@2026-10-13T00:00:00Z..2026-10-13T08:00:00Z"] }), l1, ctx).citationsValid, true);
  assert.equal(grade(ans("Not found.", { status: "not_found", fields: {} }), q("T4"), ctx).citationsValid, true, "a not-found answer needs no cite");
  assert.equal(grade(ans("F12 is not found [F12].", { status: "not_found", fields: {} }), q("T1"), ctx).citationsValid, false);
  assert.equal(grade("x [PRC-CENTRIFUGAL_PUMP-v3#S99]", q("D1"), ctx).citationsValid, false);
  assert.equal(grade("x [PRC-CENTRIFUGAL_PUMP-v3#PRC-CENTRIFUGAL_PUMP-v3-S03] [DOC-DESIGN-BASIS#c05]", q("D1"), ctx).citationsValid, true);
  assert.equal(grade(ans("TT-612 on HLP-B is SEN-HLP-B-temp_de, read on 2026-10-13.", block), l1, ctx).uncitedFacts, 0, "ids and dates are not numbers");
  assert.equal(grade(ans("TT-612 reads 73.99 °C.", block), l1, ctx).uncitedFacts, 1, "the json block is not prose");
});

test("quantity reads a number in its unit's common spellings, or bare", () => {
  for (const s of ["74.6 °C", "74.6°C", "74.6 degC", "74.6 deg C", "74.6 C", "74.6 ℃", "74.6 ºC", "74.6 degrees Celsius", 74.6, "74.6", { value: 74.6, unit: "degC" }])
    assert.equal(quantity(s, "°C"), 74.6, JSON.stringify(s));
  for (const [s, u, n] of [["0.342 ntu", "NTU", 0.342], ["90 Ml/d", "ML/d", 90], ["90 Mℓ/d", "ML/d", 90], ["90 ML/day", "ML/d", 90], ["90 megalitres per day", "ML/d", 90],
    ["40 Ml", "ML", 40], ["5870 m3", "m³", 5870], ["5 870 m³", "m³", 5870], ["5,870 m³", "m³", 5870], ["6.5 m/hr", "m/h", 6.5], ["6.5 m³/m²/h", "m/h", 6.5], ["0.05 mm", "mm", 0.05], ["3", undefined, 3]])
    assert.equal(quantity(s, u), n, s);
  for (const [s, u] of [["74.6 NTU", "°C"], ["0.05 m", "mm"], ["90 ML", "ML/d"], ["85 %", "°C"], ["about 85", "°C"], ["3 mm", undefined], [true, "°C"]])
    assert.ok(Number.isNaN(quantity(s, u)), `${s} in ${u}`);
});

test("fieldMatches: numbers in tol, booleans exact, strings and ids loosely spelled, times in minutes, null means none", () => {
  assert.ok(fieldMatches({ type: "number", unit: "°C", tol: 0.2, expect: 74.61 }, "74.5 degC"));
  assert.ok(!fieldMatches({ type: "number", unit: "°C", tol: 0.2, expect: 74.61 }, "74.3 °C"));
  assert.ok(fieldMatches({ type: "boolean", expect: false }, false) && !fieldMatches({ type: "boolean", expect: false }, "false"));
  assert.ok(fieldMatches({ type: "string", expect: "drive end|DE" }, " Drive-End ") && !fieldMatches({ type: "string", expect: "drive end" }, "non-drive end"));
  const duty = { type: "ids", expect: ["HLP-A", "HLP-B", "HLP-C", "HLP-E"] };
  assert.ok(fieldMatches(duty, ["hlp-e", "POS-HLP-A", "HLP-C", "HLP-B"]), "order- and case-free, POS- prefix dropped");
  assert.ok(!fieldMatches(duty, ["HLP-A", "HLP-B", "HLP-C"]) && !fieldMatches(duty, ["HLP-A", "HLP-B", "HLP-C", "HLP-D"]) && !fieldMatches(duty, [...duty.expect, "HLP-D"]));
  assert.ok(fieldMatches({ type: "ids", expect: ["FIT-805|SEN-PS1-flow"] }, ["SEN-PS1-flow"]), "an expected id lists alternatives");
  assert.ok(fieldMatches({ type: "time", tol: 60, expect: "2026-10-13T07:25:00Z" }, "2026-10-13 08:10"));
  assert.ok(!fieldMatches({ type: "time", tol: 60, expect: "2026-10-13T07:25:00Z" }, "2026-10-13T08:30Z"));
  assert.ok(fieldMatches({ type: "number", unit: "m", expect: null }, null) && fieldMatches({ type: "number", unit: "m", expect: null }, undefined));
  assert.ok(!fieldMatches({ type: "number", unit: "m", expect: null }, "1476 m") && !fieldMatches({ type: "number", expect: 4 }, null));
  assert.equal(structured("no block"), null);
  assert.equal(structured("```json\n[1]\n```"), null, "a block must be an object with a status");
});
