/*
 * Release files of golden-path apps, shared by the promote and rollback actions
 * (scaffolderPromote.ts).
 *
 * A golden-path app has, per environment, envs/<env>/values.yaml (environment config) and
 * envs/<env>/release.yaml (the release: image tag, release-scoped env vars and the env vars it
 * requires). Applying a release to an environment replaces its release.yaml as one unit, sets
 * environment config the release needs, and refuses a release the environment can't run (a
 * required env var it doesn't set). The same rules run in CI (scripts/ci/check-app-envs.py),
 * which stays the gate: the actions only make the pull request right the first time.
 */
import { InputError } from '@backstage/errors';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMap, parse as parseYaml, parseDocument } from 'yaml';

/** Promotion order; must match the apps ApplicationSet and scripts/ci/check-app-envs.py. */
export const ENVIRONMENTS = ['stg', 'prd'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export type Values = {
  app?: {
    image?: { repository?: string; tag?: string };
    env?: Record<string, string>;
  };
  requiredEnv?: string[];
};

export type ReleaseResult = {
  tag: string;
  previousTag?: string;
  /** Env vars set in envs/<env>/values.yaml. */
  envSet: string[];
  /** Env vars removed from envs/<env>/values.yaml (no longer needed, or now in the release). */
  envRemoved: string[];
};

export type PromotionResult = ReleaseResult & {
  from: Environment;
  to: Environment;
};

const envOf = (values: Values | undefined) => values?.app?.env ?? {};
const names = (list: string[]) =>
  `${list.join(', ')} ${list.length > 1 ? 'are' : 'is'}`;

export const parseRelease = (text: string) => (parseYaml(text) ?? {}) as Values;

/** Two release files are the same release when their content (not comments) is equal. */
export const sameRelease = (a: Values | undefined, b: Values | undefined) =>
  isDeepStrictEqual(a ?? {}, b ?? {});

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readValues(file: string): Promise<Values | undefined> {
  const text = await readText(file);
  return text === undefined ? undefined : parseRelease(text);
}

/** Sets and removes app.env.<name> in a values file, keeping its comments and block style. */
async function editEnv(
  file: string,
  set: Record<string, string>,
  remove: string[],
) {
  const doc = parseDocument(await fs.readFile(file, 'utf8'));
  for (const name of remove) {
    doc.deleteIn(['app', 'env', name]);
  }
  for (const [name, value] of Object.entries(set)) {
    doc.setIn(['app', 'env', name], value);
  }
  const env = doc.getIn(['app', 'env'], true);
  if (isMap(env) && env.items.length === 0) {
    doc.deleteIn(['app', 'env']);
  }
  // `app: {}` is a flow map: write what we add as a regular block, and an emptied `app` as {}.
  for (const keyPath of [['app'], ['app', 'env']]) {
    const node = doc.getIn(keyPath, true);
    if (isMap(node)) node.flow = node.items.length === 0;
  }
  await fs.writeFile(file, doc.toString());
}

/**
 * Makes `release` (the text of a release.yaml) the release of environment `to` of apps/<name>/
 * (appDir), and sets `env` in envs/<to>/values.yaml. With `removeUnused`, also removes from
 * envs/<to>/values.yaml the env vars the environment's current release required and the new
 * one doesn't, and those the new release now sets itself. Throws an InputError, without
 * writing anything, when there is nothing to change or the environment can't run the release.
 */
export async function applyRelease(options: {
  appDir: string;
  to: Environment;
  release: string;
  /** What the release is, for messages: "the stg release", "the previous prd release". */
  label: string;
  env?: Record<string, string>;
  removeUnused?: boolean;
}): Promise<ReleaseResult> {
  const { appDir, to, release: text, label, env = {}, removeUnused } = options;
  const app = path.basename(appDir);
  const file = (name: string) => path.join(appDir, name);

  const release = parseRelease(text);
  const toValues = await readValues(file(`envs/${to}/values.yaml`));
  if (!toValues) {
    throw new InputError(
      `apps/${app} has no envs/${to}/values.yaml; is it a golden-path app with environments?`,
    );
  }
  const current = await readValues(file(`envs/${to}/release.yaml`));
  const shared = (await readValues(file('values.yaml'))) ?? {};

  const tag = release.app?.image?.tag;
  if (!tag) {
    throw new InputError(`${label} of ${app} has no app.image.tag`);
  }
  if (sameRelease(release, current) && Object.keys(env).length === 0) {
    throw new InputError(
      `${app} already runs ${label} (${tag}) in ${to}: nothing to change`,
    );
  }

  // An env var is either release-scoped or environment config, never both.
  const releaseEnv = envOf(release);
  const toEnv = envOf(toValues);
  const inRelease = (name: string) => name in releaseEnv;
  const clashes = [
    ...Object.keys(env).filter(inRelease),
    ...Object.keys(envOf(shared)).filter(inRelease),
    ...(removeUnused ? [] : Object.keys(toEnv).filter(inRelease)),
  ];
  if (clashes.length) {
    throw new InputError(
      `${names(
        clashes,
      )} set by ${label} and also as environment config; keep one`,
    );
  }

  const required = new Set(release.requiredEnv ?? []);
  const removed = removeUnused
    ? Object.keys(toEnv).filter(
        name =>
          !(name in env) &&
          (inRelease(name) ||
            ((current?.requiredEnv ?? []).includes(name) &&
              !required.has(name))),
      )
    : [];

  const provided = new Set([
    ...Object.keys(envOf(shared)),
    ...Object.keys(toEnv).filter(name => !removed.includes(name)),
    ...Object.keys(releaseEnv),
    ...Object.keys(env),
  ]);
  const missing = [...required].filter(name => !provided.has(name));
  if (missing.length) {
    throw new InputError(
      `${tag} requires ${missing.join(', ')}, which ${to} doesn't set. Add ` +
        `${
          missing.length > 1 ? 'them' : 'it'
        } under "Environment variables for ${to}" ` +
        `and run the template again.`,
    );
  }

  await fs.writeFile(file(`envs/${to}/release.yaml`), text);
  if (Object.keys(env).length || removed.length) {
    await editEnv(file(`envs/${to}/values.yaml`), env, removed);
  }

  return {
    tag,
    previousTag: current?.app?.image?.tag,
    envSet: Object.keys(env),
    envRemoved: removed,
  };
}

/**
 * Promotes apps/<name>/ (appDir) to `to`: applies the previous environment's release.yaml,
 * with `env` and the removal of env vars the new release no longer needs.
 */
export async function promoteRelease(
  appDir: string,
  to: Environment,
  env: Record<string, string> = {},
): Promise<PromotionResult> {
  const index = ENVIRONMENTS.indexOf(to);
  if (index < 1) {
    throw new InputError(
      `${to} is not promoted to; promotion goes ${ENVIRONMENTS.join(' → ')}`,
    );
  }
  const from = ENVIRONMENTS[index - 1];
  const release = await readText(
    path.join(appDir, `envs/${from}/release.yaml`),
  );
  if (release === undefined) {
    throw new InputError(
      `apps/${path.basename(appDir)} has no envs/${from}/release.yaml; ` +
        `is it a golden-path app with environments?`,
    );
  }
  const result = await applyRelease({
    appDir,
    to,
    release,
    label: `the ${from} release`,
    env,
    removeUnused: true,
  });
  return { ...result, from, to };
}

/** The image the release in apps/<name>/envs/<env>/release.yaml runs (repository:tag). */
export async function releaseImage(
  appDir: string,
  env: Environment,
): Promise<string | undefined> {
  const shared = await readValues(path.join(appDir, 'values.yaml'));
  const release = await readValues(
    path.join(appDir, `envs/${env}/release.yaml`),
  );
  const repository = shared?.app?.image?.repository;
  const tag = release?.app?.image?.tag;
  return repository && tag ? `${repository}:${tag}` : undefined;
}
