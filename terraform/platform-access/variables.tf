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
  description = "Namespace Backstage runs in (created by platform-addons); the tokens are stored there."
  type        = string
  default     = "backstage"
}

variable "token_renew_after" {
  description = "Regenerate the Argo CD token when it is older than this (on the next apply)."
  type        = string
  default     = "720h"
}
