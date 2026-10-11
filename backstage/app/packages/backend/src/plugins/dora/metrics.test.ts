import { classifyDeploy } from './classify';
import { computeMetrics, Deploy, Incident, median } from './metrics';

const now = new Date('2026-10-31T00:00:00Z');
const at = (iso: string) => new Date(`2026-10-${iso}Z`);

const deploy = (
  deployedAt: string,
  kind: Deploy['kind'],
  stgLandedAt?: string,
): Deploy => ({
  app: 'hello',
  revision: deployedAt,
  deployedAt: at(deployedAt),
  kind,
  stgLandedAt: stgLandedAt ? at(stgLandedAt) : undefined,
});

const incident = (startedAt: string, resolvedAt?: string): Incident => ({
  app: 'hello',
  startedAt: at(startedAt),
  resolvedAt: resolvedAt ? at(resolvedAt) : undefined,
});

const metrics = (deploys: Deploy[], incidents: Incident[] = [], days = 28) =>
  computeMetrics(['hello'], deploys, incidents, { now, days });

describe('classifyDeploy', () => {
  const prd = 'apps/hello/envs/prd/release.yaml';
  const stg = 'apps/hello/envs/stg/release.yaml';

  it('tells promotions, rollbacks and hotfixes apart', () => {
    expect(
      classifyDeploy('hello', 'chore(apps): promote hello 6.15.0 to prd', [
        prd,
      ]),
    ).toBe('promote');
    expect(
      classifyDeploy(
        'hello',
        'fix(apps): roll back hello in prd to 6.14.0\n\nMerge pull request #9',
        [prd],
      ),
    ).toBe('rollback');
    expect(classifyDeploy('hello', 'fix(hello): urgent fix', [stg, prd])).toBe(
      'hotfix',
    );
    expect(classifyDeploy('hello', 'chore: edit prd by hand', [prd])).toBe(
      'release',
    );
  });

  it("is config when prd's release didn't change", () => {
    expect(
      classifyDeploy('hello', 'chore(apps): promote hello 1.0.0 to prd', [
        'apps/hello/values.yaml',
      ]),
    ).toBe('config');
    // Another app's release file.
    expect(
      classifyDeploy('hello', 'chore(apps): promote podinfo to prd', [
        'apps/podinfo/envs/prd/release.yaml',
      ]),
    ).toBe('config');
  });
});

describe('median', () => {
  it('handles empty, odd and even lists', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('computeMetrics', () => {
  it('counts release deploys in the window, per service per week', () => {
    const m = metrics([
      deploy('01T10:00:00', 'promote'), // outside the 28-day window
      deploy('05T10:00:00', 'promote'),
      deploy('12T10:00:00', 'promote'),
      deploy('20T10:00:00', 'config'), // not a release
    ]);
    expect(m.deploys).toBe(2);
    expect(m.deploysPerWeek).toBe(0.5);
    expect(m.changeFailureRate).toBe(0);
    expect(m.timeToRestoreHours).toBeNull();
  });

  it('measures lead time from stg to prd, not for rollbacks', () => {
    const m = metrics([
      deploy('10T12:00:00', 'promote', '10T10:00:00'), // 2 h
      deploy('11T16:00:00', 'promote', '11T10:00:00'), // 6 h
      deploy('12T10:00:00', 'hotfix', '12T10:00:00'), // 0 h
      deploy('20T10:00:00', 'rollback', '01T10:00:00'),
    ]);
    expect(m.leadTimeHours).toBe(2);
  });

  it('fails a deploy rolled back within 24 hours and times the restore', () => {
    const m = metrics([
      deploy('10T10:00:00', 'promote'),
      deploy('10T13:00:00', 'rollback'), // 3 h later: 10T10 failed
      deploy('15T10:00:00', 'promote'),
      deploy('17T10:00:00', 'rollback'), // 48 h later: not a failure of 15T10
    ]);
    expect(m.deploys).toBe(4);
    expect(m.failedDeploys).toBe(1);
    expect(m.changeFailureRate).toBe(0.25);
    expect(m.failures).toBe(1);
    expect(m.timeToRestoreHours).toBe(3);
  });

  it('blames the latest release for a critical alert within 24 hours', () => {
    const m = metrics(
      [deploy('10T10:00:00', 'promote'), deploy('10T12:00:00', 'promote')],
      [
        incident('10T14:00:00', '10T15:30:00'), // blames 10T12
        incident('20T10:00:00', '20T11:00:00'), // no release in 24 h: still a failure
      ],
    );
    expect(m.failedDeploys).toBe(1);
    expect(m.changeFailureRate).toBe(0.5);
    expect(m.failures).toBe(2);
    expect(m.timeToRestoreHours).toBe(1.25);
  });

  it('ends an incident at the rollback when that comes before the alert resolves', () => {
    const m = metrics(
      [deploy('10T10:00:00', 'promote'), deploy('10T11:00:00', 'rollback')],
      [incident('10T10:30:00', '10T12:00:00')],
    );
    expect(m.failedDeploys).toBe(1);
    expect(m.failures).toBe(1);
    expect(m.timeToRestoreHours).toBe(0.5);
  });

  it('merges overlapping alerts and leaves unresolved ones out of the restore time', () => {
    const m = metrics(
      [],
      [
        incident('10T10:00:00', '10T12:00:00'),
        incident('10T11:00:00', '10T13:00:00'), // overlaps: one failure, 3 h
        incident('25T10:00:00'), // still firing
      ],
    );
    expect(m.failures).toBe(2);
    expect(m.timeToRestoreHours).toBe(3);
    expect(m.changeFailureRate).toBeNull();
  });

  it('averages frequency over services', () => {
    const m = computeMetrics(
      ['hello', 'podinfo'],
      [deploy('10T10:00:00', 'promote'), deploy('11T10:00:00', 'promote')],
      [],
      { now, days: 7 * 4 },
    );
    expect(m.services).toBe(2);
    expect(m.deploysPerWeek).toBe(0.25);
  });
});
