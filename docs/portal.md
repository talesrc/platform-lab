# Developer portal

Backstage runs at <https://backstage.lab.localhost>. It is **our own image**, built from
`backstage/app/` and pushed to `ghcr.io/talesrc/platform-lab-backstage`; the lab's
configuration is baked in (`backstage/app/app-config.production.yaml`), and secrets come only
from Kubernetes Secrets.

## Sign-in

Sign in with GitHub. A login works only if a catalog User has the same name (e.g. `talesrc` in
the root `catalog-info.yaml`).

## Entity pages

Each component's page shows its live state, selected by annotations in its `catalog-info.yaml`
(the golden-path template adds all of them):

| Tab / card | Shows | Annotation |
|---|---|---|
| Kubernetes | pods, deployments, restarts, errors, logs | `backstage.io/kubernetes-label-selector`, `backstage.io/kubernetes-namespace` |
| Argo CD | sync status, health, history | `argocd/app-name`, or `argocd/app-selector` for golden-path apps (every environment) |
| Grafana | dashboards | `grafana/dashboard-selector` |
| Docs | the entity's TechDocs | `backstage.io/techdocs-ref` |

Each integration uses least-privilege access: the Kubernetes plugin uses the pod's service
account with a read-only ClusterRole (no Secrets); Argo CD a `role:readonly` API token; Grafana a
Viewer token added by Backstage's proxy, so it never reaches the browser; Vault the `backstage`
Kubernetes-auth role, which reads only the metadata of app secrets (`secret/metadata/apps/*`:
exists, version, last written), never a value. Its login token is a service-account token for the
`vault` audience, projected into the pod.

Golden-path services also get a *Releases* card: per environment, the running image, sync and
health, the last deploy, and each secret's state (see [Apps: Secrets](apps.md#secrets)).

## Docs (TechDocs)

Docs live next to the code they describe: an `mkdocs.yml` and a `docs/` folder beside the
entity's `catalog-info.yaml`, referenced with `backstage.io/techdocs-ref: dir:.`. Backstage
fetches them from GitHub and builds them itself (mkdocs-techdocs-core is part of the image), on
first view and again when they change. Built sites are kept on the pod's filesystem, so after a
restart the first visit rebuilds them.

Preview locally:

```bash
pip install mkdocs-techdocs-core==1.7.1
mkdocs serve            # from the directory that holds mkdocs.yml
```

## Notifications

The bell in the sidebar collects notifications for the owner of each component
(`platform-team` for the platform):

| Event | Sent by |
|---|---|
| Golden-path or promotion pull request opened | the template |
| stg release ready to promote to prd (soaked, healthy, no alerts; prd behind), or waiting on secrets prd lacks in Vault | the `ready-to-promote` backend plugin, once per stg release and secrets state |
| App deployed, sync failed, app degraded | Argo CD Notifications |
| Alert firing / resolved | Alertmanager |

## DORA metrics

Golden-path services show a *Delivery (DORA)* card (prd, last 30 days, with their recent prd
deploys), and the home page a widget across all of them. The numbers describe the delivery
system, never individuals; with two apps they show the pipeline working rather than a trend.

| Metric | Here |
|---|---|
| Deployment frequency | release deploys to prd (promotion, rollback or hotfix) per service per week |
| Lead time for changes | median time from the release landing in stg (the merge of `envs/stg/release.yaml`) to running in prd |
| Change failure rate | prd release deploys followed within 24 hours by a rollback, a hotfix or a critical alert in `app-<name>-prd` |
| Time to restore | median time from a prd failure (critical alert firing, or the bad deploy) to recovery (alert resolved, or rollback/hotfix deployed) |

Where the data comes from:

- **Deploys.** Argo CD Notifications calls `POST /api/dora/deploys` when a prd Application has
  synced and is healthy (`on-prd-deployed` in `terraform/platform-addons/notifications.tf`).
  The `dora` backend plugin looks up the deployed commit on GitHub and classifies it: a
  `chore(apps): promote` pull request is a promotion, `fix(apps): roll back` a rollback, a
  commit that changes the stg and prd releases together a hotfix, and a sync that doesn't
  change prd's release (shared values, the chart, environment config, comments) is not a
  release deploy. A new app's first deploy doesn't count.
- **Failures.** Alertmanager sends critical alerts in `app-<name>-prd` to `POST /api/dora/alerts`
  as well as to the owner (`gitops/platform/kube-prometheus-stack.yaml`). An alert within 24
  hours of a release counts against the latest release before it. To use SLO burn-rate alerts
  instead, change that route and `plugins/dora/signals.ts`.
- **Backfill.** Every 6 hours the plugin also reads the history of each golden-path app's
  `envs/prd/release.yaml` from GitHub, so the metrics start with the past and a missed webhook
  is caught up. A backfilled deploy is dated when its pull request merged, since git doesn't
  know when Argo CD synced it.

The data lives in the plugin's own schema (`dora`) of the portal database. The metrics are
also Tech Insights facts (`doraFactRetriever`, every 6 hours, kept a year), so their history is
kept. No scorecard check uses them.

Both webhooks reuse their caller's static token, which Backstage also allows for the `dora`
plugin. The API is `GET /api/dora/metrics?days=30` (all services) and
`GET /api/dora/metrics/<app>?days=30`.

## Database

PostgreSQL run by CloudNativePG (cluster `backstage-db`): notifications, starred entities, home
page layouts and scaffolder history survive restarts. There are no backups; the data lives as
long as the cluster.

## Changing the portal

Edit `backstage/app/` and push: CI builds a new `sha-<commit>` image; then bump the tag in
`gitops/platform/backstage.yaml`. A local build is one command, from `backstage/app`:

```bash
docker build -f packages/backend/Dockerfile .
```
