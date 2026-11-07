# GCP Slice 1: Secure Front Door and Claude on Vertex AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hosted WaterOS lets in only signed-in, allowed Google accounts. It knows who is really acting, answers with Claude through Vertex AI, and warns on spend and downtime. All of it is scripted so it can be rebuilt in the company's GCP project.

**Architecture:**
- **Sign-in.** IAP sits directly on the Cloud Run service, with no load balancer. When `WWOS_IAP_AUDIENCE` is set, the server verifies IAP's signed JWT on every request. It then accepts the persona in `x-acting-user` only if that signed-in email may act as it. Local runs keep today's behaviour.
- **Claude.** `src/llm.mjs` becomes the one place that builds the Claude client. It uses the Anthropic API client or `AnthropicVertex`, chosen by `WWOS_LLM_PROVIDER`, and the Site Agent uses the same client.
- **Infrastructure.** One parameterised script creates the service account, deploy, IAP access, budget and uptime alert.

**Tech Stack:** Node 22 (ESM, `node:test`), `@anthropic-ai/sdk`, `@anthropic-ai/vertex-sdk` (new), `node:crypto` for ES256 JWT verification, gcloud 581 (`gcloud run deploy --iap`), Cloud Monitoring, Cloud Billing Budgets.

**Spec:** `docs/adr/0001-stack-decision.md`, rows "AI" and "API edge", and the Consequences line "real authentication in front of `/mcp`". The user's decisions on 2026-11-07:
- Build this slice first.
- Claude through Vertex AI.
- IAP users: `matthewkoeberg13@gmail.com` and `matthew@novatekllc.co.za`.
- Budget alert at USD 25.
- The project will move to the company's GCP, so script everything.

## Global Constraints

**Cloud and access**
- Project `se-project-49281` (number 426022356353), region `africa-south1`, service `water-works-os`, billing account `01B233-16D37B-41FAFF` (USD). The project has no organisation parent.
- Every project, region, service, user and amount is a script parameter. No value specific to `se-project-49281` is hard-coded outside `deploy/gcp/front-door.env`.
- IAP users are exactly `matthewkoeberg13@gmail.com` and `matthew@novatekllc.co.za`. Both act as demo operators, so they may act as any synthetic persona.
- Budget USD 25, with alert thresholds at 50%, 90% and 100%, scoped to this project only.

**Claude**
- No API key in the cloud. Claude on Vertex authenticates as the Cloud Run service account, which has `roles/aiplatform.user`.
- Vertex has no server-side `fallbacks`. Send neither `betas: ["server-side-fallback-2026-07-01"]` nor `fallbacks` to Vertex. A refusal or error returns `null`, so the deterministic answer goes out (current behaviour).
- Inference is cross-border, as already disclosed under POPIA s72 (`src/llm.mjs` header). The Vertex region is the nearest one that serves Claude Opus 5.5, confirmed in Task 4.

