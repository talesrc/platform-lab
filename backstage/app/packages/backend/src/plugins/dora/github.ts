/*
 * The commits behind prd deploys, through the GitHub REST API with the GitHub integration's
 * token (integrations.github): what a commit changed, the pull request that brought it to
 * main and when that merged, and the history of a release file (backfill, lead time).
 */
import type { Config } from '@backstage/config';
import { ScmIntegrations } from '@backstage/integration';

export type CommitInfo = {
  /** The commit on main that deployed it: the merge commit when it came from a pull request. */
  revision: string;
  /** The pull request title and the commit message. */
  message: string;
  files: string[];
  /** The revision's first parent: main before it. */
  parent?: string;
  /** When it reached main: the pull request's merge, else the commit date. */
  landedAt: Date;
};

type GithubCommit = {
  sha: string;
  commit: {
    message: string;
    committer?: { date?: string };
    author?: { date?: string };
  };
  parents?: Array<{ sha: string }>;
  files?: Array<{ filename: string }>;
};

type GithubPull = {
  title: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
};

const dateOf = (c: GithubCommit) =>
  new Date(c.commit.committer?.date ?? c.commit.author?.date ?? 0);

/** owner/repo from https://github.com/owner/repo(.git). */
export function repoOf(url: string): string | undefined {
  return /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}

export class GithubCommits {
  static fromConfig(config: Config, fetchImpl: typeof fetch = fetch) {
    const token =
      ScmIntegrations.fromConfig(config).github.byHost('github.com')?.config
        .token;
    return new GithubCommits(token, fetchImpl);
  }

  constructor(
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, accept: string) {
    const url = `https://api.github.com/repos/${path}`;
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: accept,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `GitHub ${url}: ${response.status} ${response.statusText}`,
      );
    }
    return response;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.request(path, 'application/vnd.github+json');
    if (!response.ok) {
      throw new Error(`GitHub ${path}: not found`);
    }
    return (await response.json()) as T;
  }

  /** `path` at `ref`, or undefined if it didn't exist there. */
  async fileAt(repo: string, path: string, ref: string) {
    const response = await this.request(
      `${repo}/contents/${path}?ref=${ref}`,
      'application/vnd.github.raw+json',
    );
    return response.ok ? response.text() : undefined;
  }

  /**
   * Commit `sha` as it reached main. For a pull request (its merge commit, or a commit in it)
   * the files are the whole pull request's, from the merge commit.
   */
  async describe(repo: string, sha: string): Promise<CommitInfo> {
    const [commit, pulls] = await Promise.all([
      this.get<GithubCommit>(`${repo}/commits/${sha}`),
      this.get<GithubPull[]>(`${repo}/commits/${sha}/pulls`),
    ]);
    const pull = pulls.find(p => p.merged_at && p.merge_commit_sha);
    const merge =
      pull && pull.merge_commit_sha !== sha
        ? await this.get<GithubCommit>(
            `${repo}/commits/${pull.merge_commit_sha}`,
          )
        : commit;
    return {
      revision: merge.sha,
      message: pull
        ? `${pull.title}\n\n${commit.commit.message}`
        : commit.commit.message,
      files: (merge.files ?? []).map(f => f.filename),
      parent: merge.parents?.[0]?.sha,
      landedAt: pull?.merged_at ? new Date(pull.merged_at) : dateOf(merge),
    };
  }

  /** Commits on `ref` that changed `path`, newest first, optionally only up to `until`. */
  async history(
    repo: string,
    path: string,
    options: { ref?: string; until?: Date; limit?: number } = {},
  ) {
    const query = new URLSearchParams({
      path,
      sha: options.ref ?? 'main',
      per_page: String(options.limit ?? 100),
      ...(options.until ? { until: options.until.toISOString() } : {}),
    });
    const commits = await this.get<GithubCommit[]>(`${repo}/commits?${query}`);
    return commits.map(c => ({ sha: c.sha, date: dateOf(c) }));
  }

  /** When stg's current release at `before` landed on main (lead time starts there). */
  async stgLandedAt(
    repo: string,
    app: string,
    before: Date,
  ): Promise<Date | undefined> {
    const [last] = await this.history(
      repo,
      `apps/${app}/envs/stg/release.yaml`,
      {
        until: before,
        limit: 1,
      },
    );
    return last ? (await this.describe(repo, last.sha)).landedAt : undefined;
  }
}
