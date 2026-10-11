import {
  mockCredentials,
  mockServices,
  startTestBackend,
  TestDatabases,
} from '@backstage/backend-test-utils';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import request from 'supertest';
import doraPlugin from '.';

const REPO = 'https://api.github.com/repos/talesrc/platform-lab';
const PRD = 'apps/hello/envs/prd/release.yaml';
const STG = 'apps/hello/envs/stg/release.yaml';
const release = (tag: string) => `app:\n  image:\n    tag: ${tag}\n`;

// GitHub as the promotion of hello 6.15.0 left it: stg got 6.15.0 at 09:00, the promotion
// pull request merged at 11:00 as commit `merge`.
const github: Record<string, unknown> = {
  [`${REPO}/commits/merge`]: {
    sha: 'merge',
    commit: {
      message:
        'Merge pull request #4 from talesrc/promote/hello-prd-6.15.0\n\nchore(apps): promote hello 6.15.0 to prd',
      committer: { date: '2026-10-10T11:00:00Z' },
    },
    parents: [{ sha: 'before' }],
    files: [{ filename: PRD }],
  },
  [`${REPO}/commits/merge/pulls`]: [
    {
      title: 'chore(apps): promote hello 6.15.0 to prd',
      merged_at: '2026-10-10T11:00:00Z',
      merge_commit_sha: 'merge',
    },
  ],
  [`${REPO}/contents/${PRD}?ref=before`]: release('6.14.0'),
  [`${REPO}/contents/${PRD}?ref=merge`]: release('6.15.0'),
  [`${REPO}/commits/stg-release`]: {
    sha: 'stg-release',
    commit: {
      message: 'chore(deps): update hello to 6.15.0',
      committer: { date: '2026-10-10T08:30:00Z' },
    },
    files: [{ filename: STG }],
  },
  // The promotion pull request's own commit, as the history of prd's release file lists it.
  [`${REPO}/commits/promote`]: {
    sha: 'promote',
    commit: {
      message: 'chore(apps): promote hello 6.15.0 to prd',
      committer: { date: '2026-10-10T10:30:00Z' },
    },
    files: [{ filename: PRD }],
  },
  [`${REPO}/commits/promote/pulls`]: [
    {
      title: 'chore(apps): promote hello 6.15.0 to prd',
      merged_at: '2026-10-10T11:00:00Z',
      merge_commit_sha: 'merge',
    },
  ],
  [`${REPO}/commits/stg-release/pulls`]: [
    {
      title: 'chore(deps): update hello to 6.15.0',
      merged_at: '2026-10-10T09:00:00Z',
      merge_commit_sha: 'stg-release',
    },
  ],
};

const histories: Record<string, string> = {
  [STG]: 'stg-release',
  [PRD]: 'promote',
};

function fakeGithub(url: string) {
  // History of a release file: one commit each.
  if (url.startsWith(`${REPO}/commits?`)) {
    const sha = histories[new URL(url).searchParams.get('path') ?? ''];
    return new Response(
      JSON.stringify([{ sha, commit: { message: '', committer: {} } }]),
    );
  }
  const body = github[url];
  if (body === undefined) return new Response('', { status: 404 });
  return new Response(typeof body === 'string' ? body : JSON.stringify(body));
}