**Code**
- Work on branch `feat/gcp-front-door`, cut from `feat/figures-all-assets` (PR #1). Its PR targets `main` once #1 is merged.
- Local runs are unchanged when `WWOS_IAP_AUDIENCE` is unset: `x-acting-user` is trusted, and the server binds 127.0.0.1.
- No new dependency except `@anthropic-ai/vertex-sdk`. JWT checks use `node:crypto` only.
- People data is still never sent to Atlas. Synthetic data only.

## Review Focus

1. **Clock skew.** IAP's `iat` can be a few seconds ahead of the container clock. A 60 s leeway accepts it; anything further out is refused (Task 2 test `iat 30 s ahead is accepted`).
2. **Key rotation.** A JWT signed with a `kid` that isn't cached triggers one refetch of Google's keys before it is refused (Task 2 test `unknown kid refetches once`).
3. **Email case.** `Matthew@NovatekLLC.co.za` matches the configured `matthew@novatekllc.co.za` (Task 2 test `email match ignores case`).
4. **Server-sent events and MCP.** `/api/events?as=` and `POST /mcp` go through the same check as every other route. Without a valid JWT they get 401 (Task 2 test `events and mcp need the JWT too`).
5. **No persona sent.** A signed-in request without `x-acting-user` or `?as=` gets 400 "say which person you are acting as", never a silent default (Task 2 test `no persona is a 400`).

---

### Task 1: One Claude client, first-party or Vertex AI

**Files:**
- Modify: `src/llm.mjs`, `src/site-agent.mjs:96-120` (client construction and the `messages.create` call), `package.json`, `package-lock.json`
- Test: `test/llm.test.mjs` (new)

**Interfaces:**
- Produces: `export function claudeProvider(env = process.env): "vertex" | "anthropic" | null`. This is `"vertex"` when `env.WWOS_LLM_PROVIDER === "vertex"` and `env.WWOS_VERTEX_PROJECT` is set. It is `"anthropic"` when today's credentials are present. Otherwise `null`.
- Produces: `export const llmEnabled = (env = process.env) => claudeProvider(env) !== null`. The signature now takes `env`. Existing callers pass nothing.
- Produces: `export function requestExtras(provider): object`. This is `{ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }` for `"anthropic"` and `{}` for `"vertex"`.
- Produces: `export async function claudeClient(env = process.env): Promise<{ client, model, provider } | null>`. It is cached per process. For Vertex it is `new AnthropicVertex({ projectId: env.WWOS_VERTEX_PROJECT, region: env.WWOS_VERTEX_REGION })`. `model` is `env.WWOS_LLM_MODEL || MODEL`.
- `askClaude` and the Site Agent both call `client.beta.messages.create({ model, ...requestExtras(provider), ...rest })`.

- [ ] **Step 0: Confirm the Vertex SDK's API before writing code**

Read the `packages/vertex-sdk` README in https://github.com/anthropics/anthropic-sdk-typescript, using a web-fetch agent. Confirm three things:
- The import, `import { AnthropicVertex } from "@anthropic-ai/vertex-sdk"`.
- The constructor options, `projectId` and `region`.
- That `client.beta.messages.create` exists.

Record the answers in the commit message. If any differs, use what the README says and update this task's Interfaces before going on.

- [ ] **Step 1: Write the failing tests in `test/llm.test.mjs`**

```js
test("requestExtras: first-party keeps the server-side fallback, Vertex sends none", () => {
  assert.deepEqual(requestExtras("anthropic"), { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  assert.deepEqual(requestExtras("vertex"), {});
});
test("claudeProvider: Vertex needs a project; a key means first-party; nothing means off", () => {
  assert.equal(claudeProvider({ WWOS_LLM_PROVIDER: "vertex", WWOS_VERTEX_PROJECT: "p" }), "vertex");
  assert.equal(claudeProvider({ WWOS_LLM_PROVIDER: "vertex" }), null);
  assert.equal(claudeProvider({ ANTHROPIC_API_KEY: "k" }), "anthropic");
  assert.equal(claudeProvider({}), null);
});
test("claudeClient builds AnthropicVertex with the project, region and model", async () => {
  const c = await claudeClient({ WWOS_LLM_PROVIDER: "vertex", WWOS_VERTEX_PROJECT: "p", WWOS_VERTEX_REGION: "europe-west1", WWOS_LLM_MODEL: "m" });
  assert.equal(c.provider, "vertex"); assert.equal(c.model, "m"); assert.equal(c.client.constructor.name, "AnthropicVertex");
});
```

- [ ] **Step 2: Run them and check they fail**

Run `node --test test/llm.test.mjs`. Expected: FAIL, because `requestExtras` is not exported.

- [ ] **Step 3: Install the SDK and implement**

Run `npm install @anthropic-ai/vertex-sdk`. Then implement the Interfaces in `src/llm.mjs`. Change `src/site-agent.mjs` to get its client from `claudeClient()` instead of `new Anthropic()`, and to spread `requestExtras(provider)` instead of the literal `betas`/`fallbacks`. Leave `output_config`, `tools`, `tool_choice` and `max_tokens` exactly as they are.

- [ ] **Step 4: Run all tests**

Run `node --test test/llm.test.mjs`, then `npm test`. Expected: PASS, with the full suite at 684 plus the new tests.

- [ ] **Step 5: Commit**

```bash
git add src/llm.mjs src/site-agent.mjs package.json package-lock.json test/llm.test.mjs
git commit -m "feat: Claude client for first-party or Vertex AI (no server-side fallback on Vertex)"
```

---

### Task 2: Verify IAP's JWT and bind personas to signed-in emails

**Files:**
- Create: `src/iap.mjs`
- Modify: `src/server.mjs`:
  - `createServer` gets an option `iap`.
  - `viewerOf` at about line 128.
  - The run-directly block builds `iap` from env.
- Modify: `src/actions.mjs`. The three `log({ actor: ... })` calls (about lines 687, 735 and 770) add `signedIn: actor.signedIn ?? null`.
- Test: `test/iap.test.mjs` (new)

**Interfaces:**
- Produces: `export async function verifyIapJwt(token: string, { audience: string, keys: (refresh: boolean) => Promise<JWK[]>, now?: number }): Promise<{ email: string, sub: string }>`.
  - The token must be ES256.
  - `iss` must be `https://cloud.google.com/iap`, and `aud` must equal `audience`.
  - `exp` and `iat` are checked with a 60 s leeway.
  - It looks up `kid` in `keys(false)`, then once in `keys(true)`.
  - Every refusal is an `Error` whose message names the reason: `audience`, `issuer`, `expired`, `not yet valid`, `signature`, `algorithm` or `unknown key`.
- Produces: `export function googleIapKeys(fetchImpl = fetch): (refresh: boolean) => Promise<JWK[]>`. It fetches `https://www.gstatic.com/iap/verify/public_key-jwk` (field `keys`) and caches the result for an hour.
- Produces: `export function parseOperators(spec: string): Map<string, "*" | Set<string>>`. Example input: `"matthewkoeberg13@gmail.com=*,someone@x.co.za=P-028|P-002"`. Keys are lower-cased.
- Produces: `export function mayActAs(operators, email: string, personId: string): boolean`.
- `createServer(sys, { kgTools, iap })`, where `iap` is `{ audience, keys, operators } | undefined`. When it is set, `viewerOf` works in three steps:
  1. Read `x-goog-iap-jwt-assertion` and verify it. Failure gives 401.
  2. Take the persona from `x-acting-user` or `?as=`. If there is none, return 400 "say which person you are acting as".
  3. Check the email may act as that persona. If not, return 403. Otherwise the viewer gets `signedIn: email`.
- `viewerOf` becomes async, so every call site awaits it.

- [ ] **Step 1: Write the failing tests in `test/iap.test.mjs`**

Make an ES256 key pair with `crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })` and export the public key as a JWK with `kid: "k1"`. Sign test JWTs by hand with base64url header and payload plus `crypto.sign("sha256", …, { key, dsaEncoding: "ieee-p1363" })`.

Tests, each named as below:
- `a valid token gives its email`: `{ email: "a@b.co", sub: "s" }`.
- `wrong audience` rejects with /audience/.
- `wrong issuer` rejects with /issuer/.
- `expired` rejects with /expired/ when `exp` is more than 60 s in the past.
- `iat 30 s ahead is accepted`.
- `tampered payload` rejects with /signature/.
- `alg HS256` rejects with /algorithm/.
- `unknown kid refetches once`: `keys` is called with `false` and then `true`, and the call succeeds when the second set has the kid.
- `email match ignores case`: `mayActAs(parseOperators("matthew@novatekllc.co.za=*"), "Matthew@NovatekLLC.co.za", "P-028") === true`.
- `a listed persona only`: `mayActAs(parseOperators("x@y.z=P-028|P-002"), "x@y.z", "P-001") === false`.

Server tests, using `createServer(createSystem({ seed: 7 }), { iap: { audience: "/projects/1/locations/r/services/s", keys: async () => [jwk], operators: parseOperators("ok@x.co=*,one@x.co=P-028") } })`:
- `no JWT is a 401` on `GET /api/plant`.
- `valid JWT and allowed persona is a 200`, with headers `x-goog-iap-jwt-assertion` and `x-acting-user: P-001`.
- `persona not allowed is a 403` for `one@x.co` acting as `P-001`.
- `no persona is a 400`.
- `events and mcp need the JWT too`: `GET /api/events?as=P-001` and `POST /mcp` without the JWT both give 401.
- `the audit records who signed in`: `POST /api/actions/raise_alert` as `ok@x.co` acting as `P-001`. The last audit entry then has `actor: "P-001"` and `signedIn: "ok@x.co"`.
- `no iap option keeps today's behaviour`: plain `createServer(sys)` with `x-acting-user` gives 200 and no JWT is needed.

- [ ] **Step 2: Run them and check they fail**

Run `node --test test/iap.test.mjs`. Expected: FAIL, because `src/iap.mjs` does not exist.

- [ ] **Step 3: Implement `src/iap.mjs`, then wire the server and audit**

`verifyIapJwt`:
1. Split the token on `.`.
2. Parse the base64url JSON header and payload.
3. Check `alg === "ES256"`.
4. Turn the JWK into a key with `crypto.createPublicKey({ key: jwk, format: "jwk" })`.
5. Verify `crypto.verify("sha256", Buffer.from(h + "." + p), { key, dsaEncoding: "ieee-p1363" }, sig)`.
6. Check the claims.

The run-directly block sets `iap` only when `process.env.WWOS_IAP_AUDIENCE` is set. Use `keys: googleIapKeys()` and `operators: parseOperators(process.env.WWOS_OPERATORS || "")`.

- [ ] **Step 4: Run all tests**

Run `node --test test/iap.test.mjs`, then `npm test`. Expected: PASS, with nothing else changed.

- [ ] **Step 5: Commit**

```bash
git add src/iap.mjs src/server.mjs src/actions.mjs test/iap.test.mjs
git commit -m "feat: verify IAP sign-in and bind personas to allowed emails; audit records who signed in"
```

---

### Task 3: One script for the front door, parameterised for the company project

**Files:**
- Create: `deploy/gcp/front-door.sh` (bash, `set -euo pipefail`)
- Create: `deploy/gcp/front-door.env.example`, with every parameter and today's values commented in
- Create: `deploy/gcp/front-door.env` (this project's values; no secrets, so it is committed)
- Modify: `.gcloudignore` only if the script's files would be uploaded. The allowlist already excludes `deploy/`, so check with `gcloud meta list-files-for-upload`.
- Modify: `docs/CLOUD-RUN.md`:
  - Sign-in replaces "open it through the proxy".
  - Add "Move to the company project": edit `front-door.env` and run the script.
  - Remove the warning that `x-acting-user` is trusted, and add one line on demo operators.
- Test: `test/front-door-script.test.mjs` (new)

**Interfaces:**
- Parameters, as env vars read from the file named in argv[1], default `deploy/gcp/front-door.env`:
  - `PROJECT`, `REGION`, `SERVICE`, `BILLING_ACCOUNT`, `BUDGET_USD`, `ALERT_EMAIL`
  - `IAP_USERS`, comma-separated
  - `VERTEX_REGION`, `LLM_MODEL`
  - `SERVICE_ACCOUNT_NAME`, default `wateros-run`
- `DRY_RUN=1` prints each gcloud command on its own line, prefixed `+ `, and runs none.
- The script works out `WWOS_IAP_AUDIENCE` as `/projects/<PROJECT_NUMBER>/locations/<REGION>/services/<SERVICE>`, getting the number with `gcloud projects describe`. `WWOS_OPERATORS` comes from `IAP_USERS`, each `=*`.

- [ ] **Step 1: Write the failing test in `test/front-door-script.test.mjs`**

Spawn `bash deploy/gcp/front-door.sh deploy/gcp/front-door.env` with `DRY_RUN=1` and `PROJECT_NUMBER=426022356353`. The env override skips the describe call in a dry run. Assert the output:
- contains `gcloud run deploy water-works-os` with `--iap` and `--no-allow-unauthenticated`;
- contains `--service-account wateros-run@se-project-49281.iam.gserviceaccount.com`;
- contains `WWOS_LLM_PROVIDER=vertex`;
- contains `WWOS_IAP_AUDIENCE=/projects/426022356353/locations/africa-south1/services/water-works-os`;
- contains `roles/iap.httpsResourceAccessor` once for each of the two users;
- contains `roles/aiplatform.user`;
- contains `gcloud billing budgets create` with `--budget-amount=25USD` and three `--threshold-rule`s at 0.5, 0.9 and 1.0;
- contains `gcloud monitoring uptime create`;
- never contains `--allow-unauthenticated` or `ANTHROPIC_API_KEY`.

- [ ] **Step 2: Run it and check it fails**

Run `node --test test/front-door-script.test.mjs`. Expected: FAIL, because the script is missing.

- [ ] **Step 3: Write the script**

The steps, in order. Each create step tolerates "already exists", so the script can be re-run:
1. Enable `iap`, `aiplatform`, `run`, `cloudbuild`, `artifactregistry`, `monitoring` and `billingbudgets`.
2. Create the service account, and grant it `roles/aiplatform.user` on the project.
3. Run `gcloud run deploy --source . --iap --no-allow-unauthenticated --service-account … --set-env-vars WWOS_LLM_PROVIDER=vertex,WWOS_VERTEX_PROJECT=…,WWOS_VERTEX_REGION=…,WWOS_LLM_MODEL=…,WWOS_IAP_AUDIENCE=…,WWOS_OPERATORS=…`. Keep the memory, CPU and instance flags from `docs/CLOUD-RUN.md`.
4. Grant the IAP service agent `service-<PROJECT_NUMBER>@gcp-sa-iap.iam.gserviceaccount.com` the role `roles/run.invoker`.
5. Run `gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=… --region=… --member=user:<each> --role=roles/iap.httpsResourceAccessor`.
6. Create the budget.
7. Create the email notification channel, then the uptime check on the service URL. Accept 302 and 401, since IAP answers an anonymous request that way, and that proves the service is up. Then create the alert policy on that check.

Before writing steps 6 and 7, read `gcloud billing budgets create --help` and `gcloud monitoring uptime create --help` and use their exact flags. If gcloud has no GA command for the alert policy, write the policy as JSON in `deploy/gcp/uptime-policy.json` and create it with the REST API through `curl` and `gcloud auth print-access-token`.

- [ ] **Step 4: Run the tests and a dry run**

Run `node --test test/front-door-script.test.mjs`. Expected: PASS. Then run `DRY_RUN=1 bash deploy/gcp/front-door.sh` and read the printed plan.

- [ ] **Step 5: Commit**

```bash
git add deploy/gcp/ test/front-door-script.test.mjs docs/CLOUD-RUN.md
git commit -m "feat: front-door deploy script (IAP, Vertex service account, budget, uptime) with project as a parameter"
```

---

### Task 4: Go live and prove it

Nothing in this task runs without the user's yes. Steps 1 and 3 are the user's own.

**Files:**
- Modify: `docs/adr/0001-stack-decision.md`: Status "accepted 2026-11-07 for the AI and API edge rows, slice 1", plus a line on the chosen Vertex region.
- Modify: `deploy/gcp/front-door.env`: `VERTEX_REGION` and `LLM_MODEL` as confirmed in Step 2.

- [ ] **Step 1 (user): enable Claude on Vertex and confirm the second account**
  - In the Console, go to Vertex AI → Model Garden → Claude Opus 5.5 → Enable, and accept Anthropic's terms there. Only the user can accept terms.
  - Confirm `matthew@novatekllc.co.za` is a Google account (Workspace or a Google Account on that address). IAP cannot let in an address that isn't one.

- [ ] **Step 2: Find the region and model ID, and smoke-test Vertex from this machine**
  - The user runs `! gcloud auth application-default login`.
  - Read the Model Garden page for Claude Opus 5.5 to get its regions and Vertex model ID, and take the region nearest to Johannesburg.
  - Run the existing `askClaude` with `WWOS_LLM_PROVIDER=vertex WWOS_VERTEX_PROJECT=se-project-49281 WWOS_VERTEX_REGION=<region> WWOS_LLM_MODEL=<id>`.
  - Expected: a text reply, not `null`. Put the values in `front-door.env`.

- [ ] **Step 3 (user): say yes to the deploy**

PR #1 should be merged first. The user also approves the budget and alert being created.

- [ ] **Step 4: Run `bash deploy/gcp/front-door.sh`**

Expected: the script exits 0 and prints the service URL.

- [ ] **Step 5: Prove it**

Each check, with the result that means it passed:
- `curl -s -o /dev/null -w "%{http_code}"` on the service URL returns 302 or 401, never 200.
- `gcloud run services proxy` and a request with `x-acting-user` but no IAP JWT get 401 from the app itself. That proves the app no longer trusts the header.
- The user signs in, in their own browser: the app loads, and a Site Agent question shows "written by Claude".
- `gcloud logging read` shows no `[llm]` errors.
- The audit log for one action shows the signed-in email.
- `gcloud billing budgets list` shows the USD 25 budget, and the uptime check is green in Monitoring.

- [ ] **Step 6: Commit and open the PR**

```bash
git add docs/adr/0001-stack-decision.md deploy/gcp/front-door.env
git commit -m "docs: ADR 0001 accepted for slice 1; Vertex region and model recorded"
gh pr create --base main --title "GCP slice 1: IAP sign-in, Claude on Vertex AI, budget and uptime alerts"
```
