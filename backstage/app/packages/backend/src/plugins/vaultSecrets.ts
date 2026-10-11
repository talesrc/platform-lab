/*
 * App secrets in Vault, seen through their metadata only: whether each one exists, its
 * version and when it was last written. Golden-path apps keep one Vault secret per env var at
 * secret/apps/<name>/<env>/<ENV_VAR> (charts/app: secretEnv), so metadata answers "is it
 * there, and how old is it" per env var. Backstage's Vault role (backstage-secret-metadata,
 * terraform/platform-access) allows LIST and read on secret/metadata/apps/* and nothing else:
 * it can't read a value.
 *
 * Backstage logs in with Vault's Kubernetes auth method, presenting a service-account token
 * for the `vault` audience that the kubelet projects into the pod and keeps fresh
 * (gitops/platform/backstage.yaml).
 */
import type { Config } from '@backstage/config';
import { promises as fs } from 'node:fs';
import { ENVIRONMENTS, type Environment } from './releases';

export type VaultOptions = {
  /** Vault API, e.g. http://vault.vault.svc:8200. */
  url: string;
  /** KV v2 mount holding apps/ (secret). */
  mount: string;
  /** Kubernetes auth role of Backstage. */
  role: string;
  /** Projected service-account token for the `vault` audience. */
  tokenPath: string;
  /** Vault UI, for links people follow to write a value. */
  uiUrl?: string;
  fetch?: typeof fetch;
  readToken?: (path: string) => Promise<string>;
  now?: () => Date;
};

/**
 * - present: the current version exists;
 * - deleted: the path exists but its current version is deleted or destroyed (External
 *   Secrets can't read it, the app can't start);
 * - missing: nothing at that path.
 */
export type SecretStatus = 'present' | 'deleted' | 'missing';

export type SecretState = {
  name: string;
  status: SecretStatus;
  version?: number;
  /** When the current version was written (ISO 8601). */
  updatedTime?: string;
};

type KvMetadata = {
  current_version?: number;
  updated_time?: string;
  versions?: Record<
    string,
    { created_time?: string; deletion_time?: string; destroyed?: boolean }
  >;
};

const APP = /^[a-z]([-a-z0-9]{0,30}[a-z0-9])?$/;
const ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Vault settings from app-config (platformLab.vault); undefined when not configured. */
export function vaultOptionsFromConfig(
  config: Config,
): VaultOptions | undefined {
  const vault = config.getOptionalConfig('platformLab.vault');
  if (!vault) return undefined;
  return {
    url: vault.getString('url').replace(/\/$/, ''),
    mount: vault.getOptionalString('mount') ?? 'secret',
    role: vault.getOptionalString('role') ?? 'backstage',
    tokenPath:
      vault.getOptionalString('tokenPath') ?? '/var/run/secrets/vault/token',
    uiUrl: vault.getOptionalString('uiUrl')?.replace(/\/$/, ''),
  };
}

/** Vault path of an app's secrets in an environment, under the KV mount: apps/<app>/<env>. */
export function secretsPath(app: string, env: Environment): string {
  if (!APP.test(app) || !ENVIRONMENTS.includes(env)) {
    throw new Error(`not a golden-path app and environment: ${app}, ${env}`);
  }
  return `apps/${app}/${env}`;
}

/** Vault UI page listing an app's secrets in an environment. */
export function secretsUiUrl(
  options: Pick<VaultOptions, 'uiUrl' | 'mount'>,
  app: string,
  env: Environment,
): string | undefined {
  return options.uiUrl
    ? `${options.uiUrl}/ui/vault/secrets/${options.mount}/kv/list/${secretsPath(
        app,
        env,
      )}/`
    : undefined;
}

export class VaultMetadataClient {
  private token?: { value: string; expiresAt: number };

  constructor(readonly options: VaultOptions) {}

  private get fetch() {
    return this.options.fetch ?? fetch;
  }

  private now() {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  /** A Vault token, logging in again a minute before the current one expires. */
  private async login(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60_000) {
      return this.token.value;
    }
    const jwt = (
      await (this.options.readToken ?? (p => fs.readFile(p, 'utf8')))(
        this.options.tokenPath,
      )
    ).trim();
    const response = await this.fetch(
      `${this.options.url}/v1/auth/kubernetes/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: this.options.role, jwt }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Vault login as ${this.options.role} failed: ${response.status} ${response.statusText}`,
      );
    }
    const { auth } = (await response.json()) as {
      auth: { client_token: string; lease_duration: number };
    };
    this.token = {
      value: auth.client_token,
      expiresAt: this.now() + auth.lease_duration * 1000,
    };
    return this.token.value;
  }

  /** GET a path under the KV mount's metadata; undefined on 404. */
  private async get<T>(path: string): Promise<T | undefined> {
    const response = await this.fetch(
      `${this.options.url}/v1/${this.options.mount}/metadata/${path}`,
      { headers: { 'X-Vault-Token': await this.login() } },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `Vault ${this.options.mount}/metadata/${path}: ${response.status} ${response.statusText}`,
      );
    }
    return ((await response.json()) as { data: T }).data;
  }

  /** Names of the secrets stored for an app in an environment. */
  async list(app: string, env: Environment): Promise<string[]> {
    const data = await this.get<{ keys?: string[] }>(
      `${secretsPath(app, env)}/?list=true`,
    );
    // Folders (ending in /) aren't env vars.
    return (data?.keys ?? []).filter(key => ENV_VAR.test(key)).sort();
  }

  /** State of one secret, from its metadata. */
  async state(
    app: string,
    env: Environment,
    name: string,
  ): Promise<SecretState> {
    if (!ENV_VAR.test(name)) {
      throw new Error(`not an env var name: ${name}`);
    }
    const metadata = await this.get<KvMetadata>(
      `${secretsPath(app, env)}/${name}`,
    );
    if (!metadata?.current_version) return { name, status: 'missing' };
    const current = metadata.versions?.[String(metadata.current_version)];
    const gone = Boolean(current?.deletion_time) || Boolean(current?.destroyed);
    return {
      name,
      status: gone ? 'deleted' : 'present',
      version: metadata.current_version,
      updatedTime: current?.created_time ?? metadata.updated_time,
    };
  }

  /**
   * States of the secrets an environment needs (`names`) and of any other secret stored
   * there, sorted by name.
   */
  async states(
    app: string,
    env: Environment,
    names: string[],
  ): Promise<SecretState[]> {
    const all = [...new Set([...names, ...(await this.list(app, env))])].sort();
    return Promise.all(all.map(name => this.state(app, env, name)));
  }

  /**
   * Problems that should stop deploying a release that needs `names` from Vault to `env`:
   * each secret that is missing or deleted. Fails closed: an unreadable Vault is a problem.
   */
  async check(
    app: string,
    env: Environment,
    names: string[],
  ): Promise<string[]> {
    if (names.length === 0) return [];
    try {
      const states = await Promise.all(
        names.map(name => this.state(app, env, name)),
      );
      return states
        .filter(s => s.status !== 'present')
        .map(
          s =>
            `${s.name} is ${s.status} in Vault (${
              this.options.mount
            }/${secretsPath(app, env)}/${s.name}, field value)`,
        );
    } catch (error) {
      return [`could not read ${env}'s secrets from Vault (${error})`];
    }
  }
}

/** Whole days since a secret was last written (0 when unknown). */
export function ageInDays(state: SecretState, now = new Date()): number {
  if (!state.updatedTime) return 0;
  return Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(state.updatedTime)) / 86_400_000),
  );
}
