# Backstage notifications from the platform: Argo CD Notifications and Alertmanager call
# Backstage with static tokens (backend.auth.externalAccess in
# backstage/app/app-config.production.yaml), one per caller, each limited to one plugin.
# Generated here, so they never touch git: Backstage reads them from backstage-external-access,
# the callers from their own Secrets.

resource "random_password" "backstage_argocd_notifications" {
  length  = 48
  special = false
}

resource "random_password" "backstage_alertmanager" {
  length  = 48
  special = false
}

resource "kubernetes_secret_v1" "backstage_external_access" {
  metadata {
    name      = "backstage-external-access"
    namespace = kubernetes_namespace_v1.backstage.metadata[0].name
  }

  data = {
    ARGOCD_NOTIFICATIONS_TOKEN = random_password.backstage_argocd_notifications.result
    ALERTMANAGER_TOKEN         = random_password.backstage_alertmanager.result
  }
}

# kube-prometheus-stack runs here (gitops/platform/kube-prometheus-stack.yaml, which keeps
# CreateNamespace=true). Created by Terraform, like the backstage namespace, so Alertmanager's
# token Secret exists before Argo CD starts Alertmanager, which mounts it. On a cluster
# bootstrapped before this existed, adopt the namespace once:
#   terraform import kubernetes_namespace_v1.monitoring monitoring
resource "kubernetes_namespace_v1" "monitoring" {
  metadata {
    name = "monitoring"
  }
}

resource "kubernetes_secret_v1" "alertmanager_backstage" {
  metadata {
    name      = "alertmanager-backstage"
    namespace = kubernetes_namespace_v1.monitoring.metadata[0].name
  }

  data = {
    token = random_password.backstage_alertmanager.result
  }
}

locals {
  # Tenant apps (label from the apps ApplicationSet) notify the owner of the catalog
  # Component of the same name; platform apps notify the platform team.
  backstage_recipient = <<-EOT
    {{- if eq (dig "metadata" "labels" "app.kubernetes.io/part-of" "" .app) "apps" -}}
    component:default/{{ .app.metadata.name }}
    {{- else -}}
    group:default/platform-team
    {{- end -}}
  EOT

  # Body of POST /api/notifications. Free text goes through toJson (sync messages contain
  # quotes and newlines); a notification with the same scope replaces the previous one.
  backstage_notification = { for name, n in {
    deployed = {
      title       = "{{ .app.metadata.name }} deployed"
      description = "printf \"Revision %s is synced and healthy.\" (trunc 7 .app.status.sync.revision)"
      link        = "\"/catalog/default/component/{{ .app.metadata.name }}\""
      severity    = "normal"
      scope       = ""
    }
    sync-failed = {
      title       = "{{ .app.metadata.name }} failed to sync"
      description = ".app.status.operationState.message"
      link        = "\"{{ .context.argocdUrl }}/applications/argocd/{{ .app.metadata.name }}\""
      severity    = "high"
      scope       = "sync-failed"
    }
    health-degraded = {
      title       = "{{ .app.metadata.name }} is degraded"
      description = "printf \"Health: %s\" (default \"no details\" .app.status.health.message)"
      link        = "\"{{ .context.argocdUrl }}/applications/argocd/{{ .app.metadata.name }}\""
      severity    = "critical"
      scope       = "degraded"
      } } : "template.backstage-app-${name}" => yamlencode({
      webhook = {
        backstage = {
          method = "POST"
          body = join("\n", [
            "{",
            "  \"recipients\": {\"type\": \"entity\", \"entityRef\": \"${trimspace(local.backstage_recipient)}\"},",
            "  \"payload\": {",
            "    \"title\": \"${n.title}\",",
            "    \"description\": {{ ${n.description} | toJson }},",
            "    \"link\": ${n.link},",
            "    \"severity\": \"${n.severity}\",",
            n.scope == "" ? "" : "    \"scope\": \"argocd:{{ .app.metadata.name }}:${n.scope}\",",
            "    \"topic\": \"deployments\"",
            "  }",
            "}",
          ])
        }
      }
  }) }

  # Argo CD Notifications (argo-cd chart `notifications` values).
  argocd_notifications = {
    notifiers = {
      "service.webhook.backstage" = yamlencode({
        url = "http://backstage.backstage.svc:7007/api/notifications"
        headers = [
          # $backstage-token: argocd-notifications-secret (set_sensitive on helm_release.argocd).
          { name = "Authorization", value = "Bearer $backstage-token" },
          { name = "Content-Type", value = "application/json" },
        ]
      })
    }
    templates = local.backstage_notification
    triggers = {
      "trigger.on-deployed" = yamlencode([{
        description = "Synced and healthy; once per commit"
        oncePer     = "app.status.operationState?.syncResult?.revision"
        when        = "app.status.operationState != nil and app.status.operationState.phase in ['Succeeded'] and app.status.health.status == 'Healthy'"
        send        = ["backstage-app-deployed"]
      }])
      "trigger.on-sync-failed" = yamlencode([{
        description = "Sync operation failed"
        when        = "app.status.operationState != nil and app.status.operationState.phase in ['Error', 'Failed']"
        send        = ["backstage-app-sync-failed"]
      }])
      "trigger.on-health-degraded" = yamlencode([{
        description = "Health is Degraded"
        when        = "app.status.health.status == 'Degraded'"
        send        = ["backstage-app-health-degraded"]
      }])
    }
    # Every Application, no per-app annotations: tenants hear about deploys too, the
    # platform team only about failures (a platform sync is routine, not news).
    subscriptions = [
      {
        recipients = ["backstage"]
        selector   = "app.kubernetes.io/part-of=apps"
        triggers   = ["on-deployed", "on-sync-failed", "on-health-degraded"]
      },
      {
        recipients = ["backstage"]
        selector   = "app.kubernetes.io/part-of!=apps"
        triggers   = ["on-sync-failed", "on-health-degraded"]
      },
    ]
  }
}
