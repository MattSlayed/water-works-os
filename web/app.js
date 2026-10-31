// Water Works OS web console. Plain ES modules, no build step. Every request carries the acting person;
// the server prunes what that person may not see before it leaves.
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const view = $("#view");
const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const state = { user: store.get("wwos.user", "P-001"), me: null, twin: null, copilot: null, layers: { assets: true, alerts: true, people: true, permits: true } };

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, { method, headers: { "x-acting-user": state.user, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status });
  return json;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 3500);
}
const pill = (text, cls = text) => `<span class="pill ${esc(String(cls).toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">${esc(text)}</span>`;
const time = (iso) => (iso ? new Date(iso).toISOString().slice(5, 16).replace("T", " ") : "");
const link = (id, label) => `<a href="#/object/${encodeURIComponent(id)}">${esc(label || id)}</a>`;
function spark(values, alarm) {
  if (!values || values.length < 2) return "";
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 100).toFixed(1)},${(30 - ((v - min) / span) * 28).toFixed(1)}`).join("");
  return `<svg class="spark ${alarm ? "alarm" : ""}" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? (Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2)) : esc(v); };
const isAlarm = (s) => (s.alarmHi != null && s.value > s.alarmHi) || (s.alarmLo != null && s.value < s.alarmLo);

// ---------- site map (SVG), shared by Console and Map ----------
function mapSvg(m, { compact } = {}) {
  const L = state.layers;
  const zones = m.zones.map((z) => {
    const [x, y, w, h] = z.rect;
    const assets = L.assets ? z.assets.map((a) => `<g class="asset ${esc(a.state)}" tabindex="0" role="link" aria-label="${esc(a.tag)} ${esc(a.state)}" data-href="#/asset/${encodeURIComponent(a.id)}">
        <circle cx="${Number(a.xy[0])}" cy="${Number(a.xy[1])}" r="3.6"/>${L.alerts && a.alert ? `<circle class="ring" cx="${Number(a.xy[0])}" cy="${Number(a.xy[1])}" r="7.5"/>` : ""}
        ${compact ? "" : `<text x="${Number(a.xy[0]) + 5}" y="${Number(a.xy[1]) + 2}">${esc(a.tag)}</text>`}</g>`).join("") : "";
    const ppl = L.people && z.people ? `<text class="ppl" x="${Number(x) + Number(w) - 6}" y="${Number(y) + Number(h) - 4}" text-anchor="end">${Number(z.people)}</text>` : "";
    return `<g class="zone ${esc(z.hazard)}"><rect x="${Number(x)}" y="${Number(y)}" width="${Number(w)}" height="${Number(h)}"/><title>${esc(z.id)} ${esc(z.name)}</title><text x="${x + 4}" y="${y + 9}">${esc(z.id)}${!compact && w >= 100 ? " " + esc(z.name.split(" ")[0]) : ""}</text>${assets}${ppl}</g>`;
  }).join("");
  const permits = L.permits ? m.permits.map((p) => { const z = m.zones.find((zz) => zz.assets.some((a) => a.id === p.assetId)); if (!z) return ""; const [x, y, w, h] = z.rect; return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="var(--amber)" stroke-width="1.2" stroke-dasharray="4 2"/>`; }).join("") : "";
  const [bx, by, bX, bY] = m.bounds || [0, 0, 750, 190];
  return `<svg viewBox="${bx - 10} ${by - 10} ${bX - bx + 20} ${bY - by + 20}" role="img" aria-label="Site map of ${esc(m.site.name)}">${zones}${permits}</svg>`;
}
function bindMap(root) {
  root.querySelectorAll("[data-href]").forEach((g) => {
    g.addEventListener("click", () => (location.hash = g.dataset.href));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = g.dataset.href; });
  });
}

// ---------- plant (Phase 3): SVG fallback when WebGL is missing or lost ----------
function plantSvg(d, m) {
  const lines = d.lines.flatMap((l) => l.parts.map((p) => `<polyline class="pline ${esc(l.conveyance)}${l.causal ? "" : " util"}" points="${p.map(([x, y]) => `${Number(x)},${Number(y)}`).join(" ")}"><title>${esc(l.lineNumber)} ${esc(l.service)}</title></polyline>`)).join("");
  const sts = d.structures.map((s) => {
    const [x, y] = s.centre, shape = s.diameter ? `<circle cx="${Number(x)}" cy="${Number(y)}" r="${Number(s.diameter) / 2}"/>` : `<rect x="${x - s.w / 2}" y="${y - s.l / 2}" width="${Number(s.w)}" height="${Number(s.l)}"/>`;
    return `<a class="pstruct" href="#/object/${encodeURIComponent(s.id)}" aria-label="${esc(s.tag)} ${esc(s.kind.replace(/_/g, " "))}">${shape}<title>${esc(s.tag)} ${esc(s.kind)}</title></a>`;
  }).join("");
  return mapSvg(m, { compact: true }).replace("</svg>", `<g class="plantlayer">${lines}${sts}</g></svg>`);
}
function plantSide(it) {
  if (!it) return `<p class="meta">Select a structure, machine or valve. Pump, blower and chlorine houses open to show their machines.</p>`;
  const rows = it.kind3d === "machine" ? [["Position", it.positionId], ["In", it.structureId], ["State", it.state], ["Class", it.assetClass], ["Active alerts", it.alerts]]
    : it.kind3d === "valve" ? [["Kind", it.kind], ["Filter", it.filter], ["Line", it.lineId], ["Normal state", it.normalState], ["Actuated", it.actuated ? "yes" : "no"]]
    : [["Kind", String(it.kind || "").replace(/_/g, " ")], ["Zone", it.zoneId], ["Floor level", it.baseLevel], ["Top water level", it.twl], ["Volume m³", it.volumeM3], it.diameter ? ["Diameter m", it.diameter] : ["Plan m", it.w ? `${it.w} × ${it.l}` : null]];
  return `<h2>${esc(it.kind3d)}</h2><h3 style="margin:0 0 8px">${esc(it.tag)}</h3><table>${rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<tr><td class="meta">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
    <div class="btns" style="margin-top:10px"><button class="btn" id="flyto">Fly to</button>${it.kind3d !== "valve" ? `<button class="btn" id="upstream">Show upstream</button>` : ""}<a class="btn" href="#/object/${encodeURIComponent(it.id)}">Record</a>${it.assetId || it.positionId ? `<button class="btn" data-rca="${esc(it.assetId || it.positionId)}">Find root cause</button>` : ""}${it.assetId ? `<a class="btn primary" href="#/asset/${encodeURIComponent(it.assetId)}">Open twin</a>` : ""}</div>`;
}
const SHARE = { 0.25: "¼", 0.5: "½", 0.0833: "1/12", 0.3333: "⅓" };
const plantStates = (d) => Object.fromEntries([...d.machines.filter((m) => m.positionId).map((m) => [m.positionId, { state: m.state, alerts: m.alerts }]), ...d.samplePoints.map((sp) => [sp.id, { reading: sp.reading }])]);

// ---------- views ----------
// ---------- job briefs and specs (job brief design §8) ----------
const BRIEF_SECTIONS = { target: "Target", corrections: "Corrections that apply", lastTime: "Last time", open: "Open now", watchOuts: "Watch-outs", changed: "Changed since the last job here" };
const pendingText = (t) => /waits for the site manager|^Waiting:/.test(t);
function briefHtml(full) {
  const parts = Object.entries(BRIEF_SECTIONS).filter(([k]) => full && full[k] && full[k].length)
    .map(([k, label]) => `<h3 class="meta" style="margin:10px 0 4px">${label}</h3><ul class="list">${full[k].map((x) => `<li${pendingText(x.text) ? ' style="color:var(--amber)"' : ""}>${esc(x.text)} <span class="meta">${x.refs.map((r) => link(r)).join(" ")}</span></li>`).join("")}</ul>`);
  return parts.join("") || `<p class="empty">Nothing to brief on this job.</p>`;
}
const correctionsHtml = (cs) => (cs && cs.length ? `<ul class="list">${cs.map((c) => `<li>${esc(c.line)} <span class="meta">${link(c.id)}${c.inheritedFrom ? ` · from ${esc(c.inheritedFrom)}` : ""}</span></li>`).join("")}</ul>` : `<p class="empty">No corrections.</p>`);
function specsHtml(d) {
  if (!d) return `<p class="empty">No specs for this asset.</p>`;
  const rows = d.specs.map((s) => `<section style="margin-bottom:12px"><div class="row"><b>${esc(s.measure)}</b><span class="meta">v${esc(s.version)} · confirmed by ${link(s.confirmedBy)}</span></div>
    <p style="margin:4px 0">${esc(s.lo)}–${esc(s.hi)} ${esc(s.unit)}${s.condition ? ` · until ${esc(s.condition)}` : ""} · ${esc((s.sourceRefs[0] || {}).title || "no source")}</p>
    ${s.pending ? `<p style="color:var(--amber);margin:4px 0">Waiting for the site manager: ${esc(s.pending.lo)}–${esc(s.pending.hi)} ${esc(s.unit)} from ${esc(s.pending.sourceTitle || "a source")}${s.pending.at ? `, ${esc(String(s.pending.at).slice(0, 10))}` : ""}${s.pending.text ? ` · “${esc(s.pending.text)}”` : ""}${s.pending.flag ? ` · ${esc(s.pending.flag)}` : ""}</p>` : ""}
    ${s.sources.length ? `<p class="meta">Agreeing sources: ${s.sources.map((x) => `${esc(x.title)} (${esc(x.grade.toLowerCase())})`).join(" · ")}</p>` : ""}
    ${s.history.length ? `<details><summary class="meta">History · ${s.history.length}</summary><ul class="list">${s.history.slice().reverse().map((h) => `<li>v${esc(h.version)} ${esc(h.lo)}–${esc(h.hi)} · ${esc(h.reason)}</li>`).join("")}</ul></details>` : ""}</section>`).join("");
  return `${rows || `<p class="empty">No specs for this asset.</p>`}<button class="btn" id="recheck">Re-check sources</button>
    <h3 class="meta" style="margin:12px 0 4px">Corrections · ${d.corrections.length}</h3>${correctionsHtml(d.corrections)}`;
}

const AREAS = [["people", "People"], ["plant", "Plant & Process"], ["procedures", "Procedures"], ["compliance", "Compliance"]];
const STATUS_WORD = { green: "Green", amber: "Amber", red: "Red", none: "No data" };
const dot = (st) => `<span class="dot ${esc(st)}" aria-hidden="true"></span><span class="sw ${esc(st)}">${esc(STATUS_WORD[st] || st)}</span>`;
const zar = (n) => (n == null ? "—" : `R${Number(n).toLocaleString("en-ZA")}`);
// The four project indicator cards; the server rates them, this only renders. Status is always a word beside the dot.
const indicatorCards = (p, changed = []) => {
  const h = p.header, m = h.milestones;
  const diff = changed.length ? `<p class="meta pchanged">Changed since last snapshot: ${changed.map((c) => `${esc((AREAS.find(([k]) => k === c.area) || [0, c.area])[1])} ${esc(c.from)} → ${esc(c.to)}`).join(", ")}</p>` : "";
  return `<div class="pind"><p class="meta">${esc(p.title)} · ${esc(m.claimed)} of ${esc(m.total)} milestones claimed, ${esc(m.confirmed)} confirmed${m.overdue.length ? `, ${esc(m.overdue.length)} overdue` : ""} · ${zar(h.spendZar)} of ${zar(h.budgetZar)} spent · last report ${h.lastReportAt ? `${esc(h.daysSinceReport)} days ago` : "never"}</p>${diff}
    <div class="icards">${AREAS.map(([k, name]) => {
      const a = p.areas[k] || { status: "none", summary: "", items: [] };
      return `<section class="icard ${esc(a.status)}" aria-label="${esc(name)}"><h3>${dot(a.status)} ${esc(name)}</h3>
        ${a.status === "none" ? `<p class="meta">No data in the KG for this area</p>` : `<p>${esc(a.summary)}</p>${a.items.length ? `<details><summary>${esc(a.items.length)} items</summary><ul class="list">${a.items.map((i) => `<li><span class="sw ${esc(i.status)}">${esc(STATUS_WORD[i.status] || i.status)}</span> ${esc(i.text)} <span class="cite">${esc(i.cite)}</span></li>`).join("")}</ul></details>` : ""}`}</section>`;
    }).join("")}</div></div>`;
};

const views = {
  async console() {
    const [c, m] = await Promise.all([api("/api/console"), api("/api/map")]);
    const train = c.train.map((s) => `<div class="stage"><h3>${esc(s.name)}</h3>
      ${s.alerts ? `<span class="badge">${pill(s.alerts + " alert" + (s.alerts > 1 ? "s" : ""), "high")}</span>` : ""}
      ${s.values.slice(0, 2).map((v) => `<span class="v ${isAlarm(v) ? "alarm" : ""}">${num(v.value)} ${esc(v.unit)}</span><span class="meta">${esc(v.name)}</span>`).join("") || `<span class="meta">${s.assets.map((a) => esc(a.tag) + " " + esc(a.state)).join(" · ") || "—"}</span>`}</div>`).join("");
    const people = Object.entries(c.people).sort((a, b) => b[1].count - a[1].count).map(([z, p]) => `<li class="row"><span>${esc(z)} ${esc(m.zones.find((x) => x.id === z)?.name || "")}</span><span class="val">${p.count}</span></li>`).join("");
    const handover = c.drafts.find((d) => d.kind === "handover");
    view.innerHTML = `
      <div class="row"><div><h2>01 / the works now</h2><h1>Riverbend works console</h1></div><span class="meta">${c.specChanges != null ? `<a href="#/proposals">Spec changes waiting: ${esc(c.specChanges)}</a> · ` : ""}demonstrable · synthetic data</span></div>
      <section class="panel" aria-label="Process train" style="margin:12px 0"><div class="train">${train}</div></section>
      <div class="grid console">
        <div class="grid">
          <section class="panel map" aria-label="Site"><div class="row"><h2>Site</h2><a href="#/map">Open map</a></div>${mapSvg(m, { compact: true })}</section>
          <section class="panel" aria-label="Shift handover"><h2>Handover draft · Shift Handover agent</h2>${handover ? `<pre>${esc(handover.body)}</pre>` : `<p class="empty">No handover drafted yet.</p>`}
            <div class="btns"><button class="btn" data-run="Shift Handover">Draft a new handover</button></div></section>
        </div>
        <div class="grid">
          <section class="panel" aria-label="Alerts"><h2>Alerts · ${c.alerts.length} active</h2><ul class="list">${c.alerts.map((a) => `<li><div class="row"><b>${esc(a.title)}</b>${pill(a.priority || a.severity, a.severity)}</div>
            <div class="meta">${a.consequence ? `consequence ${esc(a.consequence.label)} · ${esc(a.consequence.supply)} · ${esc(a.consequence.storageHours)} h storage · ` : ""}${link(a.id)}</div></li>`).join("") || `<li class="empty">No active alerts.</li>`}</ul></section>
          <section class="panel" aria-label="Proposals"><div class="row"><h2>Awaiting a person · ${c.proposals.length}</h2><a href="#/proposals">Review</a></div><ul class="list">${c.proposals.slice(0, 5).map((p) => `<li><b>${esc(p.action)}</b> <span class="meta">${esc(p.actorId)} · ${esc(p.id)}</span></li>`).join("") || `<li class="empty">Nothing waiting.</li>`}</ul></section>
          <section class="panel" aria-label="Agent activity"><div class="row"><h2>Agent activity</h2><a href="#/agents">Agent Hub</a></div><ul class="list">${c.runs.map((r) => `<li><div class="row"><a href="#/run/${r.id}"><b>${esc(r.agent)}</b></a>${pill(r.status)}</div><div class="meta">${time(r.plantTime)} · ${r.outputs} outputs${r.refusals ? ` · ${r.refusals} refused` : ""}</div>${r.reasoning[0] ? `<div style="font-size:13px">${esc(r.reasoning[0])}</div>` : ""}</li>`).join("")}</ul></section>
          <section class="panel" aria-label="People on site"><h2>People on site by zone</h2><ul class="list">${people || `<li class="empty">Nobody recorded on site.</li>`}</ul></section>
          <section class="panel" aria-label="Chemicals"><h2>Chemicals</h2><ul class="list">${c.chemicals.map((ch) => `<li class="row"><span>${esc(ch.name)}</span><span class="val">${esc(ch.levelPct)}% ${ch.levelPct < ch.reorderPct ? pill("reorder", "medium") : ""}</span></li>`).join("")}</ul></section>
        </div>
      </div>`;
    bindMap(view);
  },

  async map() {
    const m = await api("/api/map");
    const L = state.layers;
    const roll = m.muster.on ? `<section class="panel"><h2>Muster roll · started ${time(m.muster.since)}</h2><p><b>${m.muster.people.filter((p) => p.checkedIn).length} of ${m.muster.people.length}</b> accounted for</p>
      <ul class="list">${m.muster.people.map((p) => `<li class="row"><span>${esc(p.id)} · ${esc(p.role)}<br><span class="meta">last zone ${esc(p.zoneId)}</span></span>${p.checkedIn ? pill("checked in", "done") : `<button class="btn" data-checkin="${esc(p.id)}">Mark found</button>`}</li>`).join("")}</ul></section>` : "";
    view.innerHTML = `<div class="row"><div><h2>02 / where everything is</h2><h1>Site map</h1></div>
      <div class="btns"><button class="btn ${m.muster.on ? "" : "primary"}" id="muster">${m.muster.on ? "End muster" : "Start muster"}</button></div></div>
      <div class="layers" role="group" aria-label="Layers">${Object.keys(L).map((k) => `<label><input type="checkbox" data-layer="${k}" ${L[k] ? "checked" : ""}> ${k}</label>`).join("")}</div>
      <div class="grid console"><section class="panel map">${mapSvg(m)}<p class="meta">Dots: green running, blue standby, grey isolated. Red rings: active alert. Amber numbers: people by zone. Dashed amber: open permit.</p></section><div class="grid">${roll}
      <section class="panel"><h2>Zones</h2><table><thead><tr><th>Zone</th><th>Hazard</th><th>Assets</th><th>People</th></tr></thead><tbody>${m.zones.map((z) => `<tr><td>${esc(z.id)} ${esc(z.name)}</td><td>${esc(z.hazard)}</td><td class="val">${z.assets.length}</td><td class="val">${z.people}</td></tr>`).join("")}</tbody></table></section></div></div>`;
    bindMap(view);
    view.querySelectorAll("[data-layer]").forEach((c) => c.addEventListener("change", () => { L[c.dataset.layer] = c.checked; views.map(); }));
    $("#muster").addEventListener("click", async () => { try { await api("/api/muster", { method: "POST", body: { on: !m.muster.on } }); views.map(); } catch (e) { toast(e.message); } });
    view.querySelectorAll("[data-checkin]").forEach((b) => b.addEventListener("click", async () => { await api("/api/muster/checkin", { method: "POST", body: { personId: b.dataset.checkin } }); views.map(); }));
  },

  // ---------- Region (Region design §6): the site manager's 07:00 screen, and where analysis starts outside the fence ----------
  async region(arg) {
    const q = new URLSearchParams(arg || ""), enc = encodeURIComponent;
    const [d, since, risks] = await Promise.all([api("/api/region"), api("/api/region/since"), api("/api/region/risks")]);
    state.region?.dispose();
    state.region = null;
    let cur = d, trails = [], curScene = null, lastRefresh = Date.now(); // cur: the latest payload; panels and focus read it, never the page-load copy
    const phone = matchMedia("(max-width: 720px)").matches;
    const band = (b) => `<span class="band ${esc(b)}">${esc(b)}</span>`;
    const STAGE = { intake: "the intake", main: "the raw-water main", clar: "clarification", filt: "filtration" };
    const cap = risks.capacity;
    const res = risks.storage.sites.map((s) => `<li>${esc(s.name)}: ${s.storageHours ?? "—"} h ${s.flagged ? pill("under 12 h", "red") : ""}</li>`).join("");
    const cards = `<section class="panel rcard" aria-label="Since you left"><div class="row"><h3>Since you left <small class="meta">${time(since.since)}</small></h3><button class="btn" id="seen">Mark seen</button></div>
        <ul class="rlist">${since.items.map((i) => `<li><button class="linkish" data-si="${esc(i.kind)}|${esc(i.trackerId || i.projectId || i.id)}">${esc(i.text)}</button>${i.stillOpen ? ` ${pill("still open", "amber")}` : ""}</li>`).join("") || "<li>Nothing new.</li>"}</ul>${since.more ? `<p class="meta">${since.more} more</p>` : ""}</section>
      <section class="panel rcard" aria-label="Today's supply risks"><h3>Today's supply risks</h3><ul class="rlist">
        <li>Raw water: ${band(risks.rawWater.band)} <small class="meta">satellite NDTI is an index, not calibrated; intake ${num(risks.rawWater.inputs[2].value)} NTU</small></li>
        <li>Treatment: <b>${cap.capacityMlD} ML/d</b> against demand ${cap.demandMlD != null ? `${num(cap.demandMlD)} ML/d` : "unknown"} ${cap.shortfallMlD > 0 ? pill(`short by ${num(cap.shortfallMlD)} ML/d`, "red") : ""}<small class="meta"> ${cap.outOfServiceMlD} ML/d out of service, limited by ${esc(STAGE[cap.limiting] || cap.limiting)}</small></li>${res}</ul></section>`;
    const timeline = `<div class="rtimeline" role="group" aria-label="Scene timeline">${d.scenes.filter((s) => s.inWindow || s.mission === "S2").slice(-14).map((s) => {
      const ok = Object.values(s.usable).some(Boolean);
      return `<button class="scene ${ok ? "" : "cloudy"} ${s.processed ? "" : "pending"}" data-scene="${esc(s.id)}" ${!s.inWindow || !s.processed ? "disabled" : ""} title="${esc(s.id)} · ${s.mission === "S2" ? `${s.cloudPct}% cloud${ok ? "" : ", unusable"}` : "radar"}">${esc(s.acquiredAt.slice(5, 10))}<small>${s.mission}${s.mission === "S2" ? ` ${s.cloudPct}%` : ""}</small></button>`;
    }).join("")}<label class="sr" for="gidx">Index</label><select id="gidx"><option value="ndti">NDTI turbidity</option><option value="ndci">NDCI chlorophyll</option><option value="ndwi">NDWI water</option><option value="mndwi">MNDWI water</option></select><small class="meta">index, not calibrated</small></div>`;
    const LAYERS = [["region", "Catchment and river", true], ["projects", "Project footprints", true], ["grid", "Satellite index grid", false], ["detections", "Detections", true], ["plant", "Fixed plant and remote sites", true], ["trackers", "Tagged things", true], ["alerts", "Alerts", true]];
    const layerState = Object.fromEntries(LAYERS.map(([k, , def]) => [k, def]));
    // l=grid,-region: a layer turned on, or off with a leading "-" ("+" would read back as a space)
    for (const k of (q.get("l") || "").split(",").map((x) => x.trim()).filter(Boolean)) { const off = k.startsWith("-"), key = k.replace(/^-/, ""); if (key in layerState) layerState[key] = !off; }
    const FILTERS = [["pump_station", "Pump stations"], ["reservoir", "Reservoirs"], ["valve_chamber", "Valve chambers"], ["vehicle", "Works vehicles"], ["portable", "Portable plant"], ["contractor", "Contractors"]];
    const rail = `<section class="panel rrail" aria-label="Layers and filters"><h3>Layers</h3>${LAYERS.map(([k, label]) => `<label><input type="checkbox" data-rlayer="${k}" ${layerState[k] ? "checked" : ""}> ${label}</label>`).join("")}
      <h3>Filter</h3>${FILTERS.map(([k, label]) => `<label><input type="checkbox" data-rfilter="${k}" checked> ${label}</label>`).join("")}
      <label><input type="checkbox" data-rfilter="alarmOnly"> In alarm only</label><label><input type="checkbox" data-rfilter="staleOnly"> Stale or lost tags only</label>${d.live ? `<p class="meta">Live: ${esc(d.live.ok ? `${d.live.name}, ${d.live.scene.acquiredAt.slice(0, 10)}, NDTI mean ${num(d.live.stats.ndti.mean)} (index, not calibrated)` : d.live.reason)}</p>` : ""}</section>`;
    const ops = d.operations || [];
    const tabs = `<section class="panel rtabs"><div id="rpanel" aria-live="polite"></div><div class="btns" role="tablist"><button class="btn" role="tab" data-rtab="projects" aria-selected="true">Projects (${d.projects.length})</button><button class="btn" role="tab" data-rtab="ops" aria-selected="false">Operations (${ops.length})</button></div>
      <ul class="rlist" id="rtab-projects">${d.projects.map((p) => `<li><button class="linkish" data-proj="${esc(p.id)}">${esc(p.title)}</button> ${p.status.overdue.length ? pill("overdue", "amber") : ""}<small class="meta">${esc(p.start)} to ${esc(p.end)}</small></li>`).join("")}</ul>
      <ul class="rlist" id="rtab-ops" hidden>${ops.map((o) => `<li><button class="linkish" data-op="${esc(o.kind)}|${esc(o.id)}">${esc(o.label)}</button> <small class="meta">${esc(o.kind)}</small></li>`).join("") || "<li>No operations running.</li>"}</ul></section>`;
    view.innerHTML = `<div id="regionv"><div class="row"><div><h2>03 / the region · ${esc(d.clock.slice(0, 16).replace("T", " "))} plant · synthetic works</h2><h1>Region</h1></div><div class="btns"><a class="btn" href="#/map">Site map</a><a class="btn" href="#/plant">Plant</a><button class="btn" id="clearfocus" hidden>Clear focus</button></div></div>
      <div class="rcards">${cards}</div>${phone ? "" : timeline}
      <div class="rgrid ${phone ? "phone" : ""}">${phone ? "" : rail}<section class="panel rmap" aria-label="Region map">${phone ? `<button class="btn primary" id="showmap">Show on map</button>` : ""}</section>${tabs}</div></div>`;

    const panel = $("#rpanel");
    let lastView = { center: (q.get("c") || "").split(",").map(Number).filter(Number.isFinite), zoom: Number(q.get("z")) || null };
    // the view lives in the hash (centre, zoom, layers that differ from the defaults, focus), so Back from the plant restores it
    const keepHash = (v = lastView) => {
      lastView = v;
      const l = LAYERS.filter(([k, , def]) => layerState[k] !== def).map(([k]) => `${layerState[k] ? "" : "-"}${k}`).join(",");
      history.replaceState(null, "", `#/region/c=${v.center.map((x) => x.toFixed(5)).join(",")}&z=${v.zoom}${l ? `&l=${l}` : ""}${q.get("focus") ? `&focus=${q.get("focus")}` : ""}`);
    };
    const restored = lastView.center.length === 2;
    const mount = async () => {
      try {
        const { mountRegion } = await import("/region.js");
        state.region = mountRegion($(".rmap"), d, {
          start: { center: restored ? lastView.center : null, zoom: lastView.zoom, layers: layerState },
          onSelect: (s) => select(s), onView: keepHash,
          onEnterPlant: () => { location.hash = `#/plant/${enc(d.works.plantModelId ? `${d.works.plantModelId}:STR-10UPA01` : "")}`; }
        });
        if (q.get("focus")) {
          const [k, id] = q.get("focus").split(":"), det = k === "detection" && d.detections.find((x) => x.id === id);
          focus(k, id, { fit: !restored });
          if (det && layerState.grid) loadGrid(det.sceneId); // the grid that was showing comes back with its detection
        }
      } catch (e) {
        $(".rmap").innerHTML = `<p class="sub">The map could not load (${esc(e.message)}). The cards and lists above still work.</p>`;
      }
    };
    const focus = async (kind, id, { fit = true } = {}) => {
      try {
        const f = await api(`/api/region/focus/${kind}/${enc(id)}`);
        trails = f.trackerIds;
        if (trails.length) { cur = await api(`/api/region?trails=${trails.map(enc).join(",")}`); state.region?.setData(cur); }
        state.region?.focus(f, { fit });
        $("#clearfocus").hidden = false;
        q.set("focus", `${kind}:${id}`);
        keepHash();
      } catch (e) { toast(e.message); }
    };
    const clearFocus = () => {
      trails = [];
      cur = { ...cur, trackers: cur.trackers.map(({ trail, ...t }) => t) };
      state.region?.setData(cur);
      state.region?.clearFocus();
      $("#clearfocus").hidden = true;
      q.delete("focus");
      keepHash();
    };
    // live updates: at most every 15 s, keeping trails and focus, so hover labels and reading are not interrupted
    state.regionRefresh = async () => {
      if (!state.region || Date.now() - lastRefresh < 15000) return;
      lastRefresh = Date.now();
      cur = await api(`/api/region${trails.length ? `?trails=${trails.map(enc).join(",")}` : ""}`);
      state.region?.setData(cur);
    };
    const ago = (iso) => { const m = Math.max(0, Math.round((Date.parse(cur.clock) - Date.parse(iso)) / 60000)); return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
    const showProject = async (id) => {
      const p = await api(`/api/projects/${enc(id)}/panel`);
      const pct = p.progress.budgetZar ? Math.round((p.progress.spendZar / p.progress.budgetZar) * 100) : 0;
      panel.innerHTML = `<h3>${esc(p.title)}</h3><p class="meta">${esc(p.start)} to ${esc(p.end)} · owner ${esc(p.ownerId)}</p>
        <h4>Footprint and who is on it</h4><ul class="rlist">${p.footprint.trackers.map((t) => `<li>${esc(t.name)} ${t.signal !== "live" ? pill(t.signal, "amber") : ""}</li>`).join("") || "<li>Nobody tagged on site now.</li>"}${p.footprint.permits.map((x) => `<li>Permit ${link(x.id)} open</li>`).join("")}</ul>
        <h4>Progress and money</h4><p>${p.progress.status.milestones.claimed} of ${p.progress.status.milestones.total} milestones claimed, ${p.progress.status.milestones.confirmed} confirmed. R ${(p.progress.spendZar / 1e6).toFixed(2)} m committed of R ${(p.progress.budgetZar / 1e6).toFixed(2)} m (${pct}%).</p><p class="meta">${p.progress.lastReport ? `Last report ${time(p.progress.lastReport.at)}: ${esc(p.progress.lastReport.text)}` : "No report yet."}</p>
        <h4>Impact on operations</h4><p>${esc(p.impact.text || "None recorded.")}</p>${p.impact.outOfService.length ? `<ul class="rlist">${p.impact.outOfService.map((x) => `<li>${esc(x.name)}${x.part ? ` (${esc(x.part)})` : ""} out of service ${esc(x.from)} to ${esc(x.to)}</li>`).join("")}</ul>` : ""}<p class="meta">${esc(p.impact.supplyRisk)}</p>
        <h4>Issues and risks</h4><ul class="rlist">${p.issues.map((i) => `<li>${esc(i.text)}${i.auditId ? ` <a href="#/audit" class="meta">log #${i.auditId}</a>` : ""}</li>`).join("") || "<li>None open.</li>"}</ul>`;
      focus("project", id);
    };
    const select = (s) => {
      if (s.kind === "detection") {
        const x = cur.detections.find((y) => y.id === s.id);
        if (!x) return;
        const sampled = (x.sampleIds || []).length;
        panel.innerHTML = `<h3>${esc(x.kind)} · ${esc(x.status)}</h3><p>${esc(String(x.index || "").toUpperCase())} z ${esc(x.z)} against the 90-day baseline in ${esc(x.aoiId)}, scene ${esc(x.sceneId)} (${x.cloudPct ?? "—"}% cloud). Confidence ${esc(x.confidence)}.</p><p class="meta">Index, not calibrated: a person confirms or rejects it with a raw-water sample.</p><p>${link(x.id, "Open the record")} · ${sampled} raw-water sample(s) attached</p><div class="btns"><button class="btn" data-op="detection|${esc(x.id)}">Focus the response</button>${x.status === "suggested" ? `<button class="btn primary" data-review="confirmed|${esc(x.id)}" ${sampled ? "" : 'disabled title="Needs a raw-water sample"'}>Confirm</button><button class="btn" data-review="rejected|${esc(x.id)}" ${sampled ? "" : 'disabled title="Needs a raw-water sample"'}>Reject</button>` : ""}</div>`;
        loadGrid(x.sceneId);
      } else if (s.kind === "tracker") {
        const t = cur.trackers.find((y) => y.id === s.id);
        if (!t) return;
        panel.innerHTML = `<h3>${esc(t.name)}</h3><p>${t.signal === "live" ? `Live, ping ${ago(t.pingAt)}` : `${esc(t.signal)}: last seen ${ago(t.pingAt)}`} · ${num(t.speedKmh)} km/h${t.eta ? ` · ETA ${esc(t.eta.slice(11, 16))}` : ""}${t.state ? ` · ${esc(t.state)}` : ""}${t.fuelPct != null && t.kind === "portable" ? ` · fuel ${t.fuelPct}% · ${t.runHours} h` : ""}</p>${t.projectId ? `<p><button class="linkish" data-proj="${esc(t.projectId)}">${esc(t.projectId)}</button></p>` : ""}`;
        state.region?.select(t.id);
      } else if (s.kind === "site") {
        const x = cur.sites.find((y) => y.id === s.id);
        if (!x) return;
        panel.innerHTML = `<h3>${esc(x.name)}</h3><ul class="rlist">${x.readings.map((r) => `<li>${esc(r.name)}: ${num(r.value)} ${esc(r.unit)}${isAlarm(r) ? ` ${pill("alarm", "red")}` : ""}</li>`).join("")}</ul>`;
        state.region?.select(x.id);
      } else if (s.kind === "project") showProject(s.id);
      else panel.innerHTML = `<p>${link(s.id)}</p>`;
    };
    // a scene's grid in the chosen index (radar scenes have only backscatter); the map says which scene and index it shows
    const loadGrid = async (sceneId) => {
      curScene = sceneId;
      const radar = sceneId.startsWith("S1-"), index = radar ? "vv" : $("#gidx") ? $("#gidx").value : "ndti";
      try {
        state.region?.setGrid(await api(`/api/region/scenes/${enc(sceneId)}/grid?index=${index}`));
        layerState.grid = true;
        const c = view.querySelector('[data-rlayer="grid"]');
        if (c) c.checked = true;
        keepHash();
      } catch (e) { toast(e.message); }
    };

    $("#regionv").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.proj) showProject(b.dataset.proj);
      if (b.dataset.op) { const [k, id] = b.dataset.op.split("|"); focus(k, id); if (k === "detection") select({ kind: "detection", id }); }
      if (b.dataset.si) {
        const [k, id] = b.dataset.si.split("|");
        if (k === "detection") { focus("detection", id); select({ kind: "detection", id }); }
        else if (k === "project" || k === "issue") showProject(id);
        else if (k === "site") select({ kind: "site", id });
        else if (k === "geofence" || k === "tracker") select({ kind: "tracker", id });
      }
      if (b.dataset.scene) loadGrid(b.dataset.scene);
      if (b.dataset.review) { const [verdict, id] = b.dataset.review.split("|"); api("/api/actions/review_detection", { method: "POST", body: { params: { detectionId: id, verdict } } }).then(() => { toast(`Detection ${verdict}.`); views.region(location.hash.replace(/^#\/region\/?/, "")); }, (err) => toast(err.message)); }
      if (b.dataset.rtab) { for (const t of view.querySelectorAll("[data-rtab]")) t.setAttribute("aria-selected", String(t === b)); $("#rtab-projects").hidden = b.dataset.rtab !== "projects"; $("#rtab-ops").hidden = b.dataset.rtab !== "ops"; }
    });
    view.querySelectorAll("[data-rlayer]").forEach((c) => c.addEventListener("change", () => { layerState[c.dataset.rlayer] = c.checked; state.region?.setLayer(c.dataset.rlayer, c.checked); keepHash(); }));
    view.querySelectorAll("[data-rfilter]").forEach((c) => c.addEventListener("change", () => state.region?.setFilter(c.dataset.rfilter, c.checked)));
    $("#gidx")?.addEventListener("change", () => { if (curScene && !curScene.startsWith("S1-")) loadGrid(curScene); });
    $("#seen").addEventListener("click", async () => { await api("/api/region/since", { method: "POST" }); views.region(location.hash.replace(/^#\/region\/?/, "")); });
    $("#clearfocus").addEventListener("click", clearFocus);
    document.onkeydown = (e) => { if (e.key === "Escape" && state.region && location.hash.startsWith("#/region")) clearFocus(); };
    if (phone) $("#showmap").addEventListener("click", () => { $("#showmap").remove(); mount(); });
    else await mount();
  },
  async refreshRegion() {
    await state.regionRefresh?.();
  },
  async assets() {
    const assets = await api("/api/objects?type=Asset");
    const rows = assets.sort((a, b) => String(a.positionTag).localeCompare(String(b.positionTag))).map((a) => `<tr><td><a href="#/asset/${encodeURIComponent(a.id)}"><b>${esc(a.positionTag || a.name)}</b></a></td><td>${esc(a.name)}</td><td>${esc(a.assetClass)}</td><td>${pill(a.state)}</td><td>${a.hero ? pill("3D model", "agent") : ""}</td><td class="meta">${esc(a.zoneId)}</td></tr>`).join("");
    view.innerHTML = `<h2>03 / every machine, ontologised</h2><h1>Assets and twin</h1><p class="sub">Hero assets open in the Asset Workbench with a 3D breakdown and the Technician Copilot.</p>
      <section class="panel"><table><thead><tr><th>Tag</th><th>Name</th><th>Class</th><th>State</th><th>Model</th><th>Zone</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  },

  async plant(id) {
    const [d, m] = await Promise.all([api("/api/plant"), api("/api/map")]);
    state.plant?.dispose();
    state.plant = null;
    state.plantRev = d.model.id;
    view.innerHTML = `<div class="row"><div><h2>03 / the works as drawn · plant model rev ${esc(d.model.rev)} · released ${time(d.model.release && d.model.release.at)} by ${esc(d.model.release && d.model.release.by)}</h2><h1>Plant</h1></div>
        <div class="btns"><a class="btn" href="#/plantmodels">Revisions and review</a><a class="btn" href="#/map">Site map</a></div></div>
      <div class="plantwrap"><section class="panel stage3d plant" aria-label="3D plant"><div class="disclose badge">${esc(d.model.disclosure)}</div>
        <div class="plantbar" role="group" aria-label="View"><button class="btn" data-pmode="physical">Physical</button><button class="btn" data-pmode="blueprint">Blueprint</button><button class="btn" data-popt="xray">X-ray</button><button class="btn" data-popt="skeletal">Skeletal map</button><button class="btn" id="pclear">Clear</button></div></section>
        <aside class="side"><section class="panel" id="pagent"><h2>Site Agent</h2>
          <form id="pask" class="btns" style="flex-wrap:nowrap"><label class="sr" for="pq">Ask the Site Agent</label><input id="pq" maxlength="500" placeholder="What is happening with the turbidity alert?" style="flex:1;background:var(--bg2);border:1px solid var(--line);padding:8px"><button class="btn primary">Ask</button></form>
          <div id="pans" aria-live="polite"></div></section>
        <section class="panel" id="psel" aria-live="polite">${plantSide(null)}</section></aside></div>`;
    const stage = $(".stage3d.plant"), side = $("#psel");
    const fallback = (why) => {
      state.plant?.dispose();
      state.plant = null;
      stage.innerHTML = `<div class="disclose badge">${esc(d.model.disclosure)}</div><div class="plantsvg">${plantSvg(d, m)}</div><p class="meta" style="padding:0 10px">${esc(why)} Showing the site plan with structure outlines and line paths; each structure links to its record.</p>`;
      bindMap(stage);
    };
    const { mountPlant, webglAvailable } = await import("/plant.js");
    if (!webglAvailable()) return fallback("3D is not available in this browser.");
    const enc = encodeURIComponent;
    const upstream = async (it) => {
      const u = await api(`/api/plant/graph/upstream/${enc(it.id)}`);
      state.plant.caption(null);
      state.plant.highlight([it.id, ...u.items.map((x) => x.id)], { dim: true });
      state.plant.frame([it.id, ...u.items.map((x) => x.id)]);
      bar();
      for (const x of u.items) if (x.id.includes(":STR-") && x.share > 0 && x.share < 1) state.plant.caption(x.id, `share ${SHARE[x.share] || x.share}`);
      let cap = "";
      if (u.sources[0]) {
        const w = await api(`/api/plant/graph/window?from=${enc(u.sources[0])}&to=${enc(it.id)}`);
        cap = `onset ≈ ${w.window.onsetH} h, mean ≈ ${w.window.meanH} h (design values at ${w.flowMlD} ML/d ${w.measured ? "measured" : "assumed"})`;
        state.plant.caption(it.id, cap);
      }
      $("#upinfo")?.remove();
      side.insertAdjacentHTML("beforeend", `<div id="upinfo" style="margin-top:10px"><h2>Upstream of ${esc(it.tag)}</h2><p class="meta">${u.items.length} items on causal lines; recycle edges marked, not crossed.${cap ? ` From the intake: ${esc(cap)}.` : ""}</p>
        <ul class="list">${u.items.filter((x) => x.id.includes(":STR-") || x.id.startsWith("POS-")).map((x) => `<li class="row"><span>${esc(x.id.replace(/^PM-RB-[A-Z]:STR-/, ""))}${x.recycle ? " " + pill("recycle", "noted") : ""}</span><span class="val">${SHARE[x.share] || x.share}</span></li>`).join("")}</ul></div>`);
    };
    const show = (it) => {
      side.innerHTML = plantSide(it);
      if (!it) return;
      $("#flyto")?.addEventListener("click", () => state.plant?.flyTo(it.id));
      $("#upstream")?.addEventListener("click", () => upstream(it).catch((e) => toast(e.message)));
    };
    // weak devices and phones open in blueprint (design §5.4)
    const weak = innerWidth < 720 || (navigator.deviceMemory && navigator.deviceMemory <= 4);
    const bar = () => {
      stage.querySelectorAll("[data-pmode]").forEach((b) => b.setAttribute("aria-pressed", String(state.plant?.mode === b.dataset.pmode)));
      stage.querySelectorAll("[data-popt]").forEach((b) => { b.hidden = state.plant?.mode !== "blueprint"; });
    };
    try {
      state.plant = mountPlant(stage, { ...d, zones: m.zones }, { mode: weak ? "blueprint" : "physical", onSelect: show, onLost: () => fallback("The 3D view lost its graphics context."), onSlow: () => { state.plant?.setMode("blueprint"); bar(); } });
    } catch (e) { return fallback(`3D could not start (${e.message}).`); }
    const opts = { xray: false, skeletal: false };
    stage.querySelectorAll("[data-pmode]").forEach((b) => b.addEventListener("click", () => { state.plant.setMode(b.dataset.pmode); bar(); }));
    stage.querySelectorAll("[data-popt]").forEach((b) => b.addEventListener("click", () => { opts[b.dataset.popt] = !opts[b.dataset.popt]; state.plant.setOption(b.dataset.popt, opts[b.dataset.popt]); b.setAttribute("aria-pressed", String(opts[b.dataset.popt])); }));
    $("#pclear").addEventListener("click", () => { state.plant.highlight([]); state.plant.caption(null); $("#upinfo")?.remove(); });
    // the Site Agent reads live data and documents, briefs, and flies the camera to the place it names
    $("#pask").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("#pq").value.trim(), btn = $("#pask button"), out = $("#pans");
      if (!q) return;
      btn.disabled = true;
      out.innerHTML = `<div class="msg me">${esc(q)}</div><div class="msg meta">Reading live data and documents…</div>`;
      try {
        const r = await api("/api/plant/ask", { method: "POST", body: { question: q } });
        out.lastElementChild.outerHTML = `<div class="msg">${esc(r.answer)}${r.citations.length ? `<br><span class="cite">${r.citations.map((c) => esc(c.id)).join(" · ")}</span>` : ""}<br><span class="cite">${r.model ? "written by Claude from live data and documents" : "from the active alert and its live readings"}${r.focus.length ? "" : "; nothing to show on the map"}</span></div>`;
        if (r.project) out.insertAdjacentHTML("beforeend", indicatorCards(r.project, r.changed));
        if (r.focus.length && state.plant) { state.plant.caption(null); state.plant.highlight(r.focus); state.plant.frame(r.focus, { min: 60, tilt: 0.9 }); }
      } catch (err) { out.lastElementChild.remove(); toast(err.message); }
      btn.disabled = false;
    });
    bar();
    const hitOf = (x) => x.id === id || x.positionId === id;
    if (id && state.plant.flyTo(id)) {
      const mc = d.machines.find(hitOf);
      show(mc ? { ...mc, kind3d: "machine" } : { ...(d.structures.find(hitOf) || d.valves.find(hitOf)), kind3d: d.structures.some(hitOf) ? "structure" : "valve" });
    }
  },
  async refreshPlant() {
    const d = await api("/api/plant");
    if (d.model.id !== state.plantRev) return views.plant();
    state.plant?.setStates(plantStates(d));
  },

  async plantmodels(id) {
    const enc = encodeURIComponent, eng = ["engineer", "manager"].includes(state.me.clearance);
    if (!id) {
      const [ms, dws] = await Promise.all([api("/api/plant/models"), api("/api/objects?type=Drawing")]);
      const received = dws.filter((d) => d.status === "received");
      view.innerHTML = `<div class="row"><div><h2>03 / drawing set → plant model</h2><h1>Plant model revisions</h1></div>
          <div class="btns"><a class="btn" href="#/plant">Plant</a>${eng && received.length ? `<button class="btn primary" id="ingest">Ingest received drawings (${received.length})</button>` : ""}</div></div>
        <section class="panel"><table><thead><tr><th>Model</th><th>Status</th><th>Cells</th><th>Unreviewed</th><th>Released</th><th>Drawings</th></tr></thead><tbody>${ms.map((m) => `<tr><td><a href="#/plantmodels/${enc(m.id)}"><b>${esc(m.id)}</b></a></td><td>${pill(m.status, m.status === "released" ? "done" : m.status === "superseded" ? "noted" : "proposed")}</td><td class="val">${m.cells}</td><td>${Object.entries(m.unreviewed).map(([g, n]) => `${esc(g)} ${n}`).join(" · ") || "none"}</td><td class="meta">${m.release ? `${time(m.release.at)} by ${esc(m.release.by)}` : ""}</td><td class="meta">${m.sources.map((x) => `${esc(x.number)} ${esc(x.rev)}`).join(", ")}</td></tr>`).join("")}</tbody></table></section>
        <section class="panel" style="margin-top:12px"><h2>Received, not yet ingested</h2><ul class="list">${received.map((d) => `<li>${link(d.id, d.name)}</li>`).join("") || `<li class="empty">None.</li>`}</ul></section>`;
      $("#ingest")?.addEventListener("click", async (e) => {
        e.target.disabled = true;
        try { const m = await api("/api/plant/ingest", { method: "POST", body: { drawingIds: received.map((d) => d.id) } }); location.hash = `#/plantmodels/${enc(m.id)}`; } catch (err) { toast(err.message); e.target.disabled = false; }
      });
      return;
    }
    const [m, comps] = await Promise.all([api(`/api/plant/models/${enc(id)}`), api("/api/objects?type=Competency")]);
    const today = (state.me && $("#clock").textContent.slice(0, 10)) || "";
    const canRelease = comps.some((c) => c.personId === state.me.id && c.competency === "c-model" && (!today || c.validTo >= today));
    const open = ["draft", "in_review"].includes(m.status);
    const order = { AMBIGUOUS: 0, INFERRED: 1, EXTRACTED: 2 };
    const cells = [...m.cells].sort((a, b) => (!!a.reviewed - !!b.reviewed) || order[a.grade] - order[b.grade] || a.key.localeCompare(b.key));
    const todo = cells.filter((c) => !c.reviewed);
    const sheets = Object.entries(todo.filter((c) => c.grade === "EXTRACTED").reduce((acc, c) => ((acc[c.sheet] = (acc[c.sheet] || 0) + 1), acc), {}));
    const val = (v) => (typeof v === "string" ? v : JSON.stringify(v));
    const row = (c) => `<tr class="${c.grade === "AMBIGUOUS" ? "amb" : c.grade === "INFERRED" ? "inf" : ""}" data-key="${esc(c.key)}"><td class="mono">${esc(c.key)}</td><td class="meta">${esc(c.sheet)}</td><td>${pill(c.grade, c.grade === "AMBIGUOUS" ? "medium" : c.grade === "INFERRED" ? "agent" : "low")}</td><td class="mono cv">${esc(val(c.value)).slice(0, 80)}</td><td class="why">${esc(c.reasoning)}</td>
      <td>${c.reviewed ? `<span class="meta">${esc(c.reviewed.by)} ${time(c.reviewed.at)}</span>` : open && eng ? `<div class="btns"><button class="btn" data-accept="${esc(c.key)}">Accept</button><button class="btn" data-correct="${esc(c.key)}">Correct</button>${c.field === "presence" ? `<button class="btn" data-exclude="${esc(c.key)}" title="Not on site: left out of the released model">Exclude</button>` : ""}</div>` : ""}</td></tr>`;
    view.innerHTML = `<div id="review"><div class="row"><div><h2>03 / review · ${esc(m.status)} · ${m.cells} cells · hash ${esc(m.packageHash.slice(0, 12))}</h2><h1>${esc(m.id)}</h1></div>
        <div class="btns"><a class="btn" href="#/plantmodels">All revisions</a><a class="btn" href="#/plant">Plant</a>${open && eng ? `<button class="btn primary" id="release" title="${canRelease ? "Four eyes: someone other than the last reviewer releases" : "You do not hold c-model; the server will refuse"}">Release</button>` : ""}</div></div>
      <p class="sub">${esc(m.disclosure)} · ${todo.length} cells to review (${todo.filter((c) => c.grade === "AMBIGUOUS").length} ambiguous, ${todo.filter((c) => c.grade === "INFERRED").length} inferred). Extracted cells may be accepted per sheet; inferred and ambiguous cells one by one. Release needs a second person who holds c-model.</p>
      <div id="relmsg" role="status"></div>
      ${open && eng && sheets.length ? `<div class="btns" style="margin:8px 0">${sheets.map(([sh, n]) => `<button class="btn" data-sheet="${esc(sh)}">Accept extracted · ${esc(sh)} (${n})</button>`).join("")}</div>` : ""}
      <section class="panel"><div class="row"><h2>To review · ${todo.length}</h2><label class="field" style="min-width:260px">Filter cells<input id="cf" type="search" placeholder="tag, field or sheet"></label></div>
        <table class="cells"><thead><tr><th>Cell</th><th>Sheet</th><th>Grade</th><th>Value</th><th>Reasoning</th><th></th></tr></thead><tbody id="todo">${todo.slice(0, 400).map(row).join("") || `<tr><td colspan="6" class="empty">Nothing left to review.</td></tr>`}</tbody></table></section>
      <section class="panel" style="margin-top:12px"><h2>Reviewed · ${cells.length - todo.length}</h2><table class="cells"><tbody id="done">${cells.filter((c) => c.reviewed).slice(0, 150).map(row).join("")}</tbody></table>${cells.length - todo.length > 150 ? `<p class="meta">Showing 150; filter to find others.</p>` : ""}</section></div>`;
    const act = async (params) => { try { await api("/api/actions/review_cells", { method: "POST", body: { params: { modelId: id, ...params } } }); views.plantmodels(id); } catch (err) { toast(err.message); } };
    view.querySelectorAll("[data-sheet]").forEach((b) => b.addEventListener("click", () => act({ accept: "EXTRACTED", sheet: b.dataset.sheet })));
    const onGrid = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.accept) return act({ marks: [{ key: b.dataset.accept }] });
      if (b.dataset.exclude) return act({ marks: [{ key: b.dataset.exclude, value: "excluded" }] });
      if (b.dataset.save) { const raw = b.closest("td").querySelector("input").value; let v = raw; try { v = JSON.parse(raw); } catch {} return act({ marks: [{ key: b.dataset.save, value: v }] }); }
      if (b.dataset.correct) {
        const c = m.cells.find((x) => x.key === b.dataset.correct), td = b.closest("tr").querySelector(".cv");
        td.innerHTML = `<input aria-label="Corrected value for ${esc(c.key)}" value="${esc(val(c.value))}"><button class="btn primary" style="margin-top:4px" data-save="${esc(c.key)}">Save</button>`;
        td.querySelector("input").focus();
      }
    };
    $("#review").addEventListener("click", onGrid);
    $("#cf").addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      $("#todo").innerHTML = todo.filter((c) => !q || `${c.key} ${c.sheet}`.toLowerCase().includes(q)).slice(0, 400).map(row).join("");
      $("#done").innerHTML = cells.filter((c) => c.reviewed && (!q || `${c.key} ${c.sheet}`.toLowerCase().includes(q))).slice(0, 150).map(row).join("");
    });
    $("#release")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await api("/api/actions/release_plant_model", { method: "POST", body: { params: { modelId: id, hash: m.packageHash } } });
        toast(`${id} released.`);
        location.hash = "#/plant";
      } catch (err) { $("#relmsg").innerHTML = `<p class="sub" style="color:var(--amber)">Release refused: ${esc(err.message)}</p>`; e.target.disabled = false; }
    });
  },

  async asset(id) {
    const m = await api(`/api/assets/${encodeURIComponent(id)}/model`);
    const specsD = await api(`/api/assets/${encodeURIComponent(id)}/specs`).catch(() => null);
    const briefD = specsD && specsD.workOrderId ? await api(`/api/workorders/${encodeURIComponent(specsD.workOrderId)}/brief`).catch(() => null) : null;
    const a = m.asset;
    const groups = {};
    for (const p of m.parts) (groups[p.group] ||= []).push(p);
    const tree = Object.entries(groups).map(([g, ps]) => `<div class="grp">${esc(g)}</div>${ps.map((p) => `<button data-part="${esc(p.id)}">${esc(p.name)} <span class="meta">${esc(p.din)}</span></button>`).join("")}`).join("");
    const alarmed = m.sensors.some(isAlarm);
    view.innerHTML = `<div class="row"><div><h2>${esc(a.zoneId)} · ${esc(a.serial || "")} · ${esc(a.make)} ${esc(a.model)}</h2><h1>${esc(a.name)} (${esc(a.positionTag)})</h1></div>
        <div class="btns">${pill(a.state)}${alarmed ? pill("sensor above alarm", "high") : ""}<a class="btn" href="#/object/${encodeURIComponent(a.id)}">Object view</a>${["supervisor", "engineer", "manager"].includes(state.me.clearance) ? `<button class="btn" id="permit">Open permit and isolate</button>` : ""}</div></div>
      <div class="work">
        <nav class="panel tree" aria-label="Components"><label class="field">Filter components<input id="pf" type="search"></label><div id="tree">${tree || `<p class="empty">No part breakdown for this asset yet.</p>`}</div></nav>
        <section class="panel stage3d" aria-label="3D model"><div class="disclose">TEMPLATE 3D · built from the released asset model · not the OEM's geometry</div>
          <div class="ctl"><label style="flex:1;display:flex;gap:8px;align-items:center">Explode <input id="ex" type="range" min="0" max="100" value="0" style="flex:1"></label>
          <button class="btn" id="iso">Isolate</button><button class="btn" id="loc">Locate</button><button class="btn" id="reset">Reset</button></div></section>
        <aside class="side">
          <section class="panel"><div class="tabs" role="tablist"><button class="on" data-tab="part" role="tab">Part</button><button data-tab="tel" role="tab">Telemetry</button><button data-tab="proc" role="tab">Procedure</button><button data-tab="brief" role="tab">Brief</button><button data-tab="specs" role="tab">Specs</button></div><div id="tab"></div></section>
          <section class="panel" aria-label="Technician Copilot"><h2 style="color:var(--violet)">Technician Copilot</h2><div class="chat" id="chat"><div class="msg">Select a part or ask what to check next.</div></div>
            <form id="ask" class="btns" style="flex-wrap:nowrap"><label class="sr" for="q">Ask the Copilot</label><input id="q" placeholder="What should I check next?" style="flex:1;background:var(--bg2);border:1px solid var(--line);padding:8px"><button class="btn primary">Ask</button></form></section>
        </aside>
      </div>`;
    let selected = null;
    const partById = Object.fromEntries(m.parts.map((p) => [p.id, p]));
    const tabs = {
      part: () => {
        const p = partById[selected];
        if (!p) return `<p class="empty">Select a part in the tree or on the model.</p>`;
        const finds = m.findings.filter((f) => f.partId === p.id);
        return `<h3 style="margin:0 0 8px;font:700 20px var(--cond);color:var(--ink)">${esc(p.name)}</h3><dl class="kv"><dt>DIN · stores</dt><dd>${esc(p.din)} · ${esc(p.erpNo)} · ${esc(p.stock ?? 0)} in stores${p.reserved ? `, ${esc(p.reserved)} reserved` : ""}</dd><dt>Material</dt><dd>${esc(p.material)}</dd>${p.band ? `<dt>Band</dt><dd>${esc(p.band.measure)} ${esc(p.band.lo)}–${esc(p.band.hi)} ${esc(p.band.unit)}</dd>` : ""}<dt>Steps</dt><dd>${m.procedure.filter((s) => s.partNames.includes(p.name)).map((s) => "PS " + s.step).join(", ") || "—"}</dd></dl>
          ${finds.map((f) => `<p class="meta">Finding ${esc(f.id)}: ${esc(f.text)}</p>`).join("")}
          <form id="tagf" style="margin-top:10px"><label class="field">Tag this part<textarea id="tnote" rows="2" required></textarea></label><label class="field">Reading${p.band ? ` (${esc(p.band.unit)})` : ""}<input id="tread" inputmode="decimal"></label><button class="btn primary">Save tag</button></form>`;
      },
      tel: () => m.sensors.map((s) => `<div style="margin-bottom:10px"><div class="row"><span>${esc(s.name)}</span><span class="val" style="color:${isAlarm(s) ? "var(--red)" : "inherit"}">${num(s.value)} ${esc(s.unit)}</span></div><div data-spark="${esc(s.id)}"></div></div>`).join("") || `<p class="empty">No sensors.</p>`,
      brief: () => (briefD ? `<p class="meta">Before ${link(specsD.workOrderId)}</p>${briefHtml(briefD.full)}` : `<p class="empty">No open job on this asset to brief on.</p>`),
      specs: () => specsHtml(specsD),
      proc: () => `<ol style="padding-left:18px;margin:0">${m.procedure.map((s) => `<li style="margin-bottom:6px">${esc(s.text)} ${s.intrusive ? pill("permit + isolation", "medium") : ""}</li>`).join("")}</ol>`
    };
    let tab = "part";
    const drawTab = async () => {
      $("#tab").innerHTML = tabs[tab]();
      if (tab === "tel") for (const el of view.querySelectorAll("[data-spark]")) { const t = await api(`/api/telemetry/${encodeURIComponent(el.dataset.spark)}?n=1440`); el.innerHTML = spark(t.values.filter((_, i) => i % 10 === 0), isAlarm(m.sensors.find((s) => s.id === el.dataset.spark))); }
      const rc = $("#recheck");
      if (rc) rc.addEventListener("click", async () => {
        try { const r = await api(`/api/assets/${encodeURIComponent(id)}/recheck-specs`, { method: "POST" }); toast(r.proposals.length ? `${r.proposals.length} spec change(s) waiting for the site manager.` : "Sources checked: nothing new."); views.asset(id); } catch (e) { toast(e.message); }
      });
      const f = $("#tagf");
      if (f) f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const note = $("#tnote").value.trim(), reading = $("#tread").value.trim();
        if (!note) return;
        await ensureCopilot();
        await api(`/api/copilot/${state.copilot}/tag`, { method: "POST", body: { partId: selected, note, reading: reading ? Number(reading) : null } });
        toast("Tag saved as a finding on this part.");
        if (reading) await ask(`Reading ${reading}. Is it within the band?`);
        else await ask("What should I check next?");
      });
    };
    view.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { view.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b)); tab = b.dataset.tab; drawTab(); }));
    const select = (pid) => {
      selected = pid;
      view.querySelectorAll("[data-part]").forEach((b) => b.classList.toggle("sel", b.dataset.part === pid));
      state.twin?.select(pid);
      state.copilot = null; // a new part scopes a new Copilot session
      tab = "part";
      view.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === "part"));
      drawTab();
    };
    view.querySelectorAll("[data-part]").forEach((b) => b.addEventListener("click", () => select(b.dataset.part)));
    $("#pf").addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); view.querySelectorAll("[data-part]").forEach((b) => (b.style.display = b.textContent.toLowerCase().includes(q) ? "" : "none")); });

    state.twin?.dispose();
    state.twin = null;
    if (m.parts.length) {
      try {
        const { mountTwin } = await import("/twin.js");
        state.twin = mountTwin($(".stage3d"), m.parts, { onSelect: (pid) => pid && select(pid) });
      } catch (e) {
        $(".stage3d").insertAdjacentHTML("afterbegin", `<p class="empty" style="padding:40px">3D view unavailable (${esc(e.message)}). The part tree and Copilot still work.</p>`);
      }
    }
    $("#ex").addEventListener("input", (e) => state.twin?.setExplode(e.target.value / 100));
    $("#iso").addEventListener("click", () => state.twin?.isolate(selected));
    $("#loc").addEventListener("click", () => selected && state.twin?.locate(selected));
    $("#reset").addEventListener("click", () => { state.twin?.isolate(null); state.twin?.highlight([]); $("#ex").value = 0; state.twin?.setExplode(0); });

    const chat = $("#chat");
    const ensureCopilot = async () => {
      if (state.copilot) return;
      const s = await api("/api/copilot/open", { method: "POST", body: { assetId: a.id, partId: selected } });
      state.copilot = s.id;
      const ins = s.insight;
      chat.innerHTML = `<div class="msg"><b>Situation.</b> ${ins.alerts.map((x) => esc(x.title)).join("; ") || "No active alert"}. Permit: ${ins.permit ? esc(ins.permit.id) : "none open"}; isolation ${ins.isolated ? "applied" : "not recorded"}. Hazard: ${esc(ins.hazards || "none")}. ${ins.findings.length} verified finding(s) on this asset family.</div>`;
    };
    const ask = async (q) => {
      await ensureCopilot();
      chat.insertAdjacentHTML("beforeend", `<div class="msg me">${esc(q)}</div>`);
      const r = await api(`/api/copilot/${state.copilot}/ask`, { method: "POST", body: { question: q } });
      chat.insertAdjacentHTML("beforeend", `<div class="msg">${esc(r.answer)}${r.withheld && !r.answer.includes(r.withheld) ? `<br><span style="color:var(--amber)">${esc(r.withheld)}</span>` : ""}${r.citations?.length ? `<br><span class="cite">${r.citations.map((c) => esc(c.id)).join(" · ")}</span>` : ""}${r.model ? `<br><span class="cite">written by Claude from the records above</span>` : ""}</div>`);
      chat.scrollTop = chat.scrollHeight;
      state.twin?.highlight(r.lookHere);
    };
    $("#ask").addEventListener("submit", async (e) => { e.preventDefault(); const q = $("#q").value.trim(); if (!q) return; $("#q").value = ""; try { await ask(q); } catch (err) { toast(err.message); } });
    drawTab();
    $("#permit")?.addEventListener("click", async () => {
      try {
        const p = await api("/api/actions/open_permit", { method: "POST", body: { params: { assetId: a.id, kind: "general", holderId: state.user } } });
        await api("/api/actions/record_isolation", { method: "POST", body: { params: { permitId: p.decision.objects[0], point: `Local isolator at ${a.positionTag}`, by: state.user } } });
        toast(`${p.decision.objects[0]} open on ${a.positionTag}, isolation recorded.`);
      } catch (e) { toast(e.message); }
    });
  },

  async work() {
    const [wos, drafts] = await Promise.all([api("/api/objects?type=WorkOrder"), api("/api/objects?type=Draft")]);
    const open = wos.filter((w) => !["closed", "cancelled"].includes(w.state));
    view.innerHTML = `<h2>04 / work</h2><h1>Work orders and drafts</h1>
      <div class="grid console"><section class="panel"><h2>Open work · ${open.length}</h2><table><thead><tr><th>Order</th><th>Title</th><th>State</th><th>Priority</th><th>Assignee</th></tr></thead><tbody>${open.map((w) => `<tr><td>${link(w.id)}</td><td>${esc(w.title)}</td><td>${pill(w.state)}</td><td>${esc(w.priority)}</td><td>${w.assigneeId ? link(w.assigneeId) : "—"}</td></tr>`).join("")}</tbody></table></section>
      <section class="panel"><h2>Agent drafts</h2><ul class="list">${drafts.slice().reverse().map((d) => `<li><details><summary><b>${esc(d.title)}</b> <span class="meta">${esc(d.kind)}</span></summary><pre>${esc(d.body)}</pre></details></li>`).join("") || `<li class="empty">No drafts.</li>`}</ul></section></div>`;
  },

  async agents() {
    const [agents, runs] = await Promise.all([api("/api/agents"), api("/api/runs")]);
    const canDial = ["engineer", "manager"].includes(state.me?.clearance);
    const lv = ["read", "draft", "notify", "propose", "act"];
    view.innerHTML = `<h2>05 / agents on the same ontology as people</h2><h1>Agent Hub</h1><p class="sub">${canDial ? "You can change each agent's autonomy dial." : "Engineer clearance is needed to change the autonomy dial."} The effective level is the lower of the dial and the action's ceiling.</p>
      <section class="panel" style="overflow-x:auto"><table><thead><tr><th>Agent</th><th>Trigger</th><th>Autonomy per action</th><th>Runs</th><th>Accepted</th><th></th></tr></thead><tbody>
      ${agents.map((a) => `<tr><td><b>${esc(a.name)}</b><div class="meta">${esc(a.purpose)}</div></td><td class="meta">${esc(a.trigger.kind)}${a.trigger.every ? " · " + esc(a.trigger.every) : ""}${a.trigger.on ? " · " + esc(a.trigger.on) : ""}</td>
        <td class="dial">${a.tools.map((t) => `<label style="display:flex;gap:6px;align-items:center;margin-bottom:4px"><span class="mono" style="font-size:12px;min-width:170px">${esc(t)}</span><select data-agent="${esc(a.name)}" data-action="${esc(t)}" ${canDial ? "" : "disabled"}>${lv.map((l) => `<option ${a.autonomy[t] === l ? "selected" : ""}>${l}</option>`).join("")}</select></label>`).join("") || `<span class="meta">read-only</span>`}</td>
        <td class="val">${a.runs}</td><td class="val">${a.acceptance == null ? "—" : a.acceptance + "%"}</td>
        <td><div class="btns"><button class="btn primary" data-run="${esc(a.name)}">Run</button><button class="btn" data-evals="${esc(a.name)}">Evals</button></div><div data-evalout="${esc(a.name)}"></div></td></tr>`).join("")}
      </tbody></table></section>
      <section class="panel" id="stmts" style="margin-top:14px"><h2>Decision statements</h2><p class="meta">What each agent may do, who answers it, and its off switches. Open one to read it back.</p>
        ${agents.map((a) => `<details class="stmt" data-spec="${esc(a.name)}"><summary><b>${esc(a.name)}</b></summary><div data-specout="${esc(a.name)}"><span class="meta">loading…</span></div></details>`).join("")}</section>
      <section class="panel" style="margin-top:14px"><h2>Recent runs</h2><table><thead><tr><th>Run</th><th>Agent</th><th>Trigger</th><th>Status</th><th>Read</th><th>Calls</th><th>Outputs</th></tr></thead><tbody>${runs.slice(0, 40).map((r) => `<tr><td><a href="#/run/${r.id}">${r.id}</a></td><td>${esc(r.agent)}</td><td class="meta">${esc(r.trigger.kind)}</td><td>${pill(r.status)}</td><td class="val">${r.read.length}</td><td class="val">${r.calls.length}</td><td class="val">${r.outputs.length}</td></tr>`).join("")}</tbody></table></section>`;
    view.querySelectorAll("select[data-agent]").forEach((s) => s.addEventListener("change", async () => {
      try { await api(`/api/agents/${encodeURIComponent(s.dataset.agent)}/autonomy`, { method: "PUT", body: { action: s.dataset.action, level: s.value } }); toast(`${s.dataset.agent}: ${s.dataset.action} set to ${s.value}.`); } catch (e) { toast(e.message); }
    }));
    const card = (r) => {
      const s = r.spec, sh = r.shadow, c = r.promotion.criteria;
      const who = s.approver && s.approver.clearanceOf ? "anyone with the action's clearance" : `${esc(s.approver)}${s.backup ? `, or ${esc(s.backup)} after ${esc(s.escalateAfterMin)} min` : ""}`;
      return `<div class="row">${pill(s.mode, s.mode === "bounded" ? "running" : "watch")} ${pill(s.state)}<span class="meta">owner ${esc(s.owner)} · v${esc(s.version)}</span></div>
        <ul class="list">${r.sentences.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <p class="meta">Approver: ${who}. If nobody answers: ${esc(s.onTimeout)}, never applied.</p>
        <p class="meta">Shadow record: ${sh.cases} cases, ${sh.agreePct}% agreed. Promotion needs ${c.minCases} cases, ${c.minAgreePct}% agreement, no breaches and stale evidence under ${c.maxStalePct}%.${r.promotion.gap ? ` Not yet: ${esc(r.promotion.gap)}.` : ""}</p>
        ${canDial ? `<div class="btns">${s.tools.map((t) => `<label class="meta"><input type="checkbox" data-tool-toggle data-agent="${esc(s.name)}" data-action="${esc(t.action)}" ${t.enabled ? "checked" : ""}> ${esc(t.action)}</label>`).join("")}</div>
        <div class="btns"><label class="meta">Agent <select data-agent-state="${esc(s.name)}">${["live", "paused", "retired"].map((x) => `<option ${s.state === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
          ${r.promotion.next ? `<button class="btn" data-promote="${esc(s.name)}" data-to="${esc(r.promotion.next)}">Promote to ${esc(r.promotion.next)}</button>` : ""}
          ${r.promotion.previous ? `<button class="btn" data-demote="${esc(s.name)}" data-to="${esc(r.promotion.previous)}">Demote to ${esc(r.promotion.previous)}</button>` : ""}</div>`
          : s.approver === state.me.id && r.promotion.next ? `<div class="btns"><button class="btn" data-promote="${esc(s.name)}" data-to="${esc(r.promotion.next)}">Promote to ${esc(r.promotion.next)}</button></div><p class="meta">You are this agent's approver.</p>`
          : `<p class="meta">Engineer clearance is needed for the switches.</p>`}`;
    };
    const stmts = $("#stmts");
    const load = async (name) => { stmts.querySelector(`[data-specout="${CSS.escape(name)}"]`).innerHTML = card(await api(`/api/agents/${encodeURIComponent(name)}/spec`)); };
    const harness = async (action, params, done) => { try { await api(`/api/actions/${action}`, { method: "POST", body: { params } }); toast(done); } catch (e) { toast(e.message); } load(params.agent); };
    stmts.querySelectorAll("details[data-spec]").forEach((d) => d.addEventListener("toggle", () => d.open && load(d.dataset.spec)));
    stmts.addEventListener("change", (e) => {
      const t = e.target;
      if (t.matches("[data-tool-toggle]")) harness("set_tool_enabled", { agent: t.dataset.agent, action: t.dataset.action, enabled: t.checked }, `${t.dataset.agent}: ${t.dataset.action} turned ${t.checked ? "on" : "off"}.`);
      if (t.matches("[data-agent-state]")) harness("set_agent_state", { agent: t.dataset.agentState, state: t.value }, `${t.dataset.agentState} is ${t.value}.`);
    });
    stmts.addEventListener("click", (e) => {
      const b = e.target.closest("[data-promote],[data-demote]");
      if (b) harness(b.dataset.promote ? "promote_agent" : "demote_agent", { agent: b.dataset.promote || b.dataset.demote, to: b.dataset.to }, `${b.dataset.promote || b.dataset.demote} is now ${b.dataset.to}.`);
    });
    view.querySelectorAll("[data-evals]").forEach((b) => b.addEventListener("click", async () => {
      const out = view.querySelector(`[data-evalout="${CSS.escape(b.dataset.evals)}"]`);
      out.innerHTML = `<span class="meta">running…</span>`;
      const r = await api(`/api/evals/${encodeURIComponent(b.dataset.evals)}`);
      out.innerHTML = `<div class="meta">${r.passed}/${r.total} passed</div>${r.cases.map((c) => `<div class="meta">${c.pass ? "✓" : "✗"} ${esc(c.name)}</div>`).join("")}`;
    }));
  },

  async run(id) {
    const r = await api(`/api/runs/${encodeURIComponent(id)}`);
    view.innerHTML = `<h2>Run log · ${esc(r.id)}</h2><h1>${esc(r.agent)} <span class="meta">v${esc(r.version)}</span></h1>
      <p class="sub">Trigger ${esc(r.trigger.kind)}${r.trigger.from ? ` from <a href="#/run/${esc(r.trigger.from)}">${esc(r.trigger.from)}</a>` : ""} · acting for ${esc(r.actingUserId)} · plant time ${time(r.plantTime)} · ${pill(r.status)}</p>
      <div class="grid console"><section class="panel"><h2>Reasoning</h2><ol>${r.reasoning.map((x) => `<li>${esc(x)}</li>`).join("") || `<li class="empty">No reasoning notes.</li>`}</ol>
        <h2>Tool calls</h2><ol>${r.calls.map((c) => `<li><span class="mono">${esc(c.tool)}</span> <span class="meta">${esc(JSON.stringify(c.args)).slice(0, 220)}</span><br><span class="meta">→ ${esc(JSON.stringify(c.result)).slice(0, 220)}</span></li>`).join("")}</ol>
        ${r.refusals.length ? `<h2>Refused</h2><ul>${r.refusals.map((x) => `<li>${esc(x.action)}: ${esc(x.reason)}</li>`).join("")}</ul>` : ""}</section>
      <section class="panel"><h2>Outputs</h2><ul class="list">${r.outputs.map((o) => `<li>${o.ref ? `${esc(o.action)} → ${link(o.ref)} ${pill(o.status)}` : `<pre>${esc(o.text || JSON.stringify(o))}</pre>`}</li>`).join("") || `<li class="empty">None.</li>`}</ul>
        <h2>Objects read (${r.read.length})</h2><p class="meta">${r.read.slice(0, 120).map((x) => link(x)).join(" · ")}</p></section></div>`;
  },

  async rca(id) {
    const d = await api(`/api/rca/${encodeURIComponent(id)}`), r = d.data;
    const ev = (e) => `<li>${link(e.id)} <span class="meta">${e.ageMin == null ? "" : `${e.ageMin} min old · `}${esc(e.note)}</span></li>`;
    view.innerHTML = `<h2>Root cause · ${esc(d.id)}</h2><h1>${esc(d.title.replace(/^Root cause: /, ""))}</h1>
      <p class="sub">${pill(r.verdict, r.verdict === "explained" ? "done" : "medium")} ${r.symptom && r.symptom.sensorId ? `Symptom ${link(r.symptom.sensorId)}${r.symptom.onsetAt ? `, onset ${time(r.symptom.onsetAt)}` : ""}.` : ""} ${r.window ? `Travel window from the intake ${r.window.onsetH}–${r.window.tailH} h (mean ${r.window.meanH} h).` : ""} ${r.why ? esc(r.why) + "." : ""}</p>
      <div class="grid console"><section class="panel"><h2>Causes, ranked</h2><ol>${r.causes.map((c) => `<li><div class="row"><b>${esc(c.label)}</b>${pill(c.kind, c.kind === "local" ? "high" : "watch")}<span class="meta">weight ${esc(c.weight)}</span><a class="btn" href="${esc(c.showMe)}">Show me</a></div><ul class="list">${c.evidence.map(ev).join("")}</ul></li>`).join("") || `<li class="empty">None: ${esc(r.verdict)}.</li>`}</ol></section>
      <section class="panel"><h2>Rejected</h2><ul class="list">${r.rejected.map((x) => `<li><b>${esc(x.label)}</b><div class="meta">${esc(x.reason)}</div></li>`).join("") || `<li class="empty">None.</li>`}</ul>
        <p class="meta">Deterministic: change onsets, the released plant model's process graph and its travel windows. Nothing here is guessed.</p></section></div>`;
  },

  async proposals() {
    const ps = await api("/api/proposals");
    const open = ps.filter((p) => p.state === "open" && p.action !== "update_spec"), done = ps.filter((p) => p.state !== "open");
    // spec changes (job brief design §8): the winner beside every passed-over source; only the site manager acts
    const specP = ps.filter((p) => p.state === "open" && p.action === "update_spec"), specData = {};
    for (const p of specP) if (p.params.assetId && !specData[p.params.assetId]) specData[p.params.assetId] = await api(`/api/assets/${encodeURIComponent(p.params.assetId)}/specs`).catch(() => null);
    const orgs = specP.length ? await api("/api/objects?type=Organisation").catch(() => []) : [];
    const specCard = (p) => {
      const d = specData[p.params.assetId], byId = Object.fromEntries((d ? d.candidates : []).map((c) => [c.id, c]));
      const sp = d && d.specs.find((s) => s.id === p.params.specId), win = byId[p.params.candidateId], mine = state.me.id === p.approver;
      return `<section class="panel" style="margin-bottom:12px"><div class="row"><b>${esc(d ? d.asset.positionTag : "")} ${esc(sp ? sp.measure.toLowerCase() : p.params.specId)}: ${sp ? `${esc(sp.lo)}–${esc(sp.hi)} → ` : ""}${esc(p.params.lo)}–${esc(p.params.hi)} ${esc(p.params.unit || "")}</b><span class="meta">${esc(p.id)} · ${link(p.params.assetId)}</span></div>
        <p>${esc(p.params.why || "")}${p.params.flag ? ` <span style="color:var(--amber)">${esc(p.params.flag)}</span>` : ""}</p>${win && win.text ? `<blockquote class="meta">“${esc(win.text)}”</blockquote>` : ""}
        <table><thead><tr><th>Passed over</th><th>Value</th><th>Why</th>${mine ? "<th>Wrong, not just older?</th>" : ""}</tr></thead><tbody>${p.params.passedOver.map((x) => { const c = byId[x.candidateId] || {}; return `<tr><td>${esc(x.title)}${c.text ? `<div class="meta">${esc(c.text)}</div>` : ""}</td><td>${esc(x.value ?? "unread")}</td><td>${esc(x.reason)}</td>${mine ? `<td>
          <label><input type="checkbox" data-wrong="${esc(x.candidateId)}"> this source is wrong</label>
          <select data-scope="${esc(x.candidateId)}" aria-label="Correction scope"><option value="asset">this asset</option><option value="template">this make and model</option>${orgs.map((o) => `<option value="org:${esc(o.id)}">this organisation: ${esc(o.name)}</option>`).join("")}</select>
          <input data-note="${esc(x.candidateId)}" maxlength="100" placeholder="One-line note" aria-label="Correction note"></td>` : ""}</tr>`; }).join("")}</tbody></table>
        ${mine ? `<label class="field">Reason (needed to edit or reject)<textarea rows="2" data-sreason="${esc(p.id)}"></textarea></label>
          <div class="btns"><label>Low <input data-lo="${esc(p.id)}" value="${esc(p.params.lo)}" size="8"></label><label>High <input data-hi="${esc(p.id)}" value="${esc(p.params.hi)}" size="8"></label></div>
          <div class="btns"><button class="btn primary" data-spec="approve" data-id="${esc(p.id)}">Confirm</button><button class="btn" data-spec="edit" data-id="${esc(p.id)}">Edit value</button><button class="btn" data-spec="reject" data-id="${esc(p.id)}">Reject</button></div>`
          : `<p class="meta">Only the site manager confirms a spec change.</p>`}</section>`;
    };
    // unsure sources stay listed until someone deals with them, whether or not a change is open
    const unsure = (await api("/api/objects?type=SpecCandidate").catch(() => [])).filter((c) => c.grade === "AMBIGUOUS" && c.status === "suggested");
    view.innerHTML = `<h2>06 / agents propose, people decide</h2><h1>Proposals</h1>
      ${specP.length ? `<h2>Spec changes · ${specP.length}</h2>${specP.map(specCard).join("")}` : ""}${unsure.length ? `<section class="panel" style="margin-bottom:12px"><h2>Read these yourself</h2><p class="meta">Triage could not read these, so it proposes nothing from them.</p><ul class="list">${unsure.map((c) => `<li>${esc(c.source.title)} <span class="meta">${link(c.subject)} · ${esc(String(c.source.at || "").slice(0, 10))}</span></li>`).join("")}</ul></section>` : ""}
      ${open.map((p) => `<section class="panel" style="margin-bottom:12px"><div class="row"><b>${esc(p.action)}</b><span class="meta">${esc(p.id)} · ${esc(p.actorId)}${p.runId ? ` · <a href="#/run/${esc(p.runId)}">${esc(p.runId)}</a>` : ""}</span></div>
        <pre>${esc(JSON.stringify(p.params, null, 2))}</pre>${p.evidence?.length ? `<p class="meta">Evidence: ${p.evidence.map((e) => esc(typeof e === "string" ? e : JSON.stringify(e))).join(" · ")}</p>` : ""}
        ${p.card ? `<dl class="kv"><dt>Expected effect</dt><dd>${esc(p.card.expectedEffect)}</dd><dt>Evidence age</dt><dd>${p.card.evidence.map((e) => `${esc(e.id)} ${e.ageMin == null ? "" : `(${esc(e.ageMin)} min old)`}`).join(" · ") || "none cited"}</dd>
          <dt>Constraints checked</dt><dd>${esc(p.card.constraintsChecked.join(", "))}</dd><dt>Alternatives</dt><dd>${p.card.alternatives.length ? esc(p.card.alternatives.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ")) : "none given"}</dd>
          <dt>Approver</dt><dd>${p.approver && p.approver.clearanceOf ? "anyone with the action's clearance" : esc(p.approver)}${p.escalateAt ? ` · ${esc(p.backup)} may answer from ${time(p.escalateAt)}` : ""}${p.timedOut ? " · timed out, held" : ""}</dd></dl>` : ""}
        <label class="field">Reason (needed to edit or reject)<textarea rows="2" data-reason="${esc(p.id)}"></textarea></label>
        <label class="field">Edited parameters (JSON, for Edit and approve)<textarea rows="2" data-params="${esc(p.id)}">${esc(JSON.stringify(p.params))}</textarea></label>
        <div class="btns"><button class="btn decide" data-verdict="approve" data-id="${esc(p.id)}">Approve</button><button class="btn decide" data-verdict="edit" data-id="${esc(p.id)}">Edit and approve</button><button class="btn decide" data-verdict="reject" data-id="${esc(p.id)}">Reject</button></div></section>`).join("") || `<p class="empty">Nothing is waiting for you.</p>`}
      <section class="panel"><h2>Resolved</h2><table><thead><tr><th>Proposal</th><th>Action</th><th>By agent</th><th>State</th><th>Resolved by</th></tr></thead><tbody>${done.map((p) => `<tr><td>${link(p.id)}</td><td>${esc(p.action)}</td><td>${esc(p.actorId)}</td><td>${pill(p.state)}</td><td>${esc(p.resolvedBy)}</td></tr>`).join("")}</tbody></table></section>`;
    view.querySelectorAll("[data-spec]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.id, p = specP.find((x) => x.id === id), d = specData[p.params.assetId], verdict = b.dataset.spec;
      const reason = view.querySelector(`[data-sreason="${CSS.escape(id)}"]`).value.trim();
      const params = verdict === "edit" ? { lo: Number(view.querySelector(`[data-lo="${CSS.escape(id)}"]`).value), hi: Number(view.querySelector(`[data-hi="${CSS.escape(id)}"]`).value), target: null, candidateId: null } : undefined;
      try {
        await api(`/api/proposals/${encodeURIComponent(id)}/resolve`, { method: "POST", body: { verdict, reason, params } });
        let made = 0;
        if (verdict !== "reject") for (const po of p.params.passedOver) {
          const box = view.querySelector(`[data-wrong="${CSS.escape(po.candidateId)}"]`);
          if (!box || !box.checked) continue;
          const c = d.candidates.find((x) => x.id === po.candidateId) || {}, sc = view.querySelector(`[data-scope="${CSS.escape(po.candidateId)}"]`).value;
          const note = view.querySelector(`[data-note="${CSS.escape(po.candidateId)}"]`).value.trim();
          const scope = sc === "asset" ? { assetId: p.params.assetId } : sc === "template" ? { template: d.asset.template } : { orgId: sc.slice(4) };
          await api("/api/actions/record_correction", { method: "POST", body: { params: { line: (note ? `${po.title}: ${note}` : `${po.title} is wrong for ${d.asset.positionTag}.`).slice(0, 100), scope, wrongSourceRef: { kind: c.kind, id: c.sourceId }, wrongValue: po.value, fromId: id } } });
          made++;
        }
        toast(`${id}: ${verdict}${made ? `, ${made} correction(s) recorded` : ""}`);
        views.proposals();
      } catch (e) { toast(e.message); }
    }));
    view.querySelectorAll("[data-verdict]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.id, reason = view.querySelector(`[data-reason="${CSS.escape(id)}"]`).value.trim();
      let params;
      if (b.dataset.verdict === "edit") { try { params = JSON.parse(view.querySelector(`[data-params="${CSS.escape(id)}"]`).value); } catch { return toast("Edited parameters are not valid JSON."); } }
      try { await api(`/api/proposals/${encodeURIComponent(id)}/resolve`, { method: "POST", body: { verdict: b.dataset.verdict, reason, params } }); toast(`${id}: ${b.dataset.verdict}`); views.proposals(); } catch (e) { toast(e.message); }
    }));
  },

  async knowledge() {
    const k = await api("/api/knowledge");
    view.innerHTML = `<h2>07 / tribal knowledge as a governed loop</h2><h1>Knowledge Hub</h1>
      <div class="grid console"><section class="panel"><h2>Findings · ${k.findings.length}</h2><ul class="list">${k.findings.slice().reverse().map((f) => `<li><div class="row"><b>${link(f.id)}</b>${f.verified ? pill("verified", "done") : pill("unverified", "medium")}</div><div>${esc(f.text)}</div><div class="meta">${f.partId ? link(f.partId) : ""} · ${esc(f.authorRole || f.authorId || "")} · ${esc(f.at)}</div></li>`).join("")}</ul></section>
      <section class="panel"><h2>Feedback on agents · ${k.feedback.length}</h2><ul class="list">${k.feedback.slice().reverse().map((f) => `<li><div class="row"><b>${esc(f.verdict)}</b><span class="meta">${link(f.targetId)}</span></div><div>${esc(f.comment || "")}</div><div class="meta">${esc(f.authorId)} · ${time(f.at)}</div></li>`).join("") || `<li class="empty">No feedback yet. Reject or edit a proposal with a reason to add some.</li>`}</ul></section></div>`;
  },

  async compliance() {
    const c = await api("/api/compliance");
    view.innerHTML = `<h2>08 / compliance as a workflow</h2><h1>Blue Drop evidence</h1>
      <section class="panel"><table><thead><tr><th>Requirement</th><th>Status</th><th>Evidence</th></tr></thead><tbody>${c.items.map((i) => `<tr><td>${link(i.requirementId)}</td><td>${pill(i.status)}</td><td>${esc(i.detail)}${i.refs.length ? `<div class="meta">${i.refs.slice(0, 8).map((r) => link(r)).join(" · ")}</div>` : ""}</td></tr>`).join("")}</tbody></table>
      <div class="btns"><button class="btn" data-run="Drop Pack">Refresh with the Drop Pack agent</button><button class="btn primary" id="submit">Submit pack (named person)</button></div></section>`;
    $("#submit").addEventListener("click", async () => { try { await api("/api/actions/submit_compliance_pack", { method: "POST", body: { params: { framework: "Blue Drop" } } }); toast("Submitted and recorded."); } catch (e) { toast(e.message); } });
  },

  async ontology() {
    const s = await api("/api/schema");
    view.innerHTML = `<h2>09 / the connective tissue</h2><h1>Ontology</h1><p class="sub">Object types and counts visible to you. Search any object.</p>
      <form id="os" class="btns"><label class="sr" for="oq">Search objects</label><input id="oq" placeholder="HLP-B, F07, P-023, WO-…" style="flex:1;max-width:420px;background:var(--bg2);border:1px solid var(--line);padding:8px"><button class="btn primary">Search</button></form>
      <div id="ores"></div><section class="panel" style="margin-top:12px"><table><thead><tr><th>Type</th><th>Objects</th></tr></thead><tbody>${Object.entries(s.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<tr><td><a href="#/search/type:${encodeURIComponent(t)}">${esc(t)}</a></td><td class="val">${n}</td></tr>`).join("")}</tbody></table></section>`;
    $("#os").addEventListener("submit", (e) => { e.preventDefault(); location.hash = `#/search/${encodeURIComponent($("#oq").value)}`; });
  },

  async search(q) {
    q = decodeURIComponent(q || "");
    const list = q.startsWith("type:") ? await api(`/api/objects?type=${encodeURIComponent(q.slice(5))}`) : await api(`/api/objects?q=${encodeURIComponent(q)}`);
    view.innerHTML = `<h2>Search</h2><h1>${esc(q)}</h1><section class="panel"><table><thead><tr><th>Object</th><th>Type</th><th>Name</th></tr></thead><tbody>${list.slice(0, 300).map((o) => `<tr><td>${o.type === "Asset" ? `<a href="#/asset/${encodeURIComponent(o.id)}">${esc(o.id)}</a>` : link(o.id)}</td><td>${esc(o.type)}</td><td>${esc(o.name || o.title || o.text || o.tag || "")}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">Nothing visible matches.</td></tr>`}</tbody></table></section>`;
  },

  async object(id) {
    const o = await api(`/api/objects/${encodeURIComponent(id)}`);
    const ob = o.object;
    const wb = ob.type === "WorkOrder" ? await api(`/api/workorders/${encodeURIComponent(ob.id)}/brief`).catch(() => null) : null;
    const props = Object.entries(ob).filter(([k]) => !["prov", "geom", "explode"].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("");
    view.innerHTML = `<h2>${esc(ob.type)}</h2><h1>${esc(ob.name || ob.title || ob.id)}</h1>${ob.type === "Asset" && ob.template ? `<p><a class="btn primary" href="#/asset/${encodeURIComponent(ob.id)}">Open in the Asset Workbench</a></p>` : ""}${ob.type === "Alert" && ob.assetId ? `<p><button class="btn primary" data-rca="${esc(ob.id)}">Find root cause</button></p>` : ""}
      <div class="grid console"><section class="panel"><h2>Properties</h2><dl class="kv">${props}</dl><h2 style="margin-top:12px">Provenance</h2><dl class="kv">${Object.entries(ob.prov || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></section>
      <div class="grid">${wb ? `<section class="panel" aria-label="Brief"><h2>Brief before you start</h2>${briefHtml(wb.full)}</section>` : ""}<section class="panel"><h2>Links · ${o.links.length}</h2><ul class="list">${o.links.map((l) => `<li>${l.dir === "out" ? "→" : "←"} <span class="mono">${esc(l.rel)}</span> ${l.other ? link(l.other.id, `${l.other.type} ${l.other.name}`) : ""}</li>`).join("") || `<li class="empty">None visible.</li>`}</ul></section>
      ${o.sensors.length ? `<section class="panel"><h2>Live values</h2><ul class="list">${o.sensors.map((s) => `<li class="row"><span>${esc(s.name)}</span><span class="val" style="color:${isAlarm(s) ? "var(--red)" : "inherit"}">${num(s.value)} ${esc(s.unit)}</span></li>`).join("")}</ul></section>` : ""}
      ${o.runs.length ? `<section class="panel"><h2>Agents that read this</h2><ul class="list">${o.runs.map((r) => `<li><a href="#/run/${r.id}">${esc(r.agent)}</a> <span class="meta">${time(r.plantTime)}</span></li>`).join("")}</ul></section>` : ""}
      ${o.related.decisions.length ? `<section class="panel"><h2>Decisions</h2><ul class="list">${o.related.decisions.map((d) => `<li class="row"><span>${esc(d.action)} by ${esc(d.actorId)}${d.approvedBy ? ` · approved by ${esc(d.approvedBy)}` : ""}</span>${d.reversed ? pill("reversed", "rejected") : d.reversible ? `<button class="btn" data-reverse="${esc(d.id)}">Reverse</button>` : ""}</li>`).join("")}</ul></section>` : ""}
      </div></div>`;
    view.querySelectorAll("[data-reverse]").forEach((b) => b.addEventListener("click", async () => { try { const r = await api(`/api/decisions/${encodeURIComponent(b.dataset.reverse)}/reverse`, { method: "POST" }); toast(r.kept && r.kept.length ? `Reversed; kept later changes to ${r.kept.join(", ")}.` : "Reversed."); views.object(id); } catch (e) { toast(e.message); } }));
  },

  // ---------- workforce intelligence (Phase 2) ----------
  async chat(id) {
    const chans = await api("/api/channels");
    const ch = chans.find((c) => c.id === id) || chans.find((c) => c.personId === state.user) || chans[0];
    if (!ch) { view.innerHTML = `<h1>Chat</h1><p class="empty">No chats are visible to you.</p>`; return; }
    const [msgs, exs] = await Promise.all([api(`/api/channels/${encodeURIComponent(ch.id)}/messages`), api(`/api/executions?personId=${encodeURIComponent(state.user)}`)]);
    const member = (ch.members || []).includes(state.user);
    const ex = !ch.groupName && member ? exs.find((e) => e.state === "running") : null;
    let job = "";
    if (ex) {
      const pr = (await api(`/api/procedures/${encodeURIComponent(ex.procedureId)}`)).procedure;
      const st = pr.steps.find((s) => s.step === ex.steps.find((x) => x.state === "todo").step);
      const r = st.requires.reading;
      job = `<section class="panel" aria-label="Running job"><div class="row"><h2>Job · ${esc(ex.workOrderId)} · ${esc(pr.title)} v${esc(ex.procedureVersion)}</h2>${pill(`${ex.steps.filter((s) => s.state === "done").length}/${ex.steps.length} done`, "running")}</div>
        <p><b>Step ${esc(st.step)}.</b> ${esc(st.text)}${st.requires.permit ? ` ${pill("permit and isolation", "medium")}` : ""}</p>
        <form id="step" class="btns" data-step="${esc(st.step)}">${r ? `<label class="field" style="margin:0">${esc(r.measure)} (${esc(r.unit)})<input id="stepval" inputmode="decimal" required></label>` : ""}<button class="btn primary">Done</button></form>
        <ol class="steps">${ex.steps.map((s) => `<li class="${esc(s.state)}">${esc((pr.steps.find((x) => x.step === s.step) || {}).text)}${s.minutes != null ? ` <span class="meta">${esc(s.minutes)} min${s.value != null ? ` · ${esc(s.value)}` : ""}</span>` : ""}</li>`).join("")}</ol></section>`;
    }
    const who = (m) => (m.direction === "out" ? m.sentBy || "Works number" : m.fromName);
    const bubble = (m) => `<div class="msg ${m.direction === "in" && m.from === state.user ? "me" : ""} ${esc(m.direction)}"><div class="meta">${esc(who(m))} · ${time(m.at)}${m.direction === "in" && m.outcome ? ` ${pill(m.outcome)}` : ""}</div>${esc(m.text)}${m.media && m.media.length ? `<div class="cite">${m.media.map(esc).join(" · ")}</div>` : ""}</div>`;
    view.innerHTML = `<h2>09 / the works number</h2><h1>Chat</h1><p class="sub">A stand-in for WhatsApp: a message here does what a message to the works number does.${ch.groupName ? " The works number reads this group and only posts the Friday status." : ""}</p>
      <div class="grid chatgrid">
        <section class="panel" aria-label="Chats"><h2>Chats</h2><ul class="list">${chans.map((c) => `<li><a href="#/chat/${encodeURIComponent(c.id)}"${c.id === ch.id ? ' aria-current="page"' : ""}><b>${esc(c.label)}</b></a><div class="meta">${c.last ? esc(c.last.text.slice(0, 60)) : "no messages"}</div></li>`).join("")}</ul></section>
        <div class="grid">${job}
          <section class="panel" aria-label="Messages"><h2>${esc(ch.label)}${ch.groupName ? ` ${pill("listening", "medium")}` : ""}</h2><div class="chat phone" id="thread">${msgs.map(bubble).join("") || `<p class="empty">No messages yet. Try "start".</p>`}</div>
            ${member ? `<form id="compose" class="btns"><label class="sr" for="say">Message</label><input id="say" autocomplete="off" style="flex:1" placeholder="${ch.groupName ? "Post to the group" : "Try start, done, or ask a question"}"><button class="btn primary">Send</button></form>` : `<p class="meta">Read only: you are not in this chat.</p>`}</section>
        </div>
      </div>`;
    const send = async (text) => {
      const res = await fetch(`/api/channels/${encodeURIComponent(ch.id)}/inbound`, { method: "POST", headers: { "content-type": "application/json", "x-channel-sender": state.user }, body: JSON.stringify({ text }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || res.statusText);
      if (j.outcome === "dropped") toast("Off-topic: not stored.");
      await views.chat(ch.id);
      $("#say")?.focus();
    };
    const busy = (form, fn) => async (e) => {
      e.preventDefault();
      const btn = form.querySelector("button");
      if (btn.disabled) return;
      btn.disabled = true;
      try { await fn(); } catch (err) { toast(err.message); btn.disabled = false; }
    };
    const compose = $("#compose"), stepForm = $("#step");
    compose?.addEventListener("submit", busy(compose, async () => { const t = $("#say").value.trim(); if (t) await send(t); else compose.querySelector("button").disabled = false; }));
    // the card names its step, so a second tap is refused by the server instead of completing the next step
    stepForm?.addEventListener("submit", busy(stepForm, async () => { const v = $("#stepval")?.value.trim(); await send(`step ${stepForm.dataset.step} done${v ? ` ${v}` : ""}`); }));
    const th = $("#thread");
    th.scrollTop = th.scrollHeight;
  },

  async issues() {
    const iss = await api("/api/issues");
    const next = { open: "triaged", triaged: "in_work", in_work: "done" };
    const card = (i) => `<li><b>${esc(i.title)}</b><div class="meta">${link(i.id)}${i.assetId ? ` · ${link(i.assetId)}` : ""}${i.projectId ? ` · <a href="#/project/${encodeURIComponent(i.projectId)}">${esc(i.projectId)}</a>` : ""}${i.procedureId ? ` · <a href="#/procedure/${encodeURIComponent(i.procedureId)}">step ${esc(i.step)}</a>` : ""} · ${esc(i.raisedBy)} · ${time(i.at)}</div>${next[i.state] ? `<div class="btns"><button class="btn" data-move="${esc(i.id)}" data-to="${next[i.state]}">Move to ${esc(next[i.state].replace("_", " "))}</button></div>` : ""}</li>`;
    view.innerHTML = `<h2>10 / what stopped the work</h2><h1>Issues</h1>
      <div class="grid board">${[["open", "Open"], ["triaged", "Triaged"], ["in_work", "In work"], ["done", "Done"]].map(([k, label]) => { const xs = iss.filter((i) => i.state === k); return `<section class="panel" aria-label="${label}"><h2>${label} · ${xs.length}</h2><ul class="list">${xs.map(card).join("") || `<li class="empty">None.</li>`}</ul></section>`; }).join("")}</div>`;
    view.querySelectorAll("[data-move]").forEach((b) => b.addEventListener("click", async () => {
      try { await api("/api/actions/update_issue", { method: "POST", body: { params: { issueId: b.dataset.move, patch: { state: b.dataset.to } } } }); toast(`${b.dataset.move} moved to ${b.dataset.to.replace("_", " ")}.`); views.issues(); } catch (e) { toast(e.message); }
    }));
  },

  async projects() {
    const ps = await api("/api/projects");
    view.innerHTML = `<h2>11 / projects and contracts</h2><h1>Projects</h1>${ps.map((p) => `<section class="panel"><div class="row"><a href="#/project/${encodeURIComponent(p.id)}"><b>${esc(p.title)}</b></a>${p.status.quiet ? pill(`quiet ${p.status.daysSinceReport} days`, "medium") : pill("reporting", "low")}</div>
      <p class="meta">${esc(p.id)} · ${esc(p.kind)} · ends ${esc(p.end)} · ${esc(p.status.milestones.claimed)} of ${esc(p.status.milestones.total)} milestones claimed, ${esc(p.status.milestones.confirmed)} confirmed · ${esc(p.status.openIssues)} open issue(s)</p></section>`).join("") || `<p class="empty">No projects are visible to you.</p>`}`;
  },

  async project(id) {
    const enc = encodeURIComponent;
    const [d, ind, snaps] = await Promise.all([api(`/api/projects/${enc(id)}`), api(`/api/projects/${enc(id)}/indicators`).catch(() => null), api(`/api/projects/${enc(id)}/snapshots`).catch(() => [])]);
    const p = d.project, st = d.status;
    const canConfirm = ["supervisor", "engineer", "manager"].includes(state.me.clearance);
    view.innerHTML = `<h2>11 / project</h2><h1>${esc(p.title)}</h1><p class="sub">${esc(p.contractorEmployer || "")} · ${esc(p.start)} to ${esc(p.end)} · last contractor report ${st.lastReportAt ? `${esc(st.daysSinceReport)} days ago` : "never"}${st.quiet ? ` ${pill("quiet", "medium")}` : ""}</p>
      ${ind ? indicatorCards(ind) : ""}
      <div class="grid console">
        <section class="panel" aria-label="Milestones"><h2>Milestones</h2><table><thead><tr><th>Milestone</th><th>Due</th><th>State</th><th></th></tr></thead><tbody>${p.milestones.map((m) => `<tr><td>${esc(m.id)} ${esc(m.title)}</td><td>${esc(m.due)}${st.overdue.includes(m.id) ? ` ${pill("overdue", "high")}` : ""}</td><td>${m.confirmedAt ? pill("confirmed", "done") : m.claimedAt ? pill("claimed", "proposed") : pill("open")}</td><td>${m.claimedAt && !m.confirmedAt && canConfirm ? `<button class="btn decide" data-confirm="${esc(m.id)}">Confirm</button>` : ""}</td></tr>`).join("")}</tbody></table>
          <p class="meta">A claim is what the contractor said in the group. A milestone is done when a supervisor confirms it.</p></section>
        <div class="grid">
          <section class="panel" aria-label="Claims"><h2>Claims from the group · ${d.claims.length}</h2><ul class="list">${d.claims.slice().reverse().map((c) => `<li><div class="row"><b>${esc(c.milestoneId || "general")}</b>${c.confirmed ? pill("confirmed", "done") : pill("claim")}</div><div>${esc(c.text)}</div><div class="meta">${esc(c.by)} · ${time(c.at)}${c.evidence.length ? ` · ${c.evidence.map(esc).join(", ")}` : ""}</div></li>`).join("") || `<li class="empty">No claims yet.</li>`}</ul></section>
          <section class="panel" aria-label="Issues"><h2>Issues · ${d.issues.length}</h2><ul class="list">${d.issues.map((i) => `<li><div class="row"><b>${esc(i.title)}</b>${pill(i.state)}</div><div class="meta">${link(i.id)}</div></li>`).join("") || `<li class="empty">None.</li>`}</ul>${d.channel ? `<div class="btns"><a class="btn" href="#/chat/${encodeURIComponent(d.channel.id)}">Open the group chat</a></div>` : ""}</section>
          <section class="panel" aria-label="Corrections"><h2>Corrections · ${(d.corrections || []).length}</h2>${correctionsHtml(d.corrections || [])}</section>
          <section class="panel" aria-label="Snapshots"><h2>Snapshots · ${snaps.length}</h2><ul class="list">${snaps.map((s) => `<li><div class="row"><b>${time(s.at)}</b><span class="meta">${esc(s.model || "no model")} · ${esc(s.minClearance)}</span></div><div class="snap">${AREAS.map(([k, name]) => `${esc(name)} <span class="sw ${esc(s.areas[k]?.status || "none")}">${esc(STATUS_WORD[s.areas[k]?.status] || "No data")}</span>`).join(" · ")}</div><div class="meta">${s.changed.length ? `Changed: ${s.changed.map((c) => `${esc((AREAS.find(([k]) => k === c.area) || [0, c.area])[1])} ${esc(c.from)} → ${esc(c.to)}`).join(", ")}` : "No change"}</div></li>`).join("") || `<li class="empty">None yet. Ask the Site Agent about this project.</li>`}</ul></section>
        </div>
      </div>`;
    view.querySelectorAll("[data-confirm]").forEach((b) => b.addEventListener("click", async () => {
      try { await api("/api/actions/confirm_milestone", { method: "POST", body: { params: { projectId: p.id, milestoneId: b.dataset.confirm } } }); toast(`${b.dataset.confirm} confirmed.`); views.project(id); } catch (e) { toast(e.message); }
    }));
  },

  async procedures() {
    const ps = await api("/api/procedures");
    view.innerHTML = `<h2>12 / digitised SOPs</h2><h1>Procedures</h1><section class="panel"><table><thead><tr><th>Procedure</th><th>Version</th><th>State</th><th>Steps</th><th>Source</th></tr></thead><tbody>${ps.map((p) => `<tr><td><a href="#/procedure/${encodeURIComponent(p.id)}">${esc(p.title)}</a></td><td>v${esc(p.version)}</td><td>${pill(p.state, p.state === "released" ? "done" : p.state === "draft" ? "proposed" : "noted")}</td><td>${esc(p.steps)}</td><td>${p.sourceRef ? `${esc(p.sourceRef.system)} rev ${esc(p.sourceRef.revision)}` : ""}${p.sourceBehind ? ` ${pill("source copy behind", "medium")}` : ""}</td></tr>`).join("")}</tbody></table></section>`;
  },

  async procedure(id) {
    const d = await api(`/api/procedures/${encodeURIComponent(id)}`);
    const p = d.procedure, perf = d.perf;
    const canEdit = state.me.clearance === "engineer" && p.state === "released";
    const canRelease = state.me.clearance === "manager" && p.state === "draft";
    const row = (s) => {
      const f = perf && perf.steps.find((x) => x.step === s.step);
      const notes = d.notes.filter((x) => x.step === s.step), issues = d.issues.filter((x) => x.step === s.step);
      return `<tr><td>${esc(s.step)}</td><td>${canEdit ? `<div class="meta">Now: ${esc(s.text)}</div><textarea rows="2" data-step="${esc(s.step)}" aria-label="Step ${esc(s.step)}, new text">${esc(s.text)}</textarea>` : esc(s.text)}${s.requires.permit ? ` ${pill("permit", "medium")}` : ""}${s.requires.reading ? ` ${pill(s.requires.reading.measure, "low")}` : ""}
        ${notes.length ? `<details><summary class="meta">${notes.length} field note(s)</summary><ul class="list">${notes.map((x) => `<li>${esc(x.text)} <span class="meta">${link(x.id)}</span></li>`).join("")}</ul></details>` : ""}</td>
        <td>${esc(s.expectedMinutes)} min</td>${perf ? `<td>${f && f.median != null ? `${num(f.median)} min${f.ratio >= 1.5 ? ` ${pill(`${f.ratio}x`, "high")}` : ""}` : "—"}</td>` : ""}<td>${notes.length} / ${issues.length}</td></tr>`;
    };
    view.innerHTML = `<h2>12 / procedure</h2><h1>${esc(p.title)} v${esc(p.version)}</h1>
      <p class="sub">${pill(p.state, p.state === "released" ? "done" : "proposed")} · from ${d.document ? link(d.document.id, d.document.title) : esc(p.documentId)}${d.document && d.document.sourceBehind ? ` ${pill("SharePoint copy behind", "medium")}` : ""} · versions: ${d.versions.map((v) => `<a href="#/procedure/${encodeURIComponent(v.id)}">v${esc(v.version)}</a> ${esc(v.state)}`).join(" · ")}</p>
      <section class="panel"><table><thead><tr><th>#</th><th>Step</th><th>Expected</th>${perf ? "<th>Median</th>" : ""}<th>Notes / issues</th></tr></thead><tbody>${p.steps.map(row).join("")}</tbody></table>
        ${canEdit ? `<label class="field">Reason for the new version<textarea id="reason" rows="2"></textarea></label><div class="btns"><button class="btn primary" id="propose">Propose the next version</button></div>` : ""}
        ${canRelease ? `<p class="meta">Proposed by ${esc(p.proposedBy)}: ${esc(p.reason)}</p><div class="btns"><button class="btn primary" id="release">Release v${esc(p.version)}</button></div>` : ""}</section>`;
    $("#propose")?.addEventListener("click", async () => {
      const reason = $("#reason").value.trim();
      if (!reason) return toast("Give a reason for the new version.");
      const steps = p.steps.map((s) => ({ text: view.querySelector(`[data-step="${s.step}"]`).value }));
      try { const r = await api("/api/actions/propose_procedure_version", { method: "POST", body: { params: { procedureId: p.id, steps, reason } } }); toast("Draft proposed. The works manager releases it."); location.hash = `#/procedure/${encodeURIComponent(r.decision.objects[0])}`; } catch (e) { toast(e.message); }
    });
    $("#release")?.addEventListener("click", async () => { try { await api("/api/actions/release_procedure", { method: "POST", body: { params: { procedureId: p.id } } }); toast("Released. The SharePoint copy is flagged as behind."); views.procedure(id); } catch (e) { toast(e.message); } });
  },

  async mywork() {
    const me = state.me;
    const [perf, notes] = await Promise.all([api(`/api/performance/person/${encodeURIComponent(me.id)}`), api("/api/objects?type=KnowledgeNote")]);
    const crew = ["supervisor", "engineer", "manager"].includes(me.clearance) ? await api("/api/performance/crew").catch(() => null) : null;
    const mine = notes.filter((n) => n.authorId === me.id);
    const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
    const bar = (s) => `<div class="bar" role="img" aria-label="Median ${esc(s.median)} minutes against ${esc(s.expected)} expected"><span class="${s.ratio >= 1.5 ? "long" : ""}" style="width:${Math.min(100, Math.round((Number(s.ratio) || 0) * 50))}%"></span></div>`;
    const done = perf.steps.filter((s) => s.median != null);
    view.innerHTML = `<h2>13 / my work</h2><h1>My work</h1><p class="sub">Your own numbers, for you first. Your supervisor and the engineers see them too. Nobody sees a ranking.</p>
      <div class="grid console">
        <section class="panel" aria-label="Time per step"><h2>Time per step against the procedure · ${esc(perf.executions)} job(s)</h2>
          ${done.length ? `<table><thead><tr><th>Step</th><th>Median</th><th>Expected</th><th><span class="sr">Against expected</span></th></tr></thead><tbody>${done.map((s) => `<tr><td><a href="#/procedure/${encodeURIComponent(s.procedureId)}">${esc(s.step)}. ${esc(s.text)}</a></td><td>${num(s.median)} min</td><td>${esc(s.expected)} min</td><td style="min-width:90px">${bar(s)}</td></tr>`).join("")}</tbody></table><p class="meta">The line marks the expected time.</p>` : `<p class="empty">No finished jobs on record yet.</p>`}</section>
        <div class="grid">
          <section class="panel" aria-label="Summary"><h2>Summary</h2><dl class="kv"><dt>Jobs</dt><dd>${esc(perf.executions)}</dd><dt>First time right</dt><dd>${pct(perf.firstTimeRight)}</dd><dt>Issues raised</dt><dd>${esc(perf.issuesRaised)}</dd><dt>Field notes</dt><dd>${esc(perf.notesContributed)}</dd></dl>
            <label class="consent"><input type="checkbox" id="consent" ${me.autoSubmit ? "checked" : ""}> Let the Scribe submit my job cards without asking</label></section>
          <section class="panel" aria-label="My field notes"><h2>My field notes · ${mine.length}</h2><ul class="list">${mine.map((n) => `<li>${esc(n.text)}<div class="meta">${link(n.id)} ${n.verified ? pill("verified", "done") : pill("unverified", "medium")}</div></li>`).join("") || `<li class="empty">None yet. Finish a job by chat and answer the last question.</li>`}</ul></section>
          ${crew ? `<section class="panel" aria-label="Crew rollup"><h2>Crew, by procedure</h2><table><thead><tr><th>Procedure</th><th>Jobs</th><th>First time right</th><th>Long steps</th></tr></thead><tbody>${crew.procedures.map((c) => `<tr><td>${esc(c.title)} v${esc(c.version)}</td><td>${esc(c.executions)}</td><td>${pct(c.firstTimeRight)}</td><td>${c.longSteps.map((s) => `step ${esc(s.step)} (${esc(s.ratio)}x)`).join(", ") || "—"}</td></tr>`).join("")}</tbody></table></section>` : ""}
        </div>
      </div>`;
    $("#consent").addEventListener("change", async (e) => {
      try { await api("/api/me/consent", { method: "PUT", body: { autoSubmit: e.target.checked } }); state.me.autoSubmit = e.target.checked; toast(e.target.checked ? "The Scribe will submit your job cards." : "The Scribe will ask before submitting."); } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
    });
  },

  // ---------- Agent Studio (agents design §6): describe, screen, read back, replay, start in shadow ----------
  async studio() {
    const [sugs, docs] = await Promise.all([api("/api/suggestions"), api("/api/intakes").catch(() => [])]);
    const ev = (id) => (/^DRV-/.test(id) ? `<span class="mono">${esc(id)}</span>` : link(id));
    view.innerHTML = `<h2>07 / agents people build</h2><h1>Agent Studio</h1>
      <p class="sub">Describe something you do by hand. The studio says whether it is a rule, an agent or a person's job, builds a statement only from what IT lets your role use, replays it on your last 14 days, and starts it in shadow, where it changes nothing until someone else promotes it.</p>
      ${state.llm ? "" : `<p class="meta" id="claude-off">Claude is off: the keyword planner builds a document digester, a watch, a weekly report, a chaser or a supplier tidy-up.</p>`}
      <section class="panel" id="suggested"><h2>Suggested for you</h2><p class="meta">Only you see these. Each comes from your own work in the last 30 days; nothing you view or search is recorded.</p>
        <ul class="list">${sugs.map((s) => `<li data-sug="${esc(s.id)}"><b>${esc(s.title)}</b><div class="meta">${esc(s.basis)} About ${esc(s.savedMinPerWeek)} min a week.</div>
          <details><summary class="meta">Evidence (${s.evidence.length})</summary><p class="meta">${s.evidence.slice(0, 40).map(ev).join(" · ")}</p></details>
          <div class="btns"><button class="btn primary" data-accept-sug="${esc(s.id)}">${s.statement ? "Accept: open in the studio" : "Accept"}</button><input aria-label="Reason (optional)" placeholder="Reason (optional)" data-dismiss-reason="${esc(s.id)}"><button class="btn" data-dismiss-sug="${esc(s.id)}">Dismiss</button></div></li>`).join("") || `<li class="empty">Nothing to suggest yet.</li>`}</ul></section>
      <section class="panel" id="studio" style="margin-top:14px">
        <h2>1 · Describe it</h2>
        <label class="field">What do you do by hand?<textarea id="st-text" rows="3" placeholder="When a supplier invoice comes into the accounts inbox, read it, check it against the PO and file it in the right supplier folder."></textarea></label>
        <div class="btns"><label class="meta">Example document <select id="st-doc"><option value="">none</option>${docs.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} · ${esc(d.verdict)}</option>`).join("")}</select></label><button class="btn primary" id="st-plan">Plan it</button></div>
        <div id="st-screen"></div><div id="st-read"></div><div id="st-replay"></div><div id="st-start"></div>
      </section>`;
    let cur = null, replayed = null;
    const studio = $("#studio");
    const locked = (s) => /once IT signs it off/.test(s);
    const showRead = () => {
      if (!cur || !cur.spec) return ($("#st-read").innerHTML = "");
      $("#st-read").innerHTML = `<h2>3 · Read back</h2><p class="meta">Edit a sentence in place and apply it: a schedule, a level, the approver, the escalation or what happens on silence. The checks decide.</p>
        <ol class="list">${cur.sentences.map((s, i) => `<li><input class="mono" style="width:100%" data-sentence="${i}" value="${esc(s)}" aria-label="Sentence ${i + 1}">${locked(s) ? ` ${pill("needs IT approval", "medium")}` : ""}</li>`).join("")}</ol>
        ${cur.problems.length ? `<ul class="list">${cur.problems.map((p) => `<li style="color:var(--amber)">${esc(p)}</li>`).join("")}</ul>` : ""}
        <div class="btns"><button class="btn" id="st-apply">Apply edits</button></div>`;
      const ex = $("#st-doc").value && docs.find((d) => d.id === $("#st-doc").value);
      $("#st-replay").innerHTML = `<h2>4 · Replay</h2>${ex ? `<p class="meta">Your example ${esc(ex.name)}: ${esc(ex.verdict)}${ex.issues.length ? ` (${esc(ex.issues.join(", "))})` : ""}.</p>` : ""}
        ${cur.spec.template === "digester" ? `<div class="btns"><button class="btn" id="st-replay-go" ${cur.problems.length ? "disabled" : ""}>Replay my last 14 days</button></div><div id="st-replay-out"></div>` : `<p class="meta">This kind of agent builds its record in shadow.</p>`}`;
      $("#st-start").innerHTML = `<h2>5 · Start in shadow</h2><p class="meta">In shadow it records what it would do and changes nothing. ${cur.spec.approver ? "Its approver promotes it once its record and IT's sign-off allow." : ""}</p>
        <div class="btns"><button class="btn primary" id="st-go" ${cur.problems.length ? "disabled" : ""}>Start in shadow</button></div>`;
    };
    const showPlan = (r) => {
      const v = r.screen.verdict;
      $("#st-screen").innerHTML = `<h2>2 · Rule, agent or person</h2><p>${pill(v, v === "person" ? "high" : v === "agent" ? "agent" : "low")} ${esc(r.screen.reason)}</p>
        ${r.screen.questions.length ? `<p class="meta">${esc(r.screen.questions[0].text)}</p><div class="btns"><button class="btn" data-judgement="yes">It takes judgement</button><button class="btn" data-judgement="no">Same check every time</button></div>` : ""}
        ${r.plan.template ? `<p class="meta">Template: ${esc(r.plan.template)} · ${esc(r.plan.spec.name)}</p>` : `<p class="meta">${esc(r.plan.reason)}</p>`}`;
      cur = r.plan.spec ? { spec: r.plan.spec, sentences: r.sentences, problems: r.problems } : null;
      replayed = null;
      showRead();
    };
    const plan = async (answers) => {
      const text = $("#st-text").value.trim();
      if (!text) return toast("Describe what you do first.");
      try { showPlan(await api("/api/studio/plan", { method: "POST", body: { text, answers } })); } catch (e) { toast(e.message); }
    };
    $("#st-plan").addEventListener("click", () => plan());
    studio.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.judgement) return plan({ judgement: b.dataset.judgement });
      if (b.id === "st-apply") {
        try {
          const r = await api("/api/studio/sentences", { method: "POST", body: { spec: cur.spec, sentences: [...studio.querySelectorAll("[data-sentence]")].map((i) => i.value) } });
          // a refused edit leaves the statement as it was, and says why
          cur = { spec: r.spec, sentences: r.sentences, problems: r.problems.length ? cur.problems : [] };
          showRead();
          if (r.problems.length) $("#st-read").insertAdjacentHTML("beforeend", `<ul class="list">${r.problems.map((p) => `<li style="color:var(--amber)">Not changed: ${esc(p)}</li>`).join("")}</ul>`);
          toast(r.problems.length ? `Not changed: ${r.problems[0]}` : "Statement updated.");
        } catch (err) { toast(err.message); }
      }
      if (b.id === "st-replay-go") {
        b.disabled = true;
        try {
          replayed = await api("/api/studio/replay", { method: "POST", body: { spec: cur.spec } });
          $("#st-replay-out").innerHTML = `<p><b>${replayed.agreed} of ${replayed.cases}</b> agree with what you did · ${replayed.unsure} unsure · ${replayed.caught} caught (duplicates and bank changes) · ${replayed.differed} differ</p>
            <table class="cells"><thead><tr><th>Document</th><th>Outcome</th><th>It would</th><th>You did</th><th>Why</th></tr></thead><tbody>${replayed.examples.map((x) => `<tr class="${x.outcome === "unsure" ? "amb" : ""}"><td class="mono">${esc(x.name)}</td><td>${pill(x.outcome, x.outcome === "agreed" ? "done" : x.outcome === "caught" ? "agent" : "medium")}</td><td class="meta">${esc(x.path || x.verdict)}</td><td class="meta">${esc(x.personPath || "not filed")}</td><td class="meta">${esc(x.reason || "")}</td></tr>`).join("")}</tbody></table>`;
        } catch (err) { toast(err.message); } finally { b.disabled = false; }
      }
      if (b.id === "st-go") {
        b.disabled = true;
        try { await api("/api/actions/create_studio_agent", { method: "POST", body: { params: { spec: cur.spec } } }); toast(`${cur.spec.name} started in shadow.`); location.hash = "#/agents"; } catch (err) { toast(err.message); b.disabled = false; }
      }
    });
    $("#suggested").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-accept-sug],[data-dismiss-sug]");
      if (!b) return;
      const id = b.dataset.acceptSug || b.dataset.dismissSug, s = sugs.find((x) => x.id === id);
      try {
        if (b.dataset.dismissSug) {
          const reason = $("#suggested").querySelector(`[data-dismiss-reason="${CSS.escape(id)}"]`).value.trim();
          await api("/api/actions/dismiss_suggestion", { method: "POST", body: { params: { suggestionId: id, ...(reason ? { reason } : {}) } } });
          toast("Dismissed. It will not come back for 30 days.");
          return views.studio();
        }
        await api("/api/actions/accept_suggestion", { method: "POST", body: { params: { suggestionId: id } } });
        $("#suggested").querySelector(`[data-sug="${CSS.escape(id)}"]`).remove();
        if (!s.statement) return toast("Noted.");
        const r = await api("/api/studio/sentences", { method: "POST", body: { spec: s.statement, sentences: [] } });
        $("#st-text").value = s.title;
        showPlan({ screen: { verdict: "agent", reason: "From your suggestion.", questions: [] }, plan: { template: r.spec.template, spec: r.spec }, sentences: r.sentences, problems: r.problems });
        studio.scrollIntoView({ behavior: "smooth" });
      } catch (err) { toast(err.message); }
    });
  },

  // ---------- IT's connector catalogue (agents design §7) ----------
  async catalogue() {
    const cat = await api("/api/catalogue"), lvls = ["read", "draft", "notify", "propose", "act"];
    view.innerHTML = `<h2>08 / what agents may touch</h2><h1>IT catalogue</h1>
      <p class="sub">${cat.canEdit ? "You are an IT administrator: you set which roles may use each connector, the most an agent may do with it, and sign lines off for a role." : "Read only: IT administrators change the catalogue."} A studio agent never does more than its builder's role allows here.</p>
      ${cat.connectors.map((c) => `<section class="panel" style="margin-bottom:12px"><h2>${esc(c.kind)}</h2><table><thead><tr><th>Operation</th><th>Action</th><th>Roles</th><th>Most an agent may do</th><th>IT sign-off</th></tr></thead><tbody>
        ${c.lines.map((l) => `<tr><td class="mono">${esc(l.op)}</td><td class="mono">${esc(l.action || "—")}</td>
          <td>${cat.canEdit ? `<input class="mono" data-roles="${esc(c.kind)}|${esc(l.op)}" value="${esc(l.roles.join(", "))}" aria-label="Roles for ${esc(c.kind)} ${esc(l.op)}">` : esc(l.roles.join(", "))}</td>
          <td>${cat.canEdit ? `<select data-max="${esc(c.kind)}|${esc(l.op)}">${lvls.map((x) => `<option ${x === l.maxLevel ? "selected" : ""}>${x}</option>`).join("")}</select>` : esc(l.maxLevel)}</td>
          <td>${l.itSignOff ? l.roles.filter((r) => r !== "*").map((r) => (l.signedOff || {})[r] ? `<div class="meta">${esc(r)}: signed off by ${esc(l.signedOff[r].by)} ${time(l.signedOff[r].at)}</div>` : cat.canEdit ? `<button class="btn" data-signoff="${esc(c.kind)}|${esc(l.op)}|${esc(r)}">Sign off for ${esc(r)}</button>` : `<div class="meta">${esc(r)}: ${pill("needs IT approval", "medium")}</div>`).join("") : `<span class="meta">not needed</span>`}</td></tr>`).join("")}
      </tbody></table>${cat.canEdit ? `<div class="btns"><button class="btn" data-save-con="${esc(c.kind)}">Save ${esc(c.kind)}</button></div>` : ""}</section>`).join("")}`;
    view.querySelectorAll("[data-signoff]").forEach((b) => b.addEventListener("click", async () => {
      const [kind, op, role] = b.dataset.signoff.split("|");
      try { await api("/api/actions/sign_off_catalogue_line", { method: "POST", body: { params: { kind, op, role } } }); toast(`${kind} ${op} signed off for ${role}.`); views.catalogue(); } catch (e) { toast(e.message); }
    }));
    view.querySelectorAll("[data-save-con]").forEach((b) => b.addEventListener("click", async () => {
      const kind = b.dataset.saveCon, con = cat.connectors.find((c) => c.kind === kind);
      try {
        for (const l of con.lines) {
          const roles = view.querySelector(`[data-roles="${CSS.escape(`${kind}|${l.op}`)}"]`).value.split(",").map((x) => x.trim()).filter(Boolean);
          const maxLevel = view.querySelector(`[data-max="${CSS.escape(`${kind}|${l.op}`)}"]`).value;
          if (roles.join() !== l.roles.join() || maxLevel !== l.maxLevel) await api("/api/actions/set_catalogue_line", { method: "POST", body: { params: { kind, op: l.op, patch: { roles, maxLevel } } } });
        }
        toast(`${kind} saved.`);
        views.catalogue();
      } catch (e) { toast(e.message); }
    }));
  },

  // ---------- Documents: the page beside its graded cells (agents design §8) ----------
  async intakes(id) {
    if (!id) {
      const ds = await api("/api/intakes");
      view.innerHTML = `<h2>09 / documents the digester read</h2><h1>Documents</h1><p class="sub">Only the agent's builder and its approver see these. Unsure fields are reviewed beside the document.</p>
        <section class="panel"><table><thead><tr><th>Document</th><th>Supplier</th><th>Total</th><th>Verdict</th><th>Issues</th><th>Received</th></tr></thead><tbody>${ds.map((d) => `<tr><td><a href="#/intakes/${encodeURIComponent(d.id)}"><b>${esc(d.name)}</b></a></td><td>${esc(d.supplier || "unreadable")}</td><td class="val">${d.total == null ? "?" : num(d.total)}</td><td>${pill(d.verdict, d.verdict === "file" ? "done" : d.verdict === "person" ? "high" : "medium")} <span class="meta">${esc(d.state)}</span></td><td class="meta">${esc(d.issues.join(", "))}</td><td class="meta">${time(d.receivedAt)}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No documents yet.</td></tr>`}</tbody></table></section>`;
      return;
    }
    const d = await api(`/api/intakes/${encodeURIComponent(id)}`), open = d.state === "digested";
    const order = { AMBIGUOUS: 0, INFERRED: 1, EXTRACTED: 2 };
    // lines and bank details read as they do on the document, not as JSON
    const val = (v) => (v == null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.map((l) => `${l.qty} × ${l.desc} @ ${l.price}`).join("; ") : v.account ? `${v.account} / ${v.branch}` : JSON.stringify(v));
    const page = d.preview.textLayer ? esc(d.preview.textLayer).replace(/\?+(\.\?+)?/g, (m) => `<mark>${m}</mark>`) : `<span class="meta">No text layer: this image could not be read${state.llm ? "" : " while Claude is off"}.</span>`;
    view.innerHTML = `<div id="intake"><div class="row"><div><h2>09 / ${esc(d.id)} · ${esc(d.state)}</h2><h1>${esc(d.preview.name)}</h1></div><div class="btns"><a class="btn" href="#/intakes">All documents</a></div></div>
      <p class="sub">${pill(d.verdict, d.verdict === "file" ? "done" : d.verdict === "person" ? "high" : "medium")} ${d.match.issues.map((i) => esc(i.detail)).join(" · ") || "Matches its PO and goods receipt."} ${d.verdict === "file" ? `Files to <span class="mono">${esc(d.destination.path)}</span>.` : ""}</p>
      <div class="grid console intake-grid"><section class="panel"><h2>The document · ${esc(d.preview.quality || "")}</h2><pre class="docpage">${page}</pre></section>
      <section class="panel"><h2>Fields</h2><table class="cells"><thead><tr><th>Field</th><th>Grade</th><th>Value</th><th>Reasoning</th><th></th></tr></thead><tbody>
        ${[...d.cells].sort((a, b) => order[a.grade] - order[b.grade]).map((c) => `<tr class="${c.grade === "AMBIGUOUS" ? "amb" : c.grade === "INFERRED" ? "inf" : ""}"><td class="mono">${esc(c.key)}</td><td>${pill(c.grade, c.grade === "AMBIGUOUS" ? "medium" : c.grade === "INFERRED" ? "agent" : "low")}</td><td class="mono cv">${esc(val(c.value)).slice(0, 120)}</td><td class="why meta">${esc(c.reasoning)}</td>
          <td>${c.reviewed ? `<span class="meta">${esc(c.reviewed.by)} ${time(c.reviewed.at)}</span>` : open && c.grade !== "EXTRACTED" ? `<div class="btns"><button class="btn" data-ok="${esc(c.key)}">Accept</button><button class="btn" data-fix="${esc(c.key)}">Correct</button></div>` : ""}</td></tr>`).join("")}
      </tbody></table></section></div></div>`;
    const review = async (mark) => { try { await api("/api/actions/review_intake_cells", { method: "POST", body: { params: { intakeId: id, marks: [mark] } } }); views.intakes(id); } catch (e) { toast(e.message); } };
    $("#intake").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.ok) return review({ key: b.dataset.ok, verdict: "accept" });
      if (b.dataset.save) { const raw = b.closest("td").querySelector("input").value; let v = raw; try { v = JSON.parse(raw); } catch {} return review({ key: b.dataset.save, verdict: "correct", value: v }); }
      if (b.dataset.fix) {
        const c = d.cells.find((x) => x.key === b.dataset.fix), td = b.closest("tr").querySelector(".cv");
        td.innerHTML = `<input aria-label="Corrected value for ${esc(c.key)}" value="${esc(val(c.value))}"><button class="btn primary" style="margin-top:4px" data-save="${esc(c.key)}">Save</button>`;
        td.querySelector("input").focus();
      }
    });
  },

  async audit() {
    const a = await api("/api/audit");
    view.innerHTML = `<h2>10 / every action, chained</h2><h1>Audit log</h1><p class="sub">Hash chain ${a.verified ? pill("verified", "done") : pill("broken", "gap")}</p>
      <section class="panel" style="overflow-x:auto"><table><thead><tr><th>#</th><th>Actor</th><th>Action</th><th>Outcome</th><th>Ref</th><th>Hash</th></tr></thead><tbody>${a.entries.map((e) => `<tr><td class="val">${e.seq}</td><td>${esc(e.actor)} <span class="meta">${esc(e.actorKind || "")}</span></td><td class="mono">${esc(e.action)}</td><td>${pill(e.outcome || "done")}${e.reason ? `<div class="meta">${esc(e.reason)}</div>` : ""}</td><td>${e.ref ? link(e.ref) : ""}</td><td class="meta">${esc(e.hash)}</td></tr>`).join("")}</tbody></table></section>`;
  }
};

// ---------- router, shell, live events ----------
async function route() {
  const [, name = "console", arg] = location.hash.match(/^#\/([^/]+)\/?(.*)$/) || [];
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name || a.dataset.nav === `${name}s` || (name === "plantmodels" && a.dataset.nav === "plant") || (name === "run" && a.dataset.nav === "agents")));
  if (name !== "asset") { state.twin?.dispose(); state.twin = null; state.copilot = null; }
  if (name !== "plant") { state.plant?.dispose(); state.plant = null; }
  if (name !== "region") { state.region?.dispose(); state.region = null; state.regionRefresh = null; }
  const fn = views[name];
  if (!fn) { view.innerHTML = `<h1>Not found</h1>`; return; }
  try { await fn(arg ? decodeURIComponent(arg) : undefined); } catch (e) { view.innerHTML = `<h1>${e.status === 404 ? "Not found, or not visible to you" : "Something went wrong"}</h1><p class="sub">${esc(e.message)}</p>`; }
  view.focus({ preventScroll: true });
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-run]");
  if (!b) return;
  b.disabled = true;
  try { const r = await api(`/api/agents/${encodeURIComponent(b.dataset.run)}/run`, { method: "POST", body: {} }); toast(`${r.agent}: ${r.status}, ${r.outputs.length} output(s).`); route(); } catch (err) { toast(err.message); } finally { b.disabled = false; }
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-rca]");
  if (!b) return;
  b.disabled = true;
  try { const d = await api("/api/rca", { method: "POST", body: { targetId: b.dataset.rca } }); location.hash = `#/rca/${encodeURIComponent(d.id)}`; } catch (err) { toast(err.message); b.disabled = false; }
});
$("#cmd").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#cmd-input").value.trim();
  if (!q) return;
  const run = q.match(/^run\s+(.+)$/i);
  if (run) { try { const r = await api(`/api/agents/${encodeURIComponent(run[1])}/run`, { method: "POST", body: {} }); location.hash = `#/run/${r.id}`; } catch (err) { toast(err.message); } return; }
  if (q.includes("?")) { const r = await api(`/api/agents/Ask/run`, { method: "POST", body: { mission: q } }); toast((r.outputs[0] && r.outputs[0].text) || "No answer."); return; }
  location.hash = `#/search/${encodeURIComponent(q)}`;
});
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#cmd-input").focus(); } });

