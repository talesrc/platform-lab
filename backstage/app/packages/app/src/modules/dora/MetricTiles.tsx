import Box from '@material-ui/core/Box';
import Typography from '@material-ui/core/Typography';
import { describeMetrics, DoraMetrics } from './api';

/** The four DORA metrics side by side. */
export const MetricTiles = ({ metrics }: { metrics: DoraMetrics }) => (
  <Box
    display="grid"
    style={{
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      gap: 16,
    }}
  >
    {describeMetrics(metrics).map(({ label, value, help }) => (
      <Box key={label}>
        <Typography variant="overline" color="textSecondary">
          {label}
        </Typography>
        <Typography variant="h5">{value}</Typography>
        <Typography variant="caption" color="textSecondary">
          {help}
        </Typography>
      </Box>
    ))}
  </Box>
);
