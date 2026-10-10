# Apps and the golden path

Every workload follows one golden path: the platform-owned Helm chart **`charts/app`**,
published to `oci://ghcr.io/talesrc/charts/app`. An app is a directory with a few small files;
nothing else has to be written by hand. Every app runs in two environments, **stg** and **prd**.

```
apps/<name>/
  Chart.yaml          # depends on a pinned version of the app chart
  values.yaml         # shared by every environment, under `app:` - image repository, port, probes
  envs/stg/, envs/prd/
    values.yaml       # environment config: what differs between environments (URLs, replicas)
    release.yaml      # the release: image tag, its env vars and requiredEnv (promoted stg -> prd)
  Chart.lock          # resolved dependency digest (helm dependency update)
  catalog-info.yaml   # the Backstage entity
  mkdocs.yml, docs/   # the app's docs (TechDocs)
```

## Create a service

In Backstage, choose **Create → Golden-path service**. The template opens a pull request that
adds `apps/<name>/`. CI renders it, validates the schemas and runs every platform policy
against it. Once you merge:

1. the `apps` ApplicationSet creates Applications `<name>-stg` and `<name>-prd`, in namespaces
   `app-<name>-stg` and `app-<name>-prd`, and syncs them;
2. it is served at `https://<name>-stg.apps.lab.localhost` and `https://<name>.apps.lab.localhost`
   (prd), scraped by Prometheus;
3. the catalog picks up its `catalog-info.yaml`, so its page shows pods, Argo CD status,
   Grafana dashboards and these docs.

## Releases: stg first, then promote

A new version rarely means only a new image tag: it may need new env vars too. So a **release**
is the tag *plus* the config that belongs to that version, kept in one file per environment,
`envs/<env>/release.yaml`:

```yaml
app:
  image:
    tag: "1.4.0"
  env:                  # release-scoped: the same in every environment
    FEATURE_X_ENABLED: "true"
requiredEnv:            # environment config this version needs (set in envs/<env>/values.yaml)
  - PAYMENTS_API_URL
```

Environment config, which differs between stg and prd (a database host, a partner URL,
replicas), stays in `envs/<env>/values.yaml` and is never promoted.

1. **Release to stg:** a pull request changes `envs/stg/release.yaml`, and sets any new required
   env var in `envs/stg/values.yaml`.
2. **Promote to prd:** in Backstage, **Create → Promote to prd** (or the *Promote stg to prd*
   link on the service's page). It copies `envs/stg/release.yaml` to `envs/prd/release.yaml`,
   asks for prd's value of any required env var prd doesn't set yet (and stops, naming them, if
   one is missing), and opens the pull request.
3. **Merge:** Argo CD deploys prd and notifies the owner.

CI (`scripts/ci/check-app-envs.py`) enforces the same rules on every pull request, however it
was written:

| Rule | Why |
|---|---|
| `release.yaml` holds only `app.image.tag`, `app.env`, `requiredEnv` | anything else is environment config and must not travel with promotion |
| an env var is in a release or in environment config, not both | otherwise it's unclear which wins after a promotion |
| every `requiredEnv` name is set in that environment | prd can't start a version whose config is missing |
| a changed `envs/prd/release.yaml` equals `envs/stg/release.yaml` | prd only runs what ran in stg; a hotfix changes both files in one pull request |

Good practice for teams: give new settings sensible defaults in the code, so most new versions
need no new config and promotion is just the tag.

## What the chart gives you

| | |
|---|---|
| Manifests | Deployment, Service, HTTPRoute, ServiceMonitor, PodDisruptionBudget (when `replicas > 1`) |
| Security | non-root (UID 65532), read-only root filesystem (writable `emptyDir`s via `writablePaths`), no service-account token, all capabilities dropped, seccomp `RuntimeDefault` |
| Resources | requests and a memory limit, `/readyz` and `/healthz` probes |
| Validation | `values.schema.json` rejects bad values (e.g. a missing or `latest` image tag) before anything renders |

The full list of values, with defaults, is
[`charts/app/values.yaml`](https://github.com/talesrc/platform-lab/blob/main/charts/app/values.yaml).

## Chart versions

Apps pin the chart version, so a chart change reaches an app only through a version bump:

1. the platform team changes `charts/app` and bumps its `version`;
2. the *Charts* workflow publishes it (a published version is never overwritten);
3. Renovate opens **one pull request per app**, so a release rolls out app by app.

CI renders every app twice, with its pinned chart and with the local `charts/app`, and runs the
schemas and policies on both, so a chart change is tested against all apps before it ships.

## Example: podinfo

`apps/podinfo` runs two replicas in prd (so it also gets a PodDisruptionBudget) and one in stg,
sets a custom command and arguments, adds `/data` as a writable path, and shows a different UI
message per environment (`envs/<env>/values.yaml`):

```bash
kubectl get pods,pdb,httproute -n app-podinfo-prd
curl --cacert platform-ca.crt https://podinfo.apps.lab.localhost/
kubectl get policyreport -n app-podinfo-prd   # no failures
```
