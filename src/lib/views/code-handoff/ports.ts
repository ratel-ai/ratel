/**
 * What code handoff needs from GitHub (RC-862), as an installation of the
 * Ratel GitHub App sees it. `github/client.ts` is the real adapter;
 * `fake-github.ts` is the in-memory one for tests.
 */

export interface GitHubRepo {
  id: number;
  owner: string;
  name: string;
  /** `owner/name`. */
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface RepoRef {
  owner: string;
  name: string;
}

export interface NewIssue extends RepoRef {
  title: string;
  body: string;
  labels?: string[];
}

export interface CreatedIssue {
  id: number;
  number: number;
  url: string;
}

export interface CodeSearchHit {
  path: string;
  url: string;
}

export interface GitHubPort {
  /**
   * Trade the `code` of GitHub's user authorization redirect for a user
   * access token, or null when GitHub refuses it. The caller uses the token
   * once and drops it: never store or log it.
   */
  exchangeUserCode(code: string): Promise<string | null>;
  /** The ids of the App's installations this user can reach (`GET /user/installations`, every page). */
  listUserInstallations(userToken: string): Promise<number[]>;
  /** Every repo the installation can reach. */
  listInstallationRepos(installationId: number): Promise<GitHubRepo[]>;
  /** One repo, or null when the installation cannot reach it. */
  getRepo(installationId: number, repo: RepoRef): Promise<GitHubRepo | null>;
  createIssue(installationId: number, issue: NewIssue): Promise<CreatedIssue>;
  /** Files of one repo that match `query` (GitHub code search syntax, without the `repo:` qualifier). */
  searchCode(installationId: number, repo: RepoRef, query: string): Promise<CodeSearchHit[]>;
  /** A file's text at `ref` (the default branch when absent), or null when it does not exist. */
  readFile(
    installationId: number,
    repo: RepoRef & { path: string; ref?: string },
  ): Promise<string | null>;
}
