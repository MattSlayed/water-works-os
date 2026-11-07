#!/usr/bin/env bash
# WaterOS front door on Google Cloud: sign-in (IAP), Claude on Vertex AI (service account), budget, uptime alert.
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
for v in PROJECT REGION SERVICE BILLING_ACCOUNT BUDGET_USD ALERT_EMAIL IAP_USERS VERTEX_REGION LLM_MODEL; do
  [[ -n ${!v:-} ]] || { echo "front-door: $v is empty in $ENV_FILE" >&2; exit 2; }
done
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
ENV_VARS="^|^WWOS_HOST=0.0.0.0|WWOS_LLM_PROVIDER=vertex|WWOS_VERTEX_PROJECT=$PROJECT|WWOS_VERTEX_REGION=$VERTEX_REGION|WWOS_LLM_MODEL=$LLM_MODEL|WWOS_IAP_AUDIENCE=$AUDIENCE|WWOS_OPERATORS=$OPERATORS"

echo "== 1. enable APIs" >&2
run gcloud services enable iap.googleapis.com aiplatform.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com monitoring.googleapis.com billingbudgets.googleapis.com --project "$PROJECT"

echo "== 2. service account $SA_EMAIL" >&2
get found '' gcloud iam service-accounts list --project "$PROJECT" "--filter=email=$SA_EMAIL" '--format=value(email)'
[[ -n $found ]] || run gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" --project "$PROJECT" --display-name "$SERVICE runtime"
run_retry gcloud projects add-iam-policy-binding "$PROJECT" "--member=serviceAccount:$SA_EMAIL" --role=roles/aiplatform.user --condition=None --format=none

if [[ -n $IAP_SETTINGS ]]; then
  echo "== 3. IAP sign-in uses the custom OAuth client" >&2
  run gcloud iap settings set "$IAP_SETTINGS" --project "$PROJECT" --format=none
fi

echo "== 4. deploy (IAP on, no public access)" >&2
run gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --source . --iap --no-allow-unauthenticated \
  --service-account "$SA_EMAIL" --memory 1Gi --cpu 1 --min-instances 0 --max-instances 1 --set-env-vars "$ENV_VARS"

echo "== 5. IAP service agent may invoke the service" >&2
run gcloud beta services identity create --service=iap.googleapis.com --project "$PROJECT" --format=none
run gcloud run services add-iam-policy-binding "$SERVICE" --project "$PROJECT" --region "$REGION" "--member=serviceAccount:$IAP_AGENT" --role=roles/run.invoker --format=none

echo "== 6. who may sign in" >&2
for u in "${USERS[@]}"; do
  run gcloud iap web add-iam-policy-binding --project "$PROJECT" --resource-type=cloud-run --service="$SERVICE" --region="$REGION" "--member=user:$u" --role=roles/iap.httpsResourceAccessor --format=none
done

BUDGET_NAME=$PROJECT-$SERVICE-budget  # the billing account is shared across projects, so the name carries the project
echo "== 7. budget ${BUDGET_USD} USD" >&2
get found '' gcloud billing budgets list "--billing-account=$BILLING_ACCOUNT" "--billing-project=$PROJECT" "--filter=displayName=$BUDGET_NAME" '--format=value(name)'
[[ -n $found ]] || run gcloud billing budgets create "--billing-account=$BILLING_ACCOUNT" "--billing-project=$PROJECT" "--display-name=$BUDGET_NAME" \
  "--budget-amount=${BUDGET_USD}USD" "--filter-projects=projects/$PROJECT_NUMBER" --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0

echo "== 8. email channel, uptime check, alert policy" >&2
get channel '' gcloud beta monitoring channels list --project "$PROJECT" "--filter=displayName=$SERVICE-alert-email" '--format=value(name)'
if [[ -z $channel ]]; then
  get channel "projects/$PROJECT/notificationChannels/<CHANNEL_ID>" gcloud beta monitoring channels create --project "$PROJECT" \
    "--display-name=$SERVICE-alert-email" --type=email "--channel-labels=email_address=$ALERT_EMAIL" '--format=value(name)'
fi
get found '' gcloud monitoring uptime list-configs --project "$PROJECT" "--filter=displayName=$SERVICE-uptime" '--format=value(name)'
# IAP answers an anonymous request with a 302 to sign-in (or a 401); either proves the service is up.
[[ -n $found ]] || run gcloud monitoring uptime create "$SERVICE-uptime" --project "$PROJECT" --resource-type=uptime-url \
  "--resource-labels=host=$HOST,project_id=$PROJECT" --protocol=https --status-codes=302,401 --period=5 --regions=europe,usa-iowa,usa-virginia
get found '' gcloud monitoring policies list --project "$PROJECT" "--filter=displayName=$SERVICE-down" '--format=value(name)'
[[ -n $found ]] || run gcloud monitoring policies create --project "$PROJECT" "--display-name=$SERVICE-down" "--notification-channels=$channel" \
  "--condition-display-name=$SERVICE uptime check failing" \
  "--condition-filter=metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND resource.label.host=\"$HOST\"" \
  '--aggregation={"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_NEXT_OLDER","crossSeriesReducer":"REDUCE_COUNT_FALSE","groupByFields":["resource.label.host"]}' \
  --if '> 1' --duration=300s

echo "== done: https://$HOST (sign in with: ${USERS[*]})" >&2
