# Day-1 access for Backstage's plugins and the lab's secret store. Runs after
# platform-addons (it needs Argo CD, Grafana and an initialized Vault up), so a fresh
# bootstrap never depends on a server that doesn't exist yet.
#
# Secrets go to Vault (secret/platform-lab/*); External Secrets turns them into the
# Kubernetes Secrets Backstage reads (gitops/manifests/platform-secrets).

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

# Formerly a Kubernetes Secret created here; External Secrets now owns backstage-platform-access.
# Forget the resource without deleting the live Secret (README: Secrets, migration).
removed {
  from = kubernetes_secret_v1.backstage_platform_access
  lifecycle {
    destroy = false
  }
}

# --- Vault ----------------------------------------------------------------------------

# Key/value store (version 2: versioned values, soft delete) for the lab's secrets.
resource "vault_mount" "kv" {
  path        = "secret"
  type        = "kv"
  options     = { version = "2" }
  description = "platform-lab secrets (synced to Kubernetes by External Secrets)"
}

# Kubernetes auth: workloads log in with their service-account token. Vault reviews tokens
# with its own pod identity (chart: server.authDelegator), so only the API address is needed.
resource "vault_auth_backend" "kubernetes" {
  type = "kubernetes"
  path = "kubernetes"
}

resource "vault_kubernetes_auth_backend_config" "this" {
  backend         = vault_auth_backend.kubernetes.path
  kubernetes_host = "https://kubernetes.default.svc"
}

# External Secrets may read platform-lab values, nothing else, and never write.
resource "vault_policy" "external_secrets" {
  name   = "external-secrets"
  policy = <<-EOT
    path "${vault_mount.kv.path}/data/platform-lab/*" {
      capabilities = ["read"]
    }
    path "${vault_mount.kv.path}/metadata/platform-lab/*" {
      capabilities = ["read", "list"]
    }
  EOT
}

resource "vault_kubernetes_auth_backend_role" "external_secrets" {
  backend                          = vault_auth_backend.kubernetes.path
  role_name                        = "external-secrets"
  bound_service_account_names      = ["external-secrets"]
  bound_service_account_namespaces = ["external-secrets"]
  # ESO requests tokens for this audience (ClusterSecretStore serviceAccountRef.audiences).
  audience       = "vault"
  token_policies = [vault_policy.external_secrets.name]
  token_ttl      = 3600
}

# --- Values -----------------------------------------------------------------------------

locals {
  # Vault path (under secret/) => key/value pairs; becomes the Kubernetes Secret of the same
  # last segment, prefixed backstage-, through gitops/manifests/platform-secrets/backstage.yaml.
  backstage_secrets = merge(
    {
      "platform-lab/backstage/platform-access" = {
        ARGOCD_AUTH_TOKEN = argocd_account_token.backstage.jwt
        GRAFANA_TOKEN     = grafana_service_account_token.backstage.key
      }
    },
    nonsensitive(var.backstage_github_token != null) ? {
      "platform-lab/backstage/github" = {
        GITHUB_TOKEN = var.backstage_github_token
      }
    } : {},
    nonsensitive(var.backstage_github_oauth != null) ? {
      "platform-lab/backstage/github-oauth" = {
        AUTH_GITHUB_CLIENT_ID     = var.backstage_github_oauth.client_id
        AUTH_GITHUB_CLIENT_SECRET = var.backstage_github_oauth.client_secret
      }
    } : {},
  )
  # Kubernetes Secrets External Secrets builds from those paths (for the restart below).
  backstage_externalsecrets = [for path in keys(local.backstage_secrets) : "backstage-${basename(path)}"]
}

resource "vault_kv_secret_v2" "backstage" {
  for_each = nonsensitive(toset(keys(local.backstage_secrets)))

  mount     = vault_mount.kv.path
  name      = each.key
  data_json = jsonencode(local.backstage_secrets[each.key])
}

# Backstage reads these Secrets as environment variables at start-up. When a value changes,
# have External Secrets sync now (instead of at its next refresh), wait until the Secrets are
# up to date, and restart Backstage.
resource "terraform_data" "backstage_restart" {
  triggers_replace = [nonsensitive(sha256(jsonencode(local.backstage_secrets)))]

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      # The store only turns Ready once Vault's Kubernetes auth (created above) works. Forcing a
      # sync before that fails and puts the ExternalSecrets into retry back-off past the wait below.
      kubectl wait clustersecretstore/vault --for=condition=Ready --timeout=180s
      for es in $EXTERNALSECRETS; do
        kubectl -n "$NAMESPACE" annotate externalsecret "$es" force-sync="$(date +%s)" --overwrite
      done
      for es in $EXTERNALSECRETS; do
        kubectl -n "$NAMESPACE" wait externalsecret "$es" --for=condition=Ready --timeout=180s
      done
      kubectl -n "$NAMESPACE" rollout restart deployment/backstage
    EOT
    environment = {
      KUBECONFIG      = local.kubeconfig_path
      NAMESPACE       = var.backstage_namespace
      EXTERNALSECRETS = join(" ", local.backstage_externalsecrets)
    }
  }

  depends_on = [
    vault_kv_secret_v2.backstage,
    vault_kubernetes_auth_backend_role.external_secrets,
    vault_kubernetes_auth_backend_config.this,
  ]
}
