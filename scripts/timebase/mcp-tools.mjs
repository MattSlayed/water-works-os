// Lists the MCP tools (name, description, input schema) of a Timebase component. Prints no token or secret.
// Usage: TIMEBASE_CLIENT_ID=WaterOS TIMEBASE_SECRET_FILE=<file> [NODE_EXTRA_CA_CERTS=<pem>] node scripts/timebase/mcp-tools.mjs historian|atlas
import { pulseToken } from "../../src/timebase/pulse.mjs";
import { connectMcp } from "../../src/timebase/mcp.mjs";

const env = process.env;
const urls = { historian: env.TIMEBASE_HISTORIAN_URL ?? "https://localhost:4512", atlas: env.TIMEBASE_ATLAS_URL ?? "https://localhost:4552" };
const which = process.argv[2];
if (!urls[which]) throw new Error("Usage: mcp-tools.mjs historian|atlas");
if (!env.TIMEBASE_CLIENT_ID || !env.TIMEBASE_SECRET_FILE) throw new Error("Set TIMEBASE_CLIENT_ID and TIMEBASE_SECRET_FILE");

const getToken = () => pulseToken({ pulseUrl: env.TIMEBASE_PULSE_URL ?? "https://localhost:4542", clientId: env.TIMEBASE_CLIENT_ID, secretFile: env.TIMEBASE_SECRET_FILE });
const tools = await (await connectMcp(urls[which], getToken)).listTools();
console.log(JSON.stringify(tools, null, 2));
console.error(`${tools.length} tools`);
