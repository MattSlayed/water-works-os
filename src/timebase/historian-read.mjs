// Pinned from `scripts/timebase/mcp-tools.mjs historian`: GetDataForMultipleTags returns raw TVQs for tags over [start, end).
// shortcut: the reply is human-readable text ("- <iso>  v=<n>  q=<n>" lines), so points() parses it; the Historian also
// drops consecutive repeated values, so a minute-step window holds slightly fewer points than minutes.
export const HISTORIAN_READ = {
  tool: "GetDataForMultipleTags",
  args: (tag, fromIso, toIso) => ({ datasetName: "Riverbend", tagNamesJson: JSON.stringify([tag]), startTime: fromIso, endTime: toIso }),
  points(result) {
    let text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (text.startsWith('"')) text = JSON.parse(text); // the server JSON-encodes its text reply
    return [...text.matchAll(/^- (\S+)\s+v=(\S+)\s+q=(\d+)\s*$/gm)].map((m) => ({ t: new Date(m[1]).toISOString(), v: Number(m[2]), q: Number(m[3]) }));
  }
};
