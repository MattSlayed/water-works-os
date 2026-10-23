// Append-only, hash-chained audit log (FR-GOV-003). Pattern from novacore-operations-demo/lib/audit.mjs.
import { createHash } from "node:crypto";

const canonical = (v) =>
  v === null || typeof v !== "object" ? JSON.stringify(v)
    : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
    : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;

const digest = (prev, body) => createHash("sha256").update(prev + canonical(body)).digest("hex").slice(0, 32);
export const GENESIS = "0".repeat(32);

export function createAudit() {
  const log = [];
  return {
    append(entry) {
      const prev = log.length ? log[log.length - 1].hash : GENESIS;
      const body = { seq: log.length + 1, at: new Date().toISOString(), ...entry };
      const rec = { ...body, prev, hash: digest(prev, body) };
      log.push(rec);
      return rec;
    },
    all: () => log,
    verify() {
      let prev = GENESIS;
      for (const rec of log) {
        const { prev: p, hash, ...body } = rec;
        if (p !== prev || digest(prev, body) !== hash) return false;
        prev = hash;
      }
      return true;
    }
  };
}
