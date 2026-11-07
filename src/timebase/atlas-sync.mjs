// Makes Timebase Atlas (domain "riverbend") match the WaterOS ontology: define the types, diff the instance map,
// create/update/remove, publish, compile. Used by scripts/timebase/load-atlas.mjs and by the server's write-through.
// WaterOS stays the source of truth: Atlas is only ever written from the ontology, never the other way.
import { atlasModel, coreModel, slimModel, planLoad, atlasCost, ATLAS_INSTANCE_LIMIT } from "./atlas-model.mjs";

export const ATLAS_BRANCHES = ["riverbend", "riverbend-slim"];
const MAP = "plant";

// call(method, path, body) -> { status, body }: a REST call to Atlas with a Pulse token (restCall + pulseToken).
// scope: "core" (fits the free licence), "full" (every allowlisted type) or "slim" (flow only, the unlicensed proof).
export function createAtlasSync({ call, branch = "riverbend", domain = "riverbend", scope = "core", limit = ATLAS_INSTANCE_LIMIT, log = () => {} }) {
  if (!ATLAS_BRANCHES.includes(branch)) throw new Error(`Refusing branch "${branch}": REST writes go to branch ${ATLAS_BRANCHES.map((b) => `"${b}"`).join(" or ")} only`);
  const P = `/api/v1/branches/${branch}/domains/${domain}`;
  const detail = (b) => JSON.stringify(b && typeof b === "object" ? { title: b.title, detail: b.detail, code: b.code, violations: b.violations?.slice(0, 10) } : b).slice(0, 600);
  const ok = async (what, p, also = []) => {
    const r = await p;
    if ((r.status < 200 || r.status > 299) && !also.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${detail(r.body)}`);
    return r;
  };
  // create, or on 409 replace the definition (the Atlas ontology routes update with PATCH; there is no PUT)
  const define = async (kind, { name, ...rest }) => {
    const r = await ok(`${kind} ${name}`, call("POST", `${P}/${kind}`, { name, ...rest }), [409]);
    if (r.status === 409) await ok(`${kind} ${name} (update)`, call("PATCH", `${P}/${kind}/${encodeURIComponent(name)}`, rest));
  };
  const defined = new Set(); // definitions sent by this process; a write-through sync only sends new ones
  let stale = true; // the compiled world may lag the instance map

  const modelOf = (ont) => {
    const full = atlasModel(ont, { domain });
    return scope === "full" ? full : scope === "slim" ? slimModel(full, { domain }) : coreModel(full, { domain });
  };

  async function sync(ont) {
    const model = modelOf(ont), cost = atlasCost(model);
    // refused here rather than by Atlas after every write: the ontology keeps the change, Atlas stays as it was
    if (cost > limit) throw Object.assign(new Error(`Atlas licence: this model needs about ${cost} instances and the licence allows ${limit}; nothing was sent`), { code: "ATLAS_LIMIT", cost, limit });
    if (!defined.has("branch")) {
      await ok("branch", call("POST", "/api/v1/branches", { name: branch, from: "main" }), [409]);
      await ok("domain", call("POST", "/api/v1/domains", { name: domain, branch, libraries: ["atlas-common"] }), [409]);
      await ok("instance map", call("POST", `${P}/instance-maps`, { name: MAP }), [409]);
      defined.add("branch");
    }
    for (const [kind, list] of [["properties", model.properties], ["entity-types", model.entityTypes], ["relationship-types", model.relationshipTypes]])
      for (const d of list) {
        const key = `${kind}|${JSON.stringify(d)}`;
        if (!defined.has(key)) { await define(kind, d); defined.add(key); }
      }

    const existing = (await ok("existing", call("GET", `${P}/instance-maps/${MAP}/instances`))).body || [];
    const plan = planLoad([...model.instances, ...model.edges], existing);
    const isEdge = (x) => !!x.source;
    // edges go first on removal, nodes before the edges that name them on creation
    for (const x of [...plan.remove.filter(isEdge), ...plan.remove.filter((x) => !isEdge(x))]) await ok(`remove ${x.id}`, call("DELETE", `${P}/instance-maps/instances/${encodeURIComponent(x.id)}`));
    for (const x of [...plan.create.filter((x) => !isEdge(x)), ...plan.create.filter(isEdge)]) await ok(`create ${x.id}`, call("POST", `${P}/instance-maps/${MAP}/instances`, x));
    // the vendor PATCH merges, so an instance holding a property the model dropped is cleared first ("clear" in the
    // same PATCH also wipes what it sends, proven 2026-11-07), then given the full set
    const have = new Map(existing.map((x) => [x.id, x]));
    for (const { id, ...x } of plan.update) {
      const path = `${P}/instance-maps/instances/${encodeURIComponent(id)}`;
      if (Object.keys(have.get(id)?.properties || {}).some((k) => !(k in (x.properties || {})))) await ok(`clear ${id}`, call("PATCH", path, { clear: ["properties"] }));
      await ok(`update ${id}`, call("PATCH", path, x));
    }
    const changed = plan.create.length + plan.update.length + plan.remove.length;
    log(`atlas ${branch}: create ${plan.create.length} update ${plan.update.length} remove ${plan.remove.length} (about ${cost} of ${limit} instances)`);

    // Types are licensed too (100): drop WaterOS's own definitions the model no longer uses, never a library's
    // (theirs carry a sourceLibrary; ours a "WaterOS " comment). Relationship types first, properties last.
    let pruned = 0;
    if (!defined.has("pruned")) {
      const want = { "relationship-types": model.relationshipTypes, "entity-types": model.entityTypes, properties: model.properties };
      for (const kind of ["relationship-types", "entity-types", "properties"]) {
        const b = (await ok(`list ${kind}`, call("GET", `${P}/${kind}`))).body, have = Array.isArray(b) ? b : b?.items || [];
        const keep = new Set(want[kind].map((d) => d.name));
        for (const d of have) {
          const name = String(d.label ?? d.name ?? "");
          if (d.sourceLibrary || !String(d.comment || "").startsWith("WaterOS ") || keep.has(name)) continue;
          await ok(`drop ${kind} ${name}`, call("DELETE", `${P}/${kind}/${encodeURIComponent(name)}`), [404]);
          pruned++;
        }
      }
      defined.add("pruned");
      if (pruned) log(`atlas ${branch}: dropped ${pruned} unused WaterOS definitions`);
    }

    // queries read the compiled world: compile once per process, and after any write until a compile succeeds (a sync
    // that failed between its writes and its compile leaves the next one nothing to write, yet still a world to build)
    if (changed || pruned) stale = true;
    let edges = null;
    if (stale) {
      // instance writes need no publish (only definition changes open a draft); Atlas says "nothing to publish" with a
      // 409, or with a 404 "no draft session" (seen 2026-11-07); either way the compile still has to run
      const pub = await call("POST", `/api/v1/branches/${branch}/draft/publish`, {});
      const nothing = (pub.status === 409 && pub.body?.code === "Draft.NothingToPublish") || (pub.status === 404 && /no draft session/i.test(pub.body?.detail || ""));
      if (!nothing) await ok("publish", Promise.resolve(pub));
      edges = (await ok("compile", call("PUT", `${P}/world`))).body?.edgeCount ?? null;
      stale = false;
    }
    return { create: plan.create.length, update: plan.update.length, remove: plan.remove.length, cost, limit, edges };
  }

  return { sync, modelOf };
}

// Write-through: a change to a mirrored object in the ontology schedules one debounced sync; changes made while a sync
// runs queue one more. A failed sync (Atlas down, the licence limit) leaves Atlas behind and the ontology unchanged,
// says so in status(), and the next change retries. Telemetry, alerts and work never trigger it.
const MIRRORED_TYPES = new Set(["PlantModel", "Site", "Zone", "ProcessUnit", "Structure", "Position", "Asset", "Part", "Sensor", "Line", "Valve", "SamplePoint", "Document", "MachinePlacement"]);
const MIRRORED_RELS = new Set(["HAS_ZONE", "CONTAINS", "HAS_POSITION", "INSTALLED_AT", "HAS_PART", "MEASURES", "AT", "GOVERNS", "HAS_CHUNK", "ABOUT"]);
export function atlasWriteThrough(ont, atlasSync, { delayMs = 2000, log = console.error } = {}) {
  const status = { state: "starting", at: null, last: null, error: null };
  let timer = null, running = null, again = false;
  const run = () => {
    timer = null;
    if (running) { again = true; return running; }
    status.state = "syncing";
    running = atlasSync.sync(ont)
      .then((r) => Object.assign(status, { state: "in step", at: new Date().toISOString(), last: r, error: null }))
      .catch((e) => { Object.assign(status, { state: "behind", at: new Date().toISOString(), error: String(e?.message).slice(0, 300) }); log(`atlas write-through: ${status.error}`); })
      .finally(() => { running = null; if (again) { again = false; schedule(); } });
    return running;
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(run, delayMs); timer.unref?.(); };
  ont.on((e) => {
    if ((e.kind === "upsert" && MIRRORED_TYPES.has(e.type)) || (e.kind === "link" && MIRRORED_RELS.has(e.rel)) || e.kind === "remove") schedule();
  });
  // pending: a change is waiting for its sync, so "in step" is not yet true of the latest change
  return { status: () => ({ ...status, pending: !!timer || again }), now: run };
}
