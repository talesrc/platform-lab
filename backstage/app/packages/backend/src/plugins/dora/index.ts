/*
 * DORA metrics of golden-path apps (docs/portal.md#dora-metrics): records prd deploys and
 * prd failures in its own schema and serves the four metrics.
 *
 * - POST /api/dora/deploys: Argo CD Notifications, when a prd Application has synced and is
 *   healthy (terraform/platform-addons/notifications.tf). The deployed commit is classified
 *   from GitHub (deploys.ts).
 * - POST /api/dora/alerts: Alertmanager's webhook payload, for prd failure signals
 *   (signals.ts; gitops/platform/kube-prometheus-stack.yaml routes them here).
 * - GET /api/dora/metrics[/<app>]?days=30: the metrics (metrics.ts), for the entity card,
 *   the home-page widget and the Tech Insights facts (techInsights.ts).
 *
 * A backfill task rebuilds deploys from the history of each golden-path app's
 * envs/prd/release.yaml, so the metrics don't start empty and a missed webhook is caught up
 * (deploy time = when the change merged). Webhook callers authenticate with their static
 * tokens (backend.auth.externalAccess, allowed for this plugin).
 */
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import express from 'express';
import Router from 'express-promise-router';
import { GOLDEN_PATH_SOURCE } from '../techInsightsPlatformLab';
import { describeDeploy } from './deploys';
import { GithubCommits, repoOf } from './github';
import { computeMetrics } from './metrics';
import { failingApp } from './signals';
import { DoraStore } from './store';

type DeployPayload = {
  app?: string;
  environment?: string;
  revision?: string;
  repoURL?: string;
  deployedAt?: string;
};

type AlertPayload = {
  alerts?: Array<{
    status: 'firing' | 'resolved';
    labels: Record<string, string>;
    startsAt: string;
    endsAt?: string;
    fingerprint: string;
  }>;
};

const DEFAULT_DAYS = 30;
const RECENT_DEPLOYS = 10;

function daysOf(query: unknown) {
  const days = Number(query ?? DEFAULT_DAYS);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new InputError('days must be a whole number from 1 to 365');
  }
  return days;
}

export default createBackendPlugin({
  pluginId: 'dora',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        catalog: catalogServiceRef,
      },
      async init({
        config,
        logger,
        database,
        scheduler,
        auth,
        httpAuth,
        httpRouter,
        catalog,
      }) {
        const store = await DoraStore.create(await database.getClient());
        const github = GithubCommits.fromConfig(config);

        // Golden-path apps (source under apps/<name>), their repository and branch.
        async function goldenPathApps() {
          const { items } = await catalog.getEntities(
            {
              filter: { kind: 'Component' },
              fields: ['metadata.name', 'metadata.annotations'],
            },
            { credentials: await auth.getOwnServiceCredentials() },
          );
          return items.flatMap(entity => {
            const match = GOLDEN_PATH_SOURCE.exec(
              entity.metadata.annotations?.['backstage.io/source-location'] ??
                '',
            );
            const repo = match && repoOf(match[1]);
            return repo
              ? [{ app: entity.metadata.name, repo, ref: match[2] }]
              : [];
          });
        }

        // Commits of envs/prd/release.yaml already backfilled (or found recorded).
        const backfilled = new Set<string>();

        async function backfill() {
          for (const { app, repo, ref } of await goldenPathApps()) {
            const commits = await github.history(
              repo,
              `apps/${app}/envs/prd/release.yaml`,
              { ref },
            );
            for (const { sha } of commits.reverse()) {
              const key = `${app}@${sha}`;
              if (backfilled.has(key) || (await store.hasDeploy(app, sha))) {
                backfilled.add(key);
                continue;
              }
              const deploy = await describeDeploy(github, repo, app, sha);
              await store.addDeploy({
                app,
                ...deploy,
                deployedAt: deploy.landedAt,
                source: 'git',
              });
              backfilled.add(key);
            }
          }
        }

        await scheduler.scheduleTask({
          id: 'dora-backfill',
          frequency: { hours: 6 },
          timeout: { minutes: 15 },
          initialDelay: { minutes: 2 },
          fn: async () => {
            try {
              await backfill();
            } catch (error) {
              logger.warn(`DORA backfill from git failed: ${error}`);
            }
          },
        });

        const router = Router();
        router.use(express.json({ limit: '1mb' }));

        router.post('/deploys', async (req, res) => {
          await httpAuth.credentials(req, { allow: ['service'] });
          const { app, environment, revision, repoURL, deployedAt } =
            req.body as DeployPayload;
          const repo = repoURL && repoOf(repoURL);
          if (!app || !revision || !repo) {
            throw new InputError(
              'expected app, revision and a github.com repoURL',
            );
          }
          if (environment !== 'prd') {
            res.status(202).json({ recorded: false, reason: 'not prd' });
            return;
          }
          // Without GitHub there is no classification: the request fails and the backfill
          // records the deploy later.
          const deploy = await describeDeploy(github, repo, app, revision);
          await store.addDeploy({
            app,
            ...deploy,
            revision,
            deployedAt: deployedAt ? new Date(deployedAt) : new Date(),
            source: 'argocd',
          });
          logger.info(`Recorded ${deploy.kind} deploy of ${app} (${revision})`);
          res.status(201).json({ recorded: true, kind: deploy.kind });
        });

        router.post('/alerts', async (req, res) => {
          await httpAuth.credentials(req, { allow: ['service'] });
          const { alerts } = req.body as AlertPayload;
          if (!Array.isArray(alerts)) {
            throw new InputError('expected an Alertmanager webhook payload');
          }
          let recorded = 0;
          for (const alert of alerts) {
            const app = failingApp(alert.labels);
            if (!app) continue;
            await store.recordAlert({
              app,
              fingerprint: alert.fingerprint,
              alertname: alert.labels.alertname ?? 'Alert',
              startedAt: new Date(alert.startsAt),
              resolvedAt:
                alert.status === 'resolved' && alert.endsAt
                  ? new Date(alert.endsAt)
                  : undefined,
            });
            recorded++;
          }
          res.status(200).json({ received: alerts.length, recorded });
        });

        router.get('/metrics', async (req, res) => {
          const days = daysOf(req.query.days);
          const now = new Date();
          const [apps, deploys, incidents] = await Promise.all([
            store.apps(),
            store.deploys(),
            store.incidents(),
          ]);
          res.json({
            overall: computeMetrics(apps, deploys, incidents, { now, days }),
            services: Object.fromEntries(
              apps.map(app => [
                app,
                computeMetrics([app], deploys, incidents, { now, days }),
              ]),
            ),
          });
        });

        router.get('/metrics/:app', async (req, res) => {
          const { app } = req.params;
          const days = daysOf(req.query.days);
          const [deploys, incidents] = await Promise.all([
            store.deploys(app),
            store.incidents(app),
          ]);
          res.json({
            metrics: computeMetrics([app], deploys, incidents, {
              now: new Date(),
              days,
            }),
            recentDeploys: deploys
              .slice(-RECENT_DEPLOYS)
              .reverse()
              .map(d => ({
                revision: d.revision,
                deployedAt: d.deployedAt.toISOString(),
                kind: d.kind,
                title: d.message.split('\n')[0],
              })),
          });
        });

        httpRouter.use(router);
      },
    });
  },
});
