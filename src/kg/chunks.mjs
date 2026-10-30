// Heading chunker for generated documents: one Chunk per "## " section, ids "<documentId>#c<nn>" so retrieval can quote a passage.
const MAX_WORDS = 600;
const wc = (s) => s.split(/\s+/).filter(Boolean).length;

export function chunkByHeading(documentId, markdown) {
  const sections = [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^## (.+)$/.exec(line);
    if (h) sections.push({ heading: h[1].trim(), lines: [] });
    else if (sections.length) sections.at(-1).lines.push(line);
  }
  return sections.flatMap((s, i) => {
    const order = i + 1, base = `${documentId}#c${String(order).padStart(2, "0")}`;
    const paras = s.lines.join("\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    // greedy fill to 600 words; shortcut: a single paragraph over 600 words stays whole, split it by sentence if a document ever needs that
    const parts = [];
    for (const p of paras) {
      const last = parts.at(-1);
      if (last && wc(last) + wc(p) <= MAX_WORDS) parts[parts.length - 1] = `${last}\n\n${p}`; else parts.push(p);
    }
    const texts = parts.length ? parts : [""];
    return texts.map((text, k) => ({ id: texts.length > 1 ? base + String.fromCharCode(97 + k) : base, type: "Chunk", documentId, heading: s.heading, order, text }));
  });
}
