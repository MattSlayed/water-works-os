// Reader for the DEXPI 1.3 subset the drawing set uses (design §4.1). The XML reader handles elements,
// attributes, self-closing tags and comments only: no DTD, no CDATA, no namespaces, no text content.
const bad = (why) => { throw new Error(`malformed XML: ${why}`); };
const ENT = { amp: "&", quot: '"', lt: "<", gt: ">", apos: "'" };
const unesc = (v) => v.replace(/&(amp|quot|lt|gt|apos);/g, (_, e) => ENT[e]);

export function parseXml(text) {
  const s = String(text).replace(/^﻿?<\?xml[^>]*\?>/, "");
  const root = { name: "#root", attrs: {}, children: [] }, stack = [root];
  const tag = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<!--[\s\S]*?-->/g;
  let last = 0, m;
  while ((m = tag.exec(s))) {
    if (s.slice(last, m.index).includes("<")) bad(`unreadable tag before offset ${m.index}`);
    last = tag.lastIndex;
    if (m[0].startsWith("<!--")) continue;
    const [, close, name, attrText, selfClose] = m;
    if (close) {
      const top = stack.pop();
      if (top === root || top.name !== name) bad(`</${name}> closes <${top.name}>`);
      continue;
    }
    const attrs = {};
    for (const a of attrText.matchAll(/([\w.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = unesc(a[2]);
    const el = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  if (s.slice(last).includes("<")) bad("unterminated tag");
  if (stack.length !== 1) bad(`<${stack[stack.length - 1].name}> not closed`);
  if (root.children.length !== 1) bad("expected one root element");
  return root.children[0];
}

const kids = (el, name) => el.children.filter((c) => c.name === name);
const generic = (el) => Object.fromEntries(kids(el, "GenericAttributes").flatMap((g) => kids(g, "GenericAttribute")).map((a) => [a.attrs.Name, a.attrs.Value]));
const eqTag = (id) => (id?.startsWith("EQ-") ? id.slice(3) : id);
const yes = (v) => v === "yes";

export function parseDexpi(text) {
  const doc = parseXml(text);
  if (doc.name !== "PlantModel") bad(`root is <${doc.name}>, expected <PlantModel>`);
  const equipment = kids(doc, "Equipment").map((e) => {
    const ga = generic(e);
    return { id: e.attrs.ID, tag: e.attrs.TagName, cls: e.attrs.ComponentClass, kks: ga.KKS ?? null, nozzles: kids(e, "Nozzle").map((n) => n.attrs.ID), typical: yes(e.attrs.Typical), inStructure: ga.InStructure ?? null };
  });
  const segments = kids(doc, "PipingNetworkSegment").map((sg) => {
    const ga = generic(sg), c = kids(sg, "Connection")[0]?.attrs ?? {};
    return { id: sg.attrs.ID, line: sg.attrs.LineNumber, from: eqTag(c.FromID), to: eqTag(c.ToID), service: ga.Service ?? null, dn: ga.NominalDiameter ? Number(ga.NominalDiameter) : null, mode: ga.Mode ?? "continuous" };
  });
  const components = kids(doc, "PipingComponent").map((c) => ({ cls: c.attrs.ComponentClass, tag: c.attrs.TagName, segment: c.attrs.Segment ?? null, typical: yes(c.attrs.Typical) }));
  const instruments = kids(doc, "ProcessInstrumentationFunction").map((p) => { const ga = generic(p); return { tag: p.attrs.TagName, kks: ga.KKS ?? null, measuredAt: ga.MeasuredAt ?? null }; });
  const streams = kids(doc, "Stream").map(({ attrs: a }) => ({ id: a.ID, from: a.From, to: a.To, flow: Number(a.DesignFlowM3h), split: Number(a.SplitFraction), recycle: yes(a.Recycle), mode: a.Mode ?? "continuous" }));
  // The typical's tag table: one row per filter; the typical's valve tags (15AA##-k) are expanded per filter.
  const typicalValves = components.filter((c) => c.typical && c.tag.includes("##") && /Valve$/.test(c.cls)).map((c) => c.tag);
  const tagTable = {};
  for (const r of kids(doc, "TagTable").flatMap((t) => kids(t, "TagRow"))) {
    const nn = r.attrs.Tag.slice(-2);
    tagTable[r.attrs.Filter] = { kks: r.attrs.Tag, inlet: r.attrs.Inlet, outlet: r.attrs.Outlet, filterToWaste: yes(r.attrs.FilterToWaste), valves: typicalValves.map((v) => v.replace("##", nn)) };
  }
  return { meta: doc.attrs, equipment, segments, components, instruments, streams, tagTable };
}
