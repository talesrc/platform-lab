# Read the cluster's outputs (kubeconfig, ports) from the kind-cluster state.
data "terraform_remote_state" "cluster" {
  backend = "local"
  config = {
    path = var.cluster_state_path
  }
}

locals {
  cluster = data.terraform_remote_state.cluster.outputs
}

provider "helm" {
  kubernetes = {
    config_path = local.cluster.kubeconfig_path
  }
}

provider "kubernetes" {
  config_path = local.cluster.kubeconfig_path
}
