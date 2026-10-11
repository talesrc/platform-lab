import {
  VaultMetadataClient,
  ageInDays,
  secretsUiUrl,
  type VaultOptions,
} from './vaultSecrets';

const NOW = new Date('2026-10-11T12:00:00Z');

/** A fake Vault: KV metadata by path under secret/metadata/, and the login endpoint. */
function vault(metadata: Record<string, unknown>, list: string[] = []) {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/auth/kubernetes/login')) {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ role: 'backstage', jwt: 'sa-token' });
      return new Response(
        JSON.stringify({
          auth: { client_token: 'vault-token', lease_duration: 3600 },
        }),
      );
    }
    expect((init?.headers as Record<string, string>)['X-Vault-Token']).toBe(
      'vault-token',
    );
    const path = url.replace('http://vault/v1/secret/metadata/', '');
    if (path.endsWith('/?list=true')) {
      return list.length
        ? new Response(JSON.stringify({ data: { keys: list } }))
        : new Response('{"errors":[]}', { status: 404 });
    }
    return path in metadata
      ? new Response(JSON.stringify({ data: metadata[path] }))
      : new Response('{"errors":[]}', { status: 404 });
  });
  const options: VaultOptions = {
    url: 'http://vault',
    mount: 'secret',
    role: 'backstage',
    tokenPath: '/token',
    uiUrl: 'https://vault.lab.localhost',
    fetch: fetchMock as unknown as typeof fetch,
    readToken: async () => 'sa-token\n',
    now: () => NOW,
  };
  return { client: new VaultMetadataClient(options), fetch: fetchMock };
}

const written = (version: number, at: string, extra = {}) => ({
  current_version: version,
  updated_time: at,
  versions: { [String(version)]: { created_time: at, ...extra } },
});

describe('VaultMetadataClient', () => {
  it('reports present, deleted and missing secrets from metadata', async () => {
    const { client } = vault({
      'apps/hello/prd/API_TOKEN': written(3, '2026-09-01T00:00:00Z'),
      'apps/hello/prd/OLD_KEY': written(2, '2026-01-01T00:00:00Z', {
        deletion_time: '2026-02-01T00:00:00Z',
      }),
    });

    expect(
      await client.states('hello', 'prd', [
        'API_TOKEN',
        'OLD_KEY',
        'DB_PASSWORD',
      ]),
    ).toEqual([
      {
        name: 'API_TOKEN',
        status: 'present',
        version: 3,
        updatedTime: '2026-09-01T00:00:00Z',
      },
      { name: 'DB_PASSWORD', status: 'missing' },
      {
        name: 'OLD_KEY',
        status: 'deleted',
        version: 2,
        updatedTime: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('includes secrets stored but not asked for, and logs in once', async () => {
    const { client, fetch } = vault(
      { 'apps/hello/stg/EXTRA': written(1, '2026-10-01T00:00:00Z') },
      ['EXTRA', 'nested/'],
    );

    const states = await client.states('hello', 'stg', []);

    expect(states.map(s => s.name)).toEqual(['EXTRA']);
    const logins = fetch.mock.calls.filter(([url]) => url.includes('/login'));
    expect(logins).toHaveLength(1);
  });

  it('names what prd lacks, and fails closed when Vault is unreadable', async () => {
    const { client, fetch } = vault({
      'apps/hello/prd/API_TOKEN': written(1, '2026-10-01T00:00:00Z'),
    });

    expect(
      await client.check('hello', 'prd', ['API_TOKEN', 'DB_PASSWORD']),
    ).toEqual([
      'DB_PASSWORD is missing in Vault (secret/apps/hello/prd/DB_PASSWORD, field value)',
    ]);
    expect(await client.check('hello', 'prd', [])).toEqual([]);

    fetch.mockImplementation(
      async () => new Response('sealed', { status: 503, statusText: 'Sealed' }),
    );
    const problems = await client.check('hello', 'prd', ['API_TOKEN']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/could not read prd's secrets from Vault/);
  });

  it("refuses paths that aren't an app, environment and env var", async () => {
    const { client } = vault({});

    await expect(client.state('../platform-lab', 'prd', 'X')).rejects.toThrow(
      /not a golden-path app/,
    );
    await expect(client.state('hello', 'prd', '../X')).rejects.toThrow(
      /not an env var name/,
    );
  });
});

describe('helpers', () => {
  it('links to the Vault UI and computes ages', () => {
    expect(
      secretsUiUrl(
        { uiUrl: 'https://vault.lab.localhost', mount: 'secret' },
        'hello',
        'prd',
      ),
    ).toBe(
      'https://vault.lab.localhost/ui/vault/secrets/secret/kv/list/apps/hello/prd/',
    );
    expect(
      ageInDays(
        { name: 'X', status: 'present', updatedTime: '2026-07-01T00:00:00Z' },
        NOW,
      ),
    ).toBe(102);
    expect(ageInDays({ name: 'X', status: 'missing' }, NOW)).toBe(0);
  });
});
