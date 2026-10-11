# Roadmap

What's next for the platform, in order. Each item is a pull request (or a few); tick it off
here in the same pull request that finishes it.

## Done

- **Release flow** (#8, rolled out in #11): stg check before promoting, *Roll back prd*, the
  *Releases* card and the *prd keeps up with stg* check.
- **Renovate** (#5, #6, #16): its pull requests are the maintenance queue, listed in the
  Dependency Dashboard issue. Read chart release notes against our values before merging a
  major version.
- **Required checks on `main`**: a repository ruleset requires a pull request and every CI
  check (*Helm & Kubernetes manifests*, *Kyverno policy tests*, *App environments*,
  *Terraform*, *Workflow lint*, *Conventional Commits* and its title check), and blocks force
  pushes and deleting `main`. The empty `app-hello` and `app-podinfo` namespaces are gone.
- **Secrets for apps, through the IdP** (#12): `secretEnv` and `generatedSecretEnv` in the
  chart, one Vault entry per env var at `apps/<name>/<env>/<VAR>`, the `vault-apps` store and
  the `restrict-app-externalsecrets` policy, owner policies in Vault, and in Backstage the
  promotion check, the secrets on the *Releases* card and two scorecard checks. Backstage reads
  only Vault's metadata. See [Apps: Secrets](apps.md#secrets).
- **SLOs and burn-rate alerts** (#13, #17): availability and latency SLOs per app and
  environment from the golden-path chart, multi-window burn-rate alerts, and SLO burn in the
  stg check. See [Observability: SLOs](observability.md#slos).
- **DORA metrics** (#14): the `dora` plugin records prd deploys (Argo CD) and failures
  (Alertmanager), backfills from git, and shows the four metrics on each service and the home
  page. They describe the delivery system, never individuals.
- **"Ready to promote" notification** (#15): owners are told when stg passed its checks and prd
  is behind.
- **Rollout of the above** (#18, plus `terraform apply` of `platform-access` and
  `platform-addons`). Follow-ups found along the way, in one pull request:
  - the Argo CD cards on app pages work again: the gateway kept turning `%2F` in the app
    selector into `/`;
  - the ready-to-promote notification also checks prd's secrets, and says which are missing;
  - SLO alerts and the stg check ignore windows with too little traffic to judge
    (`slo.minRequests`, `stgMinRequests`);
  - podinfo is declared in `apps/podinfo`, so it has a Vault owner policy like hello.

## Now

### 1. The release flow for real

Run it once by hand: a new stg release of `hello`, the ready-to-promote notification,
*Promote to prd*, then *Roll back prd* and promote again. Check that the DORA card counts the
promotion and the rollback, and that the rollback counts as a failure in the change failure
rate.

### 2. People log in to Vault

The owner groups from the secrets work exist but have no members: the lab's only Vault login
is the root token, so nobody can write an app secret as its owner. Log in with the same GitHub
identity as Argo CD and Backstage, through Argo CD's Dex:

- Dex gets a static client for Vault; Vault an `oidc` auth method with roles for the UI and
  the CLI.
- Vault runs in the cluster, so it must reach Dex's issuer
  (`https://argocd.lab.localhost/api/dex`): a CoreDNS rewrite of `*.lab.localhost` to the
  gateway in `terraform/kind-cluster`, and the platform CA in the auth method's config.
- Terraform maps each owner to its group: a `user:` owner (`user:default/talesrc`) becomes an
  entity alias in the owner group. Without a GitHub org Dex returns no groups, so `group:`
  owners (podinfo's `platform-team`) need members listed by hand.

### 3. Platform hygiene found in the rollout

- **Grafana keeps its state.** Grafana has no persistent storage, so a restart drops the
  service account Backstage uses and its dashboards proxy fails until `platform-access` is
  applied again. Give it a volume, or its own database in CloudNativePG.
- **Dex's GitHub client secret out of Helm values.** It is passed in `configs.secret.extra`, so
  it shows in Terraform plans and the Helm release. Read it from Vault through an
  ExternalSecret, like Backstage's secrets.

## Next

### 4. Progressive delivery in prd

Argo Rollouts with a canary step judged by Prometheus (the SLO queries), so a bad release
rolls back on its own; *Roll back prd* stays the manual path. The DORA change failure rate
shows whether it helps.

### 5. A second golden path: workers and cron jobs

A `worker`/`job` variant of the chart and template (no route or HTTP probes; a schedule for
jobs), to check that the release model (stg/prd, promotion, `requiredEnv`, secrets) holds
beyond HTTP services. The SLOs assume HTTP requests: a worker needs its own (e.g. queue age)
or none.

### 6. Resource efficiency per service

What each service reserves against what it uses, from Prometheus (requests vs 95th-percentile
usage over 7 days, per environment): a card on the service, Tech Insights facts, and two
scorecard checks, *requests match usage* (requests at most ~3x usage; memory under ~80% of the
limit) and *stg is smaller than prd*. Money only matters on a real cloud: then OpenCost is the
source and the card reads from it.

### 7. An in-house app

Both apps are podinfo. A small service with its own code, CI, image and OCI labels would
exercise what podinfo can't: DORA lead time back to the commit, image-based releases from its
own builds, and preview environments.

## Later

### 8. Preview environments per pull request

An ApplicationSet pull-request generator deploys `<app>-pr-<n>` for app pull requests, posts
the link on the pull request and removes it on close. Needs the in-house app (item 7).

### 9. Backups and restore

Vault now holds app secrets, and CloudNativePG holds Backstage's data (catalog, DORA,
notifications). Back up both, and restore once on a fresh cluster to prove it.

## Open questions

- **Generated secrets live only in the cluster.** `generatedSecretEnv` values are made by
  External Secrets in the app's namespace, not in Vault: the scorecard doesn't see them, and
  rotating one means deleting its Secret. Fine for a lab; push them to Vault if they need to
  outlive the cluster.
