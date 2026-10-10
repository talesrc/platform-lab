/*
 * Scaffolder actions for releases of golden-path apps (release files: releases.ts):
 *
 * - platform-lab:app:promote, used by "Promote to prd" (backstage/templates/promote-app):
 *   checks that stg runs the release well (stgHealth.ts), then copies envs/stg/release.yaml to
 *   prd, sets the env vars prd needs and removes the ones the new release no longer needs;
 * - platform-lab:app:rollback, used by "Roll back prd" (backstage/templates/rollback-app):
 *   restores the release prd ran before, from the git history of envs/prd/release.yaml.
 *
 * Both work on apps/<name>/ in the task workspace (fetched by fetch:plain before them); the
 * next step opens the pull request from envs/prd/.
 */
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type FileVersion, GithubFileHistory } from './releaseHistory';
import {
  ENVIRONMENTS,
  applyRelease,
  parseRelease,
  promoteRelease,
  releaseImage,
  sameRelease,
  type Values,
} from './releases';
import { checkStgHealth, stgHealthOptionsFromConfig } from './stgHealth';

/** A branch name that is new on every run (config-only releases reuse a tag). */
export function branchName(
  kind: string,
  app: string,
  tag: string,
  now = new Date(),
) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${kind}/${app}-prd-${tag.replace(/[^A-Za-z0-9._-]/g, '-')}-${stamp}`;
}

export function createPromoteAction(config: Config) {
  return createTemplateAction({
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
              'Environment config to set in envs/<env>/values.yaml (app.env)',
            ),
        checkStg: z =>
          z
            .boolean()
            .default(true)
            .describe(
              'Check in Argo CD and Alertmanager that stg runs the release well first',
            ),
      },
      output: {
        from: z => z.string(),
        to: z => z.string(),
        tag: z => z.string(),
        previousTag: z => z.string(),
        envSet: z => z.string(),
        envRemoved: z => z.string(),
        branchName: z => z.string(),
      },
    },
    async handler(ctx) {
      const { app, to, env, checkStg } = ctx.input;
      const appDir = path.join(ctx.workspacePath, 'apps', app);

      if (checkStg) {
        const image = await releaseImage(appDir, 'stg');
        const problems = await checkStgHealth(
          app,
          image,
          stgHealthOptionsFromConfig(config),
        );
        if (problems.length) {
          throw new InputError(
            `stg isn't ready to promote ${app}:\n${problems
              .map(p => `- ${p}`)
              .join('\n')}`,
          );
        }
        ctx.logger.info(`stg runs ${image} well: Synced, Healthy, no alerts`);
      }

      const result = await promoteRelease(appDir, to, env ?? {});
      ctx.logger.info(
        `${app}: ${result.previousTag ?? 'nothing'} → ${result.tag} in ${
          result.to
        }`,
      );
      ctx.output('from', result.from);
      ctx.output('to', result.to);
      ctx.output('tag', result.tag);
      ctx.output('previousTag', result.previousTag ?? 'none');
      ctx.output('envSet', result.envSet.join(', '));
      ctx.output('envRemoved', result.envRemoved.join(', '));
      ctx.output('branchName', branchName('promote', app, result.tag));
    },
  });
}

/** The newest version in `versions` (newest first) that is a different release than `current`. */
export async function previousRelease(
  versions: AsyncIterable<FileVersion>,
  current: Values,
): Promise<FileVersion | undefined> {
  for await (const version of versions) {
    if (!sameRelease(parseRelease(version.text), current)) return version;
  }
  return undefined;
}

export function createRollbackAction(
  config: Config,
  history?: GithubFileHistory,
) {
  return createTemplateAction({
    id: 'platform-lab:app:rollback',
    description:
      "Restores the release a golden-path app ran in prd before, from envs/prd/release.yaml's git history",
    schema: {
      input: {
        app: z =>
          z
            .string()
            .regex(/^[a-z]([-a-z0-9]{0,30}[a-z0-9])?$/)
            .describe('App name: apps/<app> in the workspace'),
        repo: z =>
          z
            .string()
            .default('talesrc/platform-lab')
            .describe('GitHub repository (owner/name) holding apps/'),
        env: z =>
          z
            .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
            .optional()
            .describe(
              'Environment config to set in envs/<env>/values.yaml (app.env)',
            ),
      },
      output: {
        tag: z => z.string(),
        previousTag: z => z.string(),
        envSet: z => z.string(),
        commit: z => z.string(),
        deployedSince: z => z.string(),
        branchName: z => z.string(),
      },
    },
    async handler(ctx) {
      const { app, repo, env } = ctx.input;
      const appDir = path.join(ctx.workspacePath, 'apps', app);
      const file = `apps/${app}/envs/prd/release.yaml`;
      const current = parseRelease(
        await fs.readFile(path.join(ctx.workspacePath, file), 'utf8'),
      );

      const github = history ?? GithubFileHistory.fromConfig(config);
      const target = await previousRelease(
        github.versions(repo, file),
        current,
      );
      if (!target) {
        throw new InputError(
          `${file} has no earlier release in its recent history: nothing to roll back to`,
        );
      }

      const result = await applyRelease({
        appDir,
        to: 'prd',
        release: target.text,
        label: 'the previous prd release',
        env: env ?? {},
      });
      ctx.logger.info(
        `${app}: ${result.previousTag} → ${
          result.tag
        } in prd (as of ${target.sha.slice(0, 7)})`,
      );
      ctx.output('tag', result.tag);
      ctx.output('previousTag', result.previousTag ?? 'none');
      ctx.output('envSet', result.envSet.join(', '));
      ctx.output('commit', target.sha.slice(0, 7));
      ctx.output('deployedSince', target.date);
      ctx.output('branchName', branchName('rollback', app, result.tag));
    },
  });
}

export default createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'platform-lab-promote',
  register(reg) {
    reg.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        scaffolder.addActions(
          createPromoteAction(config),
          createRollbackAction(config),
        );
      },
    });
  },
});
