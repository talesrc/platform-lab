# CI and updates

GitHub Actions (`.github/workflows/`) runs on every pull request and push to `main`.

| Workflow / job | Checks |
|---|---|
| CI → Terraform | `terraform fmt -check`, `init -backend=false` and `validate` for every module |
| CI → Helm & Kubernetes manifests | `helm lint` of the charts; renders the charts and every app (with its pinned chart and with the local `charts/app`) and validates them with kubeconform against Kubernetes and CRD schemas |
| CI → Kyverno policy tests | `kyverno test` on the policy test suites, then every app against every policy |
| CI → Conventional Commits | commitlint on pull request commits and titles |
| CI → Workflow lint | actionlint |
| Charts | publishes `charts/app` to `oci://ghcr.io/talesrc/charts` when its version changes |
| Backstage image | builds `ghcr.io/talesrc/platform-lab-backstage` (multi-stage Dockerfile) |

Run the manifest checks locally:

```bash
scripts/ci/validate-manifests.sh      # needs helm, kubeconform, PyYAML
scripts/ci/check-app-policies.sh      # needs helm, kyverno
```

## Updates

[Renovate](https://docs.renovatebot.com/) opens pull requests for chart versions in Argo CD
Applications, Terraform providers, pinned versions marked with `# renovate:` comments, GitHub
Actions and CI tools, Backstage packages (grouped), and the golden-path chart (one pull request
per app).

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
