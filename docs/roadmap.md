# Roadmap

What's next for the platform, in order. Each item is a pull request (or a few); tick it off
here in the same pull request that finishes it.

## Now

### 1. Finish the release-flow rollout

The portal changes from pull request #8 (stg check before promoting, *Roll back prd*,
the *Releases* card, the *prd keeps up with stg* check) reach the cluster once the Backstage
image is bumped in `gitops/platform/backstage.yaml`. Then check them for real: the scaffolder
lists `platform-lab:app:rollback`, `hello` shows its *Releases* card, and Renovate's Dependency
Dashboard lists the two `envs/stg/release.yaml` files. Try *Roll back prd* on `hello`, then
promote again.

### 2. Work through the first Renovate pull requests

Renovate is installed and has opened its first pull requests (curl image, kube-prometheus-stack).
Read chart release notes against our values before merging major versions; from now on the
Dependency Dashboard issue is the maintenance queue.

### 3. Required checks and cleanup

- Confirm that `main`'s branch protection **requires** the CI checks (*App environments*,
  *Helm & Kubernetes manifests*, *Kyverno policy tests*), so CI actually blocks a merge.
- Delete the empty `app-hello` and `app-podinfo` namespaces left by the move to stg/prd.

## Next

### 4. Secrets for apps, through the IdP

Env var values are plain text in git today, and apps don't use Vault or External Secrets yet.
The IdP should create everything **around** a secret and check it; values live only in Vault.

**What the IdP does**

- **Creates the structure.** The golden path gives each app and environment a Vault path
  (`apps/<name>/<env>`), a Vault policy for the owning team on that path, and the
  ExternalSecret that syncs it into `app-<name>-<env>`. The chart gets `secretEnv`: env vars
  that reference a Secret key (`secretKeyRef`), never a value.
- **Checks that secrets exist.** A release can require a secret, like `requiredEnv` requires
  environment config; promotion refuses to open the pull request while prd's secret is
  missing. Backstage reads only Vault **metadata** (exists, version, last updated: the KV v2
  `metadata/` path), never values.
- **Shows state.** The *Releases* card lists each secret per environment (missing, present,
  last rotated); a scorecard check flags secrets older than 90 days.

**Where values come from**, in order of preference:

1. **Generated, never seen by anyone:** External Secrets generators (random passwords) or Vault
   dynamic secrets (short-lived Postgres credentials from the database engine, alongside
   CloudNativePG). Rotation comes with it.
2. **Typed into Vault directly** by a person with their own Vault login, limited by the owner
   policy, for third-party keys. The IdP links straight to the right path.
3. **A Backstage form that writes to Vault** only if people can't get a Vault login: it makes
   Backstage a privileged writer of every app's secrets, so restrict it to the service's owners
   and audit it.

**Never:** secret values in git, in normal template parameters (they are stored in the
scaffolder's task history), in pull request descriptions or in notifications.

This changes the chart, so it also exercises the chart-upgrade path: a new `charts/app` version,
then one Renovate pull request per app.

### 5. DORA metrics

The four metrics, defined for this platform:

| Metric | Here |
|---|---|
| Deployment frequency | deploys of a new release to prd (promotion, rollback or hotfix) per service per week |
| Lead time for changes | from the release landing in stg (merge of `envs/stg/release.yaml`) to running in prd; for in-house apps, extend back to the commit with the image's OCI labels |
| Change failure rate | prd deploys followed by a rollback, a hotfix or a critical alert in `app-<name>-prd` within 24 hours |
| Time to restore | from a prd failure (critical alert firing, or the bad deploy) to recovery (alert resolved, or rollback deployed) |

A `dora` backend plugin records prd deploys (a second Argo CD Notifications webhook) and prd
incidents (the Alertmanager plugin) in its own Postgres schema, classifies deploys from their
commit (`chore(apps): promote`, `fix(apps): roll back`, both release files changed = hotfix)
and backfills from git. It exposes the metrics as Tech Insights facts, a card on each service
and a home-page widget. With two apps the numbers are a demo of the pipeline, not a signal; and
they describe the delivery system, never individuals.

### 6. "Ready to promote" notification

When stg has passed its soak time with no alerts and prd is behind it, notify the owner with
the prefilled *Promote to prd* link, so promotion is a nudge instead of something to remember.

### 7. SLOs and burn-rate alerts per service

The golden-path chart creates a default availability and latency SLO per app and environment
(Sloth or plain PrometheusRules, from the ServiceMonitor metrics). The stg check and the DORA
change failure rate can then use SLO burn instead of "any critical alert".

## Later

### 8. Progressive delivery in prd

Argo Rollouts with a canary step judged by Prometheus (the SLO queries from item 7), so a bad
release rolls back on its own; *Roll back prd* stays the manual path.

### 9. A second golden path: workers and cron jobs

A `worker`/`job` variant of the chart and template (no route or HTTP probes; a schedule for
jobs), to check that the release model (stg/prd, promotion, `requiredEnv`) holds beyond HTTP
services.

### 10. Preview environments per pull request

An ApplicationSet pull-request generator deploys `<app>-pr-<n>` for app pull requests, posts
the link on the pull request and removes it on close. Most useful once there is an in-house
app with real code.
