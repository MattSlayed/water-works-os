// Pulse (OIDC) client-credentials token, cached until 30 s before exp. Errors carry only status + OAuth error code.
import { readFileSync } from "node:fs";

const cache = new Map();

export async function pulseToken({ pulseUrl, clientId, secretFile, fetch: f = fetch }) {
  const key = `${pulseUrl}|${clientId}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now() / 1000 + 30) return hit.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: readFileSync(secretFile, "ascii").trim() });
  const r = await f(`${pulseUrl}/auth/token`, { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || typeof j.access_token !== "string") throw new Error(`Pulse token request failed: ${r.status} ${/^[\w.-]{1,64}$/.test(j.error) ? j.error : ""}`.trim());
  const exp = JSON.parse(Buffer.from(j.access_token.split(".")[1], "base64url").toString()).exp;
  cache.set(key, { token: j.access_token, exp });
  return j.access_token;
}
