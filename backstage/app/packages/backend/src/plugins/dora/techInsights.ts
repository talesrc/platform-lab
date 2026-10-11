/*
 * The DORA metrics of each golden-path app as Tech Insights facts (30 days, from the dora
 * plugin's API), so they have a history and checks can use them. No scorecard check uses them:
 * they describe the delivery system, and with two apps they demo the pipeline, not a signal.
 */
import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  FactRetriever,
  techInsightsFactRetrieversExtensionPoint,
} from '@backstage-community/plugin-tech-insights-node';
import { DateTime } from 'luxon';
import type { DoraMetrics } from './metrics';

const DAYS = 30;

export const doraFactRetriever: FactRetriever = {
  id: 'doraFactRetriever',
  version: '0.1.0',
  title: 'DORA metrics',
  description: `Deployment frequency, lead time, change failure rate and time to restore in prd, over ${DAYS} days`,
  entityFilter: [{ kind: ['component'] }],
  schema: {
    doraDeploys: {
      type: 'integer',
      description: `Release deploys to prd in the last ${DAYS} days`,
    },
    doraDeploysPerWeek: {
      type: 'float',
      description: 'Release deploys to prd per week (deployment frequency)',
    },
    doraLeadTimeHours: {
      type: 'float',
      description:
        'Median hours from a release landing in stg to running in prd (lead time for changes)',
    },
    doraChangeFailureRate: {
      type: 'float',
      description:
        'Share of prd deploys followed within 24 hours by a rollback, a hotfix or a critical alert (0-1)',
    },
    doraTimeToRestoreHours: {
      type: 'float',
      description:
        'Median hours from a prd failure to recovery (time to restore)',
    },
  },
  async handler(ctx) {
    const { token } = await ctx.auth.getPluginRequestToken({
      onBehalfOf: await ctx.auth.getOwnServiceCredentials(),
      targetPluginId: 'dora',
    });
    const response = await fetch(
      `${await ctx.discovery.getBaseUrl('dora')}/metrics?days=${DAYS}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new Error(
        `dora metrics: ${response.status} ${response.statusText}`,
      );
    }
    const { services } = (await response.json()) as {
      services: Record<string, DoraMetrics>;
    };

    // Golden-path apps are Components named after apps/<name> in the default namespace.
    return Object.entries(services).map(([name, m]) => {
      const facts: Record<string, number> = {
        doraDeploys: m.deploys,
        doraDeploysPerWeek: m.deploysPerWeek,
      };
      if (m.leadTimeHours !== null) facts.doraLeadTimeHours = m.leadTimeHours;
      if (m.changeFailureRate !== null) {
        facts.doraChangeFailureRate = m.changeFailureRate;
      }
      if (m.timeToRestoreHours !== null) {
        facts.doraTimeToRestoreHours = m.timeToRestoreHours;
      }
      return {
        entity: { namespace: 'default', kind: 'Component', name },
        facts,
        timestamp: DateTime.now(),
      };
    });
  },
};

export default createBackendModule({
  pluginId: 'tech-insights',
  moduleId: 'dora-facts',
  register(reg) {
    reg.registerInit({
      deps: { providers: techInsightsFactRetrieversExtensionPoint },
      async init({ providers }) {
        providers.addFactRetrievers({ doraFactRetriever });
      },
    });
  },
});
