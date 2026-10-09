#!/usr/bin/env python3
"""Render every local chart under charts/ with the values Argo CD uses.

For each charts/<name>, finds the Argo CD Applications in gitops/ whose source
path is charts/<name> and renders the chart once per Application, with its
destination namespace and helm values (valuesObject / values / valueFiles).
Charts no Application references are rendered with their default values.

Usage: render-charts.py <output-dir>
"""
import pathlib
import subprocess
import sys
import tempfile

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]


def applications():
    for f in sorted((ROOT / "gitops").rglob("*.y*ml")):
        for doc in yaml.safe_load_all(f.read_text()):
            if isinstance(doc, dict) and doc.get("kind") == "Application":
                yield f, doc


def chart_sources(app):
    spec = app.get("spec", {})
    for src in spec.get("sources") or [spec.get("source") or {}]:
        path = (src.get("path") or "").strip("/")
        if path.startswith("charts/"):
            yield path, src.get("helm") or {}


def render(chart, name, namespace, helm, out):
    cmd = ["helm", "template", name, str(ROOT / chart), "--namespace", namespace]
    with tempfile.TemporaryDirectory() as tmp:
        for vf in helm.get("valueFiles") or []:
            cmd += ["--values", str(ROOT / chart / vf)]
        if helm.get("values"):
            p = pathlib.Path(tmp, "values.yaml")
            p.write_text(helm["values"])
            cmd += ["--values", str(p)]
        if helm.get("valuesObject"):
            p = pathlib.Path(tmp, "values-object.yaml")
            p.write_text(yaml.safe_dump(helm["valuesObject"]))
            cmd += ["--values", str(p)]
        manifest = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    dest = out / f"{name}.yaml"
    dest.write_text(manifest)
    print(f"rendered {chart} as {name} (namespace {namespace}) -> {dest.relative_to(out.parent)}")


def main():
    out = pathlib.Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    used = set()
    for f, app in applications():
        for chart, helm in chart_sources(app):
            used.add(chart)
            name = helm.get("releaseName") or app["metadata"]["name"]
            ns = app.get("spec", {}).get("destination", {}).get("namespace", "default")
            render(chart, name, ns, helm, out)
    for chart_dir in sorted((ROOT / "charts").iterdir()):
        chart = f"charts/{chart_dir.name}"
        # Charts that need values (e.g. charts/app) ship ci/*-values.yaml and are rendered
        # with those by validate-manifests.sh instead.
        if list(chart_dir.glob("ci/*-values.yaml")):
            continue
        if (chart_dir / "Chart.yaml").exists() and chart not in used:
            render(chart, chart_dir.name, "default", {}, out)


if __name__ == "__main__":
    main()
