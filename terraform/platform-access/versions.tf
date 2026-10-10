terraform {
  required_version = ">= 1.7" # `removed` blocks

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
    vault = {
      source  = "hashicorp/vault"
      version = "~> 5.12"
    }
  }
}
