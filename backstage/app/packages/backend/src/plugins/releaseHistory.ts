/*
 * History of a file on GitHub, through the REST API with the GitHub integration's token
 * (integrations.github): the earlier versions of a release.yaml (rollback) and when it last
 * changed (how long prd has been behind stg, techInsightsPlatformLab.ts).
 */
import type { Config } from '@backstage/config';
import { ScmIntegrations } from '@backstage/integration';

export type FileVersion = { sha: string; date: string; text: string };

export class GithubFileHistory {
  static fromConfig(config: Config, fetchImpl: typeof fetch = fetch) {
    const token =
      ScmIntegrations.fromConfig(config).github.byHost('github.com')?.config
        .token;
    return new GithubFileHistory(token, fetchImpl);
  }

  constructor(
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get(url: string, accept: string) {
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: accept,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub ${url}: ${response.status} ${response.statusText}`,
      );
    }
    return response;
  }

  /** Commits that changed `path` on `ref`, newest first. */
  async commits(repo: string, path: string, ref = 'main', limit = 20) {
    const query = new URLSearchParams({
      path,
      sha: ref,
      per_page: String(limit),
    });
    const response = await this.get(
      `https://api.github.com/repos/${repo}/commits?${query}`,
      'application/vnd.github+json',
    );
    const commits = (await response.json()) as Array<{
      sha: string;
      commit: { committer?: { date?: string }; author?: { date?: string } };
    }>;
    return commits.map(c => ({
      sha: c.sha,
      date: c.commit.committer?.date ?? c.commit.author?.date ?? '',
    }));
  }

  /** `path` as it was at commit `sha`. */
  async contentAt(repo: string, path: string, sha: string) {
    const response = await this.get(
      `https://api.github.com/repos/${repo}/contents/${path}?ref=${sha}`,
      'application/vnd.github.raw+json',
    );
    return response.text();
  }

  /** When `path` last changed on `ref`, or undefined if it never did. */
  async lastChanged(repo: string, path: string, ref = 'main') {
    return (await this.commits(repo, path, ref, 1))[0]?.date;
  }

  /** Versions of `path` on `ref`, newest (current) first; fetched lazily. */
  async *versions(
    repo: string,
    path: string,
    ref = 'main',
  ): AsyncGenerator<FileVersion> {
    for (const { sha, date } of await this.commits(repo, path, ref)) {
      yield { sha, date, text: await this.contentAt(repo, path, sha) };
    }
  }
}
