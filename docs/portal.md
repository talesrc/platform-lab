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
Viewer token added by Backstage's proxy, so it never reaches the browser.

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
| App deployed, sync failed, app degraded | Argo CD Notifications |
| Alert firing / resolved | Alertmanager |

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
