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
// The committed env file with some values changed.
const envWith = (vals) => tmpFile(Object.entries(vals).reduce((t, [k, v]) => t.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`),
  readFileSync(path.join(root, "deploy/gcp/front-door.env"), "utf8")));

// This project has no organisation, so IAP needs the custom OAuth client; the fixture holds a sentinel secret.
const CLIENT_SECRET = "GOCSPX-SENTINEL-456";
const dry = (env = {}, file = envWith({ IAP_OAUTH_CLIENT_FILE: "test/fixtures/iap-oauth-client.json" })) =>
  spawnSync(bash, ["deploy/gcp/front-door.sh", file], {
    cwd: root, encoding: "utf8", env: { ...process.env, DRY_RUN: "1", PROJECT_NUMBER: "426022356353", ORG_CHECK: "none", ...env },
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
  assert.match(out, /WWOS_LLM_PROVIDER=vertex/);
  assert.match(out, /WWOS_VERTEX_PROJECT=se-project-49281/);
  assert.match(out, /WWOS_IAP_AUDIENCE=\/projects\/426022356353\/locations\/africa-south1\/services\/water-works-os/);
  assert.match(out, /WWOS_OPERATORS=matthewkoeberg13@gmail\.com=\*,matthew@novatekllc\.co\.za=\*/);

  // Flag spellings as `gcloud <cmd> --help` shows them (gcloud 581).
  for (const u of ["matthewkoeberg13@gmail.com", "matthew@novatekllc.co.za"]) {
    const re = new RegExp(`gcloud iap web add-iam-policy-binding .*--resource-type=cloud-run .*--service=water-works-os .*--region=africa-south1 .*--member=user:${u.replace(/\./g, "\\.")} .*--role=roles/iap\\.httpsResourceAccessor`);
    assert.equal(count(out, new RegExp(re.source, "g")), 1, u);
  }
  assert.equal(count(out, /roles\/iap\.httpsResourceAccessor/g), 2);
  assert.match(out, /roles\/aiplatform\.user/);
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
  assert.match(out, /gcloud monitoring policies create .*--notification-channels=/);

  assert.doesNotMatch(out, /--allow-unauthenticated/);
  assert.doesNotMatch(out, /ANTHROPIC_API_KEY/);
});

test("re-running looks before it creates", { skip }, () => {
  const out = dry().stdout;
  for (const what of ["iam service-accounts list", "billing budgets list", "beta monitoring channels list", "monitoring uptime list-configs", "monitoring policies list"])
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
