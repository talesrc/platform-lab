# Bring it up

## Requirements

Docker, [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) v0.32+,
Terraform ≥ 1.6, kubectl and helm. On WSL, Docker Engine runs inside the distro
(`scripts/install-docker-engine.sh`).

## Steps

The four Terraform root modules run in order. Each has a `terraform.tfvars.example`; the real
`terraform.tfvars` files are gitignored and are where secrets go.

```bash
cd terraform/registry-cache && cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

cd ../kind-cluster && cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

cd ../platform-addons && cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

# After Argo CD has synced (Grafana must be up): tokens for Backstage's plugins
cd ../platform-access && cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

export KUBECONFIG=$(terraform -chdir=../kind-cluster output -raw kubeconfig_path)
kubectl get applications -n argocd
```

Argo CD's `admin` password: `terraform -chdir=terraform/platform-addons output -raw
argocd_admin_password_command`, then run the printed command.

## Optional: GitHub sign-in and tokens

| What | Where | Needed for |
|---|---|---|
| `github_oauth` (OAuth App, callback `https://argocd.lab.localhost/api/dex/callback`) | `platform-addons` tfvars | logging in to Argo CD with GitHub |
| `backstage_github_oauth` (a second OAuth App, callback `https://backstage.lab.localhost/api/auth/github/handler/frame`) | `platform-addons` tfvars | signing in to Backstage |
| `backstage_github_token` (fine-grained PAT, Contents + Pull requests on the repo) | `platform-addons` tfvars | the golden-path template opening pull requests |

## Trust the lab CA

The gateway's certificates are signed by a local CA:

```bash
eval "$(terraform -chdir=terraform/platform-addons output -raw ca_certificate_command)"
curl --cacert platform-ca.crt https://argocd.lab.localhost
```

Import `platform-ca.crt` into your browser or OS trust store (Windows:
`certutil -user -addstore Root platform-ca.crt`) to avoid certificate warnings.

## Tear it down

```bash
terraform -chdir=terraform/platform-addons destroy
terraform -chdir=terraform/kind-cluster destroy
# Optional: also drop the image caches (the next build downloads everything again)
terraform -chdir=terraform/registry-cache destroy
```
