import {
  InfoCard,
  Progress,
  Table,
  TableColumn,
  WarningPanel,
} from '@backstage/core-components';
import { useEntity } from '@backstage/plugin-catalog-react';
import Typography from '@material-ui/core/Typography';
import { DoraMetrics, RecentDeploy, useDora } from './api';
import { MetricTiles } from './MetricTiles';

const DAYS = 30;

const columns: TableColumn<RecentDeploy>[] = [
  {
    title: 'Deployed',
    render: row => new Date(row.deployedAt).toLocaleString(),
  },
  { title: 'Kind', field: 'kind' },
  { title: 'Change', field: 'title' },
  { title: 'Revision', render: row => row.revision.slice(0, 7) },
];

/**
 * DORA metrics of a golden-path service over the last 30 days, with its recent prd deploys
 * (packages/backend/src/plugins/dora).
 */
export const DoraCard = () => {
  const { entity } = useEntity();
  const { data, error } = useDora<{
    metrics: DoraMetrics;
    recentDeploys: RecentDeploy[];
  }>(`metrics/${encodeURIComponent(entity.metadata.name)}?days=${DAYS}`);

  return (
    <InfoCard
      title="Delivery (DORA)"
      subheader={`prd, last ${DAYS} days: how the delivery system performs, not people`}
    >
      {error && (
        <WarningPanel
          title="Could not load the DORA metrics"
          message={error.message}
        />
      )}
      {!error && !data && <Progress />}
      {data && (
        <>
          <MetricTiles metrics={data.metrics} />
          {data.recentDeploys.length ? (
            <Table<RecentDeploy>
              title="Recent prd deploys"
              options={{
                paging: false,
                search: false,
                padding: 'dense',
              }}
              columns={columns}
              data={data.recentDeploys}
            />
          ) : (
            <Typography variant="body2" style={{ marginTop: 16 }}>
              No prd deploys recorded yet.
            </Typography>
          )}
        </>
      )}
    </InfoCard>
  );
};
