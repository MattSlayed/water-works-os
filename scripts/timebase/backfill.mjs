// Backfills every ontology sensor into the Timebase Historian dataset "Riverbend". Prints counts only.
// Usage: TIMEBASE_CLIENT_ID=WaterOS TIMEBASE_SECRET_FILE=<file> [NODE_EXTRA_CA_CERTS=<pulse-ca.pem>] node scripts/timebase/backfill.mjs [--reset]
import { generateWorks } from "../../src/generate.mjs";
import { createOntology } from "../../src/ontology.mjs";
import { createTelemetry } from "../../src/telemetry.mjs";
import { pulseToken } from "../../src/timebase/pulse.mjs";
import { restCall } from "../../src/timebase/rest.mjs";
import { historianTags } from "../../src/timebase/historian-tags.mjs";

const DS = "Riverbend";
const BATCH = 20000;
const env = process.env;
if (!env.TIMEBASE_CLIENT_ID || !env.TIMEBASE_SECRET_FILE) throw new Error("Set TIMEBASE_CLIENT_ID and TIMEBASE_SECRET_FILE");
const dataset = env.TIMEBASE_DATASET ?? DS;
if (dataset !== DS) throw new Error(`Refusing dataset "${dataset}": this script only writes "${DS}"`);
const base = env.TIMEBASE_HISTORIAN_URL ?? "https://localhost:4512";
const pulseUrl = env.TIMEBASE_PULSE_URL ?? "https://localhost:4542";

const call = async (method, path, body) => {
  const token = await pulseToken({ pulseUrl, clientId: env.TIMEBASE_CLIENT_ID, secretFile: env.TIMEBASE_SECRET_FILE });
  return restCall(base, method, path, body, { token });
};
const ok = (what, r) => { if (r.status < 200 || r.status > 299) throw new Error(`${what}: HTTP ${r.status}`); return r; };

const ont = createOntology(generateWorks(7));
const tel = createTelemetry({ ont }); // the window comes from telemetry, never from this script
const { start, end } = tel;
const tags = historianTags(ont);

if (process.argv.includes("--reset")) {
  const r = await call("DELETE", `/api/datasets/${DS}`);
  if (r.status !== 404) ok("reset", r);
}
ok("create dataset", await call("POST", "/api/datasets", { n: DS, pa: 0, ps: 0, lda: 120 }));
ok("create tags", await call("POST", `/api/datasets/${DS}/tags`, tags.map(({ sensorId, ...t }) => ({ ...t, f: "0.000" }))));

const totals = { tags: tags.length, sent: 0, accepted: 0, cs: 0, pp: 0, lda: 0 };
for (const { n, sensorId } of tags) {
  const pts = tel.series(sensorId, start, end); // oldest first
  for (let i = 0; i < pts.length; i += BATCH) {
    const batch = pts.slice(i, i + BATCH).map((p) => ({ t: p.t, v: p.v, q: 192 }));
    const w = ok(`write ${n}`, await call("POST", `/api/datasets/${DS}/data/${encodeURIComponent(n)}`, batch));
    totals.sent += batch.length;
    totals.accepted += w.body.a;
    for (const k of ["cs", "pp", "lda"]) totals[k] += w.body.r?.[k] ?? 0;
  }
}
totals.rejected = totals.sent - totals.accepted;
console.log(JSON.stringify(totals));
