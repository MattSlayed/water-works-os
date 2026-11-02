# WaterOS on Cloud Run

Private test deployment in project `se-project-49281`, region `africa-south1`. Service `water-works-os`, at https://water-works-os-426022356353.africa-south1.run.app. [Console](https://console.cloud.google.com/run/detail/africa-south1/water-works-os/metrics?project=se-project-49281).

## What it is

- Synthetic data and the in-memory graph only. Timebase stays on this machine, so `WWOS_KG_BACKEND` isn't set.
- No API key, so agents give deterministic answers.
- Anonymous requests get 403. Project owners can reach it after signing in with Google.
- Scales to zero. **Everything changed at runtime is lost when the instance stops**, including approvals.
- `.gcloudignore` is an allowlist. `web/figures/` and `data/geo/` stay on this machine, so anatomy figures show as missing.

`x-acting-user` is still trusted as sent. Anyone with access can act as any person. Real sign-in must replace it before real people or data go in.

## Open it

```
gcloud run services proxy water-works-os --region africa-south1 --project se-project-49281 --port 8835
```

Then browse to http://localhost:8835.

## Redeploy

```
gcloud run deploy water-works-os --project se-project-49281 --source . --region africa-south1 --no-allow-unauthenticated --memory 1Gi --cpu 1 --min-instances 0 --max-instances 1 --set-env-vars WWOS_HOST=0.0.0.0
```

Before each deploy, check what will leave the machine with `gcloud meta list-files-for-upload`.

## Remove it

```
gcloud run services delete water-works-os --region africa-south1 --project se-project-49281
```
