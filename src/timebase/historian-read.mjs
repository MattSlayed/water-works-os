// Pinned from `scripts/timebase/mcp-tools.mjs historian`: GetDataForMultipleTags returns raw TVQs for tags over [start, end).
// shortcut: the reply is human-readable text ("- <iso>  v=<n>  q=<n>" lines), so page() parses it; the Historian also
// drops consecutive repeated values, so a minute-step window holds slightly fewer points than minutes.
export const HISTORIAN_READ = {
  tool: "GetDataForMultipleTags",
  args: (tag, fromIso, toIso) => ({ datasetName: "Riverbend", tagNamesJson: JSON.stringify([tag]), startTime: fromIso, endTime: toIso }),
  // One reply. Single-tag only (args() asks for one tag). The tool lists at most 100 points and ends with "... and N more
  // point(s)"; `more` is that N. Throws on anything the reply's own point count does not account for.
  page(result) {
    let text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (text.startsWith('"')) text = JSON.parse(text); // the server JSON-encodes its text reply
    const headers = [...text.matchAll(/^## .* - (\d+) point\(s\)\s*$/gm)];
    if (!headers.length) throw new Error("Historian reply: no point(s) header (unrecognised reply)");
    const expected = headers.reduce((n, h) => n + Number(h[1]), 0);
    const more = Number(/^- \.\.\. and (\d+) more point\(s\)/m.exec(text)?.[1] ?? 0);
    const pts = [...text.matchAll(/^- (\S+Z)\s+v=(\S+)\s+q=(\d+)\s*$/gm)].map((m) => {
      const v = Number(m[2]);
      if (!Number.isFinite(v)) throw new Error("Historian reply: non-finite value");
      return { t: new Date(m[1]).toISOString(), v, q: Number(m[3]) };
    });
    if (pts.length + more !== expected) throw new Error(`Historian reply: parsed ${pts.length} of ${expected} points`);
    return { pts, more, expected };
  },
  // A whole window, a page at a time. Each page starts at the last point of the one before and lists that point again, so
  // only later points count. The first reply counts the whole window, so the total is checked against it.
  // shortcut: one call per 99 points, about 1,300 for 90 days of minutes; add a server-side aggregate read if long windows bite.
  async read(callTool, tag, fromIso, toIso) {
    const out = [];
    let from = fromIso, total = null;
    const end = new Date(Date.parse(toIso) + 1).toISOString(); // the tool's end is exclusive; callers mean up to and including toIso
    for (;;) {
      const { pts, more, expected } = this.page(await callTool(this.tool, this.args(tag, from, end)));
      total ??= expected;
      const fresh = pts.filter((p) => !out.length || p.t > out.at(-1).t);
      out.push(...fresh);
      if (!more) break;
      if (!fresh.length) throw new Error("Historian reply: more points promised but no new ones listed");
      from = out.at(-1).t;
    }
    if (out.length !== total) throw new Error(`Historian read: got ${out.length} of ${total} points`);
    return out;
  }
};
