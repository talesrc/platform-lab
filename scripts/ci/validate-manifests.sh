#!/usr/bin/env bash
# Lints the local Helm charts and validates every Kubernetes manifest in the
# repo (rendered charts + YAML under gitops/) against Kubernetes and CRD schemas.
# Requires: helm, kubeconform, python3 with PyYAML.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KUBERNETES_VERSION="${KUBERNETES_VERSION:-1.37.0}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "::group::helm lint"
for chart in "$ROOT"/charts/*/; do
  helm lint --strict "$chart"
done
echo "::endgroup::"

echo "::group::helm template"
python3 "$ROOT/scripts/ci/render-charts.py" "$OUT/rendered"
echo "::endgroup::"

# Only YAML files that are Kubernetes objects (skip e.g. Helm values files).
# tests/ dirs hold Kyverno CLI test suites (kind: Test), run by `kyverno test` instead.
mapfile -t manifests < <(grep -rlE --include='*.yaml' --include='*.yml' --exclude-dir=tests '^kind:' "$ROOT/gitops" || true)

echo "::group::kubeconform"
kubeconform \
  -strict \
  -summary \
  -output text \
  -kubernetes-version "$KUBERNETES_VERSION" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT/rendered" "${manifests[@]}"
echo "::endgroup::"
