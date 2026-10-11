/*
 * "Ready to promote": tells a golden-path app's owner when stg's release could go to prd, with
 * the prefilled "Promote to prd" form, so promotion is a nudge instead of something to remember.
 *
 * Every few minutes (platformLab.promotion.readyNotification), for each golden-path app:
 *
 * - prd is behind stg: envs/prd/release.yaml is another release than envs/stg/release.yaml
 *   (the "prd keeps up with stg" check, techInsightsPlatformLab.ts);
 * - stg runs that release well: the same check as platform-lab:app:promote before it opens a
 *   pull request (stgHealth.ts: Synced, Healthy, on the release's image, soaked, no alerts).
 *
 * The owner is notified once per stg release: what was notified is kept in this plugin's
 * database, since sending again with the same notification scope would mark it unread. A newer
 * stg release replaces the older notification (same scope per app).
 */
import {
  coreServices,
  createBackendPlugin,
  type DatabaseService,
  type LoggerService,
} from '@backstage/backend-plugin-api';
import { CATALOG_FILTER_EXISTS } from '@backstage/catalog-client';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { notificationService } from '@backstage/plugin-notifications-node';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { imageOf, sameRelease, type Values } from './releases';
import { checkStgHealth, stgHealthOptionsFromConfig } from './stgHealth';
import { GOLDEN_PATH_SOURCE } from './techInsightsPlatformLab';

/** A golden-path app, from its Component's backstage.io/source-location. */
export type GoldenPathApp = {
  entityRef: string;
  name: string;
  /** https://github.com/<owner>/<repo> */
  repo: string;
  ref: string;
  /** apps/<name> */
  appDir: string;
};

/** The key of the stg release an app's owner was last told about. */
export type LastNotified = (app: string) => Promise<string | undefined>;

export type ReadyRelease = {
  app: GoldenPathApp;
  stgTag: string;
  prdTag?: string;
  releaseKey: string;
};

/** JSON with sorted keys, so equal releases (sameRelease) get the same key. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        k =>
          `${JSON.stringify(k)}:${canonical(
            (value as Record<string, unknown>)[k],
          )}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Identifies a release by its content (config-only releases reuse a tag). */
export const releaseKey = (release: Values) =>
  createHash('sha256').update(canonical(release)).digest('hex').slice(0, 16);

/** The prefilled "Promote to prd" form (backstage/templates/promote-app). */
export const promoteLink = (entityRef: string) =>
  `/create/templates/default/promote-app?formData=${encodeURIComponent(
    JSON.stringify({ app: entityRef }),
  )}`;

/**
 * The stg releases that are ready for prd and that the owner wasn't told about yet. Unreadable
 * release files and stg checks that can't be made count as "not ready": the next run retries.
 */
export async function findReadyReleases(options: {
  apps: GoldenPathApp[];
  readValues: (url: string) => Promise<Values | undefined>;
  checkStg: (app: string, image: string | undefined) => Promise<string[]>;
  lastNotified: LastNotified;
  logger: LoggerService;
}): Promise<ReadyRelease[]> {
  const { readValues, checkStg, lastNotified, logger } = options;
  const ready: ReadyRelease[] = [];

  for (const app of options.apps) {
    const file = (name: string) =>
      `${app.repo}/blob/${app.ref}/${app.appDir}/${name}`;
    const [shared, stg, prd] = await Promise.all(
      ['values.yaml', 'envs/stg/release.yaml', 'envs/prd/release.yaml'].map(
        name => readValues(file(name)),
      ),
    );
    const stgTag = stg?.app?.image?.tag;
    if (!stg || !prd || !stgTag || sameRelease(stg, prd)) continue;

    const key = releaseKey(stg);
    if ((await lastNotified(app.name)) === key) continue;

    const problems = await checkStg(app.name, imageOf(shared, stg));
    if (problems.length) {
      logger.debug(
        `${app.name} ${stgTag} not ready to promote yet: ${problems.join(
          '; ',
        )}`,
      );
      continue;
    }
    ready.push({ app, stgTag, prdTag: prd.app?.image?.tag, releaseKey: key });
  }
  return ready;
}

/** Golden-path apps in the catalog: Components with argocd/app-selector and source in apps/. */
export function goldenPathApps(
  entities: Array<{
    kind: string;
    metadata: {
      name: string;
      namespace?: string;
      annotations?: Record<string, string>;
    };
  }>,
): GoldenPathApp[] {
  return entities.flatMap(entity => {
    const match = GOLDEN_PATH_SOURCE.exec(
      entity.metadata.annotations?.['backstage.io/source-location'] ?? '',
    );
    if (!match) return [];
    const [, repo, ref, appDir] = match;
    return [
      {
        entityRef: stringifyEntityRef({
          kind: entity.kind,
          namespace: entity.metadata.namespace,
          name: entity.metadata.name,
        }),
        name: entity.metadata.name,
        repo,
        ref,
        appDir,
      },
    ];
  });
}

