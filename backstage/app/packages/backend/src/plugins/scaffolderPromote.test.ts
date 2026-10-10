import { branchName, previousRelease } from './scaffolderPromote';

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
