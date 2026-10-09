# Envoy Gateway controller; the chart also installs the Gateway API CRDs.
resource "helm_release" "envoy_gateway" {
  name             = "eg"
  repository       = "oci://docker.io/envoyproxy"
  chart            = "gateway-helm"
  version          = var.envoy_gateway.chart_version
  namespace        = var.envoy_gateway.namespace
  create_namespace = true
  wait             = true
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
      cm = {
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
      }
    }
  })]
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

  depends_on = [helm_release.argocd, helm_release.envoy_gateway]
}
