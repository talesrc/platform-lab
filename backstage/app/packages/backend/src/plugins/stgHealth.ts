/*
 * Is stg actually running the release we are about to promote, and running it well?
 * Asked by platform-lab:app:promote (scaffolderPromote.ts) before it opens the pull request:
 *
 * - Argo CD: <app>-stg is Synced and Healthy, runs the release's image, and was last deployed
 *   at least `soakMinutes` ago (the release had time to show problems);
 * - Prometheus: over the last 30 minutes, stg spends none of its SLOs' error budgets faster
 *   than `maxBurnRate` (the golden-path chart's slo:* rules, charts/app/templates/slo.yaml).
 *   Burn rate = share of bad requests / error budget; 1 spends the budget exactly over 30
 *   days. No requests at all is no evidence either way and passes;
 * - Alertmanager: no warning or critical alert is firing in namespace app-<app>-stg (which
 *   includes the SLO burn-rate alerts, and catches what SLOs don't, like crash loops).
 *
 * Git says what stg should run; this checks what it does run. A check that can't be made
 * (Argo CD, Prometheus or Alertmanager unreachable) is a problem too: promotion fails closed.
 */
import type { Config } from '@backstage/config';

export type StgHealthOptions = {
  /** Argo CD API (the read-only `backstage` account of the Argo CD plugin). */
  argocd: { url: string; token: string };
  /** Alertmanager API, e.g. http://kube-prometheus-stack-alertmanager.monitoring.svc:9093. */
  alertmanagerUrl?: string;
  /** Prometheus API, e.g. http://kube-prometheus-stack-prometheus.monitoring.svc:9090. */
  prometheusUrl?: string;
  /** Highest SLO burn rate over the last 30 minutes that still allows promotion (default 1). */
  maxBurnRate?: number;
  /** Minimum time since stg's last deploy. */
  soakMinutes: number;
  fetch?: typeof fetch;
  now?: () => Date;
};

type ArgoApplication = {
  status?: {
    sync?: { status?: string };
    health?: { status?: string };
    summary?: { images?: string[] };
    history?: Array<{ deployedAt?: string }>;
  };
};

type Alert = { labels?: Record<string, string> };

type PrometheusVector = {
  data?: {
    result?: Array<{
      metric?: Record<string, string>;
      value?: [number, string];
    }>;
  };
};

/** Burn rate per SLO in a namespace, from the golden-path chart's recording rules. */
const burnRateQuery = (namespace: string) =>
  `slo:sli_error:ratio_rate30m{namespace="${namespace}"}` +
  ` / on (namespace, job, slo) slo:error_budget:ratio`;

const BLOCKING_SEVERITIES = new Set(['critical', 'warning']);

/** Promotion settings from app-config (platformLab.promotion) and the Argo CD plugin's. */
export function stgHealthOptionsFromConfig(config: Config): StgHealthOptions {
  const instance = config
    .getConfigArray('argocd.appLocatorMethods')[0]
    ?.getConfigArray('instances')[0];
  if (!instance) {
    throw new Error(
      'argocd.appLocatorMethods has no instance to check stg with',
    );
  }
  return {
    argocd: {
      url: instance.getString('url'),
      token: instance.getString('token'),
    },
    alertmanagerUrl: config.getOptionalString(
      'platformLab.promotion.alertmanagerUrl',
    ),
    prometheusUrl: config.getOptionalString(
      'platformLab.promotion.prometheusUrl',
    ),
    maxBurnRate: config.getOptionalNumber(
      'platformLab.promotion.stgMaxBurnRate',
    ),
    soakMinutes:
      config.getOptionalNumber('platformLab.promotion.stgSoakMinutes') ?? 10,
  };
}

async function getJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/**
 * Problems that should stop promoting `app` with `image` (repository:tag) from stg; empty
 * when stg is fine.
 */
export async function checkStgHealth(
  app: string,
  image: string | undefined,
  options: StgHealthOptions,
): Promise<string[]> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const name = `${app}-stg`;
  const problems: string[] = [];

  try {
    const { status = {} } = await getJson<ArgoApplication>(
      fetchImpl,
      `${options.argocd.url}/api/v1/applications/${encodeURIComponent(name)}`,
      { Authorization: `Bearer ${options.argocd.token}` },
    );
    const sync = status.sync?.status ?? 'Unknown';
    const health = status.health?.status ?? 'Unknown';
    if (sync !== 'Synced') {
      problems.push(
        `${name} is ${sync} in Argo CD: stg doesn't run what git says yet`,
      );
    }
    if (health !== 'Healthy') {
      problems.push(`${name} is ${health} in Argo CD`);
    }
    const images = status.summary?.images ?? [];
    if (image && !images.includes(image)) {
      problems.push(
        `stg runs ${images.join(', ') || 'no image'}, not ${image}`,
      );
    }
    const deployedAt = status.history?.at(-1)?.deployedAt;
    if (deployedAt && options.soakMinutes > 0) {
      const minutes = (now().getTime() - Date.parse(deployedAt)) / 60_000;
      if (minutes < options.soakMinutes) {
        problems.push(
          `stg was deployed ${Math.floor(minutes)} min ago; give it ` +
            `${options.soakMinutes} min before promoting`,
        );
      }
    }
  } catch (error) {
    problems.push(`could not read ${name} from Argo CD (${error})`);
  }

  if (options.prometheusUrl) {
    const maxBurnRate = options.maxBurnRate ?? 1;
    const query = encodeURIComponent(burnRateQuery(`app-${name}`));
    try {
      const { data } = await getJson<PrometheusVector>(
        fetchImpl,
        `${options.prometheusUrl}/api/v1/query?query=${query}`,
      );
      for (const { metric, value } of data?.result ?? []) {
        // NaN when stg had no requests in the window (0 / 0): never above the limit.
        const burnRate = Number(value?.[1]);
        if (burnRate > maxBurnRate) {
          problems.push(
            `stg spends its ${metric?.slo ?? 'SLO'} error budget ` +
              `${burnRate.toFixed(
                1,
              )}x as fast as the SLO allows over the last 30 min ` +
              `(at most ${maxBurnRate}x to promote)`,
          );
        }
      }
    } catch (error) {
      problems.push(`could not read SLO burn rates for app-${name} (${error})`);
    }
  }

  if (options.alertmanagerUrl) {
    const filter = encodeURIComponent(`namespace="app-${name}"`);
    try {
      const alerts = await getJson<Alert[]>(
        fetchImpl,
        `${options.alertmanagerUrl}/api/v2/alerts?active=true&silenced=false&inhibited=false&filter=${filter}`,
      );
      const firing = [
        ...new Set(
          alerts
            .filter(a => BLOCKING_SEVERITIES.has(a.labels?.severity ?? ''))
            .map(a => a.labels?.alertname ?? 'alert'),
        ),
      ];
      if (firing.length) {
        problems.push(`alerts firing in app-${name}: ${firing.join(', ')}`);
      }
    } catch (error) {
      problems.push(`could not read alerts for app-${name} (${error})`);
    }
  }

  return problems;
}
