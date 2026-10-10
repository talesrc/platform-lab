# hello

The first service created from the golden-path template (pull request #1), kept as a test of
the full flow: Backstage form → pull request → CI → merge → deployed by Argo CD.

| | |
|---|---|
| URL | <https://hello.apps.lab.localhost> |
| Namespace | `app-hello` |
| Image | `ghcr.io/stefanprodan/podinfo:6.15.0` |
| Owner | `user:default/talesrc` |
| Source | [apps/hello](https://github.com/talesrc/platform-lab/tree/main/apps/hello) |

## How it runs

`values.yaml` sets the values of the platform's app chart (`charts/app`): one replica of
podinfo on port 9898, with the chart's defaults for everything else (non-root, read-only root
filesystem, probes on `/readyz` and `/healthz`, a ServiceMonitor on `/metrics`).

## Operating it

```bash
kubectl get pods -n app-hello
curl --cacert platform-ca.crt https://hello.apps.lab.localhost/
```
