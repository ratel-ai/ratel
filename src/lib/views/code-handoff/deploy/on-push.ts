import { getLogger } from "@/lib/platform/logger";
import type { RepoLinkRow } from "@/lib/views/code-handoff/schema";
import { parseFixMarkers } from "../marker";
import { listRepoLinksByRepo, type NewRepoCommit, recordRepoCommits } from "../store";
import type {
  GitHubEventHandler,
  GitHubEventResult,
  GitHubWebhookPayload,
} from "../webhook-handler";
import { nextCommitSeq } from "./commits";

/**
 * The `push` webhook (RC-919): record the commits pushed to a linked repo's
 * default branch, with the fixes each message names (`ratel-fix: <id>`). A
 * deploy of one of these commits later becomes a fix shipment (RC-920).
 *
 * Only the link's default branch counts. A redelivered push changes nothing:
 * a commit already recorded for the link keeps its row and its `seq`.
 */

export interface PushDeps {
  listRepoLinksByRepo: (repoId: number) => Promise<RepoLinkRow[]>;
  nextCommitSeq: (repoLinkId: string) => Promise<number>;
  /** Insert the commits; one already recorded is kept. Returns how many are new. */
  recordRepoCommits: (repoLinkId: string, commits: NewRepoCommit[]) => Promise<number>;
}

export interface PushPayload extends GitHubWebhookPayload {
  ref?: string;
  forced?: boolean;
  repository?: { id?: number };
  commits?: PushCommit[];
}

export interface PushCommit {
  id?: string;
  message?: string;
  timestamp?: string;
  author?: { username?: string | null };
}

/** GitHub lists at most this many commits in one push payload. */
export const PUSH_COMMITS_MAX = 2048;

const logger = getLogger("code-handoff/deploy/push");

const defaultPushDeps: PushDeps = {
  listRepoLinksByRepo: (repoId) => listRepoLinksByRepo(repoId),
  nextCommitSeq: (repoLinkId) => nextCommitSeq(repoLinkId),
  recordRepoCommits: (repoLinkId, commits) => recordRepoCommits(repoLinkId, commits),
};

export const handlePush: GitHubEventHandler = createPushHandler(defaultPushDeps);

export function createPushHandler(pushDeps: PushDeps): GitHubEventHandler {
  return async function onPush(raw: GitHubWebhookPayload): Promise<GitHubEventResult> {
    const payload = raw as PushPayload;
    const repoId = payload.repository?.id;
    const installationId = payload.installation?.id;
    if (
      !Number.isSafeInteger(repoId) ||
      !Number.isSafeInteger(installationId) ||
      typeof payload.ref !== "string"
    ) {
      return { removed: 0, stored: 0 };
    }
    const links = (await pushDeps.listRepoLinksByRepo(repoId as number)).filter(
      (link) =>
        link.installationId === installationId &&
        payload.ref === `refs/heads/${link.defaultBranch}`,
    );
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    let stored = 0;
    for (const link of links) {
      logIncomplete(payload, commits, link);
      stored += await pushDeps.recordRepoCommits(
        link.id,
        toNewCommits(commits, await pushDeps.nextCommitSeq(link.id)),
      );
    }
    return { removed: 0, stored };
  };
}

/** The payload's well-formed commits, oldest first, numbered from `firstSeq`. */
function toNewCommits(commits: PushCommit[], firstSeq: number): NewRepoCommit[] {
  const result: NewRepoCommit[] = [];
  for (const commit of commits) {
    const pushedAt = typeof commit.timestamp === "string" ? new Date(commit.timestamp) : null;
    if (
      typeof commit.id !== "string" ||
      commit.id.length === 0 ||
      !pushedAt ||
      Number.isNaN(pushedAt.getTime())
    )
      continue;
    const message = typeof commit.message === "string" ? commit.message : "";
    result.push({
      sha: commit.id.toLowerCase(),
      message,
      authorLogin: typeof commit.author?.username === "string" ? commit.author.username : null,
      pushedAt,
      seq: firstSeq + result.length,
      fixIds: parseFixMarkers(message),
    });
  }
  return result;
}

/** A forced push or a full commit list may leave commits out: say so, then store what is present. */
function logIncomplete(payload: PushPayload, commits: PushCommit[], link: RepoLinkRow): void {
  const truncated = commits.length >= PUSH_COMMITS_MAX;
  if (!truncated && payload.forced !== true) return;
  logger.warn(
    {
      repoLinkId: link.id,
      projectId: link.projectId,
      forced: payload.forced === true,
      truncated,
      commits: commits.length,
    },
    "stored an incomplete push",
  );
}
