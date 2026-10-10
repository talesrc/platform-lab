/*
 * Tech Insights facts specific to platform-lab, used by the scorecard checks in
 * app-config.production.yaml (techInsights.factChecker):
 *
 * - live-state annotations (Kubernetes, Argo CD, Grafana) and links on the entity page
 * - golden-path apps (source under apps/<name>) on the newest version of the app chart:
 *   the `app` dependency in apps/<name>/Chart.yaml vs the version in charts/app/Chart.yaml
 *   on the same branch, both read through the GitHub integration (UrlReader).
 *
 * Built-in retrievers (ownership, metadata, techdocs) cover the rest.
 */
import { createBackendModule } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import type { Entity } from '@backstage/catalog-model';
import {
  FactRetriever,
  FactRetrieverContext,
  techInsightsFactRetrieversExtensionPoint,
} from '@backstage-community/plugin-tech-insights-node';
import { DateTime } from 'luxon';
import { parse as parseYaml } from 'yaml';

const SOURCE_LOCATION = 'backstage.io/source-location';
// url:https://github.com/<owner>/<repo>/tree/<ref>/apps/<name>
const GOLDEN_PATH_SOURCE =
  /^url:(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)\/(apps\/[^/]+)\/?$/;

const has = (entity: Entity, annotation: string) =>
  Boolean(entity.metadata.annotations?.[annotation]);

type ChartYaml = {
  version?: string;
  dependencies?: Array<{ name?: string; version?: string }>;
};

async function readChart(
  ctx: FactRetrieverContext,
  url: string,
): Promise<ChartYaml | undefined> {
  try {
    const response = await ctx.urlReader.readUrl(url);
    return parseYaml((await response.buffer()).toString('utf8')) as ChartYaml;
  } catch (error) {
    ctx.logger.warn(`Could not read ${url}: ${error}`);
    return undefined;
  }
}

/** Compares dotted numeric versions (the chart uses plain x.y.z). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export const platformLabFactRetriever: FactRetriever = {
  id: 'platformLabFactRetriever',
  version: '0.1.0',
  title: 'platform-lab',
  description: 'Live-state annotations, links and golden-path chart version',
  entityFilter: [{ kind: ['component'] }],
  schema: {
    hasKubernetesSelector: {
      type: 'boolean',
      description: 'Has backstage.io/kubernetes-label-selector (pods on the entity page)',
    },
    hasArgocdApp: {
      type: 'boolean',
      description:
        'Has argocd/app-name or argocd/app-selector (sync status and history on the entity page)',
    },
    hasGrafanaDashboards: {
      type: 'boolean',
      description: 'Has grafana/dashboard-selector (dashboards on the entity page)',
    },
    hasLinks: {
      type: 'boolean',
      description: 'Has at least one link in metadata.links',
    },
    isGoldenPathApp: {
      type: 'boolean',
      description: 'Source lives under apps/<name> (deployed by the apps ApplicationSet)',
    },
    usesLatestAppChart: {
      type: 'boolean',
      description:
        'Golden-path app depends on the newest charts/app version (true when not a golden-path app)',
    },
    appChartVersion: {
      type: 'string',
      description: 'Version of the app chart this golden-path app depends on',
    },
    latestAppChartVersion: {
      type: 'string',
      description: 'Version of charts/app on the same branch',
    },
  },
  async handler(ctx) {
    const { token } = await ctx.auth.getPluginRequestToken({
      onBehalfOf: await ctx.auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });
    const catalog = new CatalogClient({ discoveryApi: ctx.discovery });
    const { items } = await catalog.getEntities(
      { filter: ctx.entityFilter },
      { token },
    );

    // charts/app/Chart.yaml per repo+ref, read once per run.
    const latestByRepo = new Map<string, Promise<string | undefined>>();
    const latestChart = (repo: string, ref: string) => {
      const key = `${repo}@${ref}`;
      if (!latestByRepo.has(key)) {
        latestByRepo.set(
          key,
          readChart(ctx, `${repo}/blob/${ref}/charts/app/Chart.yaml`).then(
            chart => chart?.version,
          ),
        );
      }
      return latestByRepo.get(key)!;
    };

    return Promise.all(
      items.map(async entity => {
        const facts: Record<string, boolean | string> = {
          hasKubernetesSelector: has(entity, 'backstage.io/kubernetes-label-selector'),
          // app-selector: golden-path apps, one Application per environment.
          hasArgocdApp:
            has(entity, 'argocd/app-name') || has(entity, 'argocd/app-selector'),
          hasGrafanaDashboards: has(entity, 'grafana/dashboard-selector'),
          hasLinks: (entity.metadata.links ?? []).length > 0,
          isGoldenPathApp: false,
          usesLatestAppChart: true,
        };

        const match = GOLDEN_PATH_SOURCE.exec(
          entity.metadata.annotations?.[SOURCE_LOCATION] ?? '',
        );
        if (match) {
          const [, repo, ref, appDir] = match;
          facts.isGoldenPathApp = true;
          const [appChart, latest] = await Promise.all([
            readChart(ctx, `${repo}/blob/${ref}/${appDir}/Chart.yaml`),
            latestChart(repo, ref),
          ]);
          const pinned = appChart?.dependencies?.find(d => d.name === 'app')?.version;
          if (pinned) facts.appChartVersion = pinned;
          if (latest) facts.latestAppChartVersion = latest;
          // Unknown (unreadable) versions don't fail the check; a warning is logged.
          facts.usesLatestAppChart =
            !pinned || !latest || compareVersions(pinned, latest) >= 0;
        }

        return {
          entity: {
            namespace: entity.metadata.namespace ?? 'default',
            kind: entity.kind,
            name: entity.metadata.name,
          },
          facts,
          timestamp: DateTime.now(),
        };
      }),
    );
  },
};

export default createBackendModule({
  pluginId: 'tech-insights',
  moduleId: 'platform-lab-facts',
  register(reg) {
    reg.registerInit({
      deps: { providers: techInsightsFactRetrieversExtensionPoint },
      async init({ providers }) {
        providers.addFactRetrievers({ platformLabFactRetriever });
      },
    });
  },
});
