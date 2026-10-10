import { checkStgHealth, type StgHealthOptions } from './stgHealth';

const IMAGE = 'ghcr.io/stefanprodan/podinfo:6.15.0';
const NOW = new Date('2026-10-11T12:00:00Z');

function options(
  app: Record<string, unknown>,
  alerts: Array<Record<string, string>> = [],
  extra: Partial<StgHealthOptions> = {},
): StgHealthOptions & { fetch: jest.Mock } {
  const fetchMock = jest.fn(async (url: string) => {
    if (url.startsWith('http://argocd')) {
      return new Response(JSON.stringify({ status: app }), { status: 200 });
    }
    return new Response(JSON.stringify(alerts.map(labels => ({ labels }))), {
      status: 200,
    });
  });
  return {
    argocd: { url: 'http://argocd', token: 't' },
    alertmanagerUrl: 'http://alertmanager',
    soakMinutes: 10,
    fetch: fetchMock as unknown as typeof fetch & jest.Mock,
    now: () => NOW,
    ...extra,
  } as StgHealthOptions & { fetch: jest.Mock };
}

const healthy = {
  sync: { status: 'Synced' },
  health: { status: 'Healthy' },
  summary: { images: [IMAGE] },
  history: [{ deployedAt: '2026-10-11T11:00:00Z' }],
};

describe('checkStgHealth', () => {
  it('passes when stg is synced, healthy, on the image, soaked and quiet', async () => {
    const opts = options(healthy, [{ alertname: 'Info', severity: 'info' }]);

    expect(await checkStgHealth('hello', IMAGE, opts)).toEqual([]);
    expect(opts.fetch).toHaveBeenCalledWith(
      'http://argocd/api/v1/applications/hello-stg',
      { headers: { Authorization: 'Bearer t' } },
    );
    expect(opts.fetch.mock.calls[1][0]).toContain(
      encodeURIComponent('namespace="app-hello-stg"'),
    );
  });

  it('lists every problem', async () => {
    const opts = options(
      {
        sync: { status: 'OutOfSync' },
        health: { status: 'Degraded' },
        summary: { images: ['ghcr.io/stefanprodan/podinfo:6.14.1'] },
        history: [{ deployedAt: '2026-10-11T11:55:00Z' }],
      },
      [
        { alertname: 'KubePodCrashLooping', severity: 'warning' },
        { alertname: 'KubePodCrashLooping', severity: 'warning' },
      ],
    );

    expect(await checkStgHealth('hello', IMAGE, opts)).toEqual([
      "hello-stg is OutOfSync in Argo CD: stg doesn't run what git says yet",
      'hello-stg is Degraded in Argo CD',
      `stg runs ghcr.io/stefanprodan/podinfo:6.14.1, not ${IMAGE}`,
      'stg was deployed 5 min ago; give it 10 min before promoting',
      'alerts firing in app-hello-stg: KubePodCrashLooping',
    ]);
  });

  it('fails closed when Argo CD or Alertmanager cannot be read', async () => {
    const opts = options(healthy);
    opts.fetch.mockImplementation(
      async () =>
        new Response('nope', { status: 503, statusText: 'Unavailable' }),
    );

    const problems = await checkStgHealth('hello', IMAGE, opts);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/could not read hello-stg from Argo CD/);
    expect(problems[1]).toMatch(/could not read alerts for app-hello-stg/);
  });
});
