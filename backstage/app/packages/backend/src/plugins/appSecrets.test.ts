import type { UrlReaderService } from '@backstage/backend-plugin-api';
import type { Entity } from '@backstage/catalog-model';
import { NotFoundError } from '@backstage/errors';
import { appSecrets } from './appSecrets';
import type { VaultMetadataClient } from './vaultSecrets';

const REPO = 'https://github.com/talesrc/platform-lab/blob/main/apps/hello';

function reader(files: Record<string, string>): UrlReaderService {
  return {
    readUrl: async (url: string) => {
      const file = url.replace(`${REPO}/`, '');
      if (!(file in files)) throw new NotFoundError(url);
      return { buffer: async () => Buffer.from(files[file]) };
    },
  } as unknown as UrlReaderService;
}

const entity = (sourceLocation: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'hello',
    annotations: { 'backstage.io/source-location': sourceLocation },
  },
});
const hello = entity(
  'url:https://github.com/talesrc/platform-lab/tree/main/apps/hello',
);

const files = {
  'values.yaml': 'app:\n  generatedSecretEnv: { SESSION_KEY: {} }\n',
  'envs/stg/values.yaml': 'app: {}\n',
  'envs/stg/release.yaml': 'app:\n  secretEnv: [API_TOKEN, NEW_KEY]\n',
  'envs/prd/values.yaml': 'app: {}\n',
  'envs/prd/release.yaml': 'app:\n  secretEnv: [API_TOKEN]\n',
};

describe('appSecrets', () => {
  it('combines what git says each environment uses with Vault metadata', async () => {
    const states = jest.fn(async (_app: string, env: string, names: string[]) =>
      [...names, ...(env === 'prd' ? ['LEFTOVER'] : [])].map(name => ({
        name,
        status:
          name === 'NEW_KEY' ? ('missing' as const) : ('present' as const),
      })),
    );
    const vault = {
      states,
      options: { uiUrl: 'https://vault', mount: 'secret' },
    } as unknown as VaultMetadataClient;

    const result = await appSecrets(reader(files), vault, hello);

    expect(states).toHaveBeenCalledWith('hello', 'stg', [
      'API_TOKEN',
      'NEW_KEY',
    ]);
    expect(result).toEqual([
      {
        env: 'stg',
        vaultUrl:
          'https://vault/ui/vault/secrets/secret/kv/list/apps/hello/stg/',
        secrets: [
          { name: 'API_TOKEN', source: 'vault', used: true, status: 'present' },
          { name: 'NEW_KEY', source: 'vault', used: true, status: 'missing' },
          { name: 'SESSION_KEY', source: 'generated', used: true },
        ],
      },
      {
        env: 'prd',
        vaultUrl:
          'https://vault/ui/vault/secrets/secret/kv/list/apps/hello/prd/',
        secrets: [
          { name: 'API_TOKEN', source: 'vault', used: true, status: 'present' },
          { name: 'LEFTOVER', source: 'vault', used: false, status: 'present' },
          { name: 'SESSION_KEY', source: 'generated', used: true },
        ],
      },
    ]);
  });

  it('still lists the names when Vault is unreadable or not configured', async () => {
    const vault = {
      states: async () => {
        throw new Error('503 Sealed');
      },
      options: { mount: 'secret' },
    } as unknown as VaultMetadataClient;

    const [stg] = await appSecrets(reader(files), vault, hello);
    expect(stg.error).toBe('could not read Vault: Error: 503 Sealed');
    expect(stg.secrets.map(s => [s.name, s.status])).toEqual([
      ['API_TOKEN', undefined],
      ['NEW_KEY', undefined],
      ['SESSION_KEY', undefined],
    ]);

    const [, prd] = await appSecrets(reader(files), undefined, hello);
    expect(prd.error).toMatch(/isn't configured/);
  });

  it('refuses entities that are not golden-path apps', async () => {
    await expect(
      appSecrets(
        reader(files),
        undefined,
        entity(
          'url:https://github.com/talesrc/platform-lab/tree/main/backstage',
        ),
      ),
    ).rejects.toThrow(/not a golden-path app/);
  });
});
