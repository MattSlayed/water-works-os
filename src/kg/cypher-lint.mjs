// Lint for agent Cypher: read-only, and free of the two Atlas traps that parse but are silently not applied
// (a label on the far end of a traversal, an inline property map in a node pattern).
const WRITE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|CALL|LOAD\s+CSV)\b/gi;

export function lintCypher(q) {
  // string literals (with backslash escapes), backticked names and comments are blanked first, in one left-to-right
  // pass: a quote inside a comment cannot open a literal, and a // inside a literal is not a comment
  const s = String(q ?? "").replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`[^`]*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === "/" ? " " : "''"));
  const errors = [];
  for (const m of s.matchAll(WRITE)) errors.push(`${m[1].toUpperCase().replace(/\s+/, " ")} is a write or procedure clause; agent Cypher is read-only`);
  // a node pattern straight after a relationship's closing - or -> is a far end
  for (const m of s.matchAll(/[->]\s*\(\s*(\w*)\s*:\s*([\w']+)/g)) errors.push(`label on the far-end node (${m[1]}:${m[2]}) is ignored by Atlas: move the label to WHERE x:Label`);
  if (/\(\s*\w*\s*(?::\s*[\w']+\s*)?\{/.test(s)) errors.push("an inline property map in a node pattern is ignored by Atlas: use WHERE");
  return { ok: !errors.length, errors };
}
