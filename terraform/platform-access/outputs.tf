output "backstage_secret" {
  description = "Secret (namespace/name) holding the Argo CD and Grafana tokens for Backstage."
  value       = "${var.backstage_namespace}/${kubernetes_secret_v1.backstage_platform_access.metadata[0].name}"
}
