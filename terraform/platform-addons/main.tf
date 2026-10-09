locals {
  # Only the client secret is secret; whether login is on and the client ID are not, and
  # leaving them sensitive would hide Argo CD's whole values file in every plan.
  github_login     = nonsensitive(var.github_oauth != null)
  github_client_id = local.github_login ? nonsensitive(var.github_oauth.client_id) : ""

  # Dex GitHub connector (no `orgs`: a personal-account OAuth App can't restrict by org).
  dex_config = [for client_id in [local.github_client_id] : {
    "dex.config" = yamlencode({
      connectors = [{
        type = "github"
        id   = "github"
        name = "GitHub"
        config = {
          clientID = client_id
          # Resolved from argocd-secret (see set_sensitive on helm_release.argocd).
          clientSecret = "$dex.github.clientSecret"
        }
      }]
    })
  } if local.github_login]

  # https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/
  rbac_policy = join("\n", concat(
    [
      # Tenant developers: everything on Applications of the `apps` project, nothing else.
      "p, role:app-developer, applications, *, apps/*, allow",
      "p, role:app-developer, logs, get, apps/*, allow",
      "p, role:app-developer, projects, get, apps, allow",
      # Backstage's Argo CD plugin (token from terraform/platform-access): read-only.
      "g, backstage, role:readonly",
    ],
    [for subject in var.argocd_admins : "g, ${subject}, role:admin"],
    [for subject in var.argocd_app_developers : "g, ${subject}, role:app-developer"],
  ))
}

resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.argocd.chart_version
  namespace        = var.argocd.namespace
  create_namespace = true
  wait             = true

  values = [yamlencode({
    global = {
      domain = var.argocd.hostname
    }
    configs = {
      params = {
        # TLS is terminated at the platform Gateway, not by argocd-server.
        "server.insecure" = true
      }
      repositories = {
        # OCI Helm registry for charts that are only published as OCI artifacts
        # (e.g. Envoy Gateway's gateway-helm).
        envoyproxy = {
          name      = "envoyproxy"
          type      = "helm"
          url       = "docker.io/envoyproxy"
          enableOCI = "true"
        }
        # The golden-path app chart (charts/app), a dependency of every apps/<name>/Chart.yaml.
        platform-lab-charts = {
          name      = "platform-lab-charts"
          type      = "helm"
          url       = "ghcr.io/talesrc/charts"
          enableOCI = "true"
        }
      }
      rbac = {
        # Authenticated users without a matching rule get no access (e.g. any GitHub user:
        # an OAuth App on a personal account can't restrict logins to an org).
        "policy.default" = ""
        # Also match RBAC subjects against the email and GitHub username claims.
        scopes       = "[groups, email, preferred_username]"
        "policy.csv" = local.rbac_policy
      }
      cm = merge(concat(local.dex_config, [{
        # Local account for Backstage's Argo CD plugin: API tokens only, no UI login.
        "accounts.backstage" = "apiKey"
        # Report child Applications' health, so sync waves in the app-of-apps
        # wait for each wave to be Healthy before starting the next.
        "resource.customizations.health.argoproj.io_Application" = <<-LUA
          hs = {}
          hs.status = "Progressing"
          hs.message = ""
          if obj.status ~= nil and obj.status.health ~= nil then
            hs.status = obj.status.health.status
            if obj.status.health.message ~= nil then
              hs.message = obj.status.health.message
            end
          end
          return hs
        LUA
      }])...)
    }
    # Deploy, sync-failure and degraded notifications in Backstage (notifications.tf).
    notifications = local.argocd_notifications
  })]

  set_sensitive = concat(
    # Kept out of the values and plan output; ends up in argocd-secret as dex.github.clientSecret.
    local.github_login ? [{
      name  = "configs.secret.extra.dex\\.github\\.clientSecret"
      value = var.github_oauth.client_secret
    }] : [],
    # argocd-notifications-secret, referenced as $backstage-token by the backstage webhook.
    [{
      name  = "notifications.secret.items.backstage-token"
      value = random_password.backstage_argocd_notifications.result
    }],
  )
}

# Root "app of apps": everything under gitops.path is reconciled by Argo CD from git.
resource "helm_release" "argocd_apps" {
  name       = "argocd-apps"
  repository = "https://argoproj.github.io/argo-helm"
  chart      = "argocd-apps"
  version    = var.argocd.apps_chart_version
  namespace  = var.argocd.namespace

  values = [yamlencode({
    applications = {
      (var.gitops.root_app_name) = {
        namespace  = var.argocd.namespace
        project    = "default"
        finalizers = ["resources-finalizer.argocd.argoproj.io"]
        source = {
          repoURL        = var.gitops.repo_url
          targetRevision = var.gitops.target_revision
          path           = var.gitops.path
        }
        destination = {
          server    = "https://kubernetes.default.svc"
          namespace = var.argocd.namespace
        }
        syncPolicy = {
          automated = {
            prune    = true
            selfHeal = true
          }
        }
      }
    }
  })]

  # The backstage namespace must exist before Argo CD syncs the gateway route into it, and
  # the callers' tokens before Backstage and Alertmanager (which mount them) start.
  depends_on = [
    helm_release.argocd,
    kubernetes_namespace_v1.backstage,
    kubernetes_secret_v1.backstage_external_access,
    kubernetes_secret_v1.alertmanager_backstage,
  ]
}

# Backstage (gitops/platform/backstage.yaml) runs in this namespace. It is created here,
# not by Argo CD, so the optional Secrets below exist before Backstage (wave -1) starts.
resource "kubernetes_namespace_v1" "backstage" {
  metadata {
    name = "backstage"
  }
}

# GitHub token for Backstage's scaffolder (opening PRs) and catalog reads. Never in git:
# set backstage_github_token in terraform.tfvars. Without it the portal runs read-only.
resource "kubernetes_secret_v1" "backstage_github" {
  count = nonsensitive(var.backstage_github_token != null) ? 1 : 0

  metadata {
    name      = "backstage-github"
    namespace = kubernetes_namespace_v1.backstage.metadata[0].name
  }

  data = {
    GITHUB_TOKEN = var.backstage_github_token
  }
}

# GitHub OAuth App for Backstage sign-in. Never in git: set backstage_github_oauth in
# terraform.tfvars. Read by the image's app-config.production.yaml (auth.providers.github).
resource "kubernetes_secret_v1" "backstage_github_oauth" {
  count = nonsensitive(var.backstage_github_oauth != null) ? 1 : 0

  metadata {
    name      = "backstage-github-oauth"
    namespace = kubernetes_namespace_v1.backstage.metadata[0].name
  }

  data = {
    AUTH_GITHUB_CLIENT_ID     = var.backstage_github_oauth.client_id
    AUTH_GITHUB_CLIENT_SECRET = var.backstage_github_oauth.client_secret
  }
}
