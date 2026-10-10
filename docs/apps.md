# Apps and the golden path

Every workload follows one golden path: the platform-owned Helm chart **`charts/app`**,
published to `oci://ghcr.io/talesrc/charts/app`. An app is a directory with a few small files;
nothing else has to be written by hand.

```
apps/<name>/
  Chart.yaml          # depends on a pinned version of the app chart
  values.yaml         # values under `app:` - image, port, probes, replicas, ...
  Chart.lock          # resolved dependency digest (helm dependency update)
  catalog-info.yaml   # the Backstage entity
  mkdocs.yml, docs/   # the app's docs (TechDocs)
```

## Create a service

In Backstage, choose **Create → Golden-path service**. The template opens a pull request that
adds `apps/<name>/`. CI renders it, validates the schemas and runs every platform policy
against it. Once you merge:

1. the `apps` ApplicationSet creates namespace `app-<name>` and syncs the app;
2. it is served at `https://<name>.apps.lab.localhost`, scraped by Prometheus;
3. the catalog picks up its `catalog-info.yaml`, so its page shows pods, Argo CD status,
   Grafana dashboards and these docs.

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

`apps/podinfo` runs two replicas (so it also gets a PodDisruptionBudget), sets a custom
command and arguments, and adds `/data` as a writable path:

```bash
kubectl get pods,httproute -n app-podinfo
curl --cacert platform-ca.crt https://podinfo.apps.lab.localhost/
kubectl get policyreport -n app-podinfo   # no failures
```
