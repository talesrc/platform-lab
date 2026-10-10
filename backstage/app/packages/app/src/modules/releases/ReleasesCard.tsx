import { useEffect, useState } from 'react';
import {
  InfoCard,
  LinkButton,
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
import { stringifyEntityRef } from '@backstage/catalog-model';
import { useEntity } from '@backstage/plugin-catalog-react';
import {
  ARGOCD_ANNOTATION_APP_SELECTOR,
  argoCDApiRef,
} from '@roadiehq/backstage-plugin-argo-cd';
import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';

// Promotion order (the apps ApplicationSet); other environments sort last.
const ENVIRONMENTS = ['stg', 'prd'];

type Row = {
  env: string;
  app: string;
  images: string[];
  sync: string;
  health: string;
  deployedAt?: string;
  revision?: string;
};

// Fields the Argo CD API returns beyond the plugin's typed subset.
type ArgoApp = {
  metadata: { name: string; labels?: Record<string, string> };
  status?: {
    sync?: { status?: string };
    health?: { status?: string };
    summary?: { images?: string[] };
    history?: Array<{ deployedAt?: string; revision?: string }>;
  };
};

const envOf = (app: ArgoApp) =>
  app.metadata.labels?.['platform-lab/environment'] ??
  app.metadata.name.split('-').pop() ??
  '';

const ago = (iso?: string) => {
  if (!iso) return '-';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  if (minutes < 48 * 60) return rtf.format(-Math.round(minutes / 60), 'hour');
  return rtf.format(-Math.round(minutes / 1440), 'day');
};

const Status = ({ row }: { row: Row }) => {
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
};

const templateLink = (template: string, entityRef: string) =>
  `/create/templates/default/${template}?formData=${encodeURIComponent(
    JSON.stringify({ app: entityRef }),
  )}`;

/**
 * What runs where for a golden-path app: one row per environment (the Argo CD Applications
 * matching argocd/app-selector), with the running image, sync/health and the last deploy,
 * plus the release templates for this service.
 */
export const ReleasesCard = () => {
  const { entity } = useEntity();
  const argoApi = useApi(argoCDApiRef);
  const [rows, setRows] = useState<Row[]>();
  const [error, setError] = useState<Error>();
  const appSelector =
    entity.metadata.annotations?.[ARGOCD_ANNOTATION_APP_SELECTOR] ?? '';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const instances = await argoApi.serviceLocatorUrl({ appSelector });
      if (instances instanceof Error) throw instances;
      if (instances.length === 0) return [];
      const { items } = await argoApi.getAppListDetails({
        url: '',
        appSelector,
        instance: instances[0].name,
      });
      return ((items ?? []) as unknown as ArgoApp[]).map(app => {
        const last = app.status?.history?.at(-1);
        return {
          env: envOf(app),
          app: app.metadata.name,
          images: app.status?.summary?.images ?? [],
          sync: app.status?.sync?.status ?? 'Unknown',
          health: app.status?.health?.status ?? 'Unknown',
          deployedAt: last?.deployedAt,
          revision: last?.revision?.slice(0, 7),
        };
      });
    })()
      .then(result => {
        if (cancelled) return;
        const rank = (env: string) =>
          ENVIRONMENTS.includes(env) ? ENVIRONMENTS.indexOf(env) : 99;
        setRows(result.sort((a, b) => rank(a.env) - rank(b.env)));
      })
      .catch(e => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [argoApi, appSelector]);

  const columns: TableColumn<Row>[] = [
    { title: 'Environment', field: 'env' },
    {
      title: 'Image',
      render: row =>
        row.images.map(image => (
          <div key={image}>{image.split('/').pop()}</div>
        )),
    },
    { title: 'Argo CD', render: row => <Status row={row} /> },
    {
      title: 'Deployed',
      render: row => (
        <span title={row.deployedAt}>
          {ago(row.deployedAt)}
          {row.revision ? ` (${row.revision})` : ''}
        </span>
      ),
    },
  ];

  const stg = rows?.find(r => r.env === 'stg');
  const prd = rows?.find(r => r.env === 'prd');
  const sameImages = stg && prd && stg.images.join() === prd.images.join();
  const entityRef = stringifyEntityRef(entity);

  return (
    <InfoCard
      title="Releases"
      subheader="What runs in each environment (Argo CD)"
    >
      {error && (
        <WarningPanel
          title="Could not load the releases"
          message={error.message}
        />
      )}
      {!error && !rows && <Progress />}
      {rows && (
        <>
          <Table<Row>
            options={{
              paging: false,
              search: false,
              toolbar: false,
              padding: 'dense',
            }}
            columns={columns}
            data={rows}
          />
          {stg && prd && (
            <Typography variant="body2" style={{ marginTop: 8 }}>
              {sameImages
                ? 'prd runs the same image as stg (release config may still differ: see the "prd keeps up with stg" check).'
                : 'prd runs a different image than stg.'}
            </Typography>
          )}
        </>
      )}
      <Box display="flex" flexWrap="wrap" mt={2} style={{ gap: 12 }}>
        <LinkButton
          variant="contained"
          color="primary"
          to={templateLink('promote-app', entityRef)}
        >
          Promote stg to prd
        </LinkButton>
        <LinkButton
          variant="outlined"
          to={templateLink('rollback-app', entityRef)}
        >
          Roll back prd
        </LinkButton>
      </Box>
    </InfoCard>
  );
};
