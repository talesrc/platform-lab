import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import {
  findReadyReleases,
  goldenPathApps,
  notifiedReleases,
  promoteLink,
  readyNotification,
  releaseKey,
  vaultPrdSecretsChecker,
  type CheckPrdSecrets,
  type GoldenPathApp,
} from './readyToPromote';
import type { Values } from './releases';
import type { VaultMetadataClient } from './vaultSecrets';

const REPO = 'https://github.com/talesrc/platform-lab';
const HELLO: GoldenPathApp = {
  entityRef: 'component:default/hello',
  name: 'hello',
  repo: REPO,
  ref: 'main',
  appDir: 'apps/hello',
};

const release = (tag: string, env: Record<string, string> = {}): Values => ({
  app: { image: { tag }, ...(Object.keys(env).length ? { env } : {}) },
});

function setup(
  files: { stg?: Values; prd?: Values; prdValues?: Values },
  options: {
    problems?: string[];
    lastNotified?: string;
    checkPrdSecrets?: CheckPrdSecrets;
  } = {},
) {
  const byPath: Record<string, Values | undefined> = {
    'values.yaml': { app: { image: { repository: 'ghcr.io/x/hello' } } },
    'envs/stg/release.yaml': files.stg,
    'envs/prd/release.yaml': files.prd,
    'envs/prd/values.yaml': files.prdValues,
  };
  const readValues = jest.fn(async (url: string) => {
    const prefix = `${REPO}/blob/main/apps/hello/`;
    expect(url.startsWith(prefix)).toBe(true);
    return byPath[url.slice(prefix.length)];
  });
  const checkStg = jest.fn(async () => options.problems ?? []);
  const lastNotified = jest.fn(async () => options.lastNotified);
  return {
    checkStg,
    run: () =>
      findReadyReleases({
        apps: [HELLO],
        readValues,
        checkStg,
        checkPrdSecrets: options.checkPrdSecrets,
        lastNotified,
        logger: mockServices.logger.mock(),
      }),
  };
}

const withSecrets = (tag: string, secretEnv: string[]): Values => ({
  app: { image: { tag }, secretEnv },
});

describe('findReadyReleases', () => {
  it('reports a stg release that prd lacks and that runs well', async () => {
    const { run, checkStg } = setup({
      stg: release('6.16.0'),
      prd: release('6.15.0'),
    });

    expect(await run()).toEqual([
      {
        app: HELLO,
        stgTag: '6.16.0',
        prdTag: '6.15.0',
        releaseKey: releaseKey(release('6.16.0')),
      },
    ]);
    expect(checkStg).toHaveBeenCalledWith('hello', 'ghcr.io/x/hello:6.16.0');
  });

  it('skips apps whose prd runs the stg release', async () => {
    const { run, checkStg } = setup({
      stg: release('6.16.0'),
      prd: release('6.16.0'),
    });

    expect(await run()).toEqual([]);
    expect(checkStg).not.toHaveBeenCalled();
  });

  it('skips apps whose stg is not ready yet', async () => {
    const { run } = setup(
      { stg: release('6.16.0'), prd: release('6.15.0') },
      { problems: ['stg was deployed 3 min ago'] },
    );

    expect(await run()).toEqual([]);
  });

  it('notifies once per stg release', async () => {
    const { run, checkStg } = setup(
      { stg: release('6.16.0'), prd: release('6.15.0') },
      { lastNotified: releaseKey(release('6.16.0')) },
    );

    expect(await run()).toEqual([]);
    expect(checkStg).not.toHaveBeenCalled();
  });

  it('treats a config-only release on the same tag as a new release', async () => {
    const stg = release('6.16.0', { UI_MESSAGE: 'hi' });
    const { run } = setup(
      { stg, prd: release('6.15.0') },
      { lastNotified: releaseKey(release('6.16.0')) },
    );

    expect((await run()).map(r => r.releaseKey)).toEqual([releaseKey(stg)]);
  });

  it('skips apps with unreadable release files', async () => {
    const { run } = setup({ stg: release('6.16.0') });

    expect(await run()).toEqual([]);
  });

  describe("with prd's secrets", () => {
    const stg = withSecrets('6.16.0', ['API_TOKEN']);

    it("checks the release's and prd's secretEnv in prd's Vault", async () => {
      const checkPrdSecrets = jest.fn(async () => []);
      const { run } = setup(
        {
          stg,
          prd: release('6.15.0'),
          prdValues: { app: { secretEnv: ['DB_PASSWORD'] } },
        },
        { checkPrdSecrets },
      );

      expect(await run()).toEqual([
        expect.objectContaining({
          stgTag: '6.16.0',
          releaseKey: releaseKey(stg),
        }),
      ]);
      expect(checkPrdSecrets).toHaveBeenCalledWith('hello', [
        'API_TOKEN',
        'DB_PASSWORD',
      ]);
    });

    it("doesn't ask Vault when the release needs no secrets", async () => {
      const checkPrdSecrets = jest.fn(async () => []);
      const { run } = setup(
        { stg: release('6.16.0'), prd: release('6.15.0') },
        { checkPrdSecrets },
      );

      expect(await run()).toHaveLength(1);
      expect(checkPrdSecrets).not.toHaveBeenCalled();
    });

    it('reports the missing secrets, under a key of their own', async () => {
      const { run } = setup(
        { stg, prd: release('6.15.0') },
        { checkPrdSecrets: async () => ['API_TOKEN'] },
      );

      expect(await run()).toEqual([
        expect.objectContaining({
          missingSecrets: ['API_TOKEN'],
          releaseKey: `${releaseKey(stg)}:needs:API_TOKEN`,
        }),
      ]);
    });

    it('notifies again once the missing secrets are written', async () => {
      const { run } = setup(
        { stg, prd: release('6.15.0') },
        {
          checkPrdSecrets: async () => [],
          lastNotified: `${releaseKey(stg)}:needs:API_TOKEN`,
        },
      );

      expect((await run()).map(r => r.releaseKey)).toEqual([releaseKey(stg)]);
    });

    it("retries later when Vault can't tell", async () => {
      const { run, checkStg } = setup(
        { stg, prd: release('6.15.0') },
        { checkPrdSecrets: async () => undefined },
      );

      expect(await run()).toEqual([]);
      expect(checkStg).not.toHaveBeenCalled();
    });
  });
});

