data "terraform_remote_state" "cluster" {
  backend = "local"
  config = {
    path = var.cluster_state_path
  }
}

locals {
  kubeconfig_path = data.terraform_remote_state.cluster.outputs.kubeconfig_path
  # The argocd provider's kubernetes block takes connection details, not a file.
  kubeconfig   = yamldecode(file(local.kubeconfig_path))
  kube_cluster = local.kubeconfig.clusters[0].cluster
  kube_user    = local.kubeconfig.users[0].user
}

provider "kubernetes" {
  config_path = local.kubeconfig_path
}

# Admin credentials of the platform tools, read from the cluster (never stored in git).
data "kubernetes_secret_v1" "argocd_admin" {
  metadata {
    name      = "argocd-initial-admin-secret"
    namespace = var.argocd_namespace
  }
}

data "kubernetes_secret_v1" "grafana_admin" {
  metadata {
    name      = var.grafana.admin_secret
    namespace = var.grafana.namespace
  }
}

# Argo CD's API through a port-forward made by the provider itself (argocd-server runs
# plain HTTP behind the gateway, hence plain_text).
provider "argocd" {
  username                    = "admin"
  password                    = data.kubernetes_secret_v1.argocd_admin.data["password"]
  port_forward_with_namespace = var.argocd_namespace
  plain_text                  = true
  kubernetes {
    host                   = local.kube_cluster.server
    cluster_ca_certificate = base64decode(local.kube_cluster["certificate-authority-data"])
    client_certificate     = base64decode(local.kube_user["client-certificate-data"])
    client_key             = base64decode(local.kube_user["client-key-data"])
  }
}

# Grafana has no in-provider port-forward, and Go programs (Terraform) don't resolve
# *.lab.localhost like browsers do. A short-lived kubectl port-forward (it exits on its own
# after 10 minutes) exposes the Grafana Service on 127.0.0.1 for this run.
data "external" "grafana_port_forward" {
  program = ["bash", "${path.module}/port-forward.sh"]
  query = {
    kubeconfig = local.kubeconfig_path
    namespace  = var.grafana.namespace
    service    = var.grafana.service
    port       = "80"
    lifetime   = "600"
  }
}

provider "grafana" {
  url  = data.external.grafana_port_forward.result.url
  auth = "${data.kubernetes_secret_v1.grafana_admin.data["admin-user"]}:${data.kubernetes_secret_v1.grafana_admin.data["admin-password"]}"
}

# Vault: same port-forward approach as Grafana. LAB-ONLY: Terraform authenticates with the
# root token that the init CronJob stored (gitops/manifests/vault/unseal.yaml). In production
# Terraform would log in through an auth method (e.g. OIDC or JWT from CI) with a scoped policy.
data "kubernetes_secret_v1" "vault_unseal" {
  metadata {
    name      = var.vault.unseal_secret
    namespace = var.vault.namespace
  }
}

data "external" "vault_port_forward" {
  program = ["bash", "${path.module}/port-forward.sh"]
  query = {
    kubeconfig = local.kubeconfig_path
    namespace  = var.vault.namespace
    service    = var.vault.service
    port       = "8200"
    lifetime   = "600"
  }
}

provider "vault" {
  address = data.external.vault_port_forward.result.url
  token   = data.kubernetes_secret_v1.vault_unseal.data["root-token"]
}
