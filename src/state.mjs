// Saved state (ADR 0001): one JSON file holding what people and agents changed after the seed, so a restart or a redeploy
// keeps approvals, proposals, runs and the audit chain. On Cloud Run the file sits on a Cloud Storage bucket mounted as a volume.
// shortcut: whole-state snapshot every 30 s and on SIGTERM, so a crash loses up to 30 s; upgrade to a store per write (Neo4j) for a real tenant.
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { actionIds } from "./actions.mjs";
import { channelIds } from "./channels.mjs";

const V = 1;

// Records what changes from here on. Only that is saved, so a redeploy's fixes to untouched seed objects still show.
export function trackChanges(ont) {
  const ids = new Set(), removed = new Set(), links = new Map();
  ont.on((e) => {
    if (e.kind === "upsert") { ids.add(e.id); removed.delete(e.id); }
    else if (e.kind === "remove") { ids.delete(e.id); removed.add(e.id); }
    else if (e.kind === "link") links.set(`${e.id}|${e.rel}|${e.to}`, ont.links(e.id, { rel: e.rel, dir: "out" }).find((l) => l.to === e.to));
  });
  return () => ({ objects: [...ids].map((id) => ont.get(id)).filter(Boolean), links: [...links.values()].filter(Boolean), removed: [...removed] });
}

export const snapshotOf = (sys) => ({
  v: V, seed: sys.seed, savedAt: new Date().toISOString(), cursor: sys.tel.cursor(),
  ont: sys.changes(), audit: sys.audit.all(), ids: { actions: actionIds.get(), channels: channelIds.get() }, runtime: sys.runtime.state()
});

// Saved objects win over the fresh seed; a saved link is added once, and only while both ends exist.
export function overlay(ont, saved) {
  for (const o of saved.objects) ont.upsert(o);
  for (const id of saved.removed) ont.remove(id);
  for (const l of saved.links) {
    if (!ont.get(l.from) || !ont.get(l.to)) continue;
    if (ont.links(l.from, { rel: l.rel, dir: "out" }).some((x) => x.to === l.to)) continue;
    ont.link(l.from, l.rel, l.to, l.props, l.prov);
  }
}

// Write to a temporary file and rename, so a crash mid-write leaves the last good snapshot.
export function saveState(file, sys) {
  writeFileSync(`${file}.tmp`, JSON.stringify(snapshotOf(sys)));
  renameSync(`${file}.tmp`, file);
}

// null when there is nothing saved yet. A snapshot from another seed or format is refused, never half-read.
export function loadState(file, seed) {
  if (!existsSync(file)) return null;
  const s = JSON.parse(readFileSync(file, "utf8"));
  if (s.v !== V) throw new Error(`${file}: state format ${s.v}, expected ${V}`);
  if (s.seed !== seed) throw new Error(`${file}: saved for seed ${s.seed}, not ${seed}`);
  return s;
}