describe('vaultPrdSecretsChecker', () => {
  const client = (
    state: (name: string) => Promise<{ name: string; status: string }>,
  ) =>
    ({
      state: jest.fn((_app: string, _env: string, name: string) => state(name)),
    } as unknown as VaultMetadataClient);

  it('lists the secrets prd lacks', async () => {
    const statuses: Record<string, string> = { A: 'present', B: 'deleted' };
    const check = vaultPrdSecretsChecker(
      client(async name => ({ name, status: statuses[name] ?? 'missing' })),
    );

    expect(await check('hello', ['A', 'B', 'C'])).toEqual(['B', 'C']);
  });

  it("can't tell when Vault is unreadable", async () => {
    const check = vaultPrdSecretsChecker(
      client(async () => {
        throw new Error('403');
      }),
    );

    expect(await check('hello', ['A'])).toBeUndefined();
  });
});

describe('readyNotification', () => {
  const ready = {
    app: HELLO,
    stgTag: '6.16.0',
    prdTag: '6.15.0',
    releaseKey: 'k',
  };

  it('links the Promote to prd form', () => {
    expect(readyNotification(ready, 10)).toMatchObject({
      title: 'hello 6.16.0 is ready to promote to prd',
      link: promoteLink('component:default/hello'),
      scope: 'ready-to-promote:component:default/hello',
    });
  });

  it("links prd's secrets in Vault when some are missing", () => {
    const notification = readyNotification(
      { ...ready, missingSecrets: ['API_TOKEN'] },
      10,
      'https://vault/ui/hello/prd/',
    );

    expect(notification).toMatchObject({
      title: 'hello 6.16.0 passes stg, but prd lacks secrets',
      link: 'https://vault/ui/hello/prd/',
      // Replaces the "ready" notification of the same app, and is replaced by it.
      scope: 'ready-to-promote:component:default/hello',
    });
    expect(notification.description).toContain('API_TOKEN');
  });
});

describe('releaseKey', () => {
  it('ignores key order', () => {
    expect(
      releaseKey({ requiredEnv: ['A'], app: { image: { tag: '1' } } }),
    ).toBe(releaseKey({ app: { image: { tag: '1' } }, requiredEnv: ['A'] }));
  });
});

describe('goldenPathApps', () => {
  it('keeps Components with their source under apps/', () => {
    const annotated = (name: string, location: string) => ({
      kind: 'Component',
      metadata: {
        name,
        annotations: { 'backstage.io/source-location': location },
      },
    });

    expect(
      goldenPathApps([
        annotated('hello', `url:${REPO}/tree/main/apps/hello/`),
        annotated('backstage', `url:${REPO}/tree/main/backstage/app/`),
      ]),
    ).toEqual([HELLO]);
  });
});

describe('notifiedReleases', () => {
  const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

  it('keeps the latest notified stg release per app', async () => {
    const db = await databases.init('SQLITE_3');
    const ready = (tag: string) => ({
      app: HELLO,
      stgTag: tag,
      releaseKey: releaseKey(release(tag)),
    });
    const { lastNotified, markNotified } = await notifiedReleases(db);

    expect(await lastNotified('hello')).toBeUndefined();
    await markNotified(ready('6.16.0'));
    await markNotified(ready('6.17.0'));
    // Created once: a restart finds the table and its rows.
    expect(await (await notifiedReleases(db)).lastNotified('hello')).toBe(
      releaseKey(release('6.17.0')),
    );
  });
});

describe('promoteLink', () => {
  it('prefills the Promote to prd form', () => {
    expect(decodeURIComponent(promoteLink('component:default/hello'))).toBe(
      '/create/templates/default/promote-app?formData={"app":"component:default/hello"}',
    );
  });
});