const TABLE = 'notified_releases';

type Knex = Awaited<ReturnType<DatabaseService['getClient']>>;

/** What was notified, one row per app (the latest stg release), in this plugin's database. */
export async function notifiedReleases(db: Knex) {
  if (!(await db.schema.hasTable(TABLE))) {
    await db.schema.createTable(TABLE, table => {
      table.string('app').primary();
      table.string('release_key').notNullable();
      table.string('tag').notNullable();
      table.timestamp('notified_at').notNullable();
    });
  }
  const lastNotified: LastNotified = async app =>
    (await db(TABLE).where({ app }).first())?.release_key;
  const markNotified = async (ready: ReadyRelease) => {
    await db(TABLE)
      .insert({
        app: ready.app.name,
        release_key: ready.releaseKey,
        tag: ready.stgTag,
        notified_at: new Date(),
      })
      .onConflict('app')
      .merge();
  };
  return { lastNotified, markNotified };
}

export default createBackendPlugin({
  pluginId: 'ready-to-promote',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        auth: coreServices.auth,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        urlReader: coreServices.urlReader,
        catalog: catalogServiceRef,
        notifications: notificationService,
      },
      async init({
        config,
        logger,
        auth,
        database,
        scheduler,
        urlReader,
        catalog,
        notifications,
      }) {
        const settings = config.getOptionalConfig(
          'platformLab.promotion.readyNotification',
        );
        if (settings?.getOptionalBoolean('enabled') === false) {
          logger.info('Ready-to-promote notifications are disabled');
          return;
        }
        let stgOptions: ReturnType<typeof stgHealthOptionsFromConfig>;
        try {
          stgOptions = stgHealthOptionsFromConfig(config);
        } catch (error) {
          // Local development without Argo CD: there is no stg to check.
          logger.warn(`Ready-to-promote notifications are off: ${error}`);
          return;
        }

        const { lastNotified, markNotified } = await notifiedReleases(
          await database.getClient(),
        );

        async function readValues(url: string) {
          try {
            const response = await urlReader.readUrl(url);
            return (parseYaml((await response.buffer()).toString('utf8')) ??
              {}) as Values;
          } catch (error) {
            logger.warn(`Could not read ${url}: ${error}`);
            return undefined;
          }
        }

        await scheduler.scheduleTask({
          id: 'ready-to-promote',
          frequency: {
            minutes: settings?.getOptionalNumber('everyMinutes') ?? 5,
          },
          timeout: { minutes: 5 },
          initialDelay: { minutes: 1 },
          // One backend replica checks and notifies.
          scope: 'global',
          fn: async () => {
            const { items } = await catalog.getEntities(
              {
                filter: {
                  kind: 'Component',
                  'metadata.annotations.argocd/app-selector':
                    CATALOG_FILTER_EXISTS,
                },
                fields: ['kind', 'metadata'],
              },
              { credentials: await auth.getOwnServiceCredentials() },
            );

            const ready = await findReadyReleases({
              apps: goldenPathApps(items),
              readValues,
              checkStg: (app, image) => checkStgHealth(app, image, stgOptions),
              lastNotified,
              logger,
            });

            for (const release of ready) {
              const { app, stgTag, prdTag } = release;
              try {
                await notifications.send({
                  recipients: { type: 'entity', entityRef: app.entityRef },
                  payload: {
                    title: `${app.name} ${stgTag} is ready to promote to prd`,
                    description:
                      `stg has run ${stgTag} for at least ${stgOptions.soakMinutes} min: ` +
                      `Synced, Healthy, no alerts. prd runs ${
                        prdTag ?? 'another release'
                      }. Open the form to review the release and open the pull request.`,
                    link: promoteLink(app.entityRef),
                    severity: 'normal',
                    topic: 'releases',
                    // Same scope: a newer stg release replaces this notification.
                    scope: `ready-to-promote:${app.entityRef}`,
                  },
                });
                await markNotified(release);
                logger.info(
                  `Notified the owner of ${app.name} that ${stgTag} is ready for prd`,
                );
              } catch (error) {
                logger.error(
                  `Failed to notify about ${app.name} ${stgTag}: ${error}`,
                );
              }
            }
          },
        });
      },
    });
  },
});
