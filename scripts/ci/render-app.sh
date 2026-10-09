#!/usr/bin/env bash
# Render one app under apps/<name>/ to stdout, the way Argo CD does.
#   render-app.sh <app-dir> [pinned|local]
# Helm apps (Chart.yaml): `pinned` uses the dependency version from Chart.yaml (published
# chart); `local` swaps it for the working copy of charts/app, so chart changes are tested
# against every app before they are published. Kustomize apps ignore the mode.
set -euo pipefail

app="${1%/}"
mode="${2:-pinned}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
name="$(basename "$app")"

if [ -f "$app/Chart.yaml" ]; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  cp -r "$app/." "$work/"
  rm -rf "$work/charts"
  if [ "$mode" = local ]; then
    local_version="$(helm show chart "$root/charts/app" | awk '/^version:/ {print $2}')"
    python3 - "$work/Chart.yaml" "$root/charts/app" "$local_version" <<'PY'
import sys, yaml
path, chart_dir, version = sys.argv[1:]
chart = yaml.safe_load(open(path))
for dep in chart.get("dependencies", []):
    if dep["name"] == "app":
        dep["repository"] = f"file://{chart_dir}"
        dep["version"] = version
yaml.safe_dump(chart, open(path, "w"), sort_keys=False)
PY
    rm -f "$work/Chart.lock"
  fi
  helm dependency build "$work" >/dev/null
  helm template "$name" "$work" --namespace "app-$name"
elif [ -f "$app/kustomization.yaml" ]; then
  kubectl kustomize "$app"
else
  echo "apps/$name has neither Chart.yaml nor kustomization.yaml" >&2
  exit 1
fi
