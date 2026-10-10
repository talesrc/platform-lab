/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);
// platform-lab:app:promote, for the "Promote to prd" template (src/plugins/scaffolderPromote.ts).
backend.add(import('./plugins/scaffolderPromote'));

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// See https://backstage.io/docs/backend-system/building-backends/migrating#the-auth-plugin
// GitHub sign-in; see https://backstage.io/docs/auth/github/provider
backend.add(import('@backstage/plugin-auth-backend-module-github-provider'));

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// See https://backstage.io/docs/features/software-catalog/configuration#subscribing-to-catalog-errors
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));

// permission plugin
backend.add(import('@backstage/plugin-permission-backend'));

// --- Standards (IDP phase 4) ------------------------------------------------------------
// Permission policy: everyone signed in reads and runs templates; catalog changes are for
// entity owners / the platform team (src/plugins/permissionPolicy.ts).
backend.add(import('./plugins/permissionPolicy'));
// Scorecards: Tech Insights with config-defined JSON-rules checks (app-config.production.yaml)
// and platform-lab facts (src/plugins/techInsightsPlatformLab.ts).
backend.add(import('@backstage-community/plugin-tech-insights-backend'));
backend.add(
  import('@backstage-community/plugin-tech-insights-backend-module-jsonfc'),
);
backend.add(import('./plugins/techInsightsPlatformLab'));
// Kyverno policy results per entity, from Policy Reporter (gitops/platform/policy-reporter.yaml).
backend.add(import('@kyverno/backstage-plugin-policy-reporter-backend'));
// --- end Standards ----------------------------------------------------------------------

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine
// See https://backstage.io/docs/features/search/search-engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// kubernetes plugin (in-cluster service account; see app-config.production.yaml)
backend.add(import('@backstage/plugin-kubernetes-backend'));

// Argo CD sync/health per entity (Roadie); read-only token from terraform/platform-access
backend.add(import('@roadiehq/backstage-plugin-argo-cd-backend'));

// user settings plugin
backend.add(import('@backstage/plugin-user-settings-backend'));

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
// Alertmanager webhook -> notifications for the owning team (src/plugins/alertmanager.ts)
backend.add(import('./plugins/alertmanager'));
backend.add(import('@backstage/plugin-signals-backend'));

// mcp actions plugin
backend.add(import('@backstage/plugin-mcp-actions-backend'));

backend.start();
