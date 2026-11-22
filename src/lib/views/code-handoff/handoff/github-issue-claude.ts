import type { GitHubPort } from "../ports";
import type { HandoffTarget } from "./target";

/**
 * The first handoff target (RC-918): a GitHub issue in the linked repo whose
 * body starts with `@claude`, so the Claude Code GitHub App picks it up and
 * opens a pull request. The body is the brief as it stands: its data blocks
 * already hold every text from traces. The title names the fix in one line,
 * with mentions and backticks neutralised so it pings nobody.
 */

export const GITHUB_ISSUE_CLAUDE_TARGET = "github-issue-claude";

const TITLE_MAX = 120;

export function createGitHubIssueClaudeTarget(github: GitHubPort): HandoffTarget {
  return {
    id: GITHUB_ISSUE_CLAUDE_TARGET,
    async handoff(request, repo) {
      const issue = await github.createIssue(repo.installationId, {
        owner: repo.owner,
        name: repo.name,
        title: issueTitle(request.title),
        body: `@claude\n\n${request.brief}`,
      });
      return { externalId: String(issue.number), url: issue.url };
    },
  };
}

/** `Ratel fix: <title>`, one line, capped, with no `@` mention and no backtick. */
export function issueTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim().replace(/@/g, "＠").replace(/`/g, "ˋ");
  return `Ratel fix: ${flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat}`;
}
