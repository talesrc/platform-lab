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
  argoCDApiRef,
} from '@roadiehq/backstage-plugin-argo-cd';

type Row = {
  entity: Entity;
  appName?: string;
  sync?: string;
  health?: string;
};

/**
 * Live state of the platform: every component of System platform-lab, with the Argo CD
 * sync and health of the app named in its argocd/app-name annotation. It reuses the Argo CD
 * plugin's API (same backend route and read-only token as the entity pages); components
 * outside Argo CD (e.g. Argo CD itself, the registry caches) show "not managed by Argo CD".
 */
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
          const appName = entity.metadata.annotations?.[ARGOCD_ANNOTATION_APP_NAME];
          if (!appName) {
            return { entity };
          }
          try {
            // Same lookup as the plugin's overview card when appLocatorMethods is set.
            const instances = await argoApi.serviceLocatorUrl({ appName });
            if (instances instanceof Error || instances.length === 0) {
              return { entity, appName, sync: 'Unknown', health: 'Unknown' };
            }
            const app = await argoApi.getAppDetails({
              url: '',
              appName,
              instance: instances[0].name,
            });
            return {
              entity,
              appName,
              sync: app.status?.sync?.status ?? 'Unknown',
              health: app.status?.health?.status ?? 'Unknown',
            };
          } catch {
            return { entity, appName, sync: 'Unknown', health: 'Unknown' };
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
        if (!row.appName) {
          return <>not managed by Argo CD</>;
        }
        const text = `${row.sync} / ${row.health}`;
        if (row.sync === 'Synced' && row.health === 'Healthy') {
          return <StatusOK>{text}</StatusOK>;
        }
        if (row.health === 'Degraded' || row.health === 'Missing') {
          return <StatusError>{text}</StatusError>;
        }
        if (row.health === 'Progressing') {
          return <StatusPending>{text}</StatusPending>;
        }
        return <StatusWarning>{text}</StatusWarning>;
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
