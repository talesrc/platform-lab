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
2. `cert-manager-issuers` (wave -1): self-signed root → `platform-ca` ClusterIssuer
3. `platform-gateway` (wave 0): wildcard `*.localtest.me` certificate, HTTPS listener, HTTP→HTTPS redirect, routes

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

`*.localtest.me` resolves to `127.0.0.1`, so no hosts-file changes are needed.

### Trusting the lab CA

The gateway certificate is signed by a local CA. Export it with
`eval "$(terraform output -raw ca_certificate_command)"` and either pass it to curl
(`curl --cacert platform-ca.crt https://argocd.localtest.me`) or import it into your
OS/browser trust store (Windows: `certutil -user -addstore Root platform-ca.crt`).

## Tear it down

```bash
terraform -chdir=terraform/platform-addons destroy
terraform -chdir=terraform/kind-cluster destroy
```
