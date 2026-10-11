/*
 * The four DORA metrics over recorded prd deploys and prd failures (docs/roadmap.md, item 5):
 *
 * - deployment frequency: release deploys to prd (promote, rollback, hotfix) per service per
 *   week;
 * - lead time for changes: from the release landing in stg to running in prd (median);
 * - change failure rate: release deploys followed within 24 hours by a rollback, a hotfix or a
 *   failure signal (an incident) in the same app;
 * - time to restore: from a failure (the incident starting, or the bad deploy when only a
 *   rollback/hotfix shows it) to recovery (incident resolved, or rollback/hotfix deployed),
 *   median over restored failures.
 *
 * They describe the delivery system, never individuals.
 */
import { DeployKind, RELEASE_KINDS, RESTORING_KINDS } from './classify';

export type Deploy = {
  app: string;
  revision: string;
  deployedAt: Date;
  kind: DeployKind;
  /** When this release landed in stg (promotions and hotfixes); lead time starts here. */
  stgLandedAt?: Date;
};

/** A failure signal in prd: today a critical alert (signals.ts). */
export type Incident = {
  app: string;
  startedAt: Date;
  resolvedAt?: Date;
};

export type DoraMetrics = {
  windowDays: number;
  services: number;
  /** Release deploys to prd in the window. */
  deploys: number;
  /** Per service. */
  deploysPerWeek: number;
  leadTimeHours: number | null;
  failedDeploys: number;
  changeFailureRate: number | null;
  /** Failures that started in the window (incidents, and bad deploys without one). */
  failures: number;
  timeToRestoreHours: number | null;
};

const FAILURE_WINDOW_MS = 24 * 3600_000;
const hours = (ms: number) => ms / 3600_000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type Failure = { start: number; end?: number };

/** Failed deploys and failures of one app, over its whole history. */
function analyse(deploys: Deploy[], incidents: Incident[]) {
  const releases = deploys
    .filter(d => RELEASE_KINDS.has(d.kind))
    .sort((a, b) => a.deployedAt.getTime() - b.deployedAt.getTime());
  const failed = new Set<Deploy>();
  const explained = new Set<Deploy>();

  // A rollback or hotfix within 24 hours means the release before it was bad.
  releases.forEach((deploy, i) => {
    const next = releases[i + 1];
    if (
      next &&
      RESTORING_KINDS.has(next.kind) &&
      next.deployedAt.getTime() - deploy.deployedAt.getTime() <=
        FAILURE_WINDOW_MS
    ) {
      failed.add(deploy);
    }
  });

  // An incident within 24 hours of a release counts against the latest release before it.
  const restoredBy = (start: number) =>
    releases
      .find(d => RESTORING_KINDS.has(d.kind) && d.deployedAt.getTime() > start)
      ?.deployedAt.getTime();

  // Overlapping incidents (several alerts at once) are one failure.
  const sorted = [...incidents].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  const failures: Failure[] = [];
  for (const incident of sorted) {
    const start = incident.startedAt.getTime();
    const ends = [incident.resolvedAt?.getTime(), restoredBy(start)].filter(
      (t): t is number => t !== undefined,
    );
    const end = ends.length ? Math.min(...ends) : undefined;

    const cause = [...releases]
      .reverse()
      .find(d => d.deployedAt.getTime() <= start);
    if (cause && start - cause.deployedAt.getTime() <= FAILURE_WINDOW_MS) {
      failed.add(cause);
      explained.add(cause);
    }

    const last = failures.at(-1);
    if (last && (last.end === undefined || start <= last.end)) {
      last.end =
        last.end === undefined || end === undefined
          ? undefined
          : Math.max(last.end, end);
    } else {
      failures.push({ start, end });
    }
  }

  // A bad release that no incident showed: failed from its deploy to the fix.
  releases.forEach((deploy, i) => {
    if (failed.has(deploy) && !explained.has(deploy)) {
      failures.push({
        start: deploy.deployedAt.getTime(),
        end: releases[i + 1].deployedAt.getTime(),
      });
    }
  });

  return { releases, failed, failures };
}

/**
 * DORA metrics of `apps` over the `days` before `now`. `deploys` and `incidents` may go
 * further back: a release just before the window still explains an incident inside it.
 */
export function computeMetrics(
  apps: string[],
  deploys: Deploy[],
  incidents: Incident[],
  options: { now: Date; days: number },
): DoraMetrics {
  const to = options.now.getTime();
  const from = to - options.days * 24 * 3600_000;
  const inWindow = (t: number) => t > from && t <= to;

  let deployCount = 0;
  let failedCount = 0;
  const leadTimes: number[] = [];
  const restoreTimes: number[] = [];
  let failureCount = 0;

  for (const app of apps) {
    const { releases, failed, failures } = analyse(
      deploys.filter(d => d.app === app),
      incidents.filter(i => i.app === app),
    );
    for (const deploy of releases) {
      const t = deploy.deployedAt.getTime();
      if (!inWindow(t)) continue;
      deployCount++;
      if (failed.has(deploy)) failedCount++;
      if (deploy.stgLandedAt && deploy.kind !== 'rollback') {
        leadTimes.push(Math.max(0, hours(t - deploy.stgLandedAt.getTime())));
      }
    }
    for (const failure of failures) {
      if (!inWindow(failure.start)) continue;
      failureCount++;
      if (failure.end !== undefined) {
        restoreTimes.push(hours(failure.end - failure.start));
      }
    }
  }

  const services = Math.max(apps.length, 1);
  return {
    windowDays: options.days,
    services: apps.length,
    deploys: deployCount,
    deploysPerWeek: deployCount / (options.days / 7) / services,
    leadTimeHours: median(leadTimes),
    failedDeploys: failedCount,
    changeFailureRate: deployCount ? failedCount / deployCount : null,
    failures: failureCount,
    timeToRestoreHours: median(restoreTimes),
  };
}
