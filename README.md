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

1. `cert-manager`, `envoy-gateway` and `kyverno` (wave -2)
2. `cert-manager-issuers`, `metrics-server` and `kube-prometheus-stack` (wave -1): self-signed root → `platform-ca` ClusterIssuer; resource metrics; monitoring stack (see [Observability](#observability))
3. `kyverno-pod-security` and `kyverno-policies` (wave -1): policies in Audit mode (see [Policies](#policies))
4. `platform-gateway` (wave 0): wildcard `*.lab.localhost` certificate, HTTPS listener, HTTP→HTTPS redirect, routes

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

## Policies

[Kyverno](https://kyverno.io/) checks every Pod against these policies, written as CEL
`ValidatingPolicy` resources (`policies.kyverno.io`), the successor of the deprecated
`ClusterPolicy`:

| Policy | Source | Checks |
|---|---|---|
| `require-requests-limits` | `gitops/manifests/kyverno-policies` | CPU and memory requests, and a memory limit, on every container |
| `disallow-latest-tag` | `gitops/manifests/kyverno-policies` | Images pinned to a tag other than `latest`, or to a digest |
| `require-app-name-label` | `gitops/manifests/kyverno-policies` | The `app.kubernetes.io/name` label on Pods |
| Pod Security Standards (baseline), 11 policies | `kyverno-policies` chart | No privileged containers, host namespaces/paths/ports, added capabilities, ... |

All policies run in **Audit** mode: nothing is blocked, and violations are recorded in
policy reports, both for new Pods and, through background scans, for existing ones.
Platform and system namespaces (`kube-system`, `argocd`, `cert-manager`, ...) are
excluded so the reports focus on workloads; the list lives in each policy and in
`gitops/platform/kyverno-pod-security.yaml`.

Kyverno's webhooks use `failurePolicy: Ignore`, so a Kyverno outage never blocks the
cluster.

Read the results:

```bash
kubectl get policyreport -A                            # summary per namespace
kubectl get policyreport -n <namespace> -o yaml        # individual results and messages
kubectl get clusterpolicyreport                        # cluster-scoped resources
```

Switch a policy to blocking: change its `validationActions` from `[Audit]` to `[Deny]`
(or for the chart policies, set `validationFailureActionByPolicy` in
`gitops/platform/kyverno-pod-security.yaml`) and push. Check its reports are clean first.

Test the custom policies locally with the [Kyverno CLI](https://kyverno.io/docs/kyverno-cli/):

```bash
kyverno test gitops/manifests/kyverno-policies/tests
```

## Tear it down

```bash
terraform -chdir=terraform/platform-addons destroy
terraform -chdir=terraform/kind-cluster destroy
```
