# ${{ values.name }}

${{ values.description }}

| | |
|---|---|
| URL | <https://${{ values.name }}.apps.lab.localhost> (prd), <https://${{ values.name }}-stg.apps.lab.localhost> (stg) |
| Namespaces | `app-${{ values.name }}-prd`, `app-${{ values.name }}-stg` |
| Image | `${{ values.image }}:${{ values.tag }}` |
| Owner | `${{ values.owner }}` |
| Source | [apps/${{ values.name }}](https://github.com/talesrc/platform-lab/tree/main/apps/${{ values.name }}) |

## How it runs

This service is on the platform-lab golden path: its values set the platform's app chart
(`charts/app`), which renders a hardened Deployment, a Service, an HTTPRoute on the platform
gateway and a ServiceMonitor. It runs in two environments, stg and prd, and Argo CD deploys
every change merged to `main`.

| File | What goes there |
|---|---|
| `values.yaml` | config shared by every environment (image repository, port, probes, resources) |
| `envs/<env>/values.yaml` | environment config: what differs between stg and prd (URLs, replicas, ...) |
| `envs/<env>/release.yaml` | the release: image tag, env vars that belong to that version, and `requiredEnv` (the env vars it needs from each environment) |

Every option is documented in
[charts/app/values.yaml](https://github.com/talesrc/platform-lab/blob/main/charts/app/values.yaml).
CI checks every pull request against the platform policies before it can merge.

## Releasing

1. Open a pull request that changes `envs/stg/release.yaml` (new tag, and any new env vars:
   release-scoped ones in `app.env`, environment-specific ones listed in `requiredEnv` and set
   in each `envs/<env>/values.yaml`).
2. Once it runs well in stg, use **Create → Promote to prd** in Backstage. It copies the stg
   release to prd, asks for prd's value of any env var the release requires, and opens the
   pull request.
3. CI only lets `envs/prd/release.yaml` change to what stg runs. For a hotfix, change both
   files in the same pull request.

## Operating it

The service's page in Backstage shows its pods (Kubernetes tab), its Argo CD sync status and
its Grafana dashboards. Alerts in `app-${{ values.name }}-stg` and `app-${{ values.name }}-prd`
reach the owner as Backstage notifications.

```bash
kubectl get pods -n app-${{ values.name }}-prd
kubectl logs -n app-${{ values.name }}-prd deploy/${{ values.name }}
```

## About this service

Replace this section with what the service does, its API, and who to ask.
