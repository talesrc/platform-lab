import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import { HomePageWidgetBlueprint } from '@backstage/plugin-home-react/alpha';

/**
 * DORA metrics from the dora backend plugin: a card on golden-path services (entities with
 * argocd/app-selector, one Argo CD Application per environment) and a home-page widget.
 */
const doraCard = EntityCardBlueprint.make({
  name: 'dora',
  params: {
    filter: entity =>
      Boolean(entity.metadata.annotations?.['argocd/app-selector']),
    loader: async () => import('./DoraCard').then(m => <m.DoraCard />),
  },
});

const doraWidget = HomePageWidgetBlueprint.make({
  name: 'dora',
  params: {
    name: 'DoraMetrics',
    title: 'Delivery (DORA)',
    description:
      'Deployment frequency, lead time, change failure rate and time to restore in prd',
    components: () =>
      import('./DoraWidget').then(m => ({ Content: m.DoraWidget })),
  },
});

export const doraCatalogModule = createFrontendModule({
  pluginId: 'catalog',
  extensions: [doraCard],
});

export const doraHomeModule = createFrontendModule({
  pluginId: 'home',
  extensions: [doraWidget],
});
