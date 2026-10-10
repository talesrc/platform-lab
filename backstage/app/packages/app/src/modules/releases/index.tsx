import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';

/**
 * "Releases" card on the overview of golden-path services (entities with
 * argocd/app-selector: one Argo CD Application per environment).
 */
const releasesCard = EntityCardBlueprint.make({
  name: 'releases',
  params: {
    filter: entity =>
      Boolean(entity.metadata.annotations?.['argocd/app-selector']),
    loader: async () => import('./ReleasesCard').then(m => <m.ReleasesCard />),
  },
});

export const releasesModule = createFrontendModule({
  pluginId: 'catalog',
  extensions: [releasesCard],
});
