/*
 * Scaffolder action platform-lab:app:promote, used by the "Promote to prd" template
 * (backstage/templates/promote-app/template.yaml).
 *
 * A golden-path app has, per environment, envs/<env>/values.yaml (environment config) and
 * envs/<env>/release.yaml (the release: image tag, release-scoped env vars and the env vars it
 * requires). Promoting copies the previous environment's release.yaml as one unit, optionally
 * sets environment config the new release needs, and refuses a promotion the target
 * environment can't run (a required env var it doesn't set). The same rules run in CI
 * (scripts/ci/check-app-envs.py), which stays the gate: this action only makes the pull
 * request right the first time.
 *
 * It works on apps/<name>/ in the task workspace (fetched by fetch:plain before it); the next
 * step opens the pull request from envs/<to>/.
 */
import { createBackendModule } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMap, parse as parseYaml, parseDocument } from 'yaml';

/** Promotion order; must match the apps ApplicationSet and scripts/ci/check-app-envs.py. */
export const ENVIRONMENTS = ['stg', 'prd'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

type Values = {
  app?: { image?: { tag?: string }; env?: Record<string, string> };
  requiredEnv?: string[];
};

export type PromotionResult = {
  from: Environment;
  to: Environment;
  tag: string;
  previousTag?: string;
  envSet: string[];
};

const envOf = (values: Values | undefined) => values?.app?.env ?? {};

async function readValues(file: string): Promise<Values | undefined> {
  try {
    return (parseYaml(await fs.readFile(file, 'utf8')) ?? {}) as Values;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Sets app.env.<name> in a values file, keeping its comments and block style. */
async function setEnv(file: string, env: Record<string, string>) {
  const doc = parseDocument(await fs.readFile(file, 'utf8'));
  for (const [name, value] of Object.entries(env)) {
    doc.setIn(['app', 'env', name], value);
  }
  // `app: {}` is a flow map; write what we add as a regular block.
  for (const keyPath of [['app'], ['app', 'env']]) {
    const node = doc.getIn(keyPath, true);
    if (isMap(node)) node.flow = false;
  }
  await fs.writeFile(file, doc.toString());
}

/**
 * Promotes apps/<name>/ (appDir) to `to`: copies the previous environment's release.yaml
 * and sets `env` in envs/<to>/values.yaml. Throws an InputError, without writing anything,
 * when there is nothing to promote or the target environment lacks a required env var.
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
  const app = path.basename(appDir);
  const file = (name: string) => path.join(appDir, name);

  const fromRelease = await readValues(file(`envs/${from}/release.yaml`));
  const toValues = await readValues(file(`envs/${to}/values.yaml`));
  if (!fromRelease || !toValues) {
    throw new InputError(
      `apps/${app} has no envs/${from}/release.yaml or envs/${to}/values.yaml; ` +
        `is it a golden-path app with environments?`,
    );
  }
  const toRelease = await readValues(file(`envs/${to}/release.yaml`));
  const shared = (await readValues(file('values.yaml'))) ?? {};

  const tag = fromRelease.app?.image?.tag;
  if (!tag) {
    throw new InputError(
      `apps/${app}/envs/${from}/release.yaml has no app.image.tag`,
    );
  }
  if (
    isDeepStrictEqual(fromRelease, toRelease) &&
    Object.keys(env).length === 0
  ) {
    throw new InputError(
      `${app} already runs the ${from} release (${tag}) in ${to}: nothing to promote`,
    );
  }

  const releaseEnv = envOf(fromRelease);
  // An env var is either release-scoped or environment config, never both.
  const clashes = Object.keys(releaseEnv).filter(
    name => name in env || name in envOf(toValues) || name in envOf(shared),
  );
  if (clashes.length) {
    throw new InputError(
      `${clashes.join(', ')} ${
        clashes.length > 1 ? 'are' : 'is'
      } set by the release ` +
        `(envs/${from}/release.yaml) and also as environment config; keep one`,
    );
  }

  const provided = new Set([
    ...Object.keys(envOf(shared)),
    ...Object.keys(envOf(toValues)),
    ...Object.keys(releaseEnv),
    ...Object.keys(env),
  ]);
  const missing = (fromRelease.requiredEnv ?? []).filter(
    name => !provided.has(name),
  );
  if (missing.length) {
    throw new InputError(
      `${tag} requires ${missing.join(', ')}, which ${to} doesn't set. Add ` +
        `${
          missing.length > 1 ? 'them' : 'it'
        } under "Environment variables for ${to}" ` +
        `and run the template again.`,
    );
  }

  await fs.copyFile(
    file(`envs/${from}/release.yaml`),
    file(`envs/${to}/release.yaml`),
  );
  if (Object.keys(env).length) {
    await setEnv(file(`envs/${to}/values.yaml`), env);
  }

  return {
    from,
    to,
    tag,
    previousTag: toRelease?.app?.image?.tag,
    envSet: Object.keys(env),
  };
}

export const promoteAction = createTemplateAction({
  id: 'platform-lab:app:promote',
  description:
    "Promotes a golden-path app's release (envs/<from>/release.yaml) to the next environment",
  schema: {
    input: {
      app: z =>
        z
          .string()
          .regex(/^[a-z]([-a-z0-9]{0,30}[a-z0-9])?$/)
          .describe('App name: apps/<app> in the workspace'),
      to: z =>
        z
          .enum(ENVIRONMENTS)
          .default('prd')
          .describe('Environment to promote to'),
      env: z =>
        z
          .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
          .optional()
          .describe(
            'Environment config to set in envs/<to>/values.yaml (app.env)',
          ),
    },
    output: {
      from: z => z.string(),
      to: z => z.string(),
      tag: z => z.string(),
      previousTag: z => z.string(),
      envSet: z => z.string(),
    },
  },
  async handler(ctx) {
    const { app, to, env } = ctx.input;
    const result = await promoteRelease(
      path.join(ctx.workspacePath, 'apps', app),
      to,
      env ?? {},
    );
    const sets = result.envSet.length
      ? ` (sets ${result.envSet.join(', ')})`
      : '';
    ctx.logger.info(
      `${app}: ${result.previousTag ?? 'nothing'} → ${result.tag} in ${
        result.to
      }${sets}`,
    );
    ctx.output('from', result.from);
    ctx.output('to', result.to);
    ctx.output('tag', result.tag);
    ctx.output('previousTag', result.previousTag ?? 'none');
    ctx.output('envSet', result.envSet.join(', '));
  },
});

export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'platform-lab-promote',
  register(reg) {
    reg.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(promoteAction);
      },
    });
  },
});
