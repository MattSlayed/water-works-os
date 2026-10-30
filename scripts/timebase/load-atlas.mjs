// Loads the Riverbend physical layer into Timebase Atlas (domain "riverbend") on the given branch, idempotently.
// Usage: TIMEBASE_CLIENT_ID=WaterOS TIMEBASE_SECRET_FILE=<file> [NODE_EXTRA_CA_CERTS=<pulse-ca.pem>] node scripts/timebase/load-atlas.mjs riverbend
import { generateWorks } from "../../src/generate.mjs";
import { createOntology } from "../../src/ontology.mjs";
import { seedPlant, currentPlantModel } from "../../src/plant.mjs";
import { seedKg } from "../../src/kg/seed.mjs";
import { pulseToken } from "../../src/timebase/pulse.mjs";
import { restCall } from "../../src/timebase/rest.mjs";
import { atlasModel, planLoad, ATLAS_TYPES } from "../../src/timebase/atlas-model.mjs";

const BR = process.argv[2], DOM = "riverbend", MAP = "plant";
if (!BR || !/^[\w.-]+$/.test(BR)) throw new Error("Usage: load-atlas.mjs <branch>");
if (BR !== "riverbend") throw new Error(`Refusing branch "${BR}": REST writes go to branch "riverbend" only`);
const env = process.env;
if (!env.TIMEBASE_CLIENT_ID || !env.TIMEBASE_SECRET_FILE) throw new Error("Set TIMEBASE_CLIENT_ID and TIMEBASE_SECRET_FILE");
const base = env.TIMEBASE_ATLAS_URL ?? "https://localhost:4552";
const pulseUrl = env.TIMEBASE_PULSE_URL ?? "https://localhost:4542";
const P = `/api/v1/branches/${BR}/domains/${DOM}`;

const call = async (method, path, body) => {
  const token = await pulseToken({ pulseUrl, clientId: env.TIMEBASE_CLIENT_ID, secretFile: env.TIMEBASE_SECRET_FILE });
  return restCall(base, method, path, body, { token });
};
const detail = (b) => JSON.stringify(b && typeof b === "object" ? { title: b.title, detail: b.detail, code: b.code, violations: b.violations?.slice(0, 10) } : b).slice(0, 2000);
const ok = (what, r, also = []) => {
  if ((r.status < 200 || r.status > 299) && !also.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${detail(r.body)}`);
  return r;
};
// create, or on 409 replace the definition (the Atlas ontology routes update with PATCH; there is no PUT)
const define = async (kind, { name, ...rest }) => {
  const r = ok(`${kind} ${name}`, await call("POST", `${P}/${kind}`, { name, ...rest }), [409]);
  if (r.status === 409) ok(`${kind} ${name} (update)`, await call("PATCH", `${P}/${kind}/${encodeURIComponent(name)}`, rest));
};

const ont = createOntology(generateWorks(7));
seedPlant(ont);
seedKg(ont);
const model = atlasModel(ont, { domain: DOM });

ok("branch", await call("POST", "/api/v1/branches", { name: BR, from: "main" }), [409]);
ok("domain", await call("POST", "/api/v1/domains", { name: DOM, branch: BR, libraries: ["atlas-common"] }), [409]);
for (const p of model.properties) await define("properties", p);
for (const t of model.entityTypes) await define("entity-types", t);
for (const t of model.relationshipTypes) await define("relationship-types", t);
ok("instance map", await call("POST", `${P}/instance-maps`, { name: MAP }), [409]);

const existing = ok("existing", await call("GET", `${P}/instance-maps/${MAP}/instances`)).body || [];
const plan = planLoad([...model.instances, ...model.edges], existing);
const isEdge = (x) => !!x.source;
// nodes before the edges that name them; edges go first on removal
for (const x of [...plan.create.filter((x) => !isEdge(x)), ...plan.create.filter(isEdge)]) ok(`create ${x.id}`, await call("POST", `${P}/instance-maps/${MAP}/instances`, x));
for (const { id, ...x } of plan.update) ok(`update ${id}`, await call("PATCH", `${P}/instance-maps/instances/${encodeURIComponent(id)}`, x));
for (const x of [...plan.remove.filter(isEdge), ...plan.remove.filter((x) => !isEdge(x))]) ok(`remove ${x.id}`, await call("DELETE", `${P}/instance-maps/instances/${encodeURIComponent(x.id)}`));
console.log(`create ${plan.create.length} update ${plan.update.length} remove ${plan.remove.length}`);

const pub = await call("POST", `/api/v1/branches/${BR}/draft/publish`, {});
if (!(pub.status === 409 && pub.body?.code === "Draft.NothingToPublish")) ok("publish", pub);
console.log(`publish ${pub.status === 409 ? "nothing to publish" : pub.status}`);
const w = ok("compile", await call("PUT", `${P}/world`)).body;
console.log(`compile edges ${w.edgeCount} functionErrors ${w.functionErrors?.length ?? 0}`);

const counts = {};
for (const t of ATLAS_TYPES) counts[t] = ok(`count ${t}`, await call("GET", `${P}/instances?type=${encodeURIComponent(`urn:atlas:ontology:${DOM}:${t}`)}&pageSize=1`)).body.totalCount;
console.log(JSON.stringify(counts));
const res2 = `${currentPlantModel(ont).id}:STR-20UBA02`;
const q = ok("upstream", await call("POST", `${P}/queries`, { cypher: "MATCH (r)<-[:feeds*1..12]-(u) WHERE r.wosId = $id RETURN u.wosId", parameters: { id: res2 } })).body;
const up = [...new Set((q.data || []).map((row) => row[0]))].sort();
console.log(`upstream of RES-2 (${res2}): ${up.length} ${up.join(" ")}`);
