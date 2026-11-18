import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Git for Windows' bash; never WSL's C:\Windows\System32\bash.exe.
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const skip = process.platform === "win32" && !existsSync(bash) ? "Git for Windows bash not found" : false;

// A temp file as Git Bash names it (C:\x\y -> /c/x/y).
const tmp = mkdtempSync(path.join(tmpdir(), "front-door-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const bashPath = (p) => process.platform === "win32" ? p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`) : p;
let n = 0;
const tmpFile = (text) => { const f = path.join(tmp, `${++n}`); writeFileSync(f, text); return bashPath(f); };
// The committed env file with some values changed. The client file path is set per test, never taken from this machine.
const envWith = (vals) => tmpFile(Object.entries({ IAP_OAUTH_CLIENT_FILE: "", ...vals }).reduce((t, [k, v]) => t.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`),
  readFileSync(path.join(root, "deploy/gcp/front-door.env"), "utf8")));

// This project has no organisation, so IAP needs the custom OAuth client; the fixture holds a sentinel secret.
// The Anthropic key comes from the caller's environment: a sentinel here, never a real key from the test runner's shell.
const CLIENT_SECRET = "GOCSPX-SENTINEL-456", API_KEY = "sk-test-SENTINEL-123";
const dry = (env = {}, file = envWith({ IAP_OAUTH_CLIENT_FILE: "test/fixtures/iap-oauth-client.json" }), flags = []) =>
  spawnSync(bash, [...flags, "deploy/gcp/front-door.sh", file], {
    cwd: root, encoding: "utf8", env: { ...process.env, DRY_RUN: "1", PROJECT_NUMBER: "426022356353", ORG_CHECK: "none", ANTHROPIC_API_KEY: API_KEY, ...env },
  });
const count = (s, re) => (s.match(re) || []).length;

test("dry run prints the whole front-door plan and runs nothing", { skip }, () => {
  const r = dry();
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  for (const line of out.split("\n").filter(Boolean)) assert.match(line, /^\+ /, `every line is a printed command: ${line}`);

  assert.match(out, /gcloud run deploy water-works-os\b.*--iap\b.*--no-allow-unauthenticated/);
  assert.match(out, /--service-account wateros-run@se-project-49281\.iam\.gserviceaccount\.com/);
  assert.match(out, /--memory 1Gi --cpu 1 --min-instances 0 --max-instances 1/);
  assert.match(out, /WWOS_LLM_MODEL=claude-opus-5-5/);
  assert.match(out, /WWOS_IAP_AUDIENCE=\/projects\/426022356353\/locations\/africa-south1\/services\/water-works-os/);
  assert.match(out, /WWOS_OPERATORS=matthewkoeberg13@gmail\.com=\*,matthew@novatekllc\.co\.za=\*/);

  // Flag spellings as `gcloud <cmd> --help` shows them (gcloud 581).
  for (const u of ["matthewkoeberg13@gmail.com", "matthew@novatekllc.co.za"]) {
    const re = new RegExp(`gcloud iap web add-iam-policy-binding .*--resource-type=cloud-run .*--service=water-works-os .*--region=africa-south1 .*--member=user:${u.replace(/\./g, "\\.")} .*--role=roles/iap\\.httpsResourceAccessor`);
    assert.equal(count(out, new RegExp(re.source, "g")), 1, u);
  }
  assert.equal(count(out, /roles\/iap\.httpsResourceAccessor/g), 2);
  assert.match(out, /serviceAccount:service-426022356353@gcp-sa-iap\.iam\.gserviceaccount\.com --role=roles\/run\.invoker/);

  assert.match(out, /gcloud billing budgets create .*--budget-amount=25USD/);
  for (const p of ["0.5", "0.9", "1.0"]) assert.match(out, new RegExp(`--threshold-rule=percent=${p}\\s`));
  assert.equal(count(out, /--threshold-rule=/g), 3);
  assert.match(out, /--billing-account=01B233-16D37B-41FAFF/);
  assert.match(out, /--display-name=se-project-49281-water-works-os-budget /);
  assert.match(out, /budgets list .*--filter=displayName=se-project-49281-water-works-os-budget /);

  assert.match(out, /gcloud beta monitoring channels create .*--type=email .*email_address=/);
  // A check follows IAP's redirect to Google's sign-in page and gets a 200; as an AJAX request it gets IAP's 401 instead.
  assert.match(out, /gcloud monitoring uptime create water-works-os-uptime .*--headers=X-Requested-With=XMLHttpRequest .*--status-codes=401 /);
  assert.match(out, /--resource-labels=host=water-works-os-426022356353\.africa-south1\.run\.app,project_id=se-project-49281/);
  assert.doesNotMatch(out, /--path=/, "Git Bash would rewrite --path=/; the default path is /");
  assert.match(out, /gcloud monitoring policies create .*--notification-channels=\S+ --combiner=OR /);

  assert.doesNotMatch(out, /--allow-unauthenticated/);
  assert.match(out, /gcloud services enable .*cloudresourcemanager\.googleapis\.com/, "step 6 fails without it on a fresh project");

  // saved state: a private bucket in the region, mounted where WWOS_STATE_FILE points, writable by the runtime account
  assert.match(out, /gcloud storage buckets create gs:\/\/se-project-49281-water-works-os-state --project se-project-49281 --location=africa-south1 --uniform-bucket-level-access --public-access-prevention/);
  assert.match(out, /buckets add-iam-policy-binding gs:\/\/se-project-49281-water-works-os-state --member=serviceAccount:wateros-run@se-project-49281\.iam\.gserviceaccount\.com --role=roles\/storage\.objectUser/);
  assert.match(out, /--add-volume=name=state,type=cloud-storage,bucket=se-project-49281-water-works-os-state,mount-options=uid=1000;gid=1000/);
  assert.match(out, /--add-volume-mount=volume=state,mount-path=\/state/);
  assert.match(out, /WWOS_STATE_FILE=\/state\/wateros-state\.json/);
  assert.ok(out.indexOf("buckets create") < out.indexOf("gcloud run deploy"), "the bucket exists before the deploy mounts it");
});

test("anthropic: the key goes to Secret Manager, readable by the runtime account on that secret only, never shown", { skip }, () => {
  for (const flags of [[], ["-x"]]) {  // -x: a traced run must not show it either
    const r = dry({}, undefined, flags);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /gcloud services enable .*secretmanager\.googleapis\.com/);
    assert.match(out, /gcloud secrets list --project se-project-49281 /);
    assert.match(out, /gcloud secrets create anthropic-api-key --project se-project-49281 --replication-policy=automatic\n/);
    assert.match(out, /gcloud secrets versions add anthropic-api-key --project se-project-49281 --data-file=- /);
    assert.match(out, /gcloud secrets add-iam-policy-binding anthropic-api-key --project se-project-49281 --member=serviceAccount:wateros-run@se-project-49281\.iam\.gserviceaccount\.com --role=roles\/secretmanager\.secretAccessor/);
    assert.doesNotMatch(out, /projects add-iam-policy-binding .*secretAccessor/, "never project-wide");
    assert.match(out, /gcloud run deploy .*--set-secrets=ANTHROPIC_API_KEY=anthropic-api-key:latest/);
    assert.doesNotMatch(out, /aiplatform/, "least privilege: no Vertex role");
    assert.doesNotMatch(out, /WWOS_LLM_PROVIDER|WWOS_VERTEX_/);
    assert.ok(!(r.stdout + r.stderr).includes(API_KEY), `the key is shown${flags.length ? " in a trace" : ""}`);
    assert.ok(!(r.stdout + r.stderr).includes(CLIENT_SECRET));
  }
});

test("anthropic: a secret with no version and no ANTHROPIC_API_KEY stops before the deploy", { skip }, () => {
  const r = dry({ ANTHROPIC_API_KEY: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /anthropic-api-key has no enabled version and ANTHROPIC_API_KEY is empty: export it/);
  assert.doesNotMatch(r.stdout, /secrets create|run deploy/);
});

test("vertex: today's plan, no key mounted (a switch from anthropic drops it)", { skip }, () => {
  const r = dry({}, envWith({ LLM_PROVIDER: "vertex", IAP_OAUTH_CLIENT_FILE: "test/fixtures/iap-oauth-client.json" }));
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /gcloud services enable .*aiplatform\.googleapis\.com/);
  assert.match(out, /gcloud projects add-iam-policy-binding se-project-49281 --member=serviceAccount:wateros-run@se-project-49281\.iam\.gserviceaccount\.com --role=roles\/aiplatform\.user/);
  assert.match(out, /WWOS_LLM_PROVIDER=vertex/);
  assert.match(out, /WWOS_VERTEX_PROJECT=se-project-49281/);
  assert.match(out, /WWOS_VERTEX_REGION=global/);
  assert.match(out, /WWOS_LLM_MODEL=claude-opus-5-5/);
  assert.match(out, /gcloud run deploy .*--clear-secrets/);
  assert.doesNotMatch(out, /secretmanager|gcloud secrets /);
  assert.doesNotMatch(out, /ANTHROPIC_API_KEY/);
});

test("an LLM_PROVIDER other than anthropic or vertex stops the script", { skip }, () => {
  const r = dry({}, envWith({ LLM_PROVIDER: "openai", IAP_OAUTH_CLIENT_FILE: "test/fixtures/iap-oauth-client.json" }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /LLM_PROVIDER must be anthropic or vertex, not 'openai'/);
  assert.equal(r.stdout, "");
});

test("the budget is in BUDGET_CURRENCY, the billing account's own", { skip }, () => {
  const file = envWith({ BUDGET_CURRENCY: "ZAR", IAP_OAUTH_CLIENT_FILE: "test/fixtures/iap-oauth-client.json" });
  assert.match(dry({}, file).stdout, /gcloud billing budgets create .*--budget-amount=25ZAR /);
});

test("re-running looks before it creates", { skip }, () => {
  const out = dry().stdout;
  for (const what of ["iam service-accounts list", "secrets list", "billing budgets list", "beta monitoring channels list", "monitoring uptime list-configs", "monitoring policies list"])
    assert.ok(out.includes(`gcloud ${what}`), what);
});

test("a dry run without PROJECT_NUMBER shows the describe command and a placeholder", { skip }, () => {
  const r = dry({ PROJECT_NUMBER: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\+ gcloud projects describe se-project-49281 /);
  assert.match(r.stdout, /WWOS_IAP_AUDIENCE=\/projects\/<PROJECT_NUMBER>\/locations\/africa-south1/);
});

test("a missing parameter stops the script before anything is printed", { skip }, () => {
  const r = dry({}, "test/fixtures/front-door-incomplete.env");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /IAP_USERS/);
  assert.equal(r.stdout, "");
});

test("no organisation and no OAuth client file stops before anything is planned", { skip }, () => {
  for (const file of [envWith({}), envWith({ IAP_OAUTH_CLIENT_FILE: "/nope/client.json" })]) {
    const r = dry({}, file);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no organisation.*IAP_OAUTH_CLIENT_FILE.*docs\/CLOUD-RUN\.md, "IAP sign-in without an organisation"/);
    assert.equal(r.stdout, "");
  }
});

test("no organisation: the client is applied to IAP before the deploy and its secret is never shown", { skip }, () => {
  const r = dry();
  assert.equal(r.status, 0, r.stderr);
  const m = r.stdout.match(/^\+ gcloud iap settings set (\S+) --project se-project-49281 --format=none$/m);
  assert.ok(m, r.stdout);
  assert.ok(r.stdout.indexOf(m[0]) < r.stdout.indexOf("gcloud run deploy"), "set before --iap is turned on");
  assert.ok(!existsSync(m[1]), "the settings file is deleted on exit");
  assert.ok(!(r.stdout + r.stderr).includes(CLIENT_SECRET));
});

test("a broken OAuth client file stops the script without echoing its contents", { skip }, () => {
  const r = dry({}, envWith({ IAP_OAUTH_CLIENT_FILE: tmpFile(`{"web":{"client_secret":"${CLIENT_SECRET}"`) }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a web OAuth client JSON/);
  assert.ok(!(r.stdout + r.stderr).includes(CLIENT_SECRET));
});

test("a project in an organisation needs no OAuth client, but uses one when given (users outside the organisation)", { skip }, () => {
  const r = dry({ ORG_CHECK: "organization" }, envWith({}));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /iap settings set/);
  assert.match(dry({ ORG_CHECK: "organization" }).stdout, /gcloud iap settings set /);
});
