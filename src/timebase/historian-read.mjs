// Pinned from `scripts/timebase/mcp-tools.mjs historian`: GetDataForMultipleTags returns raw TVQs for tags over [start, end).
// shortcut: the reply is human-readable text ("- <iso>  v=<n>  q=<n>" lines), so points() parses it; the Historian also
// drops consecutive repeated values, so a minute-step window holds slightly fewer points than minutes.
export const HISTORIAN_READ = {
  tool: "GetDataForMultipleTags",
  args: (tag, fromIso, toIso) => ({ datasetName: "Riverbend", tagNamesJson: JSON.stringify([tag]), startTime: fromIso, endTime: toIso }),
  // Single-tag replies only (args() asks for one tag); throws on anything the reply's own point count does not account for.
  points(result) {
    let text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (text.startsWith('"')) text = JSON.parse(text); // the server JSON-encodes its text reply
    const headers = [...text.matchAll(/^## .* - (\d+) point\(s\)\s*$/gm)];
    if (!headers.length) throw new Error("Historian reply: no point(s) header (unrecognised reply)");
    const expected = headers.reduce((n, h) => n + Number(h[1]), 0);
    const pts = [...text.matchAll(/^- (\S+Z)\s+v=(\S+)\s+q=(\d+)\s*$/gm)].map((m) => {
      const v = Number(m[2]);
      if (!Number.isFinite(v)) throw new Error("Historian reply: non-finite value");
      return { t: new Date(m[1]).toISOString(), v, q: Number(m[3]) };
    });
    if (pts.length !== expected) throw new Error(`Historian reply: parsed ${pts.length} of ${expected} points`);
    return pts;
  }
};
