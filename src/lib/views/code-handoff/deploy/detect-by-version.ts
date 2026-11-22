import { getLogger } from "@/lib/platform/logger";
import type { RepoCommitRow, RepoLinkRow } from "@/lib/views/code-handoff/schema";
import {
  listLinksAwaitingDeploy,
  listUndeployedTaggedCommits,
  readMatchingServiceVersions,
} from "./commits";
import { type DeployResult, recordDeploy } from "./deployed";
import { defaultRecordDeployDeps } from "./wiring";

/**
 * The drain step of the deploy watch (RC-920, RC-993): a project whose spans
 * carry a `service.version` equal to a pending commit's sha (full, or 7+
 * characters it starts with) runs that commit, so its fixes shipped. Ingest
 * is untouched: the step reads the version `lib/otlp/span-rows.ts` already
 * keeps on each span.
 *
 * The spans are asked only about the pending shas (tagged, not deployed), so
 * other versions cannot hide a match. The read starts at the oldest pending
 * commit's time (a deploy cannot precede its commit), at most
 * `VERSION_LOOKBACK_MAX_MS` back. `recordDeploy` keeps the rule that a
 * prefix of two commits matches nothing.
 *
 * Usually no link waits for a deploy, and the step stops after one read.
 */

export interface DetectByVersionDeps {
  listLinksAwaitingDeploy: () => Promise<RepoLinkRow[]>;
  /** The link's commits that name fixes and are not deployed. */
  listPendingCommits: (repoLinkId: string) => Promise<RepoCommitRow[]>;
  /** The span versions since `since` that are one of `candidates`. */
  readMatchingServiceVersions: (
    projectId: string,
    candidates: readonly string[],
    since: Date,
  ) => Promise<string[]>;
  recordDeploy: (link: RepoLinkRow, sha: string) => Promise<DeployResult>;
  now: () => Date;
}

export interface DetectByVersionResult {
  /** Links checked (waiting for a deploy). */
  links: number;
  shipped: number;
}

/** The span read goes back to the oldest pending commit, but never further than this. */
export const VERSION_LOOKBACK_MAX_MS = 3 * 24 * 60 * 60_000;

/** The shortest `service.version` that may name a commit. */
export const SHA_PREFIX_MIN = 7;

const logger = getLogger("code-handoff/deploy/version");

const defaultDeps: DetectByVersionDeps = {
  listLinksAwaitingDeploy: () => listLinksAwaitingDeploy(),
  listPendingCommits: (repoLinkId) =>
    listUndeployedTaggedCommits(repoLinkId, Number.MAX_SAFE_INTEGER),
  readMatchingServiceVersions: (projectId, candidates, since) =>
    readMatchingServiceVersions(projectId, candidates, since),
  recordDeploy: (link, sha) => recordDeploy(link, sha, "service_version", defaultRecordDeployDeps),
  now: () => new Date(),
};

export async function detectDeploysByVersion(
  deps: DetectByVersionDeps = defaultDeps,
): Promise<DetectByVersionResult> {
  const result: DetectByVersionResult = { links: 0, shipped: 0 };
  const links = await deps.listLinksAwaitingDeploy();
  if (links.length === 0) return result;
  for (const link of links) {
    result.links++;
    try {
      const pending = await deps.listPendingCommits(link.id);
      if (pending.length === 0) continue;
      const versions = await deps.readMatchingServiceVersions(
        link.projectId,
        shaCandidates(pending),
        readSince(pending, deps.now()),
      );
      for (const version of versions)
        result.shipped += (await deps.recordDeploy(link, version)).shipped;
    } catch (err) {
      // One project's failure must not stop the others; the drain reports the step's own failures.
      logger.error(
        { err, repoLinkId: link.id, projectId: link.projectId },
        "failed to detect a deploy by service version",
      );
    }
  }
  return result;
}

/** Every version that names a pending commit: its full sha and each prefix of 7+ characters, lowercase. */
export function shaCandidates(pending: readonly Pick<RepoCommitRow, "sha">[]): string[] {
  const out = new Set<string>();
  for (const { sha } of pending) {
    const lower = sha.toLowerCase();
    for (let length = SHA_PREFIX_MIN; length <= lower.length; length++)
      out.add(lower.slice(0, length));
  }
  return [...out];
}

/** The oldest pending commit's time, at most `VERSION_LOOKBACK_MAX_MS` before now. */
function readSince(pending: readonly Pick<RepoCommitRow, "pushedAt">[], now: Date): Date {
  const oldest = Math.min(...pending.map((commit) => commit.pushedAt.getTime()));
  return new Date(Math.max(oldest, now.getTime() - VERSION_LOOKBACK_MAX_MS));
}
