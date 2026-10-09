output "argocd_url" {
  description = "Argo CD UI, via the platform Gateway (HTTPS, local CA)."
  value       = "https://${var.argocd.hostname}${local.cluster.ingress_host_ports.https == 443 ? "" : ":${local.cluster.ingress_host_ports.https}"}"
}

output "backstage_url" {
  description = "Backstage developer portal, via the platform Gateway."
  value       = "https://backstage.lab.localhost${local.cluster.ingress_host_ports.https == 443 ? "" : ":${local.cluster.ingress_host_ports.https}"}"
}

output "argocd_admin_password_command" {
  description = "Command that prints the initial Argo CD admin password."
  value       = "kubectl --kubeconfig ${local.cluster.kubeconfig_path} -n ${var.argocd.namespace} get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo"
}

output "ca_certificate_command" {
  description = "Command that saves the lab CA certificate (platform-ca.crt) for trusting it locally."
  value       = "kubectl --kubeconfig ${local.cluster.kubeconfig_path} -n cert-manager get secret platform-ca -o jsonpath='{.data.ca\\.crt}' | base64 -d > platform-ca.crt"
}
