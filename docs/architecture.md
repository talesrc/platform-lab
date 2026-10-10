# Architecture

The lab is built in layers. Terraform creates only what has to exist before GitOps can run;
everything else is reconciled by Argo CD from this repository.

```
 Terraform                                   Argo CD (from git)
 ─────────                                   ──────────────────
 registry-cache  ─ image caches, kind network
 kind-cluster    ─ the cluster
 platform-addons ─ Argo CD + root app ──────▶ gitops/platform/*  (platform services, in waves)
 platform-access ─ tokens for Backstage       app-tenancy ──────▶ apps/*  (one app per directory)
```

## Repository layout

| Path | Owner | What |
|---|---|---|
| `terraform/registry-cache` | Terraform | Pull-through image caches and the `kind` Docker network; kept across cluster rebuilds |
| `terraform/kind-cluster` | Terraform | kind cluster (via the kind CLI): nodes, Kubernetes version, networking, port mappings |
| `terraform/platform-addons` | Terraform | Bootstrap: Argo CD (with notifications), the root app-of-apps, and the Secrets platform services need before they start |
| `terraform/platform-access` | Terraform | Least-privilege tokens for Backstage's plugins (read-only Argo CD, Grafana Viewer) |
| `gitops/platform` | Argo CD | One Application per platform service, synced in waves |
| `gitops/manifests` | Argo CD | Plain manifests referenced by those Applications |
| `charts/platform-gateway` | Argo CD | The shared Gateway API entrypoint: listeners, TLS, routes |
| `charts/app` | Platform team | The golden-path Helm chart every app depends on |
| `apps` | App teams | One directory per app, deployed by the `apps` ApplicationSet |
| `backstage/app` | Platform team | Our Backstage build (image `ghcr.io/talesrc/platform-lab-backstage`) |
| `backstage/templates` | Platform team | Software templates (golden paths) |
| `catalog-info.yaml` | Platform team | The platform's catalog entities |
| `docs`, `mkdocs.yml` | Platform team | These pages |

## Platform services

| Service | Role |
|---|---|
| Envoy Gateway | Gateway API implementation behind `*.lab.localhost` and `*.apps.lab.localhost` |
| cert-manager | Certificates from the lab CA (self-signed root → `platform-ca` ClusterIssuer) |
| Kyverno | Policies in audit mode, see [Policies](policies.md) |
| kube-prometheus-stack, metrics-server | Metrics, dashboards and alerts, see [Observability](observability.md) |
| CloudNativePG | PostgreSQL operator; runs Backstage's database |
| Backstage | The developer portal, see [Developer portal](portal.md) |

## Networking

kind maps the host's ports 80/443 to NodePorts on the first control-plane node; Envoy serves
them. The gateway has three listeners, each limited to the namespaces that may use it:

| Listener | Hostnames | Routes accepted from |
|---|---|---|
| `http` | any | the gateway's own namespace (it only redirects to HTTPS) |
| `https` | `*.lab.localhost` | the platform namespaces listed in its routes |
| `https-apps` | `*.apps.lab.localhost` | namespaces labelled `app.kubernetes.io/part-of: apps` |

So an app can never claim a platform hostname such as `argocd.lab.localhost`.

## Image caches

Every node's containerd pulls through `terraform/registry-cache`: one registry in proxy mode
per upstream (docker.io, quay.io, registry.k8s.io, ghcr.io, ECR Public; `reg.kyverno.io` through
the ghcr.io cache), with layers in Docker volumes. Images are downloaded once; rebuilding the
cluster pulls them locally. If a cache is down, containerd falls back to the upstream.
