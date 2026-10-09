variable "cluster_state_path" {
  description = "Path to the kind-cluster Terraform state."
  type        = string
  default     = "../kind-cluster/terraform.tfstate"
}

variable "argocd" {
  description = "Argo CD release settings."
  type = object({
    chart_version      = optional(string, "10.10.2")
    apps_chart_version = optional(string, "2.0.6") # argocd-apps chart (root Application)
    namespace          = optional(string, "argocd")
    hostname           = optional(string, "argocd.lab.localhost") # *.localhost resolves to 127.0.0.1 in browsers/curl
  })
  default = {}
}

variable "gitops" {
  description = "Git source of the root app-of-apps Application."
  type = object({
    repo_url        = optional(string, "https://github.com/talesrc/platform-lab.git")
    target_revision = optional(string, "main")
    path            = optional(string, "gitops/platform")
    root_app_name   = optional(string, "platform")
  })
  default = {}
}
