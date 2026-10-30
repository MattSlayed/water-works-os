// JSON REST call with a bearer token. Redirects are never followed (a redirect means the login page, not the API).
export async function restCall(base, method, path, body, { token, fetch: f = fetch }) {
  const r = await f(base + path, {
    method, redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const type = r.headers.get("content-type") || "";
  const text = await r.text();
  if (r.status >= 200 && r.status < 300 && !type.includes("json")) {
    throw Object.assign(new Error(`${method} ${path}: ${r.status} reply is not JSON`), { name: "NotJson", status: r.status });
  }
  let parsed = text;
  if (type.includes("json")) try { parsed = JSON.parse(text); } catch { /* keep the raw text */ }
  return { status: r.status, body: parsed };
}
