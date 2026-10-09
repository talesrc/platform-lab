# platform-lab

A local platform engineering lab: a [kind](https://kind.sigs.k8s.io/) cluster bootstrapped
with Terraform and then managed with GitOps by [Argo CD](https://argo-cd.readthedocs.io/).

## Layout

| Path | Owner | What |
|---|---|---|
| `terraform/registry-cache` | Terraform | Pull-through image caches (docker.io, quay.io, registry.k8s.io, ghcr.io, ecr-public.aws.com; reg.kyverno.io via ghcr.io) and the `kind` Docker network; kept across cluster rebuilds |
| `terraform/kind-cluster` | Terraform | kind cluster (via the kind CLI): nodes, version, networking, port mappings |
| `terraform/platform-addons` | Terraform | Bootstrap only: Argo CD, the root app-of-apps, the `backstage` namespace and its optional GitHub token |
| `gitops/platform` | Argo CD | Child Applications, synced in waves |
| `gitops/manifests` | Argo CD | Plain manifests referenced by Applications |
| `apps` | Argo CD (ApplicationSet) | Workloads on the golden path, one directory per app (see [Apps](#apps)) |
| `charts/platform-gateway` | Argo CD | Shared Gateway API entrypoint: GatewayClass, Gateway, TLS, HTTPRoutes |
| `backstage/templates` | Backstage | Software templates (golden paths) |
| `catalog-info.yaml` | Backstage | Software catalog: system, components, team |
| `scripts` | — | Workstation setup (Docker Engine in WSL) |

Sync waves under `gitops/platform`:

1. `cert-manager`, `envoy-gateway` and `kyverno` (wave -2)
2. `cert-manager-issuers`, `metrics-server` and `kube-prometheus-stack` (wave -1): self-signed root → `platform-ca` ClusterIssuer; resource metrics; monitoring stack (see [Observability](#observability))
3. `kyverno-pod-security` and `kyverno-policies` (wave -1): policies in Audit mode (see [Policies](#policies))
4. `backstage` (wave -1): developer portal (see [Developer portal](#developer-portal))
5. `platform-gateway` (wave 0): wildcard `*.lab.localhost` certificate, HTTPS listener, HTTP→HTTPS redirect, routes
6. `app-tenancy` (wave 1): the `apps` AppProject and ApplicationSet (see [Tenancy](#tenancy))

A wave starts only when every app of the previous one is Healthy, and `Degraded` counts as
not Healthy. Platform services exposed through `platform-gateway` (wave 0) must therefore come
earlier: the gateway's HTTPRoute to a Service that doesn't exist yet is Degraded, which would
block every later wave.

## Requirements

Docker, [kind](https://kind.sigs.k8s.io/docs/user/quick-start/#installation) v0.32+, Terraform ≥ 1.6, kubectl.

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

Workloads live in `apps/<name>/` and follow one golden path. An Argo CD ApplicationSet
discovers every directory there and deploys it; there is no per-app Application to write.

| Convention | Value |
|---|---|
| Source | `apps/<name>/kustomization.yaml` + plain manifests |
| Namespace | `app-<name>`, set with `namespace:` in the kustomization; created by the ApplicationSet (don't add a Namespace object) |
| URL | `https://<name>.apps.lab.localhost`: an HTTPRoute with `parentRefs: [{name: platform, namespace: platform-gateway, sectionName: https-apps}]` |
| Pod labels | `app.kubernetes.io/name: <name>` and `app.kubernetes.io/part-of: apps` |
| Metrics | a ServiceMonitor; Prometheus picks it up from any namespace |
| Policies | must pass every lab Kyverno policy (requests + memory limit, pinned image tag, name label, Pod Security baseline) |

`https-apps` is a second HTTPS listener on the platform gateway for `*.apps.lab.localhost`, with
its own certificate from the lab CA (a wildcard covers one label only, so `*.lab.localhost` doesn't
match `x.apps.lab.localhost`). HTTP requests are redirected to HTTPS as for platform hosts.

**Add an app:** copy `apps/podinfo/`, rename it, adjust image/ports/hostname, push. CI builds it
(`kubectl kustomize`), validates the schemas and runs every lab policy against it
(`scripts/ci/check-app-policies.sh`); a violation fails the build, even though the cluster
itself only audits. Once merged, the ApplicationSet creates `app-<name>` and syncs it.

**Sample: podinfo** — `https://podinfo.apps.lab.localhost` (2 replicas, non-root, read-only
root filesystem, PodDisruptionBudget, ServiceMonitor). Verify:

```bash
kubectl get pods,httproute -n app-podinfo
curl --cacert platform-ca.crt https://podinfo.apps.lab.localhost/
kubectl get policyreport -n app-podinfo   # should list no failures
```

In Prometheus, the `podinfo` target should be up (`up{namespace="app-podinfo"}`).

### Tenancy

Every directory `apps/<name>/` (a Kustomize directory) becomes an Argo CD Application named
`<name>`, generated by the `apps` ApplicationSet (`gitops/manifests/app-tenancy`):

- deployed to namespace `app-<name>`, created by Argo CD and labelled
  `platform-lab/tenant: <name>` and `app.kubernetes.io/part-of: apps`
- synced automatically (prune + self-heal); deleting the directory deletes the app and its resources
- restricted by the `apps` AppProject: sources from this repo only, destinations `app-*` only,
  no cluster-scoped resources except the app's own Namespace, and no ResourceQuota,
  LimitRange or NetworkPolicy (those are the platform's)
- exposed at `https://<name>.apps.lab.localhost` through an HTTPRoute on the gateway's
  `https-apps` listener
- not excluded from the Kyverno policies, so violations show up in `kubectl get policyreport -n app-<name>`

Directory names must not clash with platform Application names (`kyverno`, `cert-manager`, ...),
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
in-memory SQLite (no database to run; the catalog is reloaded from git on every restart),
the catalog locations, and GitHub sign-in. Secrets come only from Kubernetes Secrets.

**Sign-in with GitHub.** The public demo image can only offer guest login (its sign-in page is
compiled in), which is why the lab builds its own: `packages/app/src/modules/signIn` replaces
the sign-in page, and the backend uses the GitHub auth provider instead of guest. A GitHub login
signs in only if a catalog User has the same name (`talesrc` in `catalog-info.yaml`).

1. Create a **second** OAuth App (GitHub allows one callback URL per app, so Argo CD's can't be
   reused): Homepage URL `https://backstage.lab.localhost`, Authorization callback URL
   `https://backstage.lab.localhost/api/auth/github/handler/frame`.
2. Put it in `terraform/platform-addons/terraform.tfvars` (git-ignored) and apply:

   ```hcl
   backstage_github_oauth = {
     client_id     = "<client id>"
     client_secret = "<client secret>"
   }
   ```

   Terraform stores it as the `backstage-github-oauth` Secret (`AUTH_GITHUB_CLIENT_ID`,
   `AUTH_GITHUB_CLIENT_SECRET`). Without it nobody can sign in.

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

- **Catalog:** `catalog-info.yaml` (system `platform-lab`, its components, team and user), read
  from `main` on GitHub every 10 minutes.
- **Golden-path template:** *Create → Golden-path service* renders
  `backstage/templates/golden-path-service/skeleton` into `apps/<name>/` (Deployment, Service,
  HTTPRoute at `<name>.apps.lab.localhost`, ServiceMonitor; compliant with the Kyverno policies)
  and opens a pull request. Merging it deploys the service through the apps ApplicationSet;
  the component shows up in the catalog once its `catalog-info.yaml` is on `main`.

Opening pull requests needs a GitHub token (without one the portal is read-only and catalog
reads use GitHub's anonymous rate limit of 60 requests/hour). Create a
[fine-grained PAT](https://github.com/settings/personal-access-tokens/new) for
`talesrc/platform-lab` only, with **Contents** and **Pull requests** set to *Read and write*,
then add it to `terraform/platform-addons/terraform.tfvars` (git-ignored) and apply:

```hcl
backstage_github_token = "github_pat_..."
```

Terraform stores it as the `backstage-github` Secret, which Backstage reads as `GITHUB_TOKEN`
(restart the pod after changing it: `kubectl -n backstage rollout restart deploy/backstage`).

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
| Helm & Kubernetes manifests | `helm lint --strict` on `charts/*`, renders each chart with the values its Argo CD Application uses, then validates the output and every manifest under `gitops/` plus every `kubectl kustomize apps/*` build with kubeconform (Kubernetes + [CRDs-catalog](https://github.com/datreeio/CRDs-catalog) schemas) |
| Kyverno policy tests | `kyverno test gitops/`: every policy against the good/bad sample resources in `tests/` dirs; then `scripts/ci/check-app-policies.sh`: every `apps/*` must pass all lab policies |
| Conventional Commits | commitlint on the PR's commits (`commitlint.config.mjs`); the PR title is checked too, since squash merges use it |
| Workflow lint | actionlint on the workflows |

Run the manifest checks locally with `scripts/ci/validate-manifests.sh` (needs helm, kubeconform, PyYAML).

[Renovate](https://docs.renovatebot.com/) (`renovate.json`) opens PRs for chart versions in Argo CD Applications,
Terraform providers, versions marked with `# renovate:` comments (Argo CD charts, `kindest/node` tag + digest),
GitHub Actions and CI tool versions. It needs the [Renovate GitHub App](https://github.com/apps/renovate)
installed on this repository.
