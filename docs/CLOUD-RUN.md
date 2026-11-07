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

Every project-specific value lives in `deploy/gcp/front-door.env` (the parameters are listed in `front-door.env.example`). One script does it all: APIs, the `wateros-run` service account with `roles/aiplatform.user`, IAP's custom OAuth client when the project has no organisation (see below), the deploy with `--iap --no-allow-unauthenticated`, who may sign in, a monthly budget with alerts at 50%, 90% and 100%, and an uptime check with an email alert.

```
DRY_RUN=1 bash deploy/gcp/front-door.sh    # prints each gcloud command, runs none
bash deploy/gcp/front-door.sh              # does it; safe to run again
```

`VERTEX_REGION` and `LLM_MODEL` in the env file are placeholders until Model Garden confirms them. The script uses `--source .`, so it redeploys the code too.

Before each deploy, check what will leave the machine with `gcloud meta list-files-for-upload`. `deploy/` is not in the allowlist, so it stays here.

## IAP sign-in without an organisation

`se-project-49281` has no organisation: `gcloud projects get-ancestors se-project-49281` lists only the project. IAP's Google-managed OAuth client admits only users inside an organisation, so without a custom OAuth client neither address in `IAP_USERS` can sign in. A project inside an organisation needs this too if any `IAP_USERS` address is outside it, such as a Gmail address.

Creating the client is a one-time step, done by hand in the Console; it cannot be scripted. In the project's [Google Auth Platform](https://console.cloud.google.com/auth/overview):

1. **Branding:** set an app name. The user support email is `ALERT_EMAIL`.
2. **Audience:** choose External, and leave the publishing status on Testing. Add every `IAP_USERS` address as a test user.
3. **Clients → Create client → Web application.** After it is created, open it and add the authorised redirect URI `https://iap.googleapis.com/v1/oauth/clientIds/CLIENT_ID:handleRedirect`, with CLIENT_ID replaced by the client's own id.
4. **Download the JSON** to a folder outside the repo; it holds the client secret. Set `IAP_OAUTH_CLIENT_FILE` in `front-door.env` to its absolute path, with forward slashes (`C:/Users/you/secrets/wateros-iap-client.json`).

`front-door.sh` looks up the organisation itself. With none, it stops before changing anything until `IAP_OAUTH_CLIENT_FILE` names the file. It then applies the client to IAP at the project level (`gcloud iap settings set`), before the deploy turns IAP on. The secret goes through a temporary file that only you can read, which is deleted when the script ends. It never appears in the output, in a dry run either.

## Move to the company project

1. Copy `deploy/gcp/front-door.env.example` to `deploy/gcp/front-door.env` and set `PROJECT`, `REGION`, `BILLING_ACCOUNT`, `ALERT_EMAIL`, `IAP_USERS`, `VERTEX_REGION` and `LLM_MODEL`.
2. If the project has no organisation, or any `IAP_USERS` address is outside it, follow "IAP sign-in without an organisation" and set `IAP_OAUTH_CLIENT_FILE`.
3. Run `DRY_RUN=1 bash deploy/gcp/front-door.sh`, read the plan, then run it without `DRY_RUN`.
4. Check the Claude model is enabled in Model Garden for the new project.

## Remove it

```
gcloud run services delete water-works-os --region africa-south1 --project se-project-49281
```
