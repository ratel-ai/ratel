import type { CodeSearchHit, CreatedIssue, GitHubPort, GitHubRepo, RepoRef } from "../ports";
import { GITHUB_API_BASE, githubHeaders, type InstallationTokens } from "./app-auth";

/**
 * The real `GitHubPort`, over `fetch` with installation tokens. A 401 drops
 * the cached token and retries once with a fresh one. Errors carry the method,
 * the path and the status, never a token or a response body.
 */

export interface GitHubClientDeps {
  tokens: InstallationTokens;
  /** The App's OAuth client, to trade a user's authorization `code` for a user token. */
  oauthClient: { clientId: string; clientSecret: string };
  fetch: typeof fetch;
  apiBase?: string;
  oauthBase?: string;
}

interface ApiRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  owner: { login: string };
}

const PAGE_SIZE = 100;
/** Enough for any installation or user we expect; a larger one is cut here rather than looping forever. */
const MAX_REPO_PAGES = 20;
const RAW_ACCEPT = "application/vnd.github.raw+json";
const GITHUB_OAUTH_BASE = "https://github.com";

export function createGitHubClient(deps: GitHubClientDeps): GitHubPort {
  const apiBase = deps.apiBase ?? GITHUB_API_BASE;
  const oauthBase = deps.oauthBase ?? GITHUB_OAUTH_BASE;

  async function call(
    installationId: number,
    method: string,
    path: string,
    init: { body?: unknown; accept?: string } = {},
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = githubHeaders(await deps.tokens.get(installationId));
      if (init.accept) headers.Accept = init.accept;
      if (init.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await deps.fetch(`${apiBase}${path}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (response.status !== 401 || attempt === 1) return response;
      deps.tokens.forget(installationId);
    }
    throw new Error("unreachable");
  }

  async function json<T>(
    installationId: number,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await call(installationId, method, path, { body });
    if (!response.ok) throw requestError(method, path, response.status);
    return (await response.json()) as T;
  }

  return {
    async exchangeUserCode(code) {
      const response = await deps.fetch(`${oauthBase}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "ratel-cloud",
        },
        body: JSON.stringify({
          client_id: deps.oauthClient.clientId,
          client_secret: deps.oauthClient.clientSecret,
          code,
        }),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { access_token?: unknown };
      return typeof body.access_token === "string" && body.access_token ? body.access_token : null;
    },
    async listUserInstallations(userToken) {
      const ids: number[] = [];
      for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const path = `/user/installations?per_page=${PAGE_SIZE}&page=${page}`;
        const response = await deps.fetch(`${apiBase}${path}`, {
          method: "GET",
          headers: githubHeaders(userToken),
        });
        if (!response.ok) throw requestError("GET", path, response.status);
        const body = (await response.json()) as {
          total_count: number;
          installations: { id: number }[];
        };
        ids.push(...body.installations.map((installation) => installation.id));
        if (body.installations.length < PAGE_SIZE || ids.length >= body.total_count) break;
      }
      return ids;
    },
    async listInstallationRepos(installationId) {
      const repos: GitHubRepo[] = [];
      for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const body = await json<{ total_count: number; repositories: ApiRepo[] }>(
          installationId,
          "GET",
          `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
        );
        repos.push(...body.repositories.map(toRepo));
        if (body.repositories.length < PAGE_SIZE || repos.length >= body.total_count) break;
      }
      return repos;
    },
    async getRepo(installationId, ref) {
      const path = `/repos/${repoPath(ref)}`;
      const response = await call(installationId, "GET", path);
      if (response.status === 404) return null;
      if (!response.ok) throw requestError("GET", path, response.status);
      return toRepo((await response.json()) as ApiRepo);
    },
    async createIssue(installationId, issue): Promise<CreatedIssue> {
      const body = await json<{ id: number; number: number; html_url: string }>(
        installationId,
        "POST",
        `/repos/${repoPath(issue)}/issues`,
        {
          title: issue.title,
          body: issue.body,
          ...(issue.labels?.length ? { labels: issue.labels } : {}),
        },
      );
      return { id: body.id, number: body.number, url: body.html_url };
    },
    async searchCode(installationId, ref, query): Promise<CodeSearchHit[]> {
      const q = encodeURIComponent(`${query} repo:${ref.owner}/${ref.name}`);
      const body = await json<{ items: { path: string; html_url: string }[] }>(
        installationId,
        "GET",
        `/search/code?q=${q}&per_page=${PAGE_SIZE}`,
      );
      return body.items.map((item) => ({ path: item.path, url: item.html_url }));
    },
    async readFile(installationId, ref) {
      const filePath = ref.path.split("/").map(encodeURIComponent).join("/");
      const query = ref.ref ? `?ref=${encodeURIComponent(ref.ref)}` : "";
      const path = `/repos/${repoPath(ref)}/contents/${filePath}${query}`;
      const response = await call(installationId, "GET", path, { accept: RAW_ACCEPT });
      if (response.status === 404) return null;
      if (!response.ok) throw requestError("GET", path, response.status);
      return response.text();
    },
  };
}

function toRepo(repo: ApiRepo): GitHubRepo {
  return {
    id: repo.id,
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    private: repo.private,
  };
}

function repoPath(ref: RepoRef): string {
  return `${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
}

function requestError(method: string, path: string, status: number): Error {
  return new Error(`github ${method} ${path.split("?")[0]} failed with status ${status}`);
}
