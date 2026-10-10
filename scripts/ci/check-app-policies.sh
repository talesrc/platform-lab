#!/usr/bin/env bash
# Golden-path gate: every app under apps/ must pass all lab Kyverno policies
# (the custom ones in gitops/manifests/kyverno-policies plus the Pod Security
# baseline from the kyverno-pod-security Application, rendered with its values).
# The cluster runs them in Audit mode; here a violation fails the build.
# Requires: kyverno, helm, kubectl (kustomize), python3 with PyYAML.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

python3 - "$ROOT/gitops/platform/kyverno-pod-security.yaml" "$OUT/pss-values.yaml" > "$OUT/pss-chart" <<'EOF'
import sys, yaml
src = yaml.safe_load(open(sys.argv[1]))["spec"]["source"]
open(sys.argv[2], "w").write(yaml.safe_dump(src["helm"]["valuesObject"]))
print(src["chart"], src["repoURL"], src["targetRevision"])
EOF
read -r chart repo version < "$OUT/pss-chart"
helm template kyverno-pod-security "$chart" --repo "$repo" --version "$version" \
  --namespace kyverno --values "$OUT/pss-values.yaml" > "$OUT/pod-security.yaml"

policies=("$ROOT"/gitops/manifests/kyverno-policies/*.yaml "$OUT/pod-security.yaml")

status=0
for app in "$ROOT"/apps/*/; do
  [ -f "$app/Chart.yaml" ] || [ -f "$app/kustomization.yaml" ] || continue
  name="$(basename "$app")"
  # Pinned: what Argo CD deploys today. Local: the app with the charts/app working copy,
  # so a chart change that breaks the policies fails before it is published.
  # Every environment (envs/<env>/), or the app alone if it has none (e.g. Kustomize).
  envs=()
  for dir in "$app"envs/*/; do [ -d "$dir" ] && envs+=("$(basename "$dir")"); done
  [ "${#envs[@]}" -gt 0 ] || envs=("")
  for env in "${envs[@]}"; do
    for mode in pinned local; do
      label="$name${env:+-$env}-$mode"
      echo "::group::apps/$name ${env:+$env }($mode)"
      "$ROOT/scripts/ci/render-app.sh" "$app" "$mode" "$env" > "$OUT/app-$label.yaml"
      kyverno apply "${policies[@]}" --resource "$OUT/app-$label.yaml" || status=1
      echo "::endgroup::"
    done
  done
done
exit "$status"
