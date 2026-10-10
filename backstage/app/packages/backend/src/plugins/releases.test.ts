import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { applyRelease, promoteRelease } from './releases';

const release = (
  tag: string,
  extra = '',
) => `# The release running in this environment.
app:
  image:
    tag: "${tag}"
  env: {}
${extra}`;

describe('promoteRelease', () => {
  let appDir: string;

  async function write(file: string, content: string) {
    await fs.mkdir(path.dirname(path.join(appDir, file)), { recursive: true });
    await fs.writeFile(path.join(appDir, file), content);
  }
  const read = (file: string) => fs.readFile(path.join(appDir, file), 'utf8');

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'promote-'));
    appDir = path.join(root, 'hello');
    await write('values.yaml', 'app:\n  env:\n    LOG_FORMAT: json\n');
    await write('envs/stg/values.yaml', 'app:\n  env:\n    DB_HOST: stg-db\n');
    await write('envs/prd/values.yaml', '# hello in prd\napp: {}\n');
    await write('envs/stg/release.yaml', release('1.1.0'));
    await write('envs/prd/release.yaml', release('1.0.0'));
  });

  it('copies the stg release to prd as one file', async () => {
    const result = await promoteRelease(appDir, 'prd');

    expect(result).toEqual({
      from: 'stg',
      to: 'prd',
      tag: '1.1.0',
      previousTag: '1.0.0',
      envSet: [],
      envRemoved: [],
    });
    expect(await read('envs/prd/release.yaml')).toBe(release('1.1.0'));
  });

  it('sets the env vars a new release requires, keeping comments', async () => {
    await write(
      'envs/stg/release.yaml',
      release('1.1.0', 'requiredEnv: [DB_HOST, LOG_FORMAT]\n'),
    );

    const result = await promoteRelease(appDir, 'prd', { DB_HOST: 'prd-db' });

    expect(result.envSet).toEqual(['DB_HOST']);
    const values = await read('envs/prd/values.yaml');
    expect(values).toMatch(/^# hello in prd\n/);
    expect(values).not.toContain('{');
    expect(parseYaml(values)).toEqual({ app: { env: { DB_HOST: 'prd-db' } } });
  });

  it('refuses a release whose required env vars prd lacks, writing nothing', async () => {
    await write(
      'envs/stg/release.yaml',
      release('1.1.0', 'requiredEnv: [DB_HOST, CACHE_URL]\n'),
    );

    await expect(
      promoteRelease(appDir, 'prd', { DB_HOST: 'prd-db' }),
    ).rejects.toThrow(/1\.1\.0 requires CACHE_URL, which prd doesn't set/);
    expect(await read('envs/prd/release.yaml')).toBe(release('1.0.0'));
    expect(await read('envs/prd/values.yaml')).toBe(
      '# hello in prd\napp: {}\n',
    );
  });

  it('refuses when prd already runs the stg release', async () => {
    await write('envs/prd/release.yaml', release('1.1.0'));

    await expect(promoteRelease(appDir, 'prd')).rejects.toThrow(
      /already runs the stg release \(1\.1\.0\) in prd/,
    );
  });

  it('refuses environment config for an env var the release sets', async () => {
    await write(
      'envs/stg/release.yaml',
      'app:\n  image:\n    tag: "1.1.0"\n  env:\n    FEATURE_X: "true"\n',
    );

    await expect(
      promoteRelease(appDir, 'prd', { FEATURE_X: 'false' }),
    ).rejects.toThrow(
      /FEATURE_X is set by the stg release and also as environment config/,
    );
  });

  it('only promotes to an environment that has a previous one', async () => {
    await expect(promoteRelease(appDir, 'stg')).rejects.toThrow(
      /promotion goes stg → prd/,
    );
  });

  it('explains when the app has no environments', async () => {
    await fs.rm(path.join(appDir, 'envs'), { recursive: true });

    await expect(promoteRelease(appDir, 'prd')).rejects.toThrow(
      /is it a golden-path app with environments/,
    );
  });

  it('removes env vars the new release no longer requires, keeping untracked ones', async () => {
    await write(
      'envs/prd/release.yaml',
      release('1.0.0', 'requiredEnv: [DB_HOST, CACHE_URL]\n'),
    );
    await write(
      'envs/prd/values.yaml',
      '# hello in prd\napp:\n  env:\n    DB_HOST: prd-db\n    CACHE_URL: redis\n    OTHER: kept\n',
    );
    await write(
      'envs/stg/release.yaml',
      release('1.1.0', 'requiredEnv: [DB_HOST]\n'),
    );

    const result = await promoteRelease(appDir, 'prd');

    expect(result.envRemoved).toEqual(['CACHE_URL']);
    expect(parseYaml(await read('envs/prd/values.yaml'))).toEqual({
      app: { env: { DB_HOST: 'prd-db', OTHER: 'kept' } },
    });
  });

  it('removes environment config that the new release now sets itself', async () => {
    await write(
      'envs/prd/values.yaml',
      '# hello in prd\napp:\n  env:\n    FEATURE_X: "false"\n',
    );
    await write(
      'envs/stg/release.yaml',
      'app:\n  image:\n    tag: "1.1.0"\n  env:\n    FEATURE_X: "true"\n',
    );

    const result = await promoteRelease(appDir, 'prd');

    expect(result.envRemoved).toEqual(['FEATURE_X']);
    expect(await read('envs/prd/values.yaml')).toBe(
      '# hello in prd\napp: {}\n',
    );
  });

  it('keeps a removed env var the run sets explicitly', async () => {
    await write(
      'envs/prd/release.yaml',
      release('1.0.0', 'requiredEnv: [CACHE_URL]\n'),
    );
    await write('envs/prd/values.yaml', 'app:\n  env:\n    CACHE_URL: redis\n');

    const result = await promoteRelease(appDir, 'prd', {
      CACHE_URL: 'redis-2',
    });

    expect(result.envRemoved).toEqual([]);
    expect(parseYaml(await read('envs/prd/values.yaml'))).toEqual({
      app: { env: { CACHE_URL: 'redis-2' } },
    });
  });
});

describe('applyRelease (rollback)', () => {
  it('restores a release without removing environment config', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rollback-'));
    const appDir = path.join(root, 'hello');
    await fs.mkdir(path.join(appDir, 'envs/prd'), { recursive: true });
    await fs.writeFile(
      path.join(appDir, 'envs/prd/release.yaml'),
      release('1.1.0', 'requiredEnv: [DB_HOST]\n'),
    );
    await fs.writeFile(
      path.join(appDir, 'envs/prd/values.yaml'),
      'app:\n  env:\n    DB_HOST: prd-db\n',
    );

    const result = await applyRelease({
      appDir,
      to: 'prd',
      release: release('1.0.0'),
      label: 'the previous prd release',
    });

    expect(result).toMatchObject({
      tag: '1.0.0',
      previousTag: '1.1.0',
      envRemoved: [],
    });
    expect(
      parseYaml(
        await fs.readFile(path.join(appDir, 'envs/prd/values.yaml'), 'utf8'),
      ),
    ).toEqual({
      app: { env: { DB_HOST: 'prd-db' } },
    });
  });
});
