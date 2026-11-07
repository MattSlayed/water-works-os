// Google IAP sign-in: verify the JWT IAP adds to each request, and which personas a signed-in email may act as.
import crypto from "node:crypto";

const ISSUER = "https://cloud.google.com/iap";
const KEYS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";
const LEEWAY = 60; // seconds of clock skew allowed on exp and iat
const part = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

export async function verifyIapJwt(token, { audience, keys, now = Math.floor(Date.now() / 1000) }) {
  if (typeof token !== "string" || !token) throw new Error("no token");
  const [h, p, s, ...rest] = token.split(".");
  if (!h || !p || s === undefined || rest.length) throw new Error("malformed token");
  let header, claims;
  try { header = part(h); claims = part(p); } catch { throw new Error("malformed token"); }
  if (header.alg !== "ES256") throw new Error("algorithm must be ES256");
  const find = async (refresh) => (await keys(refresh)).find((k) => k.kid && k.kid === header.kid);
  const jwk = (await find(false)) || (await find(true)); // a kid we have not seen means Google rotated its keys
  if (!jwk) throw new Error("unknown key");
  let ok = false;
  try { ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: crypto.createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")); } catch {}
  if (!ok) throw new Error("bad signature");
  if (claims.iss !== ISSUER) throw new Error("wrong issuer");
  if (typeof claims.aud !== "string" || claims.aud !== audience) throw new Error("wrong audience");
  if (!(now <= claims.exp + LEEWAY)) throw new Error("expired");
  if (!(claims.iat <= now + LEEWAY)) throw new Error("not yet valid");
  if (typeof claims.email !== "string" || !claims.email) throw new Error("no email in token");
  return { email: claims.email, sub: claims.sub };
}

export function googleIapKeys(fetchImpl = fetch) {
  let cached = null, at = 0;
  return async (refresh) => {
    if (refresh || !cached || Date.now() - at > 3600e3) {
      const r = await fetchImpl(KEYS_URL);
      if (!r.ok) throw new Error(`IAP keys: HTTP ${r.status}`);
      cached = (await r.json()).keys;
      at = Date.now();
    }
    return cached;
  };
}

// "a@x.co=*,b@x.co=P-028|P-002": * is any persona; emails are matched without case.
export function parseOperators(spec) {
  const ops = new Map();
  for (const entry of String(spec || "").split(",")) {
    const [email, who] = entry.split("=").map((x) => x.trim());
    if (email && who) ops.set(email.toLowerCase(), who === "*" ? "*" : new Set(who.split("|").map((x) => x.trim()).filter(Boolean)));
  }
  return ops;
}

export function mayActAs(operators, email, personId) {
  const allowed = operators.get(String(email).toLowerCase());
  return allowed === "*" || (allowed instanceof Set && allowed.has(personId));
}