describe('dora plugin', () => {
  beforeEach(() => {
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async input => fakeGithub(String(input)));
  });
  // A database the test utilities close after the tests (the default one stays open).
  const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

  // Stopped after each test, so its database connections close.
  let backend: Awaited<ReturnType<typeof startTestBackend>> | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    await backend?.stop();
  });

  // The scheduler is a mock: tests run the backfill task themselves.
  async function start(entities: object[] = []) {
    const scheduler = mockServices.scheduler.mock();
    const knex = await databases.init('SQLITE_3');
    backend = await startTestBackend({
      features: [
        doraPlugin,
        scheduler.factory,
        mockServices.database.factory({ knex }),
        catalogServiceMock.factory({ entities: entities as any }),
      ],
    });
    const [task] = scheduler.scheduleTask.mock.calls[0];
    return {
      server: backend.server,
      backfill: async () => task.fn(new AbortController().signal),
    };
  }

  it('records prd deploys and alerts, and serves the metrics', async () => {
    const { server } = await start();
    const service = mockCredentials.service.header();

    const deployed = await request(server)
      .post('/api/dora/deploys')
      .set('Authorization', service)
      .send({
        app: 'hello',
        environment: 'prd',
        revision: 'merge',
        repoURL: 'https://github.com/talesrc/platform-lab.git',
        deployedAt: new Date(Date.now() - 3600_000).toISOString(),
      });
    expect(deployed.status).toBe(201);
    expect(deployed.body).toEqual({ recorded: true, kind: 'promote' });

    const stg = await request(server)
      .post('/api/dora/deploys')
      .set('Authorization', service)
      .send({
        app: 'hello',
        environment: 'stg',
        revision: 'merge',
        repoURL: 'https://github.com/talesrc/platform-lab',
      });
    expect(stg.status).toBe(202);

    const alerts = await request(server)
      .post('/api/dora/alerts')
      .set('Authorization', service)
      .send({
        alerts: [
          {
            status: 'resolved',
            labels: {
              alertname: 'HelloDown',
              namespace: 'app-hello-prd',
              severity: 'critical',
            },
            startsAt: new Date(Date.now() - 1800_000).toISOString(),
            endsAt: new Date(Date.now() - 900_000).toISOString(),
            fingerprint: 'fp1',
          },
          // Not failure signals: stg, and a warning.
          {
            status: 'firing',
            labels: { namespace: 'app-hello-stg', severity: 'critical' },
            startsAt: new Date().toISOString(),
            fingerprint: 'fp2',
          },
          {
            status: 'firing',
            labels: { namespace: 'app-hello-prd', severity: 'warning' },
            startsAt: new Date().toISOString(),
            fingerprint: 'fp3',
          },
        ],
      });
    expect(alerts.body).toEqual({ received: 3, recorded: 1 });

    const metrics = await request(server)
      .get('/api/dora/metrics/hello')
      .set('Authorization', mockCredentials.user.header());
    expect(metrics.status).toBe(200);
    expect(metrics.body.metrics).toMatchObject({
      deploys: 1,
      failedDeploys: 1,
      changeFailureRate: 1,
      failures: 1,
      timeToRestoreHours: 0.25,
    });
    // Promotion merged 2 h after stg's release: lead time runs to the (later) deploy.
    expect(metrics.body.metrics.leadTimeHours).toBeGreaterThan(2);
    expect(metrics.body.recentDeploys).toEqual([
      expect.objectContaining({
        revision: 'merge',
        kind: 'promote',
        title: 'chore(apps): promote hello 6.15.0 to prd',
      }),
    ]);

    const all = await request(server)
      .get('/api/dora/metrics?days=7')
      .set('Authorization', mockCredentials.user.header());
    expect(Object.keys(all.body.services)).toEqual(['hello']);
    expect(all.body.overall.windowDays).toBe(7);
  });

  it("backfills prd deploys from the history of prd's release file", async () => {
    const { server, backfill } = await start([
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'hello',
          namespace: 'default',
          annotations: {
            'backstage.io/source-location':
              'url:https://github.com/talesrc/platform-lab/tree/main/apps/hello',
          },
        },
        spec: { type: 'service', owner: 'group:default/platform-team' },
      },
    ]);
    await backfill();

    const metrics = await request(server)
      .get('/api/dora/metrics/hello?days=365')
      .set('Authorization', mockCredentials.user.header());
    expect(metrics.body.recentDeploys).toEqual([
      {
        revision: 'merge',
        kind: 'promote',
        // Git knows when the pull request merged, not when Argo CD synced it.
        deployedAt: '2026-10-10T11:00:00.000Z',
        title: 'chore(apps): promote hello 6.15.0 to prd',
      },
    ]);
    // stg's release landed at 09:00, the promotion at 11:00.
    expect(metrics.body.metrics.leadTimeHours).toBe(2);
  });

  it('refuses webhooks from users and bad windows', async () => {
    const { server } = await start();
    const asUser = await request(server)
      .post('/api/dora/alerts')
      .set('Authorization', mockCredentials.user.header())
      .send({ alerts: [] });
    expect(asUser.status).toBe(403);

    const badDays = await request(server)
      .get('/api/dora/metrics?days=0')
      .set('Authorization', mockCredentials.user.header());
    expect(badDays.status).toBe(400);
  });
});
