# hello

The first service created from the golden-path template (pull request #1), kept as a test of
the full flow: Backstage form → pull request → CI → merge → deployed by Argo CD.

| | |
|---|---|
| URLs | <https://hello.apps.lab.localhost> (prd), <https://hello-stg.apps.lab.localhost> (stg) |
| Namespaces | `app-hello-prd`, `app-hello-stg` |
| Image | `ghcr.io/stefanprodan/podinfo`, tag per environment in `envs/<env>/release.yaml` |
| Owner | `user:default/talesrc` |
| Source | [apps/hello](https://github.com/talesrc/platform-lab/tree/main/apps/hello) |

## How it runs

`values.yaml` sets the values of the platform's app chart (`charts/app`) shared by both
environments: podinfo on port 9898, with the chart's defaults for everything else (one replica,
non-root, read-only root filesystem, probes on `/readyz` and `/healthz`, a ServiceMonitor on
`/metrics`). `envs/<env>/release.yaml` pins the tag each environment runs; a new tag goes to stg
first and reaches prd through **Promote to prd** in Backstage.

## Operating it

```bash
kubectl get pods -n app-hello-prd
curl --cacert platform-ca.crt https://hello.apps.lab.localhost/
curl --cacert platform-ca.crt https://hello-stg.apps.lab.localhost/
```
