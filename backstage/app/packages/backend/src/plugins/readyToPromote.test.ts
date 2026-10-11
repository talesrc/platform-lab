import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import {
  findReadyReleases,
  goldenPathApps,
  notifiedReleases,
  promoteLink,
  releaseKey,
  type GoldenPathApp,
} from './readyToPromote';
import type { Values } from './releases';

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
  files: { stg?: Values; prd?: Values },
  options: { problems?: string[]; lastNotified?: string } = {},
) {
  const read = (name: string) =>
    ({
      values: { app: { image: { repository: 'ghcr.io/x/hello' } } },
      stg: files.stg,
      prd: files.prd,
    }[name]);
  const readValues = jest.fn(async (url: string) => {
    expect(url.startsWith(`${REPO}/blob/main/apps/hello/`)).toBe(true);
    if (url.endsWith('/values.yaml') && !url.includes('/envs/')) {
      return read('values') as Values;
    }
    return read(url.includes('/envs/stg/') ? 'stg' : 'prd');
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
        lastNotified,
        logger: mockServices.logger.mock(),
      }),
  };
}

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
