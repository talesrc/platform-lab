# Day-1 access for Backstage's plugins: least-privilege credentials for the platform tools,
# stored as Secrets in the backstage namespace. Runs after platform-addons (it needs Argo CD
# and Grafana up), so a fresh bootstrap never depends on a server that doesn't exist yet.

# Argo CD: token of the `backstage` local account (apiKey only, role:readonly; defined in
# terraform/platform-addons).
resource "argocd_account_token" "backstage" {
  account     = "backstage"
  renew_after = var.token_renew_after
}

# Grafana: a Viewer service account, so Backstage can read dashboards and alerts only.
resource "grafana_service_account" "backstage" {
  name        = "backstage"
  role        = "Viewer"
  is_disabled = false
}

resource "grafana_service_account_token" "backstage" {
  name               = "backstage"
  service_account_id = grafana_service_account.backstage.id
}

resource "kubernetes_secret_v1" "backstage_platform_access" {
  metadata {
    name      = "backstage-platform-access"
    namespace = var.backstage_namespace
  }

  data = {
    ARGOCD_AUTH_TOKEN = argocd_account_token.backstage.jwt
    GRAFANA_TOKEN     = grafana_service_account_token.backstage.key
  }
}
