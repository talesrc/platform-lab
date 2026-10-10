# ${{ values.name }}

${{ values.description }}

| | |
|---|---|
| URL | <https://${{ values.name }}.apps.lab.localhost> |
| Namespace | `app-${{ values.name }}` |
| Image | `${{ values.image }}:${{ values.tag }}` |
| Owner | `${{ values.owner }}` |
| Source | [apps/${{ values.name }}](https://github.com/talesrc/platform-lab/tree/main/apps/${{ values.name }}) |

## How it runs

This service is on the platform-lab golden path: `values.yaml` sets the values of the
platform's app chart (`charts/app`), which renders a hardened Deployment, a Service, an
HTTPRoute on the platform gateway and a ServiceMonitor. Argo CD deploys every change merged to
`main`.

To change it, edit `values.yaml` (every option is documented in
[charts/app/values.yaml](https://github.com/talesrc/platform-lab/blob/main/charts/app/values.yaml))
and open a pull request. CI checks it against the platform policies before it can merge.

## Operating it

The service's page in Backstage shows its pods (Kubernetes tab), its Argo CD sync status and
its Grafana dashboards. Alerts for namespace `app-${{ values.name }}` reach the owner as
Backstage notifications.

```bash
kubectl get pods -n app-${{ values.name }}
kubectl logs -n app-${{ values.name }} deploy/${{ values.name }}
```

## About this service

Replace this section with what the service does, its API, and who to ask.
