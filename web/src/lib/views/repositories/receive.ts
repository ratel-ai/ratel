import type { FlagSubject } from "@/lib/contracts/feature-flags";
import type { CommitInput, RepositoryLink } from "./store";
import { decideCommit, parseGitHubEvent, verifySignature } from "./webhook";

/**
 * One GitHub webhook delivery: `POST /api/integrations/github/webhook`. Without a webhook secret
 * the route does not exist (404). A delivery GitHub did not sign is refused before its body is
 * read. A commit is recorded only for projects with `githubRepositories` on; a repository that
 * only flag-off projects link answers as one nobody links.
 */
export type ReceiveDeps = {
  secret: string | undefined;
  linksForRepository(repositoryId: number): Promise<RepositoryLink[]>;
  enabled(subject: FlagSubject): Promise<boolean>;
  recordCommit(input: CommitInput): Promise<{ id: string; created: boolean }>;
};

export type ReceiveInput = { event: string | null; signature: string | null; body: string };

export type ReceiveResult =
  | { status: 404 | 401 | 400; body: null }
  | { status: 202; body: { ignored: string } }
  | {
      status: 202;
      body: {
        recorded: { projectId: string; commitId: string; status: string; created: boolean }[];
        skipped: { projectId: string; reason: string }[];
      };
    };

export async function receiveWebhook(
  input: ReceiveInput,
  deps: ReceiveDeps,
): Promise<ReceiveResult> {
  if (!deps.secret) return { status: 404, body: null };
  if (!verifySignature(deps.secret, input.body, input.signature)) {
    return { status: 401, body: null };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.body);
  } catch {
    return { status: 400, body: null };
  }
  const event = parseGitHubEvent(input.event ?? "", payload);
  if ("ignored" in event) return { status: 202, body: { ignored: event.ignored } };

  const links = await deps.linksForRepository(event.repositoryId);
  const on: RepositoryLink[] = [];
  for (const link of links) {
    const subject = { organizationId: link.organizationId, projectId: link.projectId };
    if (await deps.enabled(subject).catch(() => false)) on.push(link);
  }
  if (on.length === 0) {
    return { status: 202, body: { ignored: "no project takes this repository" } };
  }

  const recorded: { projectId: string; commitId: string; status: string; created: boolean }[] = [];
  const skipped: { projectId: string; reason: string }[] = [];
  for (const link of on) {
    const decision = decideCommit(link, event);
    if (decision.action === "skip") {
      skipped.push({ projectId: link.projectId, reason: decision.reason });
      continue;
    }
    const status = decision.action === "build" ? "queued" : "awaiting_approval";
    const { id, created } = await deps.recordCommit({
      projectId: link.projectId,
      repositoryId: event.repositoryId,
      sha: event.sha,
      baseSha: event.baseSha,
      branch: event.branch,
      pullRequest: event.pullRequest,
      fromFork: event.fromFork,
      title: event.title,
      author: event.author,
      status,
      reason: decision.action === "await_approval" ? decision.reason : null,
    });
    recorded.push({ projectId: link.projectId, commitId: id, status, created });
  }
  return { status: 202, body: { recorded, skipped } };
}
