import { Progress, WarningPanel } from '@backstage/core-components';
import Typography from '@material-ui/core/Typography';
import { DoraMetrics, useDora } from './api';
import { MetricTiles } from './MetricTiles';

const DAYS = 30;

/** DORA metrics across all golden-path services (home page). */
export const DoraWidget = () => {
  const { data, error } = useDora<{ overall: DoraMetrics }>(
    `metrics?days=${DAYS}`,
  );

  if (error) {
    return (
      <WarningPanel
        title="Could not load the DORA metrics"
        message={error.message}
      />
    );
  }
  if (!data) {
    return <Progress />;
  }
  return (
    <>
      <MetricTiles metrics={data.overall} />
      <Typography
        variant="caption"
        color="textSecondary"
        component="p"
        style={{ marginTop: 12 }}
      >
        prd, last {DAYS} days, all golden-path services. They describe the
        delivery system, never individuals; with a couple of services they show
        the pipeline working rather than a trend.
      </Typography>
    </>
  );
};
