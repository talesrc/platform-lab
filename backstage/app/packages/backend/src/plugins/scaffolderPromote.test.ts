import { ConfigReader } from '@backstage/config';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  branchName,
  checkReleaseSecrets,
  previousRelease,
} from './scaffolderPromote';
import type { VaultMetadataClient } from './vaultSecrets';

async function* versions(...texts: string[]) {
  for (const [i, text] of texts.entries()) {
    yield { sha: `sha${i}`, date: `2026-10-0${i + 1}T00:00:00Z`, text };
  }
}
const release = (tag: string, comment = '') =>
  `${comment}app:\n  image:\n    tag: "${tag}"\n`;

describe('previousRelease', () => {
  it('skips the current release and comment-only changes', async () => {
    const found = await previousRelease(
      versions(
        release('1.1.0'),
        release('1.1.0', '# reworded\n'),
        release('1.0.0'),
      ),
      { app: { image: { tag: '1.1.0' } } },
    );

    expect(found?.sha).toBe('sha2');
  });

  it('finds nothing when prd never ran another release', async () => {
    expect(
      await previousRelease(versions(release('1.1.0')), {
        app: { image: { tag: '1.1.0' } },
      }),
    ).toBeUndefined();
  });
});

describe('checkReleaseSecrets', () => {
  let appDir: string;
  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(appDir, file)), { recursive: true });
    await fs.writeFile(path.join(appDir, file), content);
  };

  beforeEach(async () => {
    appDir = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-')),
      'hello',
    );
    await write('values.yaml', 'app:\n  secretEnv: [SHARED_KEY]\n');
    await write('envs/prd/values.yaml', 'app:\n  secretEnv: [PRD_ONLY]\n');
    // prd still runs a release without secrets; stg's needs API_TOKEN.
    await write('envs/prd/release.yaml', release('1.0.0'));
    await write(
      'envs/stg/release.yaml',
      `${release('1.1.0')}  secretEnv: [API_TOKEN]\n`,
    );
  });

  it("checks prd's Vault for the secrets of the stg release being promoted", async () => {
    const check = jest.fn(async () => ['API_TOKEN is missing in Vault']);
    const client = { check } as unknown as VaultMetadataClient;

    const problems = await checkReleaseSecrets(
      new ConfigReader({}),
      appDir,
      'hello',
      'prd',
      client,
    );

    expect(problems).toEqual(['API_TOKEN is missing in Vault']);
    expect(check).toHaveBeenCalledWith('hello', 'prd', [
      'API_TOKEN',
      'PRD_ONLY',
      'SHARED_KEY',
    ]);
  });

  it("doesn't ask Vault when the release needs no secrets, and fails closed without config", async () => {
    await write('values.yaml', 'app: {}\n');
    await write('envs/prd/values.yaml', 'app: {}\n');
    await write('envs/stg/release.yaml', release('1.1.0'));
    expect(
      await checkReleaseSecrets(new ConfigReader({}), appDir, 'hello', 'prd'),
    ).toEqual([]);

    await write(
      'envs/stg/release.yaml',
      `${release('1.1.0')}  secretEnv: [API_TOKEN]\n`,
    );
    expect(
      await checkReleaseSecrets(new ConfigReader({}), appDir, 'hello', 'prd'),
    ).toEqual([
      "the release needs API_TOKEN from Vault, but platformLab.vault isn't configured to check them",
    ]);
  });
});

describe('branchName', () => {
  it('is unique per run and safe for git', () => {
    expect(
      branchName(
        'promote',
        'hello',
        '6.15.0+build',
        new Date('2026-10-11T09:08:07Z'),
      ),
    ).toBe('promote/hello-prd-6.15.0-build-20261011090807');
  });
});
