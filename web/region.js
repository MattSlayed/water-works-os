// The Region map (Region design §6): Leaflet over OpenStreetMap tiles, with every layer drawn from /api/region.
// Synthetic works: the geography, tags and scenes are synthetic. Without tiles the layers draw on a plain background.
import * as L from "leaflet";

const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#60a5fa";
const BAND = { normal: "--green", raised: "--amber", high: "--red", unknown: "--dim" };
const MAX_LABELS = 12, CLUSTER_BELOW = 14, ENTER_AT = 16;
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function mountRegion(el, data, { onSelect = () => {}, onEnterPlant = () => {}, onView = () => {}, start = {} } = {}) {
  el.innerHTML = `<div class="rmap-canvas"></div><div class="disclose badge">synthetic works · indices are not calibrated</div><div class="rmap-note" hidden>basemap offline</div><div class="rmap-grid" hidden></div><button class="btn primary rmap-enter" hidden>Enter plant</button>`;
  const box = el.querySelector(".rmap-canvas"), note = el.querySelector(".rmap-note"), enter = el.querySelector(".rmap-enter"), gridNote = el.querySelector(".rmap-grid");
  // a tag's age against the plant clock: a stale ping is never shown as live
  const ago = (iso) => { const m = Math.max(0, Math.round((Date.parse(data.clock) - Date.parse(iso)) / 60000)); return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
  const map = L.map(box, { preferCanvas: true, zoomSnap: 0.5, attributionControl: true });
  const works = L.latLng(data.works.centre[1], data.works.centre[0]);
  map.setView(start.center ? L.latLng(start.center[0], start.center[1]) : works, start.zoom || 12.5);
  const R = { offline: false, features: 0, labels: 0 };
  window.__region = R;

  // basemap: tiles in the browser only; a tile error, no tile in 4 s, or an offline browser switches to a plain background
  const tiles = L.tileLayer(OSM, { maxZoom: 19, attribution: "© OpenStreetMap contributors" });
  let loaded = false;
  const offline = () => { if (R.offline) return; R.offline = true; map.removeLayer(tiles); el.classList.add("plain"); note.hidden = false; };
  tiles.on("tileload", () => { loaded = true; });
  tiles.on("tileerror", () => { if (!loaded) offline(); });
  if (navigator.onLine === false) offline(); else tiles.addTo(map);
  const watchdog = setTimeout(() => { if (!loaded) offline(); }, 4000);

  const groups = {
    region: L.layerGroup(), projects: L.layerGroup(), grid: L.layerGroup(), detections: L.layerGroup(), plant: L.layerGroup(), trackers: L.layerGroup(), people: L.layerGroup(), alerts: L.layerGroup(), focus: L.layerGroup()
  };
  const on = { region: true, projects: true, grid: false, detections: true, plant: true, trackers: true, people: false, alerts: true, ...(start.layers || {}) };
  const filters = { kinds: new Set(["pump_station", "reservoir", "valve_chamber", "vehicle", "portable", "contractor"]), alarmOnly: false, staleOnly: false };
  const byId = new Map(); // object id -> leaflet layers, for focus
  let focusSet = null, labelled = new Set();

  const fade = (id) => focusSet && !focusSet.has(id);
  const reg = (id, layer) => { (byId.get(id) || byId.set(id, []).get(id)).push(layer); R.features++; return layer; };
  const tip = (layer, text, id) => layer.bindTooltip(esc(text), { direction: "top", offset: [0, -6], permanent: labelled.has(id), className: "rlabel" });

  function draw() {
    for (const [k, g] of Object.entries(groups)) if (k !== "grid") g.clearLayers(); // the scene grid is set by setGrid only
    byId.clear();
    R.features = 0;
    const style = (id, base) => ({ ...base, opacity: fade(id) ? 0.25 : base.opacity ?? 1, fillOpacity: fade(id) ? 0.05 : base.fillOpacity ?? 0.2 });
    for (const r of data.region) {
      const g = r.geometry, isAoi = r.kind === "aoi";
      if (isAoi) continue;
      const colour = r.kind === "waterbody" ? css("--teal") : r.kind === "catchment" ? css("--dim") : r.kind === "road" ? css("--muted") : r.kind === "river" ? css("--teal") : css("--violet");
      const ll = (c) => [c[1], c[0]];
      const layer = g.type === "Polygon" ? L.polygon(g.coordinates[0].map(ll), style(r.id, { color: colour, weight: r.kind === "catchment" ? 1 : 2, dashArray: r.kind === "catchment" ? "4 4" : null, fillOpacity: r.kind === "waterbody" ? 0.25 : 0.03 }))
        : g.type === "MultiLineString" ? L.polyline(g.coordinates.map((part) => part.map(ll)), style(r.id, { color: colour, weight: r.kind === "road" ? 1.5 : 3, dashArray: r.kind === "road" ? "2 4" : null }))
        : g.type === "Point" ? L.circleMarker(ll(g.coordinates), style(r.id, { radius: 6, color: colour, fillOpacity: 0.8 })) : null;
      if (!layer) continue;
      tip(layer, r.name, r.id);
      layer.on("click", () => onSelect({ kind: "region", id: r.id }));
      groups.region.addLayer(reg(r.id, layer));
    }
    // project footprints: faint dashed outlines, brought forward in focus
    for (const p of data.projects) {
      if (!p.footprint) continue;
      const f = L.polygon(p.footprint.coordinates[0].map((c) => [c[1], c[0]]), style(p.id, { color: css("--violet"), weight: focusSet && focusSet.has(p.id) ? 2.5 : 1.2, dashArray: "5 4", fillOpacity: focusSet && focusSet.has(p.id) ? 0.15 : 0.04 }));
      tip(f, p.title, p.id);
      f.on("click", () => onSelect({ kind: "project", id: p.id }));
      groups.projects.addLayer(reg(p.id, f));
    }
    // the works as one object until Enter plant
    const w = L.circleMarker(works, style("SITE-RB", { radius: 9, color: css("--teal"), weight: 2, fillOpacity: 0.5 }));
    tip(w, `${data.works.name} (synthetic works)`, "SITE-RB");
    w.on("click", () => onSelect({ kind: "works", id: "SITE-RB" }));
    groups.plant.addLayer(reg("SITE-RB", w));
    for (const s of data.sites) {
      if (!filters.kinds.has(s.kind)) continue;
      const alarm = s.readings.some((x) => (x.alarmHi != null && x.value > x.alarmHi) || (x.alarmLo != null && x.value < x.alarmLo));
      if (filters.alarmOnly && !alarm) continue;
      const m = L.circleMarker([s.lat, s.lon], style(s.id, { radius: s.kind === "valve_chamber" ? 4 : 6, color: alarm ? css("--red") : css("--green"), fillOpacity: 0.85 }));
      tip(m, s.name, s.id);
      m.on("click", () => onSelect({ kind: "site", id: s.id }));
      groups.plant.addLayer(reg(s.id, m));
    }
    for (const d of data.detections) {
      const aoi = data.region.find((r) => r.id === d.aoiId);
      if (!aoi) continue;
      const colour = d.status === "confirmed" ? css("--red") : d.status === "rejected" ? css("--dim") : css("--amber");
      const p = L.polygon(aoi.geometry.coordinates[0].map((c) => [c[1], c[0]]), style(d.id, { color: colour, weight: 2, dashArray: d.status === "suggested" ? "6 4" : null, fillOpacity: 0.12 }));
      tip(p, `${d.kind} · ${d.status} · ${d.index.toUpperCase()} z ${d.z} (index, not calibrated)`, d.id);
      p.on("click", () => onSelect({ kind: "detection", id: d.id }));
      groups.detections.addLayer(reg(d.id, p));
    }
    for (const a of data.alerts) {
      const det = data.detections.find((d) => d.id === a.targetId), site = data.sites.find((s) => s.id === a.targetId);
      const aoi = det && data.region.find((r) => r.id === det.aoiId);
      const at = site ? [site.lat, site.lon] : aoi ? L.polygon(aoi.geometry.coordinates[0].map((c) => [c[1], c[0]])).getBounds().getCenter() : null;
      if (!at) continue;
      const ring = L.circleMarker(at, style(a.id, { radius: 14, color: css("--red"), weight: 2, fill: false, className: "ralert" }));
      tip(ring, a.title, a.id);
      groups.alerts.addLayer(reg(a.id, ring));
    }
    drawTrackers();
    R.labels = labelled.size;
  }

  // tags: clustered on a screen grid below zoom 14 so the map never fills with dots
  function drawTrackers() {
    groups.trackers.clearLayers();
    groups.focus.clearLayers(); // trails are redrawn with their tags, never stacked
    const shown = data.trackers.filter((t) => Number.isFinite(t.lat) && filters.kinds.has(t.projectId && t.kind === "vehicle" ? "contractor" : t.kind) && (!filters.staleOnly || t.signal !== "live"));
    if (map.getZoom() < CLUSTER_BELOW && !focusSet) {
      const cells = new Map();
      for (const t of shown) { const p = map.latLngToLayerPoint([t.lat, t.lon]), k = `${Math.round(p.x / 60)}|${Math.round(p.y / 60)}`; (cells.get(k) || cells.set(k, []).get(k)).push(t); }
      for (const ts of cells.values()) {
        if (ts.length === 1) { addTracker(ts[0]); continue; }
        const c = L.latLng(ts.reduce((s, t) => s + t.lat, 0) / ts.length, ts.reduce((s, t) => s + t.lon, 0) / ts.length);
        const m = L.marker(c, { icon: L.divIcon({ className: "rcluster", html: `<span>${ts.length}</span>`, iconSize: [26, 26] }) });
        tip(m, ts.map((t) => t.name).join(" · "), null);
        m.on("click", () => map.setView(c, CLUSTER_BELOW));
        groups.trackers.addLayer(m);
      }
    } else shown.forEach(addTracker);
  }
  function addTracker(t) {
    const cls = `rtag ${t.kind} ${t.signal}${fade(t.id) ? " faded" : ""}`;
    const m = L.marker([t.lat, t.lon], { icon: L.divIcon({ className: cls, html: t.kind === "vehicle" ? "▲" : "■", iconSize: [16, 16] }), opacity: fade(t.id) ? 0.25 : 1 });
    const age = t.signal === "live" ? ` · ping ${ago(t.pingAt)}` : ` · ${t.signal}, last seen ${ago(t.pingAt)}`;
    tip(m, `${t.name}${t.eta ? ` · ETA ${t.eta.slice(11, 16)}` : ""}${age}`, t.id);
    m.on("click", () => onSelect({ kind: "tracker", id: t.id }));
    groups.trackers.addLayer(reg(t.id, m));
    if (t.trail && t.trail.length > 1) groups.focus.addLayer(L.polyline(t.trail.map((c) => [c[1], c[0]]), { color: css("--amber"), weight: 2, dashArray: "3 4", opacity: 0.9 }));
  }

  for (const [k, g] of Object.entries(groups)) if (on[k] || k === "focus") g.addTo(map);
  draw();
  // first look: the dam, the works and the bulk line together
  if (!start.center) {
    const pts = data.region.filter((r) => ["waterbody", "pipeline", "main"].includes(r.kind)).flatMap((r) => (r.geometry.type === "Polygon" ? r.geometry.coordinates[0] : r.geometry.coordinates.flat()));
    if (pts.length) map.fitBounds(L.latLngBounds(pts.map((c) => [c[1], c[0]])).extend(works).pad(0.05));
  }
  map.on("zoomend", () => { drawTrackers(); });
  const canEnter = () => { enter.hidden = !(map.getZoom() >= ENTER_AT && map.getBounds().contains(works)); };
  map.on("moveend zoomend", () => { canEnter(); onView({ center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() }); });
  canEnter(); // the first view may already be close over the works (Back from the plant)
  enter.addEventListener("click", () => onEnterPlant());
  setTimeout(() => map.invalidateSize(), 0);

  return {
    map,
    setData(next) { data = next; draw(); },
    setLayer(name, v) { on[name] = v; if (v) groups[name].addTo(map); else map.removeLayer(groups[name]); },
    setFilter(name, v) { if (name === "alarmOnly" || name === "staleOnly") filters[name] = v; else if (v) filters.kinds.add(name); else filters.kinds.delete(name); draw(); },
    focus(f, { fit = true } = {}) {
      focusSet = f ? new Set([...f.ids, ...f.trackerIds]) : null;
      labelled = new Set(f ? [...f.trackerIds, ...f.ids].slice(0, MAX_LABELS) : []);
      draw();
      const ls = f && fit ? [...focusSet].flatMap((id) => byId.get(id) || []) : []; // a restored view keeps its own centre and zoom
      if (ls.length) map.fitBounds(L.featureGroup(ls).getBounds().pad(0.3), { maxZoom: 15 });
    },
    clearFocus() { this.focus(null); },
    select(id) {
      const t = data.trackers.find((x) => x.id === id);
      if (t && map.getZoom() < CLUSTER_BELOW) map.setView([t.lat, t.lon], CLUSTER_BELOW); // out of its cluster, so it can be labelled
      labelled = new Set([id]);
      draw();
      const ls = byId.get(id);
      if (ls && ls[0].getLatLng) map.panTo(ls[0].getLatLng());
    },
    // a scene grid as banded cells: never a continuous ramp
    setGrid(g) {
      groups.grid.clearLayers();
      gridNote.hidden = !g;
      if (!g) return;
      gridNote.textContent = `${g.index.toUpperCase()} · ${g.sceneId} · index, not calibrated`;
      const half = g.cellM / 2 / 111320;
      g.cells.forEach(([lon, lat], i) => {
        const dl = half / Math.cos((lat * Math.PI) / 180), b = g.bands[i];
        if (b === "normal") return; // only what stands out is drawn; normal water stays clear
        groups.grid.addLayer(L.rectangle([[lat - half, lon - dl], [lat + half, lon + dl]], { stroke: false, fillColor: css(BAND[b]), fillOpacity: b === "unknown" ? 0.15 : 0.55, interactive: false }));
      });
      if (!on.grid) this.setLayer("grid", true);
    },
    view: () => ({ center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom() }),
    dispose() { clearTimeout(watchdog); map.remove(); if (window.__region === R) delete window.__region; }
  };
}
