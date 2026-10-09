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
  [ -f "$app/kustomization.yaml" ] || continue
  name="$(basename "$app")"
  echo "::group::apps/$name"
  kubectl kustomize "$app" > "$OUT/app-$name.yaml"
  kyverno apply "${policies[@]}" --resource "$OUT/app-$name.yaml" || status=1
  echo "::endgroup::"
done
exit "$status"
