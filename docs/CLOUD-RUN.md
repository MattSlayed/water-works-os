# WaterOS on Cloud Run

Private test deployment in project `se-project-49281`, region `africa-south1`. Service `water-works-os`, at https://water-works-os-426022356353.africa-south1.run.app. [Console](https://console.cloud.google.com/run/detail/africa-south1/water-works-os/metrics?project=se-project-49281).

## What it is

- Synthetic data and the in-memory graph only. Timebase stays on this machine, so `WWOS_KG_BACKEND` isn't set.
- Claude runs on Vertex AI as the `wateros-run` service account, so there is no API key. Until `front-door.sh` has run, agents give deterministic answers.
- People sign in with Google through IAP. Only the addresses in `IAP_USERS` get in. Anonymous requests never reach the app.
- Scales to zero. **Everything changed at runtime is lost when the instance stops**, including approvals.
- `.gcloudignore` is an allowlist. `data/geo/` stays on this machine. The anatomy figures in `web/figures/` are uploaded, in their blueprint colours, except CHL-A and CHL-B: sync refuses a zone above technician clearance.

Operators (`WWOS_OPERATORS`) are demo operators: each signed-in address may act as any persona (`email=*`). Per-person limits come later, with real users.

## Open it

Browse to https://water-works-os-426022356353.africa-south1.run.app and sign in with Google. IAP checks the address against `IAP_USERS`, and the app checks IAP's signed token again.

## Set up and redeploy

Every project-specific value lives in `deploy/gcp/front-door.env` (the parameters are listed in `front-door.env.example`). One script does it all: APIs, the `wateros-run` service account with `roles/aiplatform.user`, the deploy with `--iap --no-allow-unauthenticated`, who may sign in, a monthly budget with alerts at 50%, 90% and 100%, and an uptime check with an email alert.

```
DRY_RUN=1 bash deploy/gcp/front-door.sh    # prints each gcloud command, runs none
bash deploy/gcp/front-door.sh              # does it; safe to run again
```

`VERTEX_REGION` and `LLM_MODEL` in the env file are placeholders until Model Garden confirms them. The script uses `--source .`, so it redeploys the code too.

Before each deploy, check what will leave the machine with `gcloud meta list-files-for-upload`. `deploy/` is not in the allowlist, so it stays here.

## Move to the company project

1. Copy `deploy/gcp/front-door.env.example` to `deploy/gcp/front-door.env` and set `PROJECT`, `REGION`, `BILLING_ACCOUNT`, `ALERT_EMAIL`, `IAP_USERS`, `VERTEX_REGION` and `LLM_MODEL`.
2. Run `DRY_RUN=1 bash deploy/gcp/front-door.sh`, read the plan, then run it without `DRY_RUN`.
3. Check the Claude model is enabled in Model Garden for the new project.

## Remove it

```
gcloud run services delete water-works-os --region africa-south1 --project se-project-49281
```