async function boot() {
  const people = await fetch("/api/people", { headers: { "x-acting-user": "P-001" } }).then((r) => r.json());
  const sel = $("#role");
  sel.innerHTML = people.map((p) => `<option value="${esc(p.id)}" ${p.id === state.user ? "selected" : ""}>${esc(p.id)} · ${esc(p.role.replace(/_/g, " "))} (${esc(p.clearance)})</option>`).join("");
  sel.addEventListener("change", () => { state.user = sel.value; store.set("wwos.user", sel.value); connect(); loadMe().then(route); });
  await loadMe();
  connect();
  window.addEventListener("hashchange", route);
  route();
}
async function loadMe() {
  try { state.me = await api("/api/me"); } catch { state.user = "P-001"; state.me = await api("/api/me"); }
  const c = await api("/api/console");
  $("#clock").textContent = new Date(c.clock).toISOString().slice(0, 16).replace("T", " ") + " plant";
  const chip = $("#llm-chip");
  chip.textContent = c.llm ? "Claude on" : "deterministic agents";
  chip.classList.toggle("on", c.llm);
  state.llm = !!c.llm;
  $("#prop-count").textContent = c.proposals.length || "";
}
let es, pending;
function connect() {
  es?.close();
  es = new EventSource(`/api/events?as=${encodeURIComponent(state.user)}`);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.kind === "clock") $("#clock").textContent = e.clock.slice(0, 16).replace("T", " ") + " plant";
    clearTimeout(pending);
    // refresh live views only; forms on other views are left alone
    pending = setTimeout(async () => {
      const [, name = "console", arg] = location.hash.match(/^#\/([^/]+)\/?(.*)$/) || [];
      const live = e.kind === "clock" ? ["console", "map"] : ["console", "map", "chat", "issues"];
      const typing = document.activeElement.closest?.("form") || $("#say")?.value || $("#stepval")?.value;
      if (live.includes(name) && !typing) views[name](arg ? decodeURIComponent(arg) : undefined);
      if (name === "plant" && state.plant) views.refreshPlant().catch(() => {});
      if (name === "region" && state.region) views.refreshRegion().catch(() => {});
      try { const c = await api("/api/proposals?state=open"); $("#prop-count").textContent = c.length || ""; } catch {}
    }, 1500);
  };
}
boot();
