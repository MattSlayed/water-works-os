// Bloom: the plant as a graph, drawn from the same knowledge graph the agents query (through /mcp, as the viewer).
// Plain SVG and a small force layout, no dependencies. Plant nodes are seeded at their site-plan positions.
const PALETTE = ["#60a5fa", "#a78bfa", "#2dd4bf", "#fbbf24", "#f472b6", "#fb923c", "#a3e635", "#22d3ee", "#f87171", "#4ade80", "#e879f9", "#facc15"];
const FIXED = { Structure: "#60a5fa", Position: "#a78bfa", Asset: "#2dd4bf", Sensor: "#22d3ee", Zone: "#94a3b8", Alert: "#f87171", WorkOrder: "#fb923c", Document: "#fbbf24", Chunk: "#facc15", Procedure: "#a3e635", Project: "#f472b6", Permit: "#e879f9", Requirement: "#4ade80" };
export const colourOf = (type) => FIXED[type] || PALETTE[[...String(type)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const SPAN = 1100; // seeded layout height in user units; width is 1.6x, the stage's landscape shape

// /api/plant (already pruned to the viewer) -> structures and machine positions, CONTAINS and FEEDS edges.
// Machines take their KG position id, so expanding a structure in the KG lands on the same node.
export function plantGraph(d) {
  const xs = d.structures.map((s) => s.centre[0]), ys = d.structures.map((s) => s.centre[1]);
  // the site plan's arrangement, stretched to the stage: a graph to read, not a map to measure
  const x0 = Math.min(...xs), y0 = Math.min(...ys), kx = (SPAN * 1.6) / Math.max(1, Math.max(...xs) - x0), ky = SPAN / Math.max(1, Math.max(...ys) - y0), k = Math.min(kx, ky);
  const at = ([x, y]) => [(x - x0) * kx, (y - y0) * ky];
  const nodes = [], edges = new Map(), alias = new Map(), byTag = new Map(), byId = new Map();
  for (const s of d.structures) {
    const [x, y] = at(s.centre);
    nodes.push({ id: s.id, type: "Structure", label: s.tag, sub: String(s.kind || "").replace(/_/g, " "), x, y, ax: x, ay: y });
    byTag.set(s.tag, s.id);
    byId.set(s.id, s);
  }
  for (const m of d.machines) {
    const id = m.positionId || m.id, host = byId.get(m.structureId);
    if (m.positionId) alias.set(m.id, id);
    const [x, y] = host ? at(host.centre) : [SPAN * 0.8, SPAN / 2], [ox = 0, oy = 0] = m.offset || [];
    nodes.push({ id, type: m.positionId ? "Position" : "MachinePlacement", label: m.tag, x: x + ox * k * 3, y: y + oy * k * 3 + 30 });
    if (host) edges.set(`${host.id}|${id}|CONTAINS`, { from: host.id, to: id, rel: "CONTAINS" });
  }
  for (const l of d.lines) {
    const a = byTag.get(l.from), b = byTag.get(l.to), key = `${a}|${b}|FEEDS`;
    if (!a || !b || a === b) continue;
    const e = edges.get(key);
    if (e) e.title += `, ${l.tag}`;
    else edges.set(key, { from: a, to: b, rel: "FEEDS", title: `${l.service}: ${l.tag}`, recycle: !!l.recycle });
  }
  return { nodes, edges: [...edges.values()], alias };
}

// Bloom-style search phrases -> one KG tool call. Anything else is a search.
export function parseQuery(q) {
  const s = String(q ?? "").trim();
  let m;
  if (!s) return null;
  if ((m = s.match(/^(upstream|downstream)\s+(?:of\s+)?(.+)$/i))) return { tool: m[1].toLowerCase(), args: { id: m[2].trim() } };
  if ((m = s.match(/^(?:neighbou?rs|expand|around)\s+(?:of\s+)?(.+)$/i))) return { tool: "neighbors", args: { id: m[1].trim() } };
  return { tool: "search", args: { q: s, limit: 25 } };
}

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export function mountBloom(host, graph, { onSelect = () => {}, onExpand = () => {} } = {}) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const svg = el("svg", { class: "bloomsvg", role: "group", "aria-label": "Plant knowledge graph" }, host);
  const gEdges = el("g", {}, svg), gNodes = el("g", {}, svg);
  const nodes = new Map(), edges = new Map(), alias = new Map(graph.alias);
  let vb = { x: -60, y: -60, w: SPAN + 120, h: SPAN + 120 }, z = 1, selected = null, hits = null, alpha = 0, raf = 0;
  const id = (x) => alias.get(x) || x;
  // nodes and labels keep their screen size at any zoom (z = user units per pixel), so a fitted plant stays legible
  const applyView = () => {
    svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    const nz = vb.w / (svg.clientWidth || vb.w);
    if (Math.abs(nz - z) / z < 0.01) return;
    z = nz;
    svg.style.setProperty("--z", z);
    draw();
  };

  function addNode(n, near) {
    const nid = id(n.id);
    if (nodes.has(nid)) return nodes.get(nid);
    const base = near && nodes.get(id(near));
    const a = Math.random() * Math.PI * 2;
    const node = { ...n, id: nid, x: n.x ?? (base ? base.x + Math.cos(a) * 90 : vb.x + vb.w / 2), y: n.y ?? (base ? base.y + Math.sin(a) * 90 : vb.y + vb.h / 2), vx: 0, vy: 0 };
    const r = node.type === "Structure" ? 15 : 11;
    const g = el("g", { class: "bn", tabindex: "0", role: "button", "aria-label": `${node.type} ${node.label}` }, gNodes);
    el("circle", { r, fill: colourOf(node.type) }, g);
    el("text", { class: "bl", "text-anchor": "middle", dy: "4" }, g).textContent = node.type[0];
    el("text", { class: "bt", "text-anchor": "middle", dy: String(r + 13) }, g).textContent = node.label.length > 22 ? node.label.slice(0, 21) + "…" : node.label;
    el("title", {}, g).textContent = `${node.type} · ${node.label}${node.sub ? ` · ${node.sub}` : ""}\n${node.id}`;
    node.g = g;
    bind(node);
    nodes.set(nid, node);
    return node;
  }
  function addEdge(e) {
    const from = id(e.from), to = id(e.to), key = `${from}|${to}|${e.rel}`;
    if (edges.has(key) || from === to || !nodes.has(from) || !nodes.has(to)) return;
    const line = el("line", { class: `be${e.recycle ? " recycle" : ""}` }, gEdges);
    const label = el("text", { class: "bel", "text-anchor": "middle" }, gEdges);
    label.textContent = e.rel;
    el("title", {}, line).textContent = `${e.rel}${e.title ? ` · ${e.title}` : ""}`;
    edges.set(key, { ...e, from, to, line, label });
  }

  // drag a node, or press Enter/Space to select and E (or double-click) to expand
  function bind(node) {
    let down = null;
    node.g.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); down = { x: ev.clientX, y: ev.clientY, moved: false }; node.g.setPointerCapture(ev.pointerId); });
    node.g.addEventListener("pointermove", (ev) => {
      if (!down) return;
      if (!down.moved && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 4) return;
      down.moved = true;
      const p = toUser(ev);
      node.x = node.ax = p.x; node.y = node.ay = p.y; node.pinned = true;
      draw();
    });
    node.g.addEventListener("pointerup", () => { if (down && !down.moved) select(node.id); down = null; });
    node.g.addEventListener("dblclick", () => onExpand(node));
    node.g.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(node.id); }
      if (ev.key.toLowerCase() === "e") onExpand(node);
    });
  }
  const toUser = (ev) => { const r = svg.getBoundingClientRect(); return { x: vb.x + ((ev.clientX - r.left) / r.width) * vb.w, y: vb.y + ((ev.clientY - r.top) / r.height) * vb.h }; };

  // pan by dragging the background, zoom with the wheel about the pointer
  let pan = null;
  svg.addEventListener("pointerdown", (ev) => { pan = { x: ev.clientX, y: ev.clientY, vb: { ...vb } }; svg.setPointerCapture(ev.pointerId); });
  svg.addEventListener("pointermove", (ev) => {
    if (!pan) return;
    const r = svg.getBoundingClientRect();
    vb.x = pan.vb.x - ((ev.clientX - pan.x) / r.width) * vb.w;
    vb.y = pan.vb.y - ((ev.clientY - pan.y) / r.height) * vb.h;
    applyView();
  });
  svg.addEventListener("pointerup", () => { pan = null; });
  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const p = toUser(ev), f = Math.exp(ev.deltaY * 0.0012), w = Math.min(8000, Math.max(120, vb.w * f)), s = w / vb.w;
    vb = { x: p.x - (p.x - vb.x) * s, y: p.y - (p.y - vb.y) * s, w, h: vb.h * s };
    applyView();
  }, { passive: false });

  function draw() {
    for (const n of nodes.values()) n.g.setAttribute("transform", `translate(${n.x.toFixed(1)},${n.y.toFixed(1)}) scale(${z.toFixed(3)})`);
    for (const e of edges.values()) {
      const a = nodes.get(e.from), b = nodes.get(e.to);
      e.line.setAttribute("x1", a.x); e.line.setAttribute("y1", a.y); e.line.setAttribute("x2", b.x); e.line.setAttribute("y2", b.y);
      e.label.setAttribute("x", (a.x + b.x) / 2); e.label.setAttribute("y", (a.y + b.y) / 2 - 4 * z);
    }
  }
  // repulsion, springs on edges, and a pull back to the site-plan seat for plant nodes
  function tick() {
    const list = [...nodes.values()];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], dx = b.x - a.x || 0.1, dy = b.y - a.y || 0.1, d2 = Math.max(dx * dx + dy * dy, 25);
      if (d2 > 90000) continue;
      const f = (400 / d2) * alpha;
      a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
    }
    for (const e of edges.values()) {
      const a = nodes.get(e.from), b = nodes.get(e.to), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      if (e.rel === "FEEDS") continue; // process lines keep the site plan; they are drawn, not pulled
      const f = ((d - 55) / d) * 0.06 * alpha;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const n of list) {
      if (n.ax !== undefined) { n.vx += (n.ax - n.x) * 0.08 * alpha; n.vy += (n.ay - n.y) * 0.08 * alpha; }
      if (n.pinned) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6;
      const sp = Math.hypot(n.vx, n.vy);
      if (sp > 12) { n.vx *= 12 / sp; n.vy *= 12 / sp; } // a close pair never flings a node off the plan
      n.x += n.vx; n.y += n.vy;
    }
    alpha *= 0.96;
  }
  function heat() {
    alpha = 1;
    if (still) { while (alpha > 0.02) tick(); draw(); return settle(); }
    if (raf) return;
    const loop = () => { tick(); draw(); raf = alpha > 0.02 ? requestAnimationFrame(loop) : (settle(), 0); };
    raf = requestAnimationFrame(loop);
  }

  // the last frame asked for is re-fitted once the layout has settled, so nothing ends up off the canvas
  let fitTo = null, tween = 0;
  const settle = () => { if (fitTo) frame(fitTo.ids, fitTo.pad, true); };

  function paint() {
    for (const n of nodes.values()) {
      n.g.classList.toggle("dim", !!hits && !hits.has(n.id));
      n.g.classList.toggle("hit", !!hits && hits.has(n.id));
      n.g.classList.toggle("sel", n.id === selected);
      n.g.setAttribute("aria-pressed", String(n.id === selected));
    }
    for (const e of edges.values()) {
      const on = !hits ? e.from === selected || e.to === selected : hits.has(e.from) && hits.has(e.to);
      e.line.classList.toggle("dim", !!hits && !on);
      e.line.classList.toggle("on", on);
      e.label.classList.toggle("on", on && (e.from === selected || e.to === selected)); // names only the selected node's links
    }
  }
  function select(nid) {
    selected = nid && id(nid);
    paint();
    const n = selected && nodes.get(selected);
    if (n) onSelect(n);
  }
  // fit ids with pad screen pixels around them (nodes and labels are a fixed pixel size)
  function frame(ids, pad = 70, settled = false) {
    if (!settled) fitTo = { ids, pad };
    const ns = ids.map((x) => nodes.get(id(x))).filter(Boolean);
    if (!ns.length) return;
    const x0 = Math.min(...ns.map((n) => n.x)), x1 = Math.max(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y)), y1 = Math.max(...ns.map((n) => n.y));
    const r = svg.getBoundingClientRect(), W = r.width || 800, H = r.height || 600;
    const s = Math.max((x1 - x0) / Math.max(W - 2 * pad, 50), (y1 - y0) / Math.max(H - 2 * pad, 50), 0.5);
    const w = W * s, h = H * s;
    const to = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h }, from = { ...vb }, t0 = performance.now(), mine = ++tween;
    if (still) { vb = to; return applyView(); }
    const step = (t) => {
      if (mine !== tween) return; // a newer fit supersedes this one
      const u = Math.min(1, (t - t0) / 300), e = 1 - (1 - u) ** 3;
      vb = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, w: from.w + (to.w - from.w) * e, h: from.h + (to.h - from.h) * e };
      applyView();
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const seed = () => { for (const n of graph.nodes) addNode(n); for (const e of graph.edges) addEdge(e); };
  seed();
  draw();
  applyView();
  heat();
  frame([...nodes.keys()], 50);

  return {
    // nodes [{id,type,label}] near an existing node, edges [{from,to,rel}]; returns the ids now on the canvas
    add(ns, es = [], near) {
      const ids = ns.map((n) => addNode(n, near).id);
      for (const e of es) addEdge(e);
      heat();
      paint();
      return ids;
    },
    has: (x) => nodes.has(id(x)),
    resolve: id,
    highlight(ids) { hits = ids && ids.length ? new Set(ids.map(id).filter((x) => nodes.has(x))) : null; paint(); },
    frame,
    select,
    reset() {
      gNodes.replaceChildren(); gEdges.replaceChildren(); nodes.clear(); edges.clear(); hits = null; selected = null;
      seed(); draw(); heat(); frame([...nodes.keys()], 50);
    },
    get size() { return nodes.size; },
    get types() { return new Set([...nodes.values()].map((n) => n.type)); },
    dispose() { cancelAnimationFrame(raf); svg.remove(); }
  };
}
