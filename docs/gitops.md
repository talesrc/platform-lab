# GitOps and sync waves

Terraform installs Argo CD and one root Application, `platform`, that syncs
`gitops/platform/`. Every file there is itself an Argo CD Application, so pushing to `main` is
how the platform changes: nobody runs `kubectl apply`.

## Sync waves

The root app creates its child Applications in waves (the `argocd.argoproj.io/sync-wave`
annotation) and waits for each wave to be **Healthy** before starting the next:

| Wave | Applications |
|---|---|
| -2 | `cert-manager`, `envoy-gateway`, `kyverno`, `cloudnative-pg` |
| -1 | `cert-manager-issuers`, `metrics-server`, `kube-prometheus-stack`, `kyverno-pod-security`, `kyverno-policies`, `backstage` |
| 0 | `platform-gateway` |
| 1 | `app-tenancy` (the `apps` AppProject and ApplicationSet) |

Argo CD doesn't report an Application's health by default; a health check added in
`terraform/platform-addons` makes the waves wait.

!!! warning "Degraded blocks later waves"
    `Degraded` counts as *not Healthy*. The gateway (wave 0) holds the HTTPRoutes of platform
    UIs, and a route to a Service that doesn't exist yet is Degraded. So every platform service
    exposed through the gateway must sync in an **earlier** wave than the gateway.

## Apps

`app-tenancy` generates one Application per directory under `apps/` (see
[Apps and the golden path](apps.md)). Those Applications are restricted by the `apps`
AppProject:

- sources from this repository only, destinations `app-*` namespaces only;
- no cluster-scoped resources except the app's own Namespace;
- no ResourceQuota, LimitRange or NetworkPolicy (those belong to the platform);
- synced automatically with prune and self-heal: deleting the directory deletes the app.

Directory names must not clash with platform Application names (`kyverno`, `cert-manager`, …),
since every Application lives in the `argocd` namespace.

## Argo CD access

- Local `admin` account (password from `terraform output`).
- Optional GitHub login through Dex. Without a GitHub organization anyone can authenticate, so
  access comes only from RBAC: `policy.default` is empty, `argocd_admins` get `role:admin`,
  `argocd_app_developers` get `role:app-developer` (Applications of the `apps` project only).
- A `backstage` account with API tokens only, bound to `role:readonly`, for the portal.
