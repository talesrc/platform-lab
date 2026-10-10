# podinfo

The golden path's reference application: [podinfo](https://github.com/stefanprodan/podinfo),
a small Go web service with metrics, health checks and a UI. It shows the optional parts of the
platform's app chart (`charts/app`) that a minimal app doesn't need.

| | |
|---|---|
| URL | <https://podinfo.apps.lab.localhost> |
| Namespace | `app-podinfo` |
| Image | `ghcr.io/stefanprodan/podinfo:6.15.0` |
| Owner | `group:platform-team` |
| Source | [apps/podinfo](https://github.com/talesrc/platform-lab/tree/main/apps/podinfo) |

## What it uses from the chart

| Value | Why |
|---|---|
| `replicas: 2` | the chart also creates a PodDisruptionBudget (`minAvailable: 1`) |
| `command: [./podinfo]` + `args` | the image's binary is its CMD (there's no ENTRYPOINT), and `args` alone would replace it |
| `writablePaths: [/tmp, /data]` | the root filesystem is read-only; podinfo writes to `/data` |
| `securityContext` UID/GID 100/101 | the image's own `app` user |
| `env.PODINFO_UI_MESSAGE` | the message on the UI |

## Operating it

```bash
kubectl get pods,pdb,httproute -n app-podinfo
curl --cacert platform-ca.crt https://podinfo.apps.lab.localhost/
kubectl get policyreport -n app-podinfo   # no failures
```

In Prometheus, both pods should be up: `up{namespace="app-podinfo"}`.
