# platform-lab

A local platform engineering lab: a [kind](https://kind.sigs.k8s.io/) cluster bootstrapped
with Terraform and then managed with GitOps by [Argo CD](https://argo-cd.readthedocs.io/).

## Layout

| Path | Owner | What |
|---|---|---|
| `terraform/registry-cache` | Terraform | Pull-through image caches (docker.io, quay.io, registry.k8s.io, ghcr.io, ecr-public.aws.com; reg.kyverno.io via ghcr.io) and the `kind` Docker network; kept across cluster rebuilds |
| `terraform/kind-cluster` | Terraform | kind cluster (via the kind CLI): nodes, version, networking, port mappings |
| `terraform/platform-addons` | Terraform | Bootstrap only: Argo CD (with its notifications), the root app-of-apps, the `backstage` and `monitoring` namespaces and the notification-token Secrets |
| `terraform/platform-access` | Terraform | Day-1 configuration after platform-addons: Vault (KV, Kubernetes auth, External Secrets role) and the values it stores (Backstage's GitHub values, read-only Argo CD token, Grafana Viewer token); see [Secrets](#secrets-vault--external-secrets) |
| `gitops/platform` | Argo CD | Child Applications, synced in waves |
| `gitops/manifests` | Argo CD | Plain manifests referenced by Applications |
| `apps` | Argo CD (ApplicationSet) | Workloads on the golden path, one directory per app (see [Apps](#apps)) |
| `charts/platform-gateway` | Argo CD | Shared Gateway API entrypoint: GatewayClass, Gateway, TLS, HTTPRoutes |
| `backstage/templates` | Backstage | Software templates (golden paths) |
| `catalog-info.yaml` | Backstage | Software catalog: system, components, team |
| `scripts` | — | Workstation setup (Docker Engine in WSL) |

Sync waves under `gitops/platform`:

1. `cert-manager`, `envoy-gateway`, `kyverno`, `cloudnative-pg` and `external-secrets` (wave -2)
2. `cert-manager-issuers`, `metrics-server` and `kube-prometheus-stack` (wave -1): self-signed root → `platform-ca` ClusterIssuer; resource metrics; monitoring stack (see [Observability](#observability))
3. `kyverno-pod-security` and `kyverno-policies` (wave -1): policies in Audit mode (see [Policies](#policies))
   and `policy-reporter` (wave -1): Kyverno results for Backstage (see [Standards](#standards-scorecards-policy-results-permissions))
4. `backstage` and `vault` (wave -1): developer portal (see [Developer portal](#developer-portal)); secret store (see [Secrets](#secrets-vault--external-secrets))
5. `platform-gateway` (wave 0): wildcard `*.lab.localhost` certificate, HTTPS listener, HTTP→HTTPS redirect, routes
6. `app-tenancy` (wave 1): the `apps` AppProject and ApplicationSet (see [Tenancy](#tenancy))
7. `platform-secrets` (wave 2): the Vault ClusterSecretStore and the ExternalSecrets; last, because
   it is Degraded until `terraform/platform-access` has configured Vault

A wave starts only when every app of the previous one is Healthy, and `Degraded` counts as
not Healthy. Platform services exposed through `platform-gateway` (wave 0) must therefore come
earlier: the gateway's HTTPRoute to a Service that doesn't exist yet is Degraded, which would
block every later wave.

## Requirements

Docker, [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) v0.32+, Terraform ≥ 1.7, kubectl.

## Bring it up

```bash
cd terraform/registry-cache
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

cd ../kind-cluster
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

cd ../platform-addons
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

# After Argo CD has synced (Grafana up, Vault initialized by its unseal CronJob, ~1 min):
# Vault configuration and the secrets External Secrets syncs into the cluster
cd ../platform-access
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply

export KUBECONFIG=$(terraform -chdir=../kind-cluster output -raw kubeconfig_path)
kubectl get applications -n argocd
```

Argo CD: `terraform output argocd_url` (user `admin`, password from
`terraform output -raw argocd_admin_password_command`).

### Registry caches

Every node's containerd pulls through `terraform/registry-cache`: one
[Distribution](https://distribution.github.io/distribution/) registry in proxy mode per upstream,
on the `kind` Docker network, with layers stored in Docker volumes. Images are downloaded from
the internet once; cluster rebuilds pull them from the local cache. kind-cluster reads the
mirror endpoints from the registry-cache state (`registry_cache_state_path`; set it to `null`
to pull directly). If a cache is down, containerd falls back to the upstream registry.

Registries that front another one are cached through it with `aliases`: `reg.kyverno.io`
serves `ghcr.io/kyverno/*` and delegates auth to ghcr.io, which a Distribution proxy can't
follow, so it uses the ghcr.io cache. When a new image comes from another registry, add it
to `upstreams` (or `aliases`) — `kubectl get events -A | grep Pulled` shows where images come from.

The kubelet pulls up to `max_parallel_image_pulls` (default 5) images at once per node, so a
slow pull doesn't block the others.

`*.localhost` names (RFC 6761) resolve to `127.0.0.1` in browsers and curl, so no DNS or hosts-file changes are needed. Other tools use the OS resolver, which does not resolve them.

### Trusting the lab CA

The gateway certificate is signed by a local CA. Export it with
`eval "$(terraform output -raw ca_certificate_command)"` and either pass it to curl
(`curl --cacert platform-ca.crt https://argocd.lab.localhost`) or import it into your
OS/browser trust store (Windows: `certutil -user -addstore Root platform-ca.crt`).

## Observability

[kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack)
(Prometheus Operator, Prometheus, Alertmanager, Grafana, node-exporter, kube-state-metrics)
runs in `monitoring`, plus `metrics-server` for `kubectl top`. No persistent volumes;
Prometheus keeps 2 days of data.

| UI | URL |
|---|---|
| Grafana | https://grafana.lab.localhost |
| Prometheus | https://prometheus.lab.localhost |
| Alertmanager | https://alertmanager.lab.localhost |

Grafana user is `admin`; the password is generated in-cluster (never stored in git):

```bash
kubectl -n monitoring get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

Alertmanager sends every alert except `Watchdog` to Backstage as a notification for the
owning team (see [Developer portal](#developer-portal)).

Prometheus selects ServiceMonitors, PodMonitors, Probes and PrometheusRules from every
namespace. etcd, kube-scheduler, kube-controller-manager and kube-proxy are not scraped:
kind binds their metrics to `127.0.0.1` inside the nodes.

## Policies

[Kyverno](https://kyverno.io/) checks every Pod against these policies, written as CEL
`ValidatingPolicy` resources (`policies.kyverno.io`), the successor of the deprecated
`ClusterPolicy`:

| Policy | Source | Checks |
|---|---|---|
| `require-requests-limits` | `gitops/manifests/kyverno-policies` | CPU and memory requests, and a memory limit, on every container |
| `disallow-latest-tag` | `gitops/manifests/kyverno-policies` | Images pinned to a tag other than `latest`, or to a digest |
| `require-app-name-label` | `gitops/manifests/kyverno-policies` | The `app.kubernetes.io/name` label on Pods |
| Pod Security Standards (baseline), 11 policies | `kyverno-policies` chart | No privileged containers, host namespaces/paths/ports, added capabilities, ... |

All policies run in **Audit** mode: nothing is blocked, and violations are recorded in
policy reports, both for new Pods and, through background scans, for existing ones.
Platform and system namespaces (`kube-system`, `argocd`, `cert-manager`, ...) are
excluded so the reports focus on workloads; the list lives in each policy and in
`gitops/platform/kyverno-pod-security.yaml`.

Kyverno's webhooks use `failurePolicy: Ignore`, so a Kyverno outage never blocks the
cluster.

Read the results:

```bash
kubectl get policyreport -A                            # summary per namespace
kubectl get policyreport -n <namespace> -o yaml        # individual results and messages
kubectl get clusterpolicyreport                        # cluster-scoped resources
```

Switch a policy to blocking: change its `validationActions` from `[Audit]` to `[Deny]`
(or for the chart policies, set `validationFailureActionByPolicy` in
`gitops/platform/kyverno-pod-security.yaml`) and push. Check its reports are clean first.

Test the custom policies locally with the [Kyverno CLI](https://kyverno.io/docs/kyverno-cli/):

```bash
kyverno test gitops/manifests/kyverno-policies/tests
```

## Apps

Workloads live in `apps/<name>/` and follow one golden path: the platform-owned Helm chart
**`charts/app`**, published to `oci://ghcr.io/talesrc/charts/app`. Every app runs in two
environments, **stg** and **prd**; an Argo CD ApplicationSet discovers every directory and
deploys it once per environment (no per-app Application).

```
apps/<name>/
  Chart.yaml          # depends on a pinned version of the app chart
  values.yaml         # shared by every environment, under `app:`: image repository, port, probes
  envs/<env>/
    values.yaml       # environment config: what differs between stg and prd (URLs, replicas, ...)
    release.yaml      # the release: image tag, its env vars, requiredEnv; promoted stg -> prd
  Chart.lock          # resolved dependency digest (helm dependency update)
  catalog-info.yaml   # Backstage entity (optional)
```

| Convention | Value |
|---|---|
| Manifests | rendered by `charts/app`: Deployment, Service, HTTPRoute, ServiceMonitor, PodDisruptionBudget (replicas > 1) |
| Defaults | non-root (UID 65532), read-only root filesystem (writable `emptyDir`s via `writablePaths`), no service-account token, requests + memory limit, `/readyz` + `/healthz` probes |
| Values | `charts/app/values.yaml` documents them; `values.schema.json` rejects bad ones (e.g. a missing or `latest` image tag) before anything renders |
| Namespaces | `app-<name>-stg` and `app-<name>-prd`, created by the ApplicationSet |
| URLs | `https://<name>.apps.lab.localhost` (prd), `https://<name>-stg.apps.lab.localhost` (stg), routes on the gateway's `https-apps` listener |
| Policies | must pass every lab Kyverno policy; the chart's defaults already do |

**Chart versions.** Apps pin the chart version, so a chart change reaches an app only through a
version bump. Changing `charts/app` means bumping its `version` (the Charts workflow publishes it
and never overwrites a published version); Renovate then opens **one PR per app** to upgrade,
so a release rolls out app by app. CI renders every app with its pinned chart *and* with the
local `charts/app`, and runs schemas and policies on both, so a chart change is tested against
all apps before it is published (`scripts/ci/render-app.sh`).

`https-apps` is a second HTTPS listener on the platform gateway for `*.apps.lab.localhost`, with
its own certificate from the lab CA (a wildcard covers one label only, so `*.lab.localhost` doesn't
match `x.apps.lab.localhost`). HTTP requests are redirected to HTTPS as for platform hosts.

**Add an app:** use Backstage (*Create → Golden-path service*), which opens a PR with
`apps/<name>/`, or copy `apps/hello/` by hand. CI renders it per environment, validates the
schemas and runs every lab policy against it (`scripts/ci/check-app-policies.sh`); a violation
fails the build, even though the cluster itself only audits. Once merged, the ApplicationSet
creates `app-<name>-stg` and `app-<name>-prd` and syncs them, and the catalog picks up its
`catalog-info.yaml` (a `Location` globs `apps/*`).

**Releases and promotion.** A release is the image tag *plus* the config that version expects,
so it lives in one file, `envs/<env>/release.yaml`, and moves as one unit:

1. a new version goes to stg: a PR changes `envs/stg/release.yaml` (tag, release-scoped env vars
   in `app.env`, and `requiredEnv`, the env vars it needs from each environment);
2. *Create → Promote to prd* in Backstage (or the *Promote stg to prd* link on the service's
   page) copies it to `envs/prd/release.yaml`, asks for prd's value of any required env var prd
   doesn't set yet, and opens the PR (`platform-lab:app:promote`,
   `backstage/app/packages/backend/src/plugins/scaffolderPromote.ts`).

CI (`scripts/ci/check-app-envs.py`) is the gate, whoever writes the PR: a release file holds only
the tag, `app.env` and `requiredEnv`; an env var is release-scoped or environment config, never
both; every required env var is set; and a changed `envs/prd/release.yaml` must equal
`envs/stg/release.yaml` (a hotfix changes both in one PR).

**Sample: podinfo** — `https://podinfo.apps.lab.localhost` (2 replicas in prd, so it also gets
a PodDisruptionBudget; custom command/args, `/data` as an extra writable path). Verify:

```bash
kubectl get pods,pdb,httproute -n app-podinfo-prd
curl --cacert platform-ca.crt https://podinfo.apps.lab.localhost/       # prd
curl --cacert platform-ca.crt https://podinfo-stg.apps.lab.localhost/   # stg
kubectl get policyreport -n app-podinfo-prd   # should list no failures
```

In Prometheus, the `podinfo` targets should be up (`up{namespace=~"app-podinfo-.*"}`).

### Tenancy

Every directory `apps/<name>/` becomes one Argo CD Application per environment, `<name>-stg`
and `<name>-prd`, generated by the `apps` ApplicationSet (`gitops/manifests/app-tenancy`, a
matrix of the environment list and the `apps/*` directories):

- rendered with `values.yaml`, `envs/<env>/values.yaml` and `envs/<env>/release.yaml`, as Helm
  release `<name>` (same resource names in every environment)
- deployed to namespace `app-<name>-<env>`, created by Argo CD and labelled
  `platform-lab/tenant: <name>`, `platform-lab/environment: <env>` and
  `app.kubernetes.io/part-of: apps` (the Applications carry the same labels)
- synced automatically (prune + self-heal); deleting the directory deletes the app and its resources
- restricted by the `apps` AppProject: sources from this repo only, destinations `app-*` only,
  no cluster-scoped resources except the app's own Namespace, and no ResourceQuota,
  LimitRange or NetworkPolicy (those are the platform's)
- exposed at `https://<name>.apps.lab.localhost` (prd) and `https://<name>-stg.apps.lab.localhost`
  (stg) through an HTTPRoute on the gateway's `https-apps` listener; the ApplicationSet sets the
  hostname, so it follows the convention
- not excluded from the Kyverno policies, so violations show up in `kubectl get policyreport -n app-<name>-<env>`

`<name>-<env>` must not clash with platform Application names (`kyverno`, `cert-manager`, ...),
since all Applications live in the `argocd` namespace.

## Argo CD login with GitHub

Optional: log in to Argo CD with GitHub instead of the local `admin` account (which keeps
working as a fallback). A personal GitHub account is enough; no organization needed.

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:
   - Homepage URL: `https://argocd.lab.localhost`
   - Authorization callback URL: `https://argocd.lab.localhost/api/dex/callback`
2. Put the client ID and a new client secret in `terraform/platform-addons/terraform.tfvars`
   (gitignored; see the commented example in `terraform.tfvars.example`):

   ```hcl
   github_oauth = {
     client_id     = "<client id>"
     client_secret = "<client secret>"
   }
   argocd_admins = ["you@example.com"] # GitHub email or username
   ```

3. `terraform -chdir=terraform/platform-addons apply`, then use "Log in via GitHub".

Without an organization any GitHub user can authenticate, so access comes only from RBAC
(`argocd-rbac-cm`): `policy.default` is empty (no access), `argocd_admins` get `role:admin`,
and `argocd_app_developers` get `role:app-developer`, which can only manage Applications of
the `apps` project. The client secret is passed with `set_sensitive`: it never appears in git
or plan output, but it is stored in the local Terraform state and in the `argocd-secret` Secret.

## Developer portal

[Backstage](https://backstage.io/) runs at https://backstage.lab.localhost. It is **our own
image**, built from `backstage/app/` (scaffolded with `@backstage/create-app`) by
`.github/workflows/backstage-image.yaml` and pushed to `ghcr.io/talesrc/platform-lab-backstage`
(tags `sha-<commit>` and `latest`; `gitops/platform/backstage.yaml` pins a `sha-` tag). The
lab's configuration is baked into the image (`backstage/app/app-config.production.yaml`):
the database, the catalog locations, GitHub sign-in and the tokens platform tools use to call
Backstage. Secrets come only from Kubernetes Secrets.

**Database.** PostgreSQL run by [CloudNativePG](https://cloudnative-pg.io/): the operator is
`gitops/platform/cloudnative-pg.yaml`, and a one-instance `Cluster` named `backstage-db`
(2 GiB volume) ships with the `backstage` Application, which starts the portal only once the
database is healthy. Backstage reads the generated `backstage-db-app` Secret and keeps every
plugin in its own schema of the `backstage` database, so notifications, starred entities,
home page layouts and scaffolder history survive restarts. There are no backups: the data
lives as long as the kind cluster.

**Sign-in with GitHub.** The public demo image can only offer guest login (its sign-in page is
compiled in), which is why the lab builds its own: `packages/app/src/modules/signIn` replaces
the sign-in page, and the backend uses the GitHub auth provider instead of guest. A GitHub login
signs in only if a catalog User has the same name (`talesrc` in `catalog-info.yaml`).

1. Create a **second** OAuth App (GitHub allows one callback URL per app, so Argo CD's can't be
   reused): Homepage URL `https://backstage.lab.localhost`, Authorization callback URL
   `https://backstage.lab.localhost/api/auth/github/handler/frame`.
2. Put it in `terraform/platform-access/terraform.tfvars` (git-ignored) and apply:

   ```hcl
   backstage_github_oauth = {
     client_id     = "<client id>"
     client_secret = "<client secret>"
   }
   ```

   Terraform stores it in Vault (`secret/platform-lab/backstage/github-oauth`); External
   Secrets turns it into the `backstage-github-oauth` Secret (`AUTH_GITHUB_CLIENT_ID`,
   `AUTH_GITHUB_CLIENT_SECRET`). Without it nobody can sign in.

**Entity pages** show each component's live state, selected by annotations in its
`catalog-info.yaml` (the golden-path template adds them to new services):

| Tab/card | Source | Annotation | Access |
|---|---|---|---|
| Kubernetes | pods, deployments, restarts, errors, logs | `backstage.io/kubernetes-label-selector` (+ `-namespace` for platform components; golden-path apps omit it to show every environment) | pod service account, read-only ClusterRole (no Secrets) |
| Argo CD | sync status, health, history | `argocd/app-name`, or `argocd/app-selector: platform-lab/tenant=<name>` for golden-path apps (all environments) | `backstage` Argo CD account, `role:readonly` (API tokens only) |
| Grafana | dashboards | `grafana/dashboard-selector` | Viewer service account, via Backstage's proxy (token never reaches the browser) |

The Argo CD and Grafana tokens come from `terraform/platform-access`. It reaches Argo CD with
the provider's own port-forward, and Grafana with a short-lived `kubectl port-forward`
(`port-forward.sh`): Terraform is a Go program, and Go doesn't resolve `*.localhost` names the
way browsers and curl do. Grafana's alerts card only lists Grafana-managed alerts and the lab's
alerts are Prometheus rules, so the card is turned off; alerts arrive as notifications instead.

**Changing the portal:** edit `backstage/app/`, push; CI builds and pushes a new `sha-` image;
bump the tag in `gitops/platform/backstage.yaml`. The image is a multi-stage build from source
(`backstage/app/packages/backend/Dockerfile`: dependency install, `yarn tsc`, bundle, then a
runtime stage with production dependencies only), so CI just runs `docker build` and a local
build is one command: `docker build -f packages/backend/Dockerfile .` from `backstage/app`
(about 5 minutes cold, under 30 seconds after a source-only change). Backstage packages are upgraded
together (`yarn backstage-cli versions:bump`, or Renovate's grouped `backstage` PR).
`package.json` pins `@yarnpkg/core` to 4.9.1: 4.9.2 was published with a dependency on a patch
file that only exists in Yarn's own repository, which breaks fresh installs; drop the
resolution once a fixed version is out.

**Notifications** (the bell in the sidebar) reach the owner of a catalog component, or
`platform-team` for the platform itself:

| Event | Sent by | To |
|---|---|---|
| Golden-path pull request opened | the template's `notification:send` step | whoever ran the template |
| App deployed (synced and healthy, once per commit) | Argo CD Notifications | the app's owner |
| App sync failed, app degraded | Argo CD Notifications | the app's owner; `platform-team` for platform Applications |
| Alert firing / resolved | Alertmanager | owners of the components whose `backstage.io/kubernetes-namespace` is the alert's namespace; otherwise `platform-team` |

Argo CD Notifications (configured in `terraform/platform-addons/notifications.tf`) calls
Backstage's notifications API for every Application, with no per-app annotations; tenant apps
are matched to their component by the `platform-lab/tenant` label (`hello-prd` → `hello`), and
alerts in `app-<name>-<env>` reach component `<name>`. Alertmanager's webhook goes to a small backend plugin,
`backstage/app/packages/backend/src/plugins/alertmanager.ts`; a resolved alert replaces its
firing notification. Each caller has its own static token, generated by Terraform and limited
to the one Backstage plugin it calls (`backend.auth.externalAccess`).

- **Catalog:** `catalog-info.yaml` (system `platform-lab`, its components, team and user), read
  from `main` on GitHub every 10 minutes.
- **Golden-path template:** *Create → Golden-path service* renders
  `backstage/templates/golden-path-service/skeleton` into `apps/<name>/` (Deployment, Service,
  HTTPRoute at `<name>.apps.lab.localhost`, ServiceMonitor; compliant with the Kyverno policies)
  and opens a pull request. Merging it deploys the service to stg and prd through the apps
  ApplicationSet; the component shows up in the catalog once its `catalog-info.yaml` is on `main`.
- **Promote template:** *Create → Promote to prd* (`backstage/templates/promote-app`) copies a
  service's stg release to prd and opens a pull request; see [Apps](#apps).

Opening pull requests needs a GitHub token (without one the portal is read-only and catalog
reads use GitHub's anonymous rate limit of 60 requests/hour). Create a
[fine-grained PAT](https://github.com/settings/personal-access-tokens/new) for
`talesrc/platform-lab` only, with **Contents** and **Pull requests** set to *Read and write*,
then add it to `terraform/platform-access/terraform.tfvars` (git-ignored) and apply:

```hcl
backstage_github_token = "github_pat_..."
```

Terraform stores it in Vault; External Secrets turns it into the `backstage-github` Secret,
which Backstage reads as `GITHUB_TOKEN`. The apply restarts Backstage when a value changes.

## Secrets (Vault + External Secrets)

[HashiCorp Vault](https://developer.hashicorp.com/vault) is the lab's secret store, and the
[External Secrets Operator](https://external-secrets.io) (ESO) turns its values into the
Kubernetes Secrets workloads read. Nothing secret is in git, and Terraform writes values to
Vault instead of creating Kubernetes Secrets.

```
terraform/platform-access ──writes──▶ Vault  secret/platform-lab/backstage/{github,github-oauth,platform-access}
                                         │  Kubernetes auth: role external-secrets (read-only)
ESO (ClusterSecretStore vault) ─reads────┘
   └─▶ ExternalSecrets ─▶ Secrets backstage-github, backstage-github-oauth, backstage-platform-access
```

| Piece | Where |
|---|---|
| Vault 2.0 (chart 0.34.1): single node, Raft storage on a 1Gi PVC, UI at https://vault.lab.localhost | `gitops/platform/vault.yaml` (wave -1) |
| Init/unseal CronJob (lab-only, below) | `gitops/manifests/vault/unseal.yaml` |
| External Secrets Operator (chart 2.12.0) | `gitops/platform/external-secrets.yaml` (wave -2) |
| ClusterSecretStore `vault`, ExternalSecrets for Backstage | `gitops/manifests/platform-secrets`, app `platform-secrets` (wave 2) |
| KV v2 mount `secret/`, Kubernetes auth, policy + role `external-secrets`, the values | `terraform/platform-access` |

ExternalSecrets keep the **same Secret names and keys** Terraform used to create, so
Backstage's deployment didn't change. ESO refreshes every 5 minutes; after a value changes,
`terraform -chdir=terraform/platform-access apply` forces a sync and restarts Backstage
(Backstage reads Secrets as environment variables at start-up). External Secrets logs in to
Vault with its own service-account token (audience `vault`) and may only read
`secret/platform-lab/*`.

**Unsealing (LAB-ONLY).** Vault starts *sealed* after every restart. Production setups use
auto-unseal: a `seal` stanza pointing at a cloud KMS, an HSM or another Vault's Transit
engine, so no person or job ever holds the key. A local kind cluster has none of those, so
the `vault-unseal` CronJob (every minute) initializes Vault once (1 key share, threshold 1:
with no separate key holders, more shares side by side add nothing) and stores the unseal key
**and the root token** in the Secret `vault/vault-unseal-keys`, then unseals Vault whenever it
finds it sealed. Anyone who can read that Secret owns Vault; Terraform also uses that root token.
Fine for a single-user lab, never for production (where the root token is revoked after setup
and Terraform logs in through an auth method).

A sealed or uninitialized Vault still reports Ready (its readiness check accepts those
states), so it can't block later sync waves; the `platform-secrets` app sits in the last wave
because it is Degraded until `platform-access` has configured Vault.

```bash
kubectl -n vault get secret vault-unseal-keys -o jsonpath='{.data.root-token}' | base64 -d; echo
kubectl -n vault logs -l app.kubernetes.io/name=vault-unseal --tail=5   # last unseal run
kubectl get externalsecrets -A        # READY True, STATUS SecretSynced
```

**Still created by Terraform** (follow-ups): Argo CD's Dex client secret and the notification
tokens (`notifications.tf`: `backstage-external-access`, `monitoring/alertmanager-backstage`,
`argocd-notifications-secret`). They are generated or needed while `platform-addons` installs
Argo CD and before Alertmanager starts, i.e. before Vault exists; moving them means a
two-phase bootstrap or Vault-generated tokens.

**Migrating a running lab** (Terraform-managed → ESO-managed Secrets):

1. Push; Argo CD installs `external-secrets`, `vault` (the CronJob initializes it within a
   minute) and `platform-secrets` (Degraded for now).
2. Move `backstage_github_token` and `backstage_github_oauth` from
   `terraform/platform-addons/terraform.tfvars` to `terraform/platform-access/terraform.tfvars`.
3. `terraform -chdir=terraform/platform-addons apply`: its `removed` blocks make Terraform
   forget the two GitHub Secrets without deleting them (Backstage keeps working).
4. `kubectl -n backstage delete secret backstage-github backstage-github-oauth backstage-platform-access`
   (ESO only adopts Secrets it created; the running Backstage pod keeps its environment).
5. `terraform -chdir=terraform/platform-access init -upgrade && terraform -chdir=terraform/platform-access apply`:
   forgets its old Secret (`removed` block), configures Vault, writes the values, waits for
   the ExternalSecrets to be Ready and restarts Backstage.

## Docs (TechDocs)

The platform's docs live in [`docs/`](docs/) (`mkdocs.yml` at the root) and are rendered in
Backstage on the `platform-lab` system's *Docs* tab: architecture, bring-up, GitOps and waves,
apps and the golden path, the portal, policies, observability and CI. Every app has its own
`mkdocs.yml` + `docs/` next to its `catalog-info.yaml`; the golden-path template generates them.

| Piece | How |
|---|---|
| Reference | `backstage.io/techdocs-ref: dir:.` on the entity (`url:` for podinfo, which is declared in the root `catalog-info.yaml`) |
| Build | Backstage's local generator (`techdocs.generator.runIn: local`): it fetches the sources from GitHub and runs mkdocs-techdocs-core, installed in the image (`/opt/mkdocs`, pinned in `backstage/app/packages/backend/techdocs-requirements.txt`), so no Docker-in-Docker |
| Storage | local publisher on the pod's filesystem: sites are rebuilt on first view after a restart (production would use `builder: external`, build in CI and publish to object storage) |

Preview locally: `pip install mkdocs-techdocs-core==1.7.1 && mkdocs serve` (from the directory
with the `mkdocs.yml`).

## Standards (scorecards, policy results, permissions)

Backstage makes "good" visible and keeps catalog changes with their owners.

**Scorecards** ([Tech Insights](https://github.com/backstage/community-plugins/tree/main/workspaces/tech-insights)):
every component gets a *Scorecards* tab and card. Fact retrievers collect facts into
PostgreSQL; the checks are JSON rules in `app-config.production.yaml` (`techInsights`):

| Check | Passes when | Applies to |
|---|---|---|
| Owned by a team | `spec.owner` is a Group | all entities |
| Has a description | `metadata.description` is set | all entities |
| Has docs | `backstage.io/techdocs-ref` is set | all entities |
| Shows live state | Kubernetes and Argo CD annotations are set | `service` components |
| Has links | `metadata.links` is not empty | components |
| On the latest golden-path chart | `apps/<name>/Chart.yaml` depends on the newest `charts/app` version | golden-path apps |

The last three use `platformLabFactRetriever` (`packages/backend/src/plugins/techInsightsPlatformLab.ts`),
which reads both `Chart.yaml` files through the GitHub integration, hourly.

**Kyverno results per entity**: [Policy Reporter](https://kyverno.github.io/policy-reporter/)
(`gitops/platform/policy-reporter.yaml`, core API only) aggregates Kyverno's PolicyReports, and
Backstage's Policy Reporter plugin shows them in a *Policy Reporter* tab. An entity needs:

```yaml
metadata:
  annotations:
    kyverno.io/resource-name: <name>   # the workload's name
    kyverno.io/kind: Deployment
    kyverno.io/namespace: app-<name>-prd   # or backstage.io/kubernetes-namespace
spec:
  dependsOn:
    - resource:default/platform-lab-cluster   # carries kyverno.io/endpoint
```

The golden-path template adds these. (The Kubernetes plugin's `customResources` can't do this:
Kyverno labels PolicyReports only with `app.kubernetes.io/managed-by`, not with the app's labels.)

**Permissions** (`packages/backend/src/plugins/permissionPolicy.ts`, replaces allow-all):

| Action | Who |
|---|---|
| Read the catalog, docs, live state, scorecards; run templates | every signed-in user |
| Unregister/delete or refresh an entity | its owners, and `group:platform-team` |
| Register/remove catalog locations | `group:platform-team` |

Templates stay open to everyone: they only open a pull request, and the merge is the gate (CI,
review, Kyverno, the `apps` AppProject). Service-to-service calls (fact retrievers, the
Alertmanager webhook plugin) and the external access tokens (Argo CD Notifications,
Alertmanager) use service principals, which the policy doesn't gate.


### Home page

The landing page (`/`) is the developer's front door. Its default layout is set in
`backstage/app/app-config.yaml` (`page:home`); users can rearrange it.

| Widget | Shows |
|---|---|
| Search bar | catalog and docs search |
| Welcome | the golden path in three steps, with *Create a service* |
| Toolkit | Argo CD, Grafana, Prometheus, Alertmanager and the GitHub repo |
| Starred / Recently / Most visited | the user's own shortcuts |
| **Platform status** | every `platform-lab` component with its live Argo CD sync and health (through the Argo CD plugin's API and read-only token; no extra backend) |
| **My services** | components owned by the signed-in user or their groups (`relations.ownedBy`) |

The two custom widgets live in `packages/app/src/modules/home/`.

## Tear it down

```bash
terraform -chdir=terraform/platform-addons destroy
terraform -chdir=terraform/kind-cluster destroy
# Optional: also drop the image caches (the next build downloads everything again)
terraform -chdir=terraform/registry-cache destroy
```

## CI

GitHub Actions (`.github/workflows/`) runs on every pull request and push to `main`:

| Job | Checks |
|---|---|
| Terraform | `terraform fmt -check`, `init -backend=false` + `validate` for every module in `terraform/` |
| Helm & Kubernetes manifests | `helm lint --strict` on `charts/*`, renders each chart with the values its Argo CD Application uses, then validates the output and every manifest under `gitops/` plus every `apps/*` (rendered with its pinned chart and with the local `charts/app`) with kubeconform (Kubernetes + [CRDs-catalog](https://github.com/datreeio/CRDs-catalog) schemas) |
| Kyverno policy tests | `kyverno test gitops/`: every policy against the good/bad sample resources in `tests/` dirs; then `scripts/ci/check-app-policies.sh`: every `apps/*` must pass all lab policies |
| Conventional Commits | commitlint on the PR's commits (`commitlint.config.mjs`); the PR title is checked too, since squash merges use it |
| Workflow lint | actionlint on the workflows |

Run the manifest checks locally with `scripts/ci/validate-manifests.sh` (needs helm, kubeconform, PyYAML).

[Renovate](https://docs.renovatebot.com/) (`renovate.json`) opens PRs for chart versions in Argo CD Applications,
Terraform providers, versions marked with `# renovate:` comments (Argo CD charts, `kindest/node` tag + digest),
GitHub Actions and CI tool versions. It needs the [Renovate GitHub App](https://github.com/apps/renovate)
installed on this repository.
