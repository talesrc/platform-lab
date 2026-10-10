#!/usr/bin/env bash
# Lints the local Helm charts and validates every Kubernetes manifest in the
# repo (rendered charts, kustomize-built apps/* and YAML under gitops/) against
# Kubernetes and CRD schemas.
# Requires: helm, kubectl (kustomize apps), kubeconform, python3 with PyYAML.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KUBERNETES_VERSION="${KUBERNETES_VERSION:-1.37.0}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "::group::helm lint"
for chart in "$ROOT"/charts/*/; do
  # Charts that require values (e.g. charts/app) ship them in ci/*-values.yaml.
  if compgen -G "${chart}ci/*-values.yaml" >/dev/null; then
    for values in "${chart}"ci/*-values.yaml; do
      helm lint --strict "$chart" -f "$values"
    done
  else
    helm lint --strict "$chart"
  fi
done
echo "::endgroup::"

echo "::group::helm template"
python3 "$ROOT/scripts/ci/render-charts.py" "$OUT/rendered"
echo "::endgroup::"

echo "::group::render apps per environment (pinned chart + local charts/app)"
for app in "$ROOT"/apps/*/; do
  [ -f "$app/Chart.yaml" ] || [ -f "$app/kustomization.yaml" ] || continue
  name="$(basename "$app")"
  # Every environment (envs/<env>/), or the app alone if it has none (e.g. Kustomize).
  envs=()
  for dir in "$app"envs/*/; do [ -d "$dir" ] && envs+=("$(basename "$dir")"); done
  [ "${#envs[@]}" -gt 0 ] || envs=("")
  for env in "${envs[@]}"; do
    for mode in pinned local; do
      label="$name${env:+-$env}-$mode"
      "$ROOT/scripts/ci/render-app.sh" "$app" "$mode" "$env" > "$OUT/rendered/app-$label.yaml"
      echo "rendered apps/$name ${env:+$env }($mode) -> rendered/app-$label.yaml"
    done
  done
done
for values in "$ROOT"/charts/app/ci/*-values.yaml; do
  [ -f "$values" ] || continue
  helm template ci "$ROOT/charts/app" -f "$values" > "$OUT/rendered/chart-app-$(basename "$values" .yaml).yaml"
done
echo "::endgroup::"

# Only YAML files that are Kubernetes objects (skip e.g. Helm values files).
# tests/ dirs hold Kyverno CLI test suites (kind: Test), run by `kyverno test` instead.
mapfile -t manifests < <(grep -rlE --include='*.yaml' --include='*.yml' --exclude-dir=tests '^kind:' "$ROOT/gitops" || true)

echo "::group::kubeconform"
# ClusterSecretStore is skipped: the CRDs-catalog schema for external-secrets.io/v1 has a
# property literally named "additionalProperties" set to false (crd provider,
# whitelist.rules.items), which kubeconform can't compile, so it reports "could not find
# schema" for every ClusterSecretStore. The API server still validates it on apply.
kubeconform \
  -strict \
  -summary \
  -output text \
  -skip ClusterSecretStore \
  -kubernetes-version "$KUBERNETES_VERSION" \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  "$OUT/rendered" "${manifests[@]}"
echo "::endgroup::"
