import { useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';

/** GET /api/dora/metrics (packages/backend/src/plugins/dora). */
export type DoraMetrics = {
  windowDays: number;
  services: number;
  deploys: number;
  deploysPerWeek: number;
  leadTimeHours: number | null;
  failedDeploys: number;
  changeFailureRate: number | null;
  failures: number;
  timeToRestoreHours: number | null;
};

export type RecentDeploy = {
  revision: string;
  deployedAt: string;
  kind: string;
  title: string;
};

/** GET /api/dora/<path> as JSON, reloaded when `path` changes. */
export function useDora<T>(path: string) {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const base = await discoveryApi.getBaseUrl('dora');
      const response = await fetchApi.fetch(`${base}/${path}`);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return (await response.json()) as T;
    })()
      .then(result => !cancelled && setData(result))
      .catch(e => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [discoveryApi, fetchApi, path]);

  return { data, error };
}

export const formatHours = (value: number | null) => {
  if (value === null) return '-';
  if (value < 1) return `${Math.round(value * 60)} min`;
  if (value < 48) return `${value.toFixed(1)} h`;
  return `${(value / 24).toFixed(1)} days`;
};

export const formatRate = (value: number | null) =>
  value === null ? '-' : `${Math.round(value * 100)}%`;

/** The four metrics as label/value/explanation, for the card and the widget. */
export const describeMetrics = (m: DoraMetrics) => [
  {
    label: 'Deployment frequency',
    value: `${m.deploysPerWeek.toFixed(1)} / week`,
    help: `${m.deploys} release deploys to prd${
      m.services > 1 ? `, per service (${m.services})` : ''
    }`,
  },
  {
    label: 'Lead time for changes',
    value: formatHours(m.leadTimeHours),
    help: 'median, from landing in stg to running in prd',
  },
  {
    label: 'Change failure rate',
    value: formatRate(m.changeFailureRate),
    help: `${m.failedDeploys} of ${m.deploys} followed by a rollback, hotfix or critical alert within 24 h`,
  },
  {
    label: 'Time to restore',
    value: formatHours(m.timeToRestoreHours),
    help: `median over ${m.failures} prd failure${m.failures === 1 ? '' : 's'}`,
  },
];
