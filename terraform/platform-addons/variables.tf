variable "cluster_state_path" {
  description = "Path to the kind-cluster Terraform state."
  type        = string
  default     = "../kind-cluster/terraform.tfstate"
}

variable "argocd" {
  description = "Argo CD release settings."
  type = object({
    # renovate: datasource=helm depName=argo-cd registryUrl=https://argoproj.github.io/argo-helm
    chart_version = optional(string, "10.10.2")
    # renovate: datasource=helm depName=argocd-apps registryUrl=https://argoproj.github.io/argo-helm
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

variable "github_oauth" {
  description = <<-EOT
    GitHub OAuth App for Argo CD login through Dex (a personal account is enough).
    Callback URL: https://<argocd.hostname>/api/dex/callback. null = no GitHub login.
    Without an org any GitHub user can authenticate, but RBAC gives them no access unless
    they are listed below. Set it only in terraform.tfvars (gitignored), never in git.
  EOT
  type = object({
    client_id     = string
    client_secret = string
  })
  default   = null
  sensitive = true
}

variable "argocd_admins" {
  description = "GitHub emails or usernames granted role:admin in Argo CD (used with github_oauth)."
  type        = list(string)
  default     = ["tales.ribeirop@gmail.com"]
}

variable "argocd_app_developers" {
  description = "GitHub emails or usernames granted role:app-developer (the `apps` project only)."
  type        = list(string)
  default     = []
}

variable "backstage_github_token" {
  description = "Fine-grained GitHub PAT for Backstage (Contents + Pull requests read/write on platform-lab). null = read-only portal."
  type        = string
  default     = null
  sensitive   = true
}
