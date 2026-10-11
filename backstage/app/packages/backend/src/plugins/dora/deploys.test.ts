import { describeDeploy } from './deploys';
import { GithubCommits } from './github';

const REPO = 'https://api.github.com/repos/o/r';
const PRD = 'apps/hello/envs/prd/release.yaml';
const STG = 'apps/hello/envs/stg/release.yaml';

/** A commit `sha` on main (no pull request) changing `files` from `before` to `after`. */
function githubWith(
  message: string,
  files: Record<string, { before?: string; after: string }>,
) {
  const responses: Record<string, unknown> = {
    [`${REPO}/commits/sha`]: {
      sha: 'sha',
      commit: { message, committer: { date: '2026-10-10T10:00:00Z' } },
      parents: [{ sha: 'parent' }],
      files: Object.keys(files).map(filename => ({ filename })),
    },
    [`${REPO}/commits/sha/pulls`]: [],
  };
  for (const [path, { before, after }] of Object.entries(files)) {
    if (before !== undefined) {
      responses[`${REPO}/contents/${path}?ref=parent`] = before;
    }
    responses[`${REPO}/contents/${path}?ref=sha`] = after;
  }
  const fetchImpl = (async (input: string) => {
    if (input.startsWith(`${REPO}/commits?`)) return new Response('[]');
    const body = responses[input];
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body));
  }) as unknown as typeof fetch;
  return new GithubCommits(undefined, fetchImpl);
}

describe('describeDeploy', () => {
  it('classifies a hotfix and starts its lead time when it landed', async () => {
    const github = githubWith('fix(hello): hotfix', {
      [STG]: {
        before: 'app: {image: {tag: "1"}}',
        after: 'app: {image: {tag: "2"}}',
      },
      [PRD]: {
        before: 'app: {image: {tag: "1"}}',
        after: 'app: {image: {tag: "2"}}',
      },
    });
    const deploy = await describeDeploy(github, 'o/r', 'hello', 'sha');
    expect(deploy).toMatchObject({ revision: 'sha', kind: 'hotfix' });
    expect(deploy.stgLandedAt).toEqual(new Date('2026-10-10T10:00:00Z'));
  });

  it('ignores comment-only edits of the release files', async () => {
    const github = githubWith('docs: explain the release files', {
      [STG]: {
        before: 'app: {image: {tag: "1"}}',
        after: '# stg\napp: {image: {tag: "1"}}',
      },
      [PRD]: {
        before: 'app: {image: {tag: "1"}}',
        after: '# prd\napp: {image: {tag: "1"}}',
      },
    });
    const deploy = await describeDeploy(github, 'o/r', 'hello', 'sha');
    expect(deploy.kind).toBe('config');
  });

  it("doesn't count a new app's first deploy as a release change", async () => {
    const github = githubWith('feat(apps): add hello', {
      [STG]: { after: 'app: {image: {tag: "1"}}' },
      [PRD]: { after: 'app: {image: {tag: "1"}}' },
    });
    const deploy = await describeDeploy(github, 'o/r', 'hello', 'sha');
    expect(deploy.kind).toBe('config');
  });
});
