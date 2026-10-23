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
  return `<svg viewBox="-10 -10 760 200" role="img" aria-label="Site map of ${esc(m.site.name)}">${zones}${permits}</svg>`;
}
function bindMap(root) {
  root.querySelectorAll("[data-href]").forEach((g) => {
    g.addEventListener("click", () => (location.hash = g.dataset.href));
    g.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = g.dataset.href; });
  });
}

// ---------- views ----------
const views = {
  async console() {
    const [c, m] = await Promise.all([api("/api/console"), api("/api/map")]);
    const train = c.train.map((s) => `<div class="stage"><h3>${esc(s.name)}</h3>
      ${s.alerts ? `<span class="badge">${pill(s.alerts + " alert" + (s.alerts > 1 ? "s" : ""), "high")}</span>` : ""}
      ${s.values.slice(0, 2).map((v) => `<span class="v ${isAlarm(v) ? "alarm" : ""}">${num(v.value)} ${esc(v.unit)}</span><span class="meta">${esc(v.name)}</span>`).join("") || `<span class="meta">${s.assets.map((a) => esc(a.tag) + " " + esc(a.state)).join(" · ") || "—"}</span>`}</div>`).join("");
    const people = Object.entries(c.people).sort((a, b) => b[1].count - a[1].count).map(([z, p]) => `<li class="row"><span>${esc(z)} ${esc(m.zones.find((x) => x.id === z)?.name || "")}</span><span class="val">${p.count}</span></li>`).join("");
    const handover = c.drafts.find((d) => d.kind === "handover");
    view.innerHTML = `
      <div class="row"><div><h2>01 / the works now</h2><h1>Riverbend works console</h1></div><span class="meta">demonstrable · synthetic data</span></div>
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

  async assets() {
    const assets = await api("/api/objects?type=Asset");
    const rows = assets.sort((a, b) => String(a.positionTag).localeCompare(String(b.positionTag))).map((a) => `<tr><td><a href="#/asset/${encodeURIComponent(a.id)}"><b>${esc(a.positionTag || a.name)}</b></a></td><td>${esc(a.name)}</td><td>${esc(a.assetClass)}</td><td>${pill(a.state)}</td><td>${a.hero ? pill("3D model", "agent") : ""}</td><td class="meta">${esc(a.zoneId)}</td></tr>`).join("");
    view.innerHTML = `<h2>03 / every machine, ontologised</h2><h1>Assets and twin</h1><p class="sub">Hero assets open in the Asset Workbench with a 3D breakdown and the Technician Copilot.</p>
      <section class="panel"><table><thead><tr><th>Tag</th><th>Name</th><th>Class</th><th>State</th><th>Model</th><th>Zone</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  },

  async asset(id) {
    const m = await api(`/api/assets/${encodeURIComponent(id)}/model`);
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
          <section class="panel"><div class="tabs" role="tablist"><button class="on" data-tab="part" role="tab">Part</button><button data-tab="tel" role="tab">Telemetry</button><button data-tab="proc" role="tab">Procedure</button></div><div id="tab"></div></section>
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
      proc: () => `<ol style="padding-left:18px;margin:0">${m.procedure.map((s) => `<li style="margin-bottom:6px">${esc(s.text)} ${s.intrusive ? pill("permit + isolation", "medium") : ""}</li>`).join("")}</ol>`
    };
    let tab = "part";
    const drawTab = async () => {
      $("#tab").innerHTML = tabs[tab]();
      if (tab === "tel") for (const el of view.querySelectorAll("[data-spark]")) { const t = await api(`/api/telemetry/${encodeURIComponent(el.dataset.spark)}?n=1440`); el.innerHTML = spark(t.values.filter((_, i) => i % 10 === 0), isAlarm(m.sensors.find((s) => s.id === el.dataset.spark))); }
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
      <section class="panel" style="margin-top:14px"><h2>Recent runs</h2><table><thead><tr><th>Run</th><th>Agent</th><th>Trigger</th><th>Status</th><th>Read</th><th>Calls</th><th>Outputs</th></tr></thead><tbody>${runs.slice(0, 40).map((r) => `<tr><td><a href="#/run/${r.id}">${r.id}</a></td><td>${esc(r.agent)}</td><td class="meta">${esc(r.trigger.kind)}</td><td>${pill(r.status)}</td><td class="val">${r.read.length}</td><td class="val">${r.calls.length}</td><td class="val">${r.outputs.length}</td></tr>`).join("")}</tbody></table></section>`;
    view.querySelectorAll("select[data-agent]").forEach((s) => s.addEventListener("change", async () => {
      try { await api(`/api/agents/${encodeURIComponent(s.dataset.agent)}/autonomy`, { method: "PUT", body: { action: s.dataset.action, level: s.value } }); toast(`${s.dataset.agent}: ${s.dataset.action} set to ${s.value}.`); } catch (e) { toast(e.message); }
    }));
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

  async proposals() {
    const ps = await api("/api/proposals");
    const open = ps.filter((p) => p.state === "open"), done = ps.filter((p) => p.state !== "open");
    view.innerHTML = `<h2>06 / agents propose, people decide</h2><h1>Proposals</h1>
      ${open.map((p) => `<section class="panel" style="margin-bottom:12px"><div class="row"><b>${esc(p.action)}</b><span class="meta">${esc(p.id)} · ${esc(p.actorId)}${p.runId ? ` · <a href="#/run/${esc(p.runId)}">${esc(p.runId)}</a>` : ""}</span></div>
        <pre>${esc(JSON.stringify(p.params, null, 2))}</pre>${p.evidence?.length ? `<p class="meta">Evidence: ${p.evidence.map((e) => esc(typeof e === "string" ? e : JSON.stringify(e))).join(" · ")}</p>` : ""}
        <label class="field">Reason (needed to edit or reject)<textarea rows="2" data-reason="${esc(p.id)}"></textarea></label>
        <label class="field">Edited parameters (JSON, for Edit and approve)<textarea rows="2" data-params="${esc(p.id)}">${esc(JSON.stringify(p.params))}</textarea></label>
        <div class="btns"><button class="btn decide" data-verdict="approve" data-id="${esc(p.id)}">Approve</button><button class="btn decide" data-verdict="edit" data-id="${esc(p.id)}">Edit and approve</button><button class="btn decide" data-verdict="reject" data-id="${esc(p.id)}">Reject</button></div></section>`).join("") || `<p class="empty">Nothing is waiting for you.</p>`}
      <section class="panel"><h2>Resolved</h2><table><thead><tr><th>Proposal</th><th>Action</th><th>By agent</th><th>State</th><th>Resolved by</th></tr></thead><tbody>${done.map((p) => `<tr><td>${link(p.id)}</td><td>${esc(p.action)}</td><td>${esc(p.actorId)}</td><td>${pill(p.state)}</td><td>${esc(p.resolvedBy)}</td></tr>`).join("")}</tbody></table></section>`;
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
    const props = Object.entries(ob).filter(([k]) => !["prov", "geom", "explode"].includes(k)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("");
    view.innerHTML = `<h2>${esc(ob.type)}</h2><h1>${esc(ob.name || ob.title || ob.id)}</h1>${ob.type === "Asset" && ob.template ? `<p><a class="btn primary" href="#/asset/${encodeURIComponent(ob.id)}">Open in the Asset Workbench</a></p>` : ""}
      <div class="grid console"><section class="panel"><h2>Properties</h2><dl class="kv">${props}</dl><h2 style="margin-top:12px">Provenance</h2><dl class="kv">${Object.entries(ob.prov || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></section>
      <div class="grid"><section class="panel"><h2>Links · ${o.links.length}</h2><ul class="list">${o.links.map((l) => `<li>${l.dir === "out" ? "→" : "←"} <span class="mono">${esc(l.rel)}</span> ${l.other ? link(l.other.id, `${l.other.type} ${l.other.name}`) : ""}</li>`).join("") || `<li class="empty">None visible.</li>`}</ul></section>
      ${o.sensors.length ? `<section class="panel"><h2>Live values</h2><ul class="list">${o.sensors.map((s) => `<li class="row"><span>${esc(s.name)}</span><span class="val" style="color:${isAlarm(s) ? "var(--red)" : "inherit"}">${num(s.value)} ${esc(s.unit)}</span></li>`).join("")}</ul></section>` : ""}
      ${o.runs.length ? `<section class="panel"><h2>Agents that read this</h2><ul class="list">${o.runs.map((r) => `<li><a href="#/run/${r.id}">${esc(r.agent)}</a> <span class="meta">${time(r.plantTime)}</span></li>`).join("")}</ul></section>` : ""}
      ${o.related.decisions.length ? `<section class="panel"><h2>Decisions</h2><ul class="list">${o.related.decisions.map((d) => `<li class="row"><span>${esc(d.action)} by ${esc(d.actorId)}${d.approvedBy ? ` · approved by ${esc(d.approvedBy)}` : ""}</span>${d.reversed ? pill("reversed", "rejected") : d.reversible ? `<button class="btn" data-reverse="${esc(d.id)}">Reverse</button>` : ""}</li>`).join("")}</ul></section>` : ""}
      </div></div>`;
    view.querySelectorAll("[data-reverse]").forEach((b) => b.addEventListener("click", async () => { try { await api(`/api/decisions/${encodeURIComponent(b.dataset.reverse)}/reverse`, { method: "POST" }); toast("Reversed."); views.object(id); } catch (e) { toast(e.message); } }));
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
    const d = await api(`/api/projects/${encodeURIComponent(id)}`);
    const p = d.project, st = d.status;
    const canConfirm = ["supervisor", "engineer", "manager"].includes(state.me.clearance);
    view.innerHTML = `<h2>11 / project</h2><h1>${esc(p.title)}</h1><p class="sub">${esc(p.contractorEmployer || "")} · ${esc(p.start)} to ${esc(p.end)} · last contractor report ${st.lastReportAt ? `${esc(st.daysSinceReport)} days ago` : "never"}${st.quiet ? ` ${pill("quiet", "medium")}` : ""}</p>
      <div class="grid console">
        <section class="panel" aria-label="Milestones"><h2>Milestones</h2><table><thead><tr><th>Milestone</th><th>Due</th><th>State</th><th></th></tr></thead><tbody>${p.milestones.map((m) => `<tr><td>${esc(m.id)} ${esc(m.title)}</td><td>${esc(m.due)}${st.overdue.includes(m.id) ? ` ${pill("overdue", "high")}` : ""}</td><td>${m.confirmedAt ? pill("confirmed", "done") : m.claimedAt ? pill("claimed", "proposed") : pill("open")}</td><td>${m.claimedAt && !m.confirmedAt && canConfirm ? `<button class="btn decide" data-confirm="${esc(m.id)}">Confirm</button>` : ""}</td></tr>`).join("")}</tbody></table>
          <p class="meta">A claim is what the contractor said in the group. A milestone is done when a supervisor confirms it.</p></section>
        <div class="grid">
          <section class="panel" aria-label="Claims"><h2>Claims from the group · ${d.claims.length}</h2><ul class="list">${d.claims.slice().reverse().map((c) => `<li><div class="row"><b>${esc(c.milestoneId || "general")}</b>${c.confirmed ? pill("confirmed", "done") : pill("claim")}</div><div>${esc(c.text)}</div><div class="meta">${esc(c.by)} · ${time(c.at)}${c.evidence.length ? ` · ${c.evidence.map(esc).join(", ")}` : ""}</div></li>`).join("") || `<li class="empty">No claims yet.</li>`}</ul></section>
          <section class="panel" aria-label="Issues"><h2>Issues · ${d.issues.length}</h2><ul class="list">${d.issues.map((i) => `<li><div class="row"><b>${esc(i.title)}</b>${pill(i.state)}</div><div class="meta">${link(i.id)}</div></li>`).join("") || `<li class="empty">None.</li>`}</ul>${d.channel ? `<div class="btns"><a class="btn" href="#/chat/${encodeURIComponent(d.channel.id)}">Open the group chat</a></div>` : ""}</section>
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

  async audit() {
    const a = await api("/api/audit");
    view.innerHTML = `<h2>10 / every action, chained</h2><h1>Audit log</h1><p class="sub">Hash chain ${a.verified ? pill("verified", "done") : pill("broken", "gap")}</p>
      <section class="panel" style="overflow-x:auto"><table><thead><tr><th>#</th><th>Actor</th><th>Action</th><th>Outcome</th><th>Ref</th><th>Hash</th></tr></thead><tbody>${a.entries.map((e) => `<tr><td class="val">${e.seq}</td><td>${esc(e.actor)} <span class="meta">${esc(e.actorKind || "")}</span></td><td class="mono">${esc(e.action)}</td><td>${pill(e.outcome || "done")}${e.reason ? `<div class="meta">${esc(e.reason)}</div>` : ""}</td><td>${e.ref ? link(e.ref) : ""}</td><td class="meta">${esc(e.hash)}</td></tr>`).join("")}</tbody></table></section>`;
  }
};

// ---------- router, shell, live events ----------
async function route() {
  const [, name = "console", arg] = location.hash.match(/^#\/([^/]+)\/?(.*)$/) || [];
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === name || a.dataset.nav === `${name}s` || (name === "run" && a.dataset.nav === "agents")));
  if (name !== "asset") { state.twin?.dispose(); state.twin = null; state.copilot = null; }
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
      try { const c = await api("/api/proposals?state=open"); $("#prop-count").textContent = c.length || ""; } catch {}
    }, 1500);
  };
}
boot();
