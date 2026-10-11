/*
 * Secrets of a golden-path app, per environment, for the Releases card:
 *
 *   GET /api/app-secrets/status?entityRef=component:default/hello
 *
 * Which secrets each environment needs comes from git (secretEnv and generatedSecretEnv in
 * values.yaml, envs/<env>/values.yaml and envs/<env>/release.yaml, read through the GitHub
 * integration); whether Vault has them, their version and when they were last written come
 * from Vault's metadata (vaultSecrets.ts). No value is ever read.
 */
import {
  coreServices,
  createBackendPlugin,
  type UrlReaderService,
} from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { InputError, NotFoundError } from '@backstage/errors';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import Router from 'express-promise-router';
import { parse as parseYaml } from 'yaml';
import {
  ENVIRONMENTS,
  vaultSecretNames,
  type Environment,
  type Values,
} from './releases';
import { GOLDEN_PATH_SOURCE, SOURCE_LOCATION } from './techInsightsPlatformLab';
import {
  VaultMetadataClient,
  secretsUiUrl,
  vaultOptionsFromConfig,
  type SecretStatus,
} from './vaultSecrets';

export type AppSecret = {
  name: string;
  /** vault: secretEnv (value in Vault); generated: generatedSecretEnv (in the cluster only). */
  source: 'vault' | 'generated';
  /** The environment's values reference it (false: stored in Vault but unused). */
  used: boolean;
  /** Vault state; undefined for generated secrets. */
  status?: SecretStatus;
  version?: number;
  updatedTime?: string;
};

export type EnvironmentSecrets = {
  env: Environment;
  secrets: AppSecret[];
  /** Vault UI page of this environment's secrets, where owners write values. */
  vaultUrl?: string;
  /** Vault couldn't be read; secrets then have no status. */
  error?: string;
};

/** apps/<name> of a golden-path entity: its repository, ref and directory. */
export function goldenPathSource(entity: Entity) {
  const match = GOLDEN_PATH_SOURCE.exec(
    entity.metadata.annotations?.[SOURCE_LOCATION] ?? '',
  );
  if (!match) return undefined;
  const [, repo, ref, appDir] = match;
  return { repo, ref, appDir, app: appDir.replace(/^apps\//, '') };
}

async function readValues(
  reader: UrlReaderService,
  url: string,
): Promise<Values | undefined> {
  try {
    const response = await reader.readUrl(url);
    return (parseYaml((await response.buffer()).toString('utf8')) ??
      {}) as Values;
  } catch (error) {
    if ((error as Error).name === 'NotFoundError') return undefined;
    throw error;
  }
}

/** Names each environment takes from Vault and from generators, per git. */
export async function secretNamesFromGit(
  reader: UrlReaderService,
  source: NonNullable<ReturnType<typeof goldenPathSource>>,
): Promise<Record<Environment, { vault: string[]; generated: string[] }>> {
  const url = (file: string) =>
    `${source.repo}/blob/${source.ref}/${source.appDir}/${file}`;
  const shared = await readValues(reader, url('values.yaml'));
  const result = {} as Record<
    Environment,
    { vault: string[]; generated: string[] }
  >;
  for (const env of ENVIRONMENTS) {
    const files = [
      shared,
      await readValues(reader, url(`envs/${env}/values.yaml`)),
      await readValues(reader, url(`envs/${env}/release.yaml`)),
    ];
    result[env] = {
      vault: vaultSecretNames(...files),
      generated: [
        ...new Set(
          files.flatMap(v => Object.keys(v?.app?.generatedSecretEnv ?? {})),
        ),
      ].sort(),
    };
  }
  return result;
}

/** What the Releases card shows: per environment, every secret and its state. */
export async function appSecrets(
  reader: UrlReaderService,
  vault: VaultMetadataClient | undefined,
  entity: Entity,
): Promise<EnvironmentSecrets[]> {
  const source = goldenPathSource(entity);
  if (!source) {
    throw new InputError(
      `${entity.metadata.name} is not a golden-path app (no source under apps/<name>)`,
    );
  }
  const names = await secretNamesFromGit(reader, source);

  return Promise.all(
    ENVIRONMENTS.map(async env => {
      const { vault: needed, generated } = names[env];
      const result: EnvironmentSecrets = {
        env,
        secrets: generated.map(name => ({
          name,
          source: 'generated' as const,
          used: true,
        })),
        vaultUrl: vault && secretsUiUrl(vault.options, source.app, env),
      };
      const unchecked = needed.map(name => ({
        name,
        source: 'vault' as const,
        used: true,
      }));
      if (!vault) {
        result.error = "platformLab.vault isn't configured";
        result.secrets.push(...unchecked);
      } else {
        try {
          const states = await vault.states(source.app, env, needed);
          result.secrets.push(
            ...states.map(state => ({
              ...state,
              source: 'vault' as const,
              used: needed.includes(state.name),
            })),
          );
        } catch (error) {
          result.error = `could not read Vault: ${error}`;
          result.secrets.push(...unchecked);
        }
      }
      result.secrets.sort((a, b) => a.name.localeCompare(b.name));
      return result;
    }),
  );
}

export default createBackendPlugin({
  pluginId: 'app-secrets',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        urlReader: coreServices.urlReader,
        catalog: catalogServiceRef,
      },
      async init({ config, httpAuth, httpRouter, urlReader, catalog }) {
        const options = vaultOptionsFromConfig(config);
        const vault = options && new VaultMetadataClient(options);

        const router = Router();
        router.get('/status', async (req, res) => {
          // The caller's own credentials: no entity the caller can't see in the catalog.
          const credentials = await httpAuth.credentials(req, {
            allow: ['user', 'service'],
          });
          const entityRef = String(req.query.entityRef ?? '');
          if (!entityRef) throw new InputError('entityRef is required');
          const entity = await catalog.getEntityByRef(entityRef, {
            credentials,
          });
          if (!entity) throw new NotFoundError(`${entityRef} not found`);
          res.json({
            environments: await appSecrets(urlReader, vault, entity),
          });
        });
        httpRouter.use(router);
      },
    });
  },
});
