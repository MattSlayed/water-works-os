import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Git for Windows' bash; never WSL's C:\Windows\System32\bash.exe.
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const skip = process.platform === "win32" && !existsSync(bash) ? "Git for Windows bash not found" : false;

const dry = (env = {}, args = ["deploy/gcp/front-door.env"]) =>
  spawnSync(bash, ["deploy/gcp/front-door.sh", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, DRY_RUN: "1", PROJECT_NUMBER: "426022356353", ...env },
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
  assert.match(out, /gcloud monitoring uptime create water-works-os-uptime .*--status-codes=302,401/);
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
  const r = dry({}, ["test/fixtures/front-door-incomplete.env"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /IAP_USERS/);
  assert.equal(r.stdout, "");
});
