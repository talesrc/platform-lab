# Secrets of golden-path apps: secret/apps/<name>/<env>/<ENV_VAR> (field `value`), one Vault
# secret per env var so Backstage can show and check each one from its metadata alone.
#
#   - External Secrets reads them (role external-secrets-apps, store vault-apps) into the
#     app's namespace; a Kyverno policy keeps each namespace on its own path
#     (gitops/manifests/kyverno-policies/restrict-app-externalsecrets.yaml).
#   - Backstage reads metadata only (exists, version, last updated), never values: the
#     Releases card, the promotion check and the rotation scorecard.
#   - The app's owner (spec.owner in apps/<name>/catalog-info.yaml) may write and delete its
#     values, but not read them back: the app reads them, people don't need to.
#
# Re-apply this module after adding an app or changing its owner (the owner policies come
# from the catalog files in git). The app itself doesn't wait for it: its ExternalSecret works
# as soon as the values exist.

locals {
  apps_dir = "${path.module}/../../apps"

  # apps/<name>/catalog-info.yaml (a single Component) -> its owner reference, e.g.
  # group:platform-team or user:default/talesrc. Apps without one have no owner policy.
  app_owner_refs = {
    for file in fileset(local.apps_dir, "*/catalog-info.yaml") :
    dirname(file) => try(yamldecode(file("${local.apps_dir}/${file}")).spec.owner, null)
  }
  # Owner reference -> Vault policy name: owner-<kind>-<name> (kind defaults to group, as in
  # Backstage), e.g. owner-group-platform-team, owner-user-talesrc.
  app_owner_policies = {
    for app, ref in local.app_owner_refs : app => format(
      "owner-%s-%s",
      lower(coalesce(regex("^(?:([A-Za-z]+):)?(?:[^/]+/)?(.+)$", ref)[0], "group")),
      lower(regex("^(?:([A-Za-z]+):)?(?:[^/]+/)?(.+)$", ref)[1]),
    ) if ref != null
  }
  owner_apps = {
    for policy in distinct(values(local.app_owner_policies)) :
    policy => sort([for app, p in local.app_owner_policies : app if p == policy])
  }
}

# External Secrets may read app secrets, nothing else, and never write.
resource "vault_policy" "external_secrets_apps" {
  name   = "external-secrets-apps"
  policy = <<-EOT
    path "${vault_mount.kv.path}/data/apps/*" {
      capabilities = ["read"]
    }
    path "${vault_mount.kv.path}/metadata/apps/*" {
      capabilities = ["read", "list"]
    }
  EOT
}

# Same service account as the platform store, separate role and policy: the vault-apps store
# never reads platform-lab/*, and the vault store never reads apps/*.
resource "vault_kubernetes_auth_backend_role" "external_secrets_apps" {
  backend                          = vault_auth_backend.kubernetes.path
  role_name                        = "external-secrets-apps"
  bound_service_account_names      = ["external-secrets"]
  bound_service_account_namespaces = ["external-secrets"]
  audience                         = "vault"
  token_policies                   = [vault_policy.external_secrets_apps.name]
  token_ttl                        = 3600
}

# Backstage: metadata of app secrets only. KV v2 keeps values under data/ and versions and
# timestamps under metadata/, so this policy can't read a value.
resource "vault_policy" "backstage_secret_metadata" {
  name   = "backstage-secret-metadata"
  policy = <<-EOT
    path "${vault_mount.kv.path}/metadata/apps/*" {
      capabilities = ["read", "list"]
    }
  EOT
}

# Backstage logs in with its own service account, through a projected token for the `vault`
# audience (gitops/platform/backstage.yaml), not the API-server token it already has.
resource "vault_kubernetes_auth_backend_role" "backstage" {
  backend                          = vault_auth_backend.kubernetes.path
  role_name                        = "backstage"
  bound_service_account_names      = ["backstage"]
  bound_service_account_namespaces = [var.backstage_namespace]
  audience                         = "vault"
  token_policies                   = [vault_policy.backstage_secret_metadata.name]
  token_ttl                        = 3600
}

# One policy per owner, covering every app it owns: write and delete values, see versions.
resource "vault_policy" "app_owner" {
  for_each = local.owner_apps

  name   = each.key
  policy = <<-EOT
    %{for app in each.value~}
    # apps/${app}
    path "${vault_mount.kv.path}/data/apps/${app}/*" {
      capabilities = ["create", "update", "delete"]
    }
    path "${vault_mount.kv.path}/metadata/apps/${app}/*" {
      capabilities = ["read", "list", "delete"]
    }
    path "${vault_mount.kv.path}/metadata/apps/${app}/" {
      capabilities = ["list"]
    }
    %{endfor~}
  EOT
}

# A Vault group per owner, holding its policy. Members come from the login method people use
# (OIDC or another auth method mapped to these groups); this lab has none yet besides the root
# token, so membership is managed outside Terraform.
resource "vault_identity_group" "app_owner" {
  for_each = local.owner_apps

  name                       = each.key
  type                       = "internal"
  policies                   = [vault_policy.app_owner[each.key].name]
  external_member_entity_ids = true
  metadata = {
    apps = join(",", each.value)
  }
}
