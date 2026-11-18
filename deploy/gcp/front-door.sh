#!/usr/bin/env bash
# WaterOS front door on Google Cloud: sign-in (IAP), Claude (first-party API with its key in Secret Manager, or Vertex AI
# as the service account), budget, uptime alert.
# Usage: deploy/gcp/front-door.sh [env-file]      (default: deploy/gcp/front-door.env, see front-door.env.example)
#        DRY_RUN=1 deploy/gcp/front-door.sh       prints every gcloud command as "+ ..." and runs none
# Safe to re-run: every create step looks first, the rest are idempotent in gcloud.
set -euo pipefail
# Git for Windows' bash rewrites path-like arguments to native programs (--path=/ became C:/Program Files/Git/), so
# no --flag is converted. Not MSYS_NO_PATHCONV=1: the gcloud wrapper needs its own gcloud.py path converted.
export MSYS2_ARG_CONV_EXCL=--

DRY_RUN=${DRY_RUN:-0}
PN_OVERRIDE=${PROJECT_NUMBER:-}   # lets a dry run skip the describe lookup
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ENV_FILE=${1:-deploy/gcp/front-door.env}
[[ $ENV_FILE = /* ]] || ENV_FILE=$PWD/$ENV_FILE
[[ -f $ENV_FILE ]] || { echo "front-door: no env file at $ENV_FILE" >&2; exit 2; }
cd "$ROOT"

set -a; source "$ENV_FILE"; set +a
SERVICE_ACCOUNT_NAME=${SERVICE_ACCOUNT_NAME:-wateros-run}
ANTHROPIC_SECRET=${ANTHROPIC_SECRET:-anthropic-api-key}
STATE_BUCKET=${STATE_BUCKET:-$PROJECT-$SERVICE-state}  # bucket names are global, so the default carries the project
for v in PROJECT REGION SERVICE BILLING_ACCOUNT BUDGET_USD ALERT_EMAIL IAP_USERS VERTEX_REGION LLM_MODEL LLM_PROVIDER; do
  [[ -n ${!v:-} ]] || { echo "front-door: $v is empty in $ENV_FILE" >&2; exit 2; }
done
[[ $LLM_PROVIDER = anthropic || $LLM_PROVIDER = vertex ]] || { echo "front-door: LLM_PROVIDER must be anthropic or vertex, not '$LLM_PROVIDER'" >&2; exit 2; }
[[ $DRY_RUN = 1 ]] || command -v gcloud >/dev/null || { echo "front-door: gcloud is not on PATH" >&2; exit 2; }

# IAP's Google-managed OAuth client admits only an organisation's own users, so a project without one (or with users
# outside it) needs a custom client, made once by hand in the Console. The lookup is read-only, so a dry run makes it
# too (tests: ORG_CHECK=none|organization).
ANCESTORS=${ORG_CHECK:-$(gcloud projects get-ancestors "$PROJECT" '--format=value(type)')}
IAP_SETTINGS=""
if [[ $ANCESTORS != *organization* || -n ${IAP_OAUTH_CLIENT_FILE:-} ]]; then
  [[ -f ${IAP_OAUTH_CLIENT_FILE:-} ]] || { echo "front-door: IAP needs a custom OAuth client here ($PROJECT has no organisation, or IAP_OAUTH_CLIENT_FILE is set), but IAP_OAUTH_CLIENT_FILE in $ENV_FILE names no file: see docs/CLOUD-RUN.md, \"IAP sign-in without an organisation\"" >&2; exit 2; }
  IAP_SETTINGS=$(mktemp)  # mode 600 from mktemp; it holds the client secret, so it is deleted on exit
  trap 'rm -f "$IAP_SETTINGS"' EXIT
  command -v cygpath >/dev/null && IAP_SETTINGS=$(cygpath -m "$IAP_SETTINGS")  # gcloud on Windows is native and needs C:/...
  # node moves the secret from file to file, so it never passes through bash, a trace or an error message.
  node -e 'try { const w = JSON.parse(require("fs").readFileSync(0, "utf8")).web; if (!w.client_id || !w.client_secret) throw 0;
    process.stdout.write(JSON.stringify({ accessSettings: { oauthSettings: { clientId: w.client_id, clientSecret: w.client_secret } } }));
  } catch { console.error("front-door: IAP_OAUTH_CLIENT_FILE is not a web OAuth client JSON (web.client_id, web.client_secret)"); process.exit(2); }' \
    <"$IAP_OAUTH_CLIENT_FILE" >"$IAP_SETTINGS"
fi

# say: print one command, shell-quoted only where needed.
say() { printf '+'; local a; for a; do [[ $a =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]] && printf ' %s' "$a" || printf " '%s'" "${a//\'/\'\\\'\'}"; done; printf '\n'; }
# run: execute (or, in a dry run, print) one command.
run() { if [[ $DRY_RUN = 1 ]]; then say "$@"; else "$@"; fi; }
# get VAR placeholder cmd...: VAR = first line of the command's output (dry run: print it, VAR = placeholder).
get() {
  local var=$1 ph=$2 o; shift 2
  if [[ $DRY_RUN = 1 ]]; then say "$@"; printf -v "$var" '%s' "$ph"; return; fi
  o=$("$@"); printf -v "$var" '%s' "${o%%$'\n'*}"
}
# retry: a new service account takes a few seconds to be visible to IAM.
retry() { local i; for i in 1 2 3 4 5 6; do "$@" && return 0; sleep 5; done; "$@"; }
run_retry() { if [[ $DRY_RUN = 1 ]]; then say "$@"; else retry "$@"; fi; }

if [[ -n $PN_OVERRIDE ]]; then PROJECT_NUMBER=$PN_OVERRIDE
else get PROJECT_NUMBER '<PROJECT_NUMBER>' gcloud projects describe "$PROJECT" '--format=value(projectNumber)'; fi

SA_EMAIL=$SERVICE_ACCOUNT_NAME@$PROJECT.iam.gserviceaccount.com
IAP_AGENT=service-$PROJECT_NUMBER@gcp-sa-iap.iam.gserviceaccount.com
HOST=$SERVICE-$PROJECT_NUMBER.$REGION.run.app
AUDIENCE=/projects/$PROJECT_NUMBER/locations/$REGION/services/$SERVICE
USERS=(); OPERATORS=""
IFS=, read -ra raw <<<"$IAP_USERS"
for u in "${raw[@]}"; do u=${u//[[:space:]]/}; [[ -z $u ]] || { USERS+=("$u"); OPERATORS+=${OPERATORS:+,}$u=*; }; done
[[ ${#USERS[@]} -gt 0 ]] || { echo "front-door: IAP_USERS has no users" >&2; exit 2; }  # empty operators = every request 403
# Env values hold commas, so the list uses gcloud's alternate delimiter: ^|^KEY=V|KEY=V
ENV_VARS="^|^WWOS_HOST=0.0.0.0|WWOS_LLM_MODEL=$LLM_MODEL|WWOS_IAP_AUDIENCE=$AUDIENCE|WWOS_OPERATORS=$OPERATORS|WWOS_STATE_FILE=/state/wateros-state.json"
if [[ $LLM_PROVIDER = vertex ]]; then
  LLM_API=aiplatform.googleapis.com SECRETS=--clear-secrets  # a switch from anthropic must not leave the key mounted
  ENV_VARS+="|WWOS_LLM_PROVIDER=vertex|WWOS_VERTEX_PROJECT=$PROJECT|WWOS_VERTEX_REGION=$VERTEX_REGION"
else
  LLM_API=secretmanager.googleapis.com SECRETS=--set-secrets=ANTHROPIC_API_KEY=$ANTHROPIC_SECRET:latest
fi

echo "== 1. enable APIs" >&2
run gcloud services enable iap.googleapis.com "$LLM_API" run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com monitoring.googleapis.com billingbudgets.googleapis.com storage.googleapis.com --project "$PROJECT"

echo "== 2. service account $SA_EMAIL and its access to Claude ($LLM_PROVIDER)" >&2
get found '' gcloud iam service-accounts list --project "$PROJECT" "--filter=email=$SA_EMAIL" '--format=value(email)'
[[ -n $found ]] || run gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" --project "$PROJECT" --display-name "$SERVICE runtime"
if [[ $LLM_PROVIDER = vertex ]]; then
  run_retry gcloud projects add-iam-policy-binding "$PROJECT" "--member=serviceAccount:$SA_EMAIL" --role=roles/aiplatform.user --condition=None --format=none
else
  # The key is read from the caller's ANTHROPIC_API_KEY only when the secret has no enabled version yet. It is never
  # expanded on a command line (a trace would show it): node writes it to gcloud's stdin.
  get found '' gcloud secrets list --project "$PROJECT" "--filter=name~/secrets/$ANTHROPIC_SECRET\$" '--format=value(name)'
  version=''
  [[ -z $found ]] || get version '' gcloud secrets versions list "$ANTHROPIC_SECRET" --project "$PROJECT" --filter=state=enabled '--format=value(name)'
  if [[ -z $version ]]; then
    [[ -n ${ANTHROPIC_API_KEY:+set} ]] || { echo "front-door: secret $ANTHROPIC_SECRET has no enabled version and ANTHROPIC_API_KEY is empty: export it in this shell first (docs/CLOUD-RUN.md, \"Claude's API key\")" >&2; exit 2; }
    [[ -n $found ]] || run gcloud secrets create "$ANTHROPIC_SECRET" --project "$PROJECT" --replication-policy=automatic
    if [[ $DRY_RUN = 1 ]]; then say gcloud secrets versions add "$ANTHROPIC_SECRET" --project "$PROJECT" --data-file=- '<stdin: $ANTHROPIC_API_KEY, not shown>'
    else node -e 'process.stdout.write(process.env.ANTHROPIC_API_KEY)' | gcloud secrets versions add "$ANTHROPIC_SECRET" --project "$PROJECT" --data-file=-; fi
  fi
  run_retry gcloud secrets add-iam-policy-binding "$ANTHROPIC_SECRET" --project "$PROJECT" "--member=serviceAccount:$SA_EMAIL" --role=roles/secretmanager.secretAccessor --format=none
fi

echo "== 2b. state bucket gs://$STATE_BUCKET in $REGION, writable by the runtime account only" >&2
# Saved state stays in the region (POPIA). Soft delete keeps overwritten snapshots 7 days, so a bad save can be rolled back.
get found '' gcloud storage buckets list --project "$PROJECT" "--filter=name=$STATE_BUCKET" '--format=value(name)'
[[ -n $found ]] || run gcloud storage buckets create "gs://$STATE_BUCKET" --project "$PROJECT" "--location=$REGION" \
  --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=7d
run_retry gcloud storage buckets add-iam-policy-binding "gs://$STATE_BUCKET" "--member=serviceAccount:$SA_EMAIL" --role=roles/storage.objectUser --format=none

if [[ -n $IAP_SETTINGS ]]; then
  echo "== 3. IAP sign-in uses the custom OAuth client" >&2
  run gcloud iap settings set "$IAP_SETTINGS" --project "$PROJECT" --format=none
fi

echo "== 4. deploy (IAP on, no public access)" >&2
run gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --source . --iap --no-allow-unauthenticated \
  --service-account "$SA_EMAIL" --memory 1Gi --cpu 1 --min-instances 0 --max-instances 1 "--set-env-vars=$ENV_VARS" "$SECRETS" \
  --clear-volumes "--add-volume=name=state,type=cloud-storage,bucket=$STATE_BUCKET,mount-options=uid=1000;gid=1000" \
  --clear-volume-mounts --add-volume-mount=volume=state,mount-path=/state
# max-instances 1 is also what keeps the state file single-writer: two instances would overwrite each other's saves.

echo "== 5. IAP service agent may invoke the service" >&2
run gcloud beta services identity create --service=iap.googleapis.com --project "$PROJECT" --format=none
run gcloud run services add-iam-policy-binding "$SERVICE" --project "$PROJECT" --region "$REGION" "--member=serviceAccount:$IAP_AGENT" --role=roles/run.invoker --format=none

echo "== 6. who may sign in" >&2
for u in "${USERS[@]}"; do
  run gcloud iap web add-iam-policy-binding --project "$PROJECT" --resource-type=cloud-run --service="$SERVICE" --region="$REGION" "--member=user:$u" --role=roles/iap.httpsResourceAccessor --format=none
done

BUDGET_NAME=$PROJECT-$SERVICE-budget  # the billing account is shared across projects, so the name carries the project
echo "== 7. budget ${BUDGET_USD} ${BUDGET_CURRENCY:-(in the currency of the billing account)}" >&2
get found '' gcloud billing budgets list "--billing-account=$BILLING_ACCOUNT" "--billing-project=$PROJECT" "--filter=displayName=$BUDGET_NAME" '--format=value(name)'
[[ -n $found ]] || run gcloud billing budgets create "--billing-account=$BILLING_ACCOUNT" "--billing-project=$PROJECT" "--display-name=$BUDGET_NAME" \
  "--budget-amount=${BUDGET_USD}${BUDGET_CURRENCY:-}" "--filter-projects=projects/$PROJECT_NUMBER" --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0

echo "== 8. email channel, uptime check, alert policy" >&2
get channel '' gcloud beta monitoring channels list --project "$PROJECT" "--filter=displayName=$SERVICE-alert-email" '--format=value(name)'
if [[ -z $channel ]]; then
  get channel "projects/$PROJECT/notificationChannels/<CHANNEL_ID>" gcloud beta monitoring channels create --project "$PROJECT" \
    "--display-name=$SERVICE-alert-email" --type=email "--channel-labels=email_address=$ALERT_EMAIL" '--format=value(name)'
fi
get found '' gcloud monitoring uptime list-configs --project "$PROJECT" "--filter=displayName=$SERVICE-uptime" '--format=value(name)'
# A check follows redirects, so IAP's 302 would end on Google's sign-in page (200). To an AJAX request IAP answers 401
# instead. That proves only that IAP's front door answers: IAP replies before the app is reached.
[[ -n $found ]] || run gcloud monitoring uptime create "$SERVICE-uptime" --project "$PROJECT" --resource-type=uptime-url \
  "--resource-labels=host=$HOST,project_id=$PROJECT" --protocol=https --headers=X-Requested-With=XMLHttpRequest --status-codes=401 \
  --period=5 --regions=europe,usa-iowa,usa-virginia
get found '' gcloud monitoring policies list --project "$PROJECT" "--filter=displayName=$SERVICE-down" '--format=value(name)'
[[ -n $found ]] || run gcloud monitoring policies create --project "$PROJECT" "--display-name=$SERVICE-down" "--notification-channels=$channel" \
  "--condition-display-name=$SERVICE uptime check failing" \
  "--condition-filter=metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND resource.label.host=\"$HOST\"" \
  '--aggregation={"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_NEXT_OLDER","crossSeriesReducer":"REDUCE_COUNT_FALSE","groupByFields":["resource.label.host"]}' \
  --if '> 1' --duration=300s

echo "== done: https://$HOST (sign in with: ${USERS[*]})" >&2
