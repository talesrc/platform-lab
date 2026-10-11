/*
 * Tech Insights facts about golden-path apps' secrets, for the scorecard checks in
 * app-config.production.yaml (secretsPresent, secretsRotated). Per app, across stg and prd,
 * for the secrets git says each environment uses (secretEnv): how many Vault lacks, and the
 * age in days of the oldest one. Vault metadata only (vaultSecrets.ts); generated secrets
 * aren't in Vault and aren't counted.
 */
import { createBackendModule } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import {
  FactRetriever,
  techInsightsFactRetrieversExtensionPoint,
} from '@backstage-community/plugin-tech-insights-node';
import { DateTime } from 'luxon';
import { goldenPathSource, secretNamesFromGit } from './appSecrets';
import { ENVIRONMENTS } from './releases';
import {
  VaultMetadataClient,
  ageInDays,
  vaultOptionsFromConfig,
} from './vaultSecrets';

export const appSecretsFactRetriever: FactRetriever = {
  id: 'appSecretsFactRetriever',
  version: '0.1.0',
  title: 'App secrets',
  description:
    'Vault secrets of golden-path apps: missing ones and the oldest one',
  entityFilter: [{ kind: ['component'] }],
  schema: {
    secretsMissing: {
      type: 'integer',
      description:
        'Secrets an environment uses (secretEnv) that Vault lacks or has deleted, across environments',
    },
    oldestSecretDays: {
      type: 'integer',
      description:
        'Days since the least recently written secret in use was written (0 with no secrets)',
    },
  },
  async handler(ctx) {
    const options = vaultOptionsFromConfig(ctx.config);
    if (!options) {
      ctx.logger.info('platformLab.vault is not configured; no secret facts');
      return [];
    }
    const vault = new VaultMetadataClient(options);
    const { token } = await ctx.auth.getPluginRequestToken({
      onBehalfOf: await ctx.auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });
    const catalog = new CatalogClient({ discoveryApi: ctx.discovery });
    const { items } = await catalog.getEntities(
      { filter: ctx.entityFilter },
      { token },
    );

    const facts = await Promise.all(
      items.map(async entity => {
        const source = goldenPathSource(entity);
        if (!source) return undefined;
        try {
          const names = await secretNamesFromGit(ctx.urlReader, source);
          let secretsMissing = 0;
          let oldestSecretDays = 0;
          for (const env of ENVIRONMENTS) {
            for (const name of names[env].vault) {
              const state = await vault.state(source.app, env, name);
              if (state.status !== 'present') secretsMissing++;
              else
                oldestSecretDays = Math.max(oldestSecretDays, ageInDays(state));
            }
          }
          return {
            entity: {
              namespace: entity.metadata.namespace ?? 'default',
              kind: entity.kind,
              name: entity.metadata.name,
            },
            facts: { secretsMissing, oldestSecretDays },
            timestamp: DateTime.now(),
          };
        } catch (error) {
          // No fact rather than a wrong one: the check shows "no data" for this run.
          ctx.logger.warn(
            `Could not read the secrets of ${entity.metadata.name}: ${error}`,
          );
          return undefined;
        }
      }),
    );
    return facts.filter(f => f !== undefined);
  },
};

export default createBackendModule({
  pluginId: 'tech-insights',
  moduleId: 'platform-lab-secrets',
  register(reg) {
    reg.registerInit({
      deps: { providers: techInsightsFactRetrieversExtensionPoint },
      async init({ providers }) {
        providers.addFactRetrievers({ appSecretsFactRetriever });
      },
    });
  },
});
