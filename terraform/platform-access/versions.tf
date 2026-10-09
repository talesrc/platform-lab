terraform {
  required_version = ">= 1.6"

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.3"
    }
    argocd = {
      source  = "argoproj-labs/argocd"
      version = "~> 7.17"
    }
    grafana = {
      source  = "grafana/grafana"
      version = "~> 4.49"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.4"
    }
  }
}
