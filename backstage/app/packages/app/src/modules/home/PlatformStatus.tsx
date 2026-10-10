import { useEffect, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import {
  Progress,
  StatusError,
  StatusOK,
  StatusPending,
  StatusWarning,
  Table,
  TableColumn,
  WarningPanel,
} from '@backstage/core-components';
import { useApi } from '@backstage/frontend-plugin-api';
import { catalogApiRef, EntityRefLink } from '@backstage/plugin-catalog-react';
import {
  ARGOCD_ANNOTATION_APP_NAME,
  ARGOCD_ANNOTATION_APP_SELECTOR,
  argoCDApiRef,
} from '@roadiehq/backstage-plugin-argo-cd';

type AppState = {
  name: string;
  sync: string;
  health: string;
};

type Row = {
  entity: Entity;
  /** Undefined: not managed by Argo CD. */
  apps?: AppState[];
};

const unknown = (name: string): AppState => ({
  name,
  sync: 'Unknown',
  health: 'Unknown',
});

/**
 * Live state of the platform: every component of System platform-lab, with the Argo CD
 * sync and health of its apps: the one named in argocd/app-name (platform components), or
 * every app matching argocd/app-selector (golden-path apps, one Application per environment:
 * hello-stg, hello-prd). It reuses the Argo CD plugin's API (same backend route and read-only
 * token as the entity pages); components outside Argo CD (e.g. Argo CD itself, the registry
 * caches) show "not managed by Argo CD".
 */
const AppStatus = ({ app, named }: { app: AppState; named: boolean }) => {
  const text = `${named ? `${app.name}: ` : ''}${app.sync} / ${app.health}`;
  if (app.sync === 'Synced' && app.health === 'Healthy') {
    return <StatusOK>{text}</StatusOK>;
  }
  if (app.health === 'Degraded' || app.health === 'Missing') {
    return <StatusError>{text}</StatusError>;
  }
  if (app.health === 'Progressing') {
    return <StatusPending>{text}</StatusPending>;
  }
  return <StatusWarning>{text}</StatusWarning>;
};

export const PlatformStatus = () => {
  const catalogApi = useApi(catalogApiRef);
  const argoApi = useApi(argoCDApiRef);
  const [rows, setRows] = useState<Row[]>();
  const [error, setError] = useState<Error>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { items } = await catalogApi.getEntities({
        filter: { kind: 'Component', 'spec.system': 'platform-lab' },
        fields: ['kind', 'metadata', 'spec.type'],
      });
      const result = await Promise.all(
        items.map(async (entity): Promise<Row> => {
          const annotations = entity.metadata.annotations ?? {};
          const appName = annotations[ARGOCD_ANNOTATION_APP_NAME];
          const appSelector = annotations[ARGOCD_ANNOTATION_APP_SELECTOR];
          if (!appName && !appSelector) {
            return { entity };
          }
          const label = appName ?? appSelector;
          try {
            // Same lookups as the plugin's overview card when appLocatorMethods is set.
            const instances = await argoApi.serviceLocatorUrl(
              appName ? { appName } : { appSelector },
            );
            if (instances instanceof Error || instances.length === 0) {
              return { entity, apps: [unknown(label)] };
            }
            const instance = instances[0].name;
            const found = appName
              ? [await argoApi.getAppDetails({ url: '', appName, instance })]
              : (
                  await argoApi.getAppListDetails({
                    url: '',
                    appSelector: appSelector!,
                    instance,
                  })
                ).items ?? [];
            const apps = found
              .map(app => ({
                name: app.metadata.name,
                sync: app.status?.sync?.status ?? 'Unknown',
                health: app.status?.health?.status ?? 'Unknown',
              }))
              .sort((a, b) => a.name.localeCompare(b.name));
            return { entity, apps: apps.length ? apps : [unknown(label)] };
          } catch {
            return { entity, apps: [unknown(label)] };
          }
        }),
      );
      if (!cancelled) {
        setRows(
          result.sort((a, b) =>
            a.entity.metadata.name.localeCompare(b.entity.metadata.name),
          ),
        );
      }
    })().catch(e => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [catalogApi, argoApi]);

  if (error) {
    return <WarningPanel title="Could not load the platform status" message={error.message} />;
  }
  if (!rows) {
    return <Progress />;
  }

  const columns: TableColumn<Row>[] = [
    {
      title: 'Component',
      render: row => <EntityRefLink entityRef={row.entity} />,
    },
    {
      title: 'Argo CD',
      render: row => {
        if (!row.apps) {
          return <>not managed by Argo CD</>;
        }
        // One line per Application; the name only when there are several (environments).
        return row.apps.map(app => (
          <div key={app.name}>
            <AppStatus app={app} named={row.apps!.length > 1} />
          </div>
        ));
      },
    },
  ];

  return (
    <Table<Row>
      options={{ paging: false, search: false, toolbar: false, padding: 'dense' }}
      columns={columns}
      data={rows}
    />
  );
};
