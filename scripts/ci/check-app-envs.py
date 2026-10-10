#!/usr/bin/env python3
"""Check the environments of every golden-path app (apps/<name>/ with a Chart.yaml).

Each app has envs/<env>/values.yaml (environment config) and envs/<env>/release.yaml (the
release: image tag, release-scoped env vars and the env vars it requires), for every
environment of the apps ApplicationSet. Promotion copies a release.yaml to the next
environment as one unit, so:

1. release.yaml holds only app.image.tag, app.env and requiredEnv;
2. an env var is either release-scoped (release.yaml) or environment config (values.yaml,
   envs/<env>/values.yaml), never both;
3. every name in requiredEnv is set in that environment;
4. with --base <git ref> (pull requests): a release.yaml that changed since <ref> must equal
   the previous environment's release.yaml, so prd only runs what stg runs. A hotfix changes
   both files in the same pull request.

Usage: check-app-envs.py [--base <git ref>]
"""
import argparse
import pathlib
import subprocess
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
# Promotion order; must match the list generator in gitops/manifests/app-tenancy/applicationset.yaml.
ENVIRONMENTS = ["stg", "prd"]
RELEASE_KEYS = {"app": {"image": {"tag"}, "env": None}, "requiredEnv": None}


def load(path):
    return yaml.safe_load(path.read_text()) or {}


def env_of(values):
    return dict(((values or {}).get("app") or {}).get("env") or {})


def unexpected_keys(doc, allowed, prefix=""):
    """Keys of doc not in allowed ({key: nested allowed | None for any value})."""
    if not isinstance(doc, dict):
        return []
    found = []
    for key, value in doc.items():
        if key not in allowed:
            found.append(prefix + key)
        elif allowed[key] is not None:
            nested = allowed[key]
            found += unexpected_keys(value, {k: None for k in nested} if isinstance(nested, set) else nested, f"{prefix}{key}.")
    return found


def at_ref(ref, path):
    """Parsed file at a git ref, or None if it didn't exist there."""
    rel = path.relative_to(ROOT).as_posix()
    result = subprocess.run(["git", "-C", str(ROOT), "show", f"{ref}:{rel}"], capture_output=True, text=True)
    return (yaml.safe_load(result.stdout) or {}) if result.returncode == 0 else None


def check_app(app, base):
    errors = []
    name = app.name
    shared = env_of(load(app / "values.yaml")) if (app / "values.yaml").exists() else {}

    envs_dir = app / "envs"
    present = sorted(p.name for p in envs_dir.iterdir() if p.is_dir()) if envs_dir.is_dir() else []
    for extra in sorted(set(present) - set(ENVIRONMENTS)):
        errors.append(f"envs/{extra}/ is not an environment of the platform ({', '.join(ENVIRONMENTS)})")

    releases = {}
    for env in ENVIRONMENTS:
        values_file, release_file = envs_dir / env / "values.yaml", envs_dir / env / "release.yaml"
        missing = [f"envs/{env}/{f.name}" for f in (values_file, release_file) if not f.exists()]
        if missing:
            errors += [f"{m} is missing" for m in missing]
            continue
        values, release = load(values_file), load(release_file)
        releases[env] = release

        for key in unexpected_keys(release, RELEASE_KEYS):
            errors.append(
                f"envs/{env}/release.yaml sets {key}: only app.image.tag, app.env and requiredEnv "
                f"belong to a release (environment config goes in envs/{env}/values.yaml)"
            )
        if not ((release.get("app") or {}).get("image") or {}).get("tag"):
            errors.append(f"envs/{env}/release.yaml has no app.image.tag")

        release_env, env_env = env_of(release), env_of(values)
        for var in sorted(set(release_env) & (set(env_env) | set(shared))):
            where = f"envs/{env}/values.yaml" if var in env_env else "values.yaml"
            errors.append(
                f"{var} is set in both envs/{env}/release.yaml and {where}: an env var is either "
                f"release-scoped (same everywhere) or environment config, not both"
            )

        required = release.get("requiredEnv") or []
        if not isinstance(required, list):
            errors.append(f"envs/{env}/release.yaml: requiredEnv must be a list of env var names")
            required = []
        provided = set(shared) | set(env_env) | set(release_env)
        for var in required:
            if var not in provided:
                errors.append(
                    f"{var} is required by the release in {env} "
                    f"({(release.get('app') or {}).get('image', {}).get('tag', '?')}) "
                    f"but not set in envs/{env}/values.yaml"
                )

    if base:
        for previous, env in zip(ENVIRONMENTS, ENVIRONMENTS[1:]):
            if env not in releases or previous not in releases:
                continue
            if at_ref(base, envs_dir / env / "release.yaml") == releases[env]:
                continue
            if releases[env] != releases[previous]:
                errors.append(
                    f"envs/{env}/release.yaml changed but differs from envs/{previous}/release.yaml: "
                    f"only promote what runs in {previous} (copy the file, or change both for a hotfix)"
                )

    return [f"apps/{name}: {e}" for e in errors]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", help="git ref to compare release.yaml files against (pull requests)")
    args = parser.parse_args()

    errors = []
    apps = sorted(p for p in (ROOT / "apps").iterdir() if (p / "Chart.yaml").exists())
    for app in apps:
        app_errors = check_app(app, args.base)
        errors += app_errors
        print(f"apps/{app.name}: {'ok' if not app_errors else f'{len(app_errors)} problem(s)'}")
    for e in errors:
        print(f"::error::{e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
