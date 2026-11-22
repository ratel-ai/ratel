import { getLogger } from "@/lib/platform/logger";
import type { RepoCommitRow, RepoLinkRow } from "@/lib/views/code-handoff/schema";
import type {
  RecordedFixShipment,
  RecordFixShipmentInput,
} from "@/lib/views/fixes/record-shipment";
import type { Fix } from "@/lib/views/fixes/types";

/**
 * "This sha is live" becomes fix shipments, exactly once (RC-920). Both
 * signals end here: a `deployment_status` success webhook and a new
 * `service.version` on the project's spans.
 *
 * The deployed commit is found by its full sha or a prefix of 7+ characters.
 * Every commit at or before it (by `seq`) that names fixes and is not yet
 * deployed is claimed, then each fix it names is shipped through
 * `recordFixShipment`. The claim (`deployed_at`) keeps two concurrent runs
 * apart, and makes a replay, or the other signal, a no-op. A fix that no
 * longer exists ships nothing; its commit stays claimed, so it is not tried
 * again.
 *
 * One shipment per fix and deploy (decision `one-shipment-per-fix`): the key
 * of a GitHub shipment is (project, fix, version = full deployed sha). An
 * existing row with that key is reused, and each shipment id is written back
 * on its commit as soon as it exists. So a run that fails half way (claim
 * released) leaves what it finished, and the replay stores only the rest.
 */

export type DeploySource = "deployment_status" | "service_version";

export interface RecordDeployDeps {
  /** Commits of the link whose sha starts with `prefix`, at most `limit`. */
  findCommitsBySha: (repoLinkId: string, prefix: string, limit: number) => Promise<RepoCommitRow[]>;
  /** Commits of the link with `seq <= maxSeq`, fix ids set and not deployed, oldest first. */
  listUndeployedTaggedCommits: (repoLinkId: string, maxSeq: number) => Promise<RepoCommitRow[]>;
  /** Set `deployed_at` when it is still null. False when another caller had it. */
  claimCommit: (commitId: string, deployedAt: Date) => Promise<boolean>;
  /** Undo a claim whose shipments failed, so the next signal tries again. */
  releaseCommit: (commitId: string) => Promise<void>;
  setCommitShipments: (commitId: string, shipmentIds: string[]) => Promise<void>;
  /** The project's fixes, open or applied, or null when they cannot be read. */
  loadProjectFixes: (projectId: string) => Promise<FixLookup | null>;
  recordFixShipment: (input: RecordFixShipmentInput) => Promise<RecordedFixShipment>;
  /** The id of the project's shipment of this fix in this version, if one is stored. */
  findShipment: (projectId: string, fixId: string, version: string) => Promise<string | null>;
  now: () => Date;
}

/** Finds a fix by its id or an alias. */
export type FixLookup = (fixId: string) => Fix | null;

export interface DeployResult {
  /** Shipments recorded. */
  shipped: number;
  /** Commits claimed by this deploy. */
  commits: number;
}

/** A sha or the shortest prefix that may name one. */
export const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

const NOTHING: DeployResult = { shipped: 0, commits: 0 };
const logger = getLogger("code-handoff/deploy");

export async function recordDeploy(
  link: RepoLinkRow,
  sha: string,
  source: DeploySource,
  deps: RecordDeployDeps,
): Promise<DeployResult> {
  const deployed = await findDeployedCommit(link, sha, source, deps);
  if (!deployed) return NOTHING;
  const pending = await deps.listUndeployedTaggedCommits(link.id, deployed.seq);
  if (pending.length === 0) return NOTHING;

  const findFix = await deps.loadProjectFixes(link.projectId);
  if (!findFix) {
    logger.warn(
      { repoLinkId: link.id, projectId: link.projectId, sha: deployed.sha, source },
      "skipped a deploy whose fixes could not be read",
    );
    return NOTHING;
  }
  const shippedByFix = new Map<string, string>();
  const result = { ...NOTHING };
  for (const commit of pending) {
    if (!(await deps.claimCommit(commit.id, deps.now()))) continue;
    result.commits++;
    try {
      result.shipped += await shipCommit(link, deployed.sha, commit, findFix, shippedByFix, deps);
    } catch (err) {
      await deps.releaseCommit(commit.id);
      logger.error(
        { err, repoLinkId: link.id, projectId: link.projectId, commit: commit.sha, source },
        "failed to record a deploy shipment",
      );
      throw err;
    }
  }
  logger.info(
    { repoLinkId: link.id, projectId: link.projectId, sha: deployed.sha, source, ...result },
    "recorded a deploy",
  );
  return result;
}

/** The commit a deploy names, or null when no commit or several match. */
async function findDeployedCommit(
  link: RepoLinkRow,
  sha: string,
  source: DeploySource,
  deps: RecordDeployDeps,
): Promise<RepoCommitRow | null> {
  const prefix = sha.trim().toLowerCase();
  if (!SHA_PATTERN.test(prefix)) return null;
  const matches = await deps.findCommitsBySha(link.id, prefix, 2);
  if (matches.length > 1) {
    logger.warn(
      { repoLinkId: link.id, projectId: link.projectId, prefix, source },
      "ignored an ambiguous deployed sha prefix",
    );
    return null;
  }
  return matches[0] ?? null;
}

/**
 * Ship each fix a commit names, once per fix and deploy: reuse a shipment
 * this deploy already has (an earlier commit, or an earlier failed run), else
 * record one. Each id is written back on the commit at once. Returns how many
 * shipments were recorded.
 */
async function shipCommit(
  link: RepoLinkRow,
  deployedSha: string,
  commit: RepoCommitRow,
  findFix: FixLookup,
  shippedByFix: Map<string, string>,
  deps: RecordDeployDeps,
): Promise<number> {
  const ids = [...commit.shipmentIds];
  let recorded = 0;
  for (const fixId of commit.fixIds) {
    const fix = findFix(fixId);
    if (!fix) {
      logger.warn(
        { repoLinkId: link.id, projectId: link.projectId, commit: commit.sha, fixId },
        "skipped a deployed fix that no longer exists",
      );
      continue;
    }
    let shipmentId =
      shippedByFix.get(fix.id) ?? (await deps.findShipment(link.projectId, fix.id, deployedSha));
    if (!shipmentId) {
      const { row } = await deps.recordFixShipment({
        projectId: link.projectId,
        fix,
        experiment: null,
        version: deployedSha,
        notes: commit.messageHead || null,
        shippedBy: `github:${link.installationId}`,
        actor: { distinctId: `github:${link.installationId}`, projectId: link.projectId },
        surface: "github",
      });
      shipmentId = row.id;
      recorded++;
    }
    shippedByFix.set(fix.id, shipmentId);
    if (ids.includes(shipmentId)) continue;
    ids.push(shipmentId);
    await deps.setCommitShipments(commit.id, [...ids]);
  }
  return recorded;
}
