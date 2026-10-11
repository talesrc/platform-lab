# Policies

[Kyverno](https://kyverno.io/) checks every Pod against these policies, written as CEL
`ValidatingPolicy` resources:

| Policy | Checks |
|---|---|
| `require-requests-limits` | CPU and memory requests, and a memory limit, on every container |
| `disallow-latest-tag` | images pinned to a tag other than `latest`, or to a digest |
| `require-app-name-label` | the `app.kubernetes.io/name` label on Pods |
| Pod Security Standards (baseline), 11 policies | no privileged containers, host namespaces/paths/ports, added capabilities, … |
| `restrict-app-externalsecrets` (**Deny**) | ExternalSecrets in `app-<name>-<env>` use the `vault-apps` store and keys under `apps/<name>/<env>/` only, or generators |

## Audit mode

All policies but `restrict-app-externalsecrets` run in **Audit** mode: nothing is blocked in the
cluster, and violations are
recorded in policy reports. Platform and system namespaces are excluded, so the reports focus
on workloads. Kyverno's webhooks use `failurePolicy: Ignore`, so a Kyverno outage never blocks
the cluster.

`restrict-app-externalsecrets` is the exception: it is a security boundary, not a best practice.
The `vault-apps` store's Vault role reads every app's secrets, so this policy is what keeps one
tenant out of another's; it denies, with `failurePolicy: Fail`, and only matches ExternalSecrets
in app namespaces.

CI is stricter: every app under `apps/` must pass all policies, or the pull request fails.

```bash
kubectl get policyreport -A                       # summary per namespace
kubectl get policyreport -n <namespace> -o yaml   # individual results
```

## Making a policy blocking

Change its `validationActions` from `[Audit]` to `[Deny]` (for the Pod Security policies, set
`validationFailureActionByPolicy` in `gitops/platform/kyverno-pod-security.yaml`) and push. Check
that its reports are clean first.

## Testing policies

```bash
kyverno test gitops/manifests/kyverno-policies/tests
```
