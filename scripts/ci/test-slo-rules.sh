#!/usr/bin/env bash
# Unit-tests the SLO recording and burn-rate alert rules of charts/app (templates/slo.yaml):
# renders them for an app "hello" in app-hello-stg and runs scripts/ci/slo-rules-test.yaml
# against them with `promtool test rules`, so a chart change can't silently break the alerts.
# Requires: helm, promtool, python3 with PyYAML.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

helm template hello "$ROOT/charts/app" --namespace app-hello-stg \
  -f "$ROOT/charts/app/ci/default-values.yaml" --show-only templates/slo.yaml \
  | python3 -c 'import sys, yaml; yaml.safe_dump(yaml.safe_load(sys.stdin)["spec"], sys.stdout, sort_keys=False)' \
  > "$OUT/rules.yaml"
cp "$ROOT/scripts/ci/slo-rules-test.yaml" "$OUT/"

promtool check rules "$OUT/rules.yaml"
promtool test rules "$OUT/slo-rules-test.yaml"
