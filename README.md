# platform-lab

A local platform engineering lab: a [kind](https://kind.sigs.k8s.io/) cluster bootstrapped
with Terraform and then managed with GitOps by [Argo CD](https://argo-cd.readthedocs.io/).

## Layout

| Path | Owner | What |
|---|---|---|
| `terraform/kind-cluster` | Terraform | kind cluster (via the kind CLI): nodes, version, networking, port mappings |
| `terraform/platform-addons` | Terraform | Bootstrap only: Argo CD and the root app-of-apps |
| `gitops/platform` | Argo CD | Child Applications, synced in waves |
| `gitops/manifests` | Argo CD | Plain manifests referenced by Applications |
| `charts/platform-gateway` | Argo CD | Shared Gateway API entrypoint: GatewayClass, Gateway, TLS, HTTPRoutes |
| `scripts` | — | Workstation setup (Docker Engine in WSL) |

Sync waves under `gitops/platform`:

1. `cert-manager` and `envoy-gateway` (wave -2)
2. `cert-manager-issuers`, `metrics-server` and `kube-prometheus-stack` (wave -1): self-signed root → `platform-ca` ClusterIssuer; resource metrics; monitoring stack (see [Observability](#observability))
3. `platform-gateway` (wave 0): wildcard `*.lab.localhost` certificate, HTTPS listener, HTTP→HTTPS redirect, routes

## Requirements

Docker, [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) v0.32+, Terraform ≥ 1.6, kubectl.

## Bring it up

```bash
cd terraform/kind-cluster
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

cd ../platform-addons
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

export KUBECONFIG=$(terraform -chdir=../kind-cluster output -raw kubeconfig_path)
kubectl get applications -n argocd
```

Argo CD: `terraform output argocd_url` (user `admin`, password from
`terraform output -raw argocd_admin_password_command`).

`*.localhost` names (RFC 6761) resolve to `127.0.0.1` in browsers and curl, so no DNS or hosts-file changes are needed. Other tools use the OS resolver, which does not resolve them.

### Trusting the lab CA

The gateway certificate is signed by a local CA. Export it with
`eval "$(terraform output -raw ca_certificate_command)"` and either pass it to curl
(`curl --cacert platform-ca.crt https://argocd.lab.localhost`) or import it into your
OS/browser trust store (Windows: `certutil -user -addstore Root platform-ca.crt`).

## Observability

[kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack)
(Prometheus Operator, Prometheus, Alertmanager, Grafana, node-exporter, kube-state-metrics)
runs in `monitoring`, plus `metrics-server` for `kubectl top`. No persistent volumes;
Prometheus keeps 2 days of data.

| UI | URL |
|---|---|
| Grafana | https://grafana.lab.localhost |
| Prometheus | https://prometheus.lab.localhost |
| Alertmanager | https://alertmanager.lab.localhost |

Grafana user is `admin`; the password is generated in-cluster (never stored in git):

```bash
kubectl -n monitoring get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

Prometheus selects ServiceMonitors, PodMonitors, Probes and PrometheusRules from every
namespace. etcd, kube-scheduler, kube-controller-manager and kube-proxy are not scraped:
kind binds their metrics to `127.0.0.1` inside the nodes.

## Tear it down

```bash
terraform -chdir=terraform/platform-addons destroy
terraform -chdir=terraform/kind-cluster destroy
```
