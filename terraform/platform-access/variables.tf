variable "cluster_state_path" {
  description = "Path to the kind-cluster Terraform state (for the kubeconfig)."
  type        = string
  default     = "../kind-cluster/terraform.tfstate"
}

variable "argocd_namespace" {
  description = "Namespace Argo CD runs in."
  type        = string
  default     = "argocd"
}

variable "grafana" {
  description = "In-cluster Grafana (kube-prometheus-stack) that Backstage reads dashboards and alerts from."
  type = object({
    namespace    = optional(string, "monitoring")
    service      = optional(string, "kube-prometheus-stack-grafana")
    admin_secret = optional(string, "kube-prometheus-stack-grafana")
  })
  default = {}
}

variable "backstage_namespace" {
  description = "Namespace Backstage runs in (created by platform-addons); External Secrets writes its Secrets there."
  type        = string
  default     = "backstage"
}

variable "token_renew_after" {
  description = "Regenerate the Argo CD token when it is older than this (on the next apply)."
  type        = string
  default     = "720h"
}

variable "vault" {
  description = "In-cluster Vault (gitops/platform/vault.yaml) and the lab-only Secret its init job writes."
  type = object({
    namespace     = optional(string, "vault")
    service       = optional(string, "vault")
    unseal_secret = optional(string, "vault-unseal-keys")
  })
  default = {}
}

variable "backstage_github_token" {
  description = "Fine-grained GitHub PAT for Backstage (Contents + Pull requests read/write on platform-lab), stored in Vault. null = read-only portal."
  type        = string
  default     = null
  sensitive   = true
}

variable "backstage_github_oauth" {
  description = <<-EOT
    GitHub OAuth App for Backstage sign-in (a separate app from Argo CD's: one callback URL per
    app), stored in Vault. Callback URL: https://backstage.lab.localhost/api/auth/github/handler/frame.
    Users sign in only if their GitHub login matches a catalog User (catalog-info.yaml).
    Set it only in terraform.tfvars (gitignored), never in git. null = nobody can sign in.
  EOT
  type = object({
    client_id     = string
    client_secret = string
  })
  default   = null
  sensitive = true
}
