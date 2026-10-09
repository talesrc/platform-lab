output "cluster_name" {
  description = "Name of the kind cluster."
  value       = terraform_data.cluster.output.name
}

output "node_image" {
  description = "Node image the cluster runs."
  value       = terraform_data.cluster.output.image
}

output "endpoint" {
  description = "Kubernetes API server endpoint."
  value       = "https://${var.networking.api_server_address}:${var.networking.api_server_port}"
}

# Use this with the kubernetes/helm providers (config_path) in later modules.
output "kubeconfig_path" {
  description = "Path to the generated kubeconfig."
  value       = terraform_data.cluster.output.kubeconfig_path
}

output "kind_config" {
  description = "Rendered kind cluster configuration."
  value       = terraform_data.cluster.output.config
}

output "ingress_node_ports" {
  description = "NodePorts that receive traffic from ingress_host_ports; the gateway Service must use them."
  value       = var.ingress_node_ports
}

output "ingress_host_ports" {
  description = "Host ports that reach the cluster's gateway."
  value       = var.ingress_host_ports
}
