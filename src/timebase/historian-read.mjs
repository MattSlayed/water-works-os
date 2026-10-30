// Pinned in the live follow-up: run `node scripts/timebase/mcp-tools.mjs historian`, then fill tool/args/points.
const unpinned = () => { throw new Error("HISTORIAN_READ not pinned yet — run scripts/timebase/mcp-tools.mjs historian"); };
export const HISTORIAN_READ = { tool: null, args: unpinned, points: unpinned };
