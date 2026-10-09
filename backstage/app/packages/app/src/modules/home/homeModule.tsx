import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { HomePageWidgetBlueprint } from '@backstage/plugin-home-react/alpha';
import { LinkButton, MarkdownContent } from '@backstage/core-components';
import Box from '@material-ui/core/Box';

const content = `
**platform-lab** is TALECO's internal developer platform. Every service here is
described in the [catalog](/catalog) and deployed from git by Argo CD.

### Ship a service in three steps

1. **Create** — fill in the golden-path form. It renders the manifests for you.
2. **Review and merge** the pull request it opens on \`talesrc/platform-lab\`.
3. **Argo CD deploys it** to namespace \`app-<name>\`, live at
   \`https://<name>.apps.lab.localhost\`, with Prometheus scraping and dashboards.

Each service page shows its pods, Argo CD sync status and Grafana dashboards.
`;

const welcomeWidget = HomePageWidgetBlueprint.make({
  name: 'welcome',
  params: {
    name: 'Welcome',
    title: 'Welcome to platform-lab',
    description: 'How the golden path takes a service from form to running',
    components: async () => ({
      Content: () => (
        <>
          <MarkdownContent content={content} />
          <Box display="flex" flexWrap="wrap" mt={2} style={{ gap: 12 }}>
            <LinkButton to="/create" variant="contained" color="primary">
              Create a service
            </LinkButton>
            <LinkButton to="/catalog" variant="outlined" color="primary">
              Browse the catalog
            </LinkButton>
          </Box>
        </>
      ),
    }),
  },
});

export const homeModule = createFrontendModule({
  pluginId: 'home',
  extensions: [welcomeWidget],
});
