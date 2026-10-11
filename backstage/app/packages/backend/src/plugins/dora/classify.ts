/*
 * What a prd deploy was, from the commit Argo CD deployed: the templates and CI write
 * recognisable commits (scaffolderPromote.ts, backstage/templates/*), and the release files
 * it changed say whether a release reached prd at all.
 */

/**
 * - promote: stg's release copied to prd (Promote to prd: `chore(apps): promote ...`)
 * - rollback: prd back to an earlier release (Roll back prd: `fix(apps): roll back ...`)
 * - hotfix: one commit changed the stg and prd releases together
 * - release: prd's release changed some other way (an edit by hand)
 * - config: prd synced, but its release didn't change (shared values, chart, env config)
 */
export type DeployKind =
  | 'promote'
  | 'rollback'
  | 'hotfix'
  | 'release'
  | 'config';

/** Kinds that deploy a release to prd: the ones DORA counts. */
export const RELEASE_KINDS: ReadonlySet<DeployKind> = new Set([
  'promote',
  'rollback',
  'hotfix',
  'release',
]);

/** Kinds that restore prd after a bad release. */
export const RESTORING_KINDS: ReadonlySet<DeployKind> = new Set([
  'rollback',
  'hotfix',
]);

const PROMOTE = /^chore\(apps\): promote /m;
const ROLLBACK = /^fix\(apps\): roll back /m;

/**
 * Classifies a deploy of golden-path app `app` from its commit: `message` (for a merge, the
 * pull request title is enough) and the paths it changed.
 */
export function classifyDeploy(
  app: string,
  message: string,
  files: string[],
): DeployKind {
  const changed = (env: string) =>
    files.includes(`apps/${app}/envs/${env}/release.yaml`);
  if (!changed('prd')) return 'config';
  if (changed('stg')) return 'hotfix';
  if (ROLLBACK.test(message)) return 'rollback';
  if (PROMOTE.test(message)) return 'promote';
  return 'release';
}
