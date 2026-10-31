// A project answer written back into the KG. It stores the asker's clearance, never the asker: ont.view then hides it from
// anyone below, so a lower-clearance viewer neither sees it nor is diffed against it.
// ids end in the per-project count, which orders snapshots even when two share a plant-clock second
export const nOf = (s) => Number(s.id.slice(s.id.lastIndexOf("-") + 1));

// What changed in `areas` against `prev` (null: nothing to compare)
export const changedAreas = (prev, areas) => prev ? Object.keys(areas).filter((k) => prev.areas[k]?.status !== areas[k].status).map((k) => ({ area: k, from: prev.areas[k]?.status ?? "none", to: areas[k].status })) : [];

export function writeSnapshot(ont, viewer, ind, { brief, citations, model, at }) {
  // only a snapshot written at the asker's own clearance counts: an earlier answer for a wider (or narrower) view would show a phantom change
  const prev = ont.view(viewer).list("ProjectSnapshot", (s) => s.projectId === ind.id && s.minClearance === viewer.clearance).sort((a, b) => nOf(b) - nOf(a))[0];
  const areas = Object.fromEntries(Object.entries(ind.areas).map(([k, a]) => [k, { status: a.status, summary: a.summary }]));
  const changed = changedAreas(prev, areas);
  // numbered over every snapshot of the project, including ones this viewer cannot see
  const snapshot = ont.upsert({ id: `PSN-${ind.id}-${ont.list("ProjectSnapshot", (s) => s.projectId === ind.id).length + 1}`, type: "ProjectSnapshot", projectId: ind.id, at, minClearance: viewer.clearance, by: "Site Agent", model, areas, brief, citations });
  ont.link(snapshot.id, "ABOUT", ind.id);
  return { snapshot, changed };
}
