// The job brief (job brief design §6): what a person should know before they calibrate or test an asset, built from
// their own view. Deterministic; Claude, when on, may only shorten its wording.

// Corrections that reach a job, most specific first (the asset, its make and model, then an organisation), newest first
// within each. An organisation reaches the asset through any project that touched it or the job's own project; the
// works' owner reaches every job (design §4.5).
export function correctionsFor(view, asset, workOrder = null) {
  const orgs = new Set(["ORG-OWNER"]);
  for (const p of view.list("Project", (x) => (x.assetIds || []).includes(asset.id) || x.assetId === asset.id || (workOrder && workOrder.projectId === x.id))) {
    if (p.clientOrgId) orgs.add(p.clientOrgId);
    if (p.contractorOrgId) orgs.add(p.contractorOrgId);
  }
  const level = (c) => (!c.scope ? -1 : c.scope.assetId ? (c.scope.assetId === asset.id ? 0 : -1) : c.scope.template ? (c.scope.template === asset.template ? 1 : -1) : c.scope.orgId && orgs.has(c.scope.orgId) ? 2 : -1);
  return view.list("Correction").map((c) => [level(c), c]).filter(([l]) => l >= 0)
    .sort((a, b) => a[0] - b[0] || String(b[1].at).localeCompare(String(a[1].at))).map(([, c]) => c);
}
