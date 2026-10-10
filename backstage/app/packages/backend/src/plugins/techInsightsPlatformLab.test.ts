import { mockServices } from '@backstage/backend-test-utils';
import type { FactRetrieverContext } from '@backstage-community/plugin-tech-insights-node';
import { compareVersions, platformLabFactRetriever } from './techInsightsPlatformLab';

const mockEntities = [
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'hello',
      annotations: {
        'backstage.io/source-location':
          'url:https://github.com/talesrc/platform-lab/tree/main/apps/hello',
        'backstage.io/kubernetes-label-selector': 'app.kubernetes.io/name=hello',
        'argocd/app-name': 'hello',
      },
      links: [{ url: 'https://hello.apps.lab.localhost' }],
    },
  },
  {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'registry-cache',
      annotations: {
        'backstage.io/source-location':
          'url:https://github.com/talesrc/platform-lab/tree/main/terraform/registry-cache',
      },
    },
  },
];

const files: Record<string, string> = {
  'https://github.com/talesrc/platform-lab/blob/main/apps/hello/Chart.yaml':
    'apiVersion: v2\nname: hello\nversion: 1.0.0\ndependencies:\n  - name: app\n    version: 0.1.0\n',
  'https://github.com/talesrc/platform-lab/blob/main/charts/app/Chart.yaml':
    'apiVersion: v2\nname: app\nversion: 0.2.0\n',
};

// The retriever builds its own CatalogClient; serve the entities from a mock.
jest.mock('@backstage/catalog-client', () => ({
  CatalogClient: jest.fn().mockImplementation(() => ({
    getEntities: async () => ({ items: mockEntities }),
  })),
}));

function context(): FactRetrieverContext {
  return {
    config: mockServices.rootConfig(),
    discovery: { getBaseUrl: async () => 'http://catalog', getExternalBaseUrl: async () => 'http://catalog' },
    logger: mockServices.logger.mock(),
    auth: mockServices.auth(),
    urlReader: {
      readUrl: async (url: string) => {
        if (!(url in files)) throw new Error(`not found: ${url}`);
        return { buffer: async () => Buffer.from(files[url]) } as any;
      },
      readTree: jest.fn(),
      search: jest.fn(),
    },
    entityFilter: platformLabFactRetriever.entityFilter,
  } as unknown as FactRetrieverContext;
}

describe('platformLabFactRetriever', () => {
  it('compares chart versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
  });

  it('reports live-state annotations, links and the golden-path chart version', async () => {
    const facts = await platformLabFactRetriever.handler(context());
    const byName = Object.fromEntries(facts.map(f => [f.entity.name, f.facts]));

    expect(byName.hello).toEqual({
      hasKubernetesSelector: true,
      hasArgocdApp: true,
      hasGrafanaDashboards: false,
      hasLinks: true,
      isGoldenPathApp: true,
      appChartVersion: '0.1.0',
      latestAppChartVersion: '0.2.0',
      usesLatestAppChart: false,
    });
    expect(byName['registry-cache']).toEqual({
      hasKubernetesSelector: false,
      hasArgocdApp: false,
      hasGrafanaDashboards: false,
      hasLinks: false,
      isGoldenPathApp: false,
      usesLatestAppChart: true,
    });
  });
});
