/*
 * From a commit Argo CD deployed to prd to a classified deploy: what it changed (classify.ts)
 * and when its release landed in stg (lead time).
 */
import { parseRelease, sameRelease } from '../releases';
import { classifyDeploy, DeployKind } from './classify';
import { GithubCommits } from './github';

export type DescribedDeploy = {
  revision: string;
  kind: DeployKind;
  message: string;
  landedAt: Date;
  stgLandedAt?: Date;
};

/**
 * Release files of `app` whose release changed in the commit: comment-only edits don't count,
 * and neither does a file the commit created (a new app's first deploy is not a change to prd).
 */
async function changedReleases(
  github: GithubCommits,
  repo: string,
  app: string,
  info: { revision: string; parent?: string; files: string[] },
) {
  const changed: string[] = [];
  for (const env of ['stg', 'prd']) {
    const path = `apps/${app}/envs/${env}/release.yaml`;
    if (!info.files.includes(path) || !info.parent) continue;
    const [before, after] = await Promise.all([
      github.fileAt(repo, path, info.parent),
      github.fileAt(repo, path, info.revision),
    ]);
    if (
      before !== undefined &&
      after !== undefined &&
      !sameRelease(parseRelease(before), parseRelease(after))
    ) {
      changed.push(path);
    }
  }
  return changed;
}

/** The prd deploy of `app` that commit `sha` (on main, or in a merged pull request) made. */
export async function describeDeploy(
  github: GithubCommits,
  repo: string,
  app: string,
  sha: string,
): Promise<DescribedDeploy> {
  const info = await github.describe(repo, sha);
  const kind = classifyDeploy(
    app,
    info.message,
    await changedReleases(github, repo, app, info),
  );

  // Lead time starts when the release reached stg: for a promotion, when stg's current
  // release landed; a hotfix reached both at once. Rollbacks bring back an old release.
  let stgLandedAt: Date | undefined;
  if (kind === 'promote') {
    stgLandedAt = await github.stgLandedAt(repo, app, info.landedAt);
  } else if (kind === 'hotfix') {
    stgLandedAt = info.landedAt;
  }

  return {
    revision: info.revision,
    kind,
    message: info.message,
    landedAt: info.landedAt,
    stgLandedAt,
  };
}
