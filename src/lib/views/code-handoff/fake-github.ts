import type {
  CodeSearchHit,
  CreatedIssue,
  GitHubPort,
  GitHubRepo,
  NewIssue,
  RepoRef,
} from "./ports";

/**
 * An in-memory GitHub for tests: installations own repos, repos hold files,
 * created issues are recorded. Code search matches a file when its path or
 * text contains the query.
 */

export interface FakeGitHub extends GitHubPort {
  /** A GitHub person: the `code` their authorization redirect carries and the installations they can reach. */
  addUser(user: { code: string; token: string; installationIds: number[] }): void;
  /** Every user token handed out, to check where a token went. */
  readonly tokensIssued: string[];
  addRepo(
    installationId: number,
    repo: Omit<GitHubRepo, "fullName" | "private"> & { private?: boolean },
    files?: Record<string, string>,
  ): GitHubRepo;
  removeInstallation(installationId: number): void;
  readonly issues: (NewIssue & { installationId: number } & CreatedIssue)[];
}

export function createFakeGitHub(): FakeGitHub {
  const installations = new Map<
    number,
    Map<string, { repo: GitHubRepo; files: Record<string, string> }>
  >();
  const issues: FakeGitHub["issues"] = [];
  const users = new Map<string, { token: string; installationIds: number[] }>();
  const tokensIssued: string[] = [];

  function find(installationId: number, ref: RepoRef) {
    return installations.get(installationId)?.get(`${ref.owner}/${ref.name}`.toLowerCase()) ?? null;
  }

  return {
    issues,
    tokensIssued,
    addUser(user) {
      users.set(user.code, { token: user.token, installationIds: user.installationIds });
    },
    async exchangeUserCode(code) {
      const user = users.get(code);
      if (!user) return null;
      // A code works once, as on GitHub.
      users.delete(code);
      users.set(`used:${code}`, user);
      tokensIssued.push(user.token);
      return user.token;
    },
    async listUserInstallations(userToken) {
      const user = [...users.values()].find((candidate) => candidate.token === userToken);
      return user ? user.installationIds.filter((id) => installations.has(id)) : [];
    },
    addRepo(installationId, input, files = {}) {
      const repo: GitHubRepo = {
        private: true,
        ...input,
        fullName: `${input.owner}/${input.name}`,
      };
      const repos = installations.get(installationId) ?? new Map();
      repos.set(repo.fullName.toLowerCase(), { repo, files });
      installations.set(installationId, repos);
      return repo;
    },
    removeInstallation(installationId) {
      installations.delete(installationId);
    },
    async listInstallationRepos(installationId) {
      return [...(installations.get(installationId)?.values() ?? [])].map((entry) => entry.repo);
    },
    async getRepo(installationId, ref) {
      return find(installationId, ref)?.repo ?? null;
    },
    async createIssue(installationId, issue) {
      const entry = find(installationId, issue);
      if (!entry) throw new Error(`github request failed with status 404`);
      const number = issues.length + 1;
      const created: CreatedIssue = {
        id: 1000 + number,
        number,
        url: `https://github.com/${entry.repo.fullName}/issues/${number}`,
      };
      issues.push({ ...issue, installationId, ...created });
      return created;
    },
    async searchCode(installationId, ref, query): Promise<CodeSearchHit[]> {
      const entry = find(installationId, ref);
      if (!entry) return [];
      return Object.entries(entry.files)
        .filter(([path, text]) => path.includes(query) || text.includes(query))
        .map(([path]) => ({
          path,
          url: `https://github.com/${entry.repo.fullName}/blob/${entry.repo.defaultBranch}/${path}`,
        }));
    },
    async readFile(installationId, ref) {
      return find(installationId, ref)?.files[ref.path] ?? null;
    },
  };
}
