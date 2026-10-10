/*
 * Is stg actually running the release we are about to promote, and running it well?
 * Asked by platform-lab:app:promote (scaffolderPromote.ts) before it opens the pull request:
 *
 * - Argo CD: <app>-stg is Synced and Healthy, runs the release's image, and was last deployed
 *   at least `soakMinutes` ago (the release had time to show problems);
 * - Alertmanager: no warning or critical alert is firing in namespace app-<app>-stg.
 *
 * Git says what stg should run; this checks what it does run. A check that can't be made
 * (Argo CD or Alertmanager unreachable) is a problem too: promotion fails closed.
 */
import type { Config } from '@backstage/config';

export type StgHealthOptions = {
  /** Argo CD API (the read-only `backstage` account of the Argo CD plugin). */
  argocd: { url: string; token: string };
  /** Alertmanager API, e.g. http://kube-prometheus-stack-alertmanager.monitoring.svc:9093. */
  alertmanagerUrl?: string;
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
