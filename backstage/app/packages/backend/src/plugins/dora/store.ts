/*
 * prd deploys and prd incidents, in the dora plugin's own schema of the backstage database
 * (backend.database.pluginDivisionMode: schema).
 */
import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { DeployKind } from './classify';
import type { Deploy, Incident } from './metrics';

export type StoredDeploy = Deploy & {
  /** argocd: from the deploy webhook; git: backfilled from the release file's history. */
  source: 'argocd' | 'git';
  message: string;
};

type DeployRow = {
  app: string;
  revision: string;
  deployed_at: Date | string;
  kind: string;
  stg_landed_at: Date | string | null;
  source: string;
  message: string;
};

type IncidentRow = {
  app: string;
  fingerprint: string;
  alertname: string;
  started_at: Date | string;
  resolved_at: Date | string | null;
};

type Knex = Awaited<ReturnType<DatabaseService['getClient']>>;

const date = (value: Date | string) => new Date(value);

export class DoraStore {
  static async create(knex: Knex) {
    if (!(await knex.schema.hasTable('deploys'))) {
      await knex.schema.createTable('deploys', table => {
        table.string('app').notNullable();
        // The commit on main Argo CD deployed (a pull request's merge commit).
        table.string('revision').notNullable();
        table.timestamp('deployed_at', { useTz: true }).notNullable();
        table.string('kind').notNullable();
        table.timestamp('stg_landed_at', { useTz: true }).nullable();
        table.string('source').notNullable();
        table.text('message').notNullable();
        table.primary(['app', 'revision']);
      });
    }
    if (!(await knex.schema.hasTable('incidents'))) {
      await knex.schema.createTable('incidents', table => {
        table.string('app').notNullable();
        table.string('fingerprint').notNullable();
        table.string('alertname').notNullable();
        table.timestamp('started_at', { useTz: true }).notNullable();
        table.timestamp('resolved_at', { useTz: true }).nullable();
        table.primary(['fingerprint', 'started_at']);
      });
    }
    return new DoraStore(knex);
  }

  private constructor(private readonly knex: Knex) {}

  /**
   * Records a deploy. The webhook's deploy time wins over a backfilled one (git only knows when
   * the change merged, not when Argo CD synced it); a backfill never overwrites the webhook.
   */
  async addDeploy(deploy: StoredDeploy) {
    const row: DeployRow = {
      app: deploy.app,
      revision: deploy.revision,
      deployed_at: deploy.deployedAt,
      kind: deploy.kind,
      stg_landed_at: deploy.stgLandedAt ?? null,
      source: deploy.source,
      message: deploy.message,
    };
    const insert = this.knex<DeployRow>('deploys')
      .insert(row)
      .onConflict(['app', 'revision']);
    await (deploy.source === 'argocd' ? insert.merge() : insert.ignore());
  }

  async hasDeploy(app: string, revision: string) {
    return Boolean(
      await this.knex<DeployRow>('deploys')
        .where({ app, revision })
        .first('revision'),
    );
  }

  async deploys(app?: string): Promise<StoredDeploy[]> {
    const rows = await this.knex<DeployRow>('deploys')
      .where(app ? { app } : {})
      .orderBy('deployed_at');
    return rows.map(row => ({
      app: row.app,
      revision: row.revision,
      deployedAt: date(row.deployed_at),
      kind: row.kind as DeployKind,
      stgLandedAt: row.stg_landed_at ? date(row.stg_landed_at) : undefined,
      source: row.source as StoredDeploy['source'],
      message: row.message,
    }));
  }

  /** Records a firing alert, or resolves it; Alertmanager repeats both, so this is idempotent. */
  async recordAlert(alert: {
    app: string;
    fingerprint: string;
    alertname: string;
    startedAt: Date;
    resolvedAt?: Date;
  }) {
    await this.knex<IncidentRow>('incidents')
      .insert({
        app: alert.app,
        fingerprint: alert.fingerprint,
        alertname: alert.alertname,
        started_at: alert.startedAt,
        resolved_at: alert.resolvedAt ?? null,
      })
      .onConflict(['fingerprint', 'started_at'])
      .merge(alert.resolvedAt ? ['resolved_at'] : ['alertname']);
  }

  async incidents(app?: string): Promise<Incident[]> {
    const rows = await this.knex<IncidentRow>('incidents')
      .where(app ? { app } : {})
      .orderBy('started_at');
    return rows.map(row => ({
      app: row.app,
      startedAt: date(row.started_at),
      resolvedAt: row.resolved_at ? date(row.resolved_at) : undefined,
    }));
  }

  /** Apps with any deploy or incident recorded. */
  async apps(): Promise<string[]> {
    const rows = await this.knex
      .select('app')
      .from('deploys')
      .union(qb => qb.select('app').from('incidents'));
    return [...new Set(rows.map((r: { app: string }) => r.app))].sort();
  }
}
