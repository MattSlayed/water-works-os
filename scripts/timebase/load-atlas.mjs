// Loads the Riverbend physical layer into Timebase Atlas (domain "riverbend") on the given branch, idempotently.
// Usage: TIMEBASE_CLIENT_ID=WaterOS TIMEBASE_SECRET_FILE=<file> [NODE_EXTRA_CA_CERTS=<pulse-ca.pem>] node scripts/timebase/load-atlas.mjs riverbend [core|full]
// Branch riverbend-slim always loads the slim model. The default scope, core, fits the free licence (atlas-model.mjs).
import { generateWorks } from "../../src/generate.mjs";
import { createOntology } from "../../src/ontology.mjs";
import { seedPlant, currentPlantModel } from "../../src/plant.mjs";
import { seedKg } from "../../src/kg/seed.mjs";
import { pulseToken } from "../../src/timebase/pulse.mjs";
import { restCall } from "../../src/timebase/rest.mjs";
import { createAtlasSync } from "../../src/timebase/atlas-sync.mjs";

const [BR, SCOPE = "core"] = process.argv.slice(2), DOM = "riverbend";
if (!BR || !/^[\w.-]+$/.test(BR)) throw new Error("Usage: load-atlas.mjs <branch> [core|full]");
if (!["core", "full"].includes(SCOPE)) throw new Error(`Unknown scope "${SCOPE}": core or full`);
const env = process.env;
if (!env.TIMEBASE_CLIENT_ID || !env.TIMEBASE_SECRET_FILE) throw new Error("Set TIMEBASE_CLIENT_ID and TIMEBASE_SECRET_FILE");
const base = env.TIMEBASE_ATLAS_URL ?? "https://localhost:4552";
const pulseUrl = env.TIMEBASE_PULSE_URL ?? "https://localhost:4542";
const call = async (method, path, body) => restCall(base, method, path, body, { token: await pulseToken({ pulseUrl, clientId: env.TIMEBASE_CLIENT_ID, secretFile: env.TIMEBASE_SECRET_FILE }) });

const atlas = createAtlasSync({ call, branch: BR, domain: DOM, scope: BR === "riverbend-slim" ? "slim" : SCOPE, log: console.log }); // refuses a wrong branch before any network call
const ont = createOntology(generateWorks(7));
seedPlant(ont);
seedKg(ont);
const r = await atlas.sync(ont);
console.log(`compile edges ${r.edges ?? "unchanged"}`);

const res2 = `${currentPlantModel(ont).id}:STR-20UBA02`;
const q = (await call("POST", `/api/v1/branches/${BR}/domains/${DOM}/queries`, { cypher: "MATCH (r)<-[:feeds*1..12]-(u) WHERE r.wosId = $id RETURN u.wosId", parameters: { id: res2 } })).body;
const up = [...new Set((q?.data || []).map((row) => row[0]))].sort();
console.log(`upstream of RES-2 (${res2}): ${up.length} ${up.join(" ")}`);
