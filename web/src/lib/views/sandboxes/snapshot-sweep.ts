import type { SandboxVersionHolds } from "@/lib/contracts/sandbox-version-holds";
import { getLogger } from "@/lib/platform/logger";
import { versionsToRetire } from "./domain/retention";
import { snapshotVersionId } from "./domain/snapshot-name";
import type { RetentionStore } from "./ports/retention-store";
import type { SandboxProvider } from "./ports/sandbox-provider";

/**
 * The drain step of snapshots. The provider charges each saved snapshot each day, so:
 * - retention: each sandbox keeps the snapshots of its newest `keep` ready versions, and of each
 *   version that is held (another module needs it, or a queued or running run or a live VM uses
 *   it). Each other ready version is retired first, then its snapshot is deleted. A retired
 *   version never runs again.
 * - orphans: a snapshot of this deployment whose version row is gone (a project or an organization
 *   delete cascades the rows) is deleted.
 * Only a snapshot with a name of this deployment is ever deleted (`domain/snapshot-name.ts`): other
 * deployments can share the account. A snapshot with the old name `rv-<version id>` carries no
 * deployment, so it is never deleted here, and its version is never retired.
 */
export type SnapshotSweepDeps = {
  store: RetentionStore;
  provider: SandboxProvider | null;
  /** The id of this deployment (`sandboxDeploymentId`). */
  deploymentId: string;
  /** The versions that another module needs (`lib/contracts/sandbox-version-holds.ts`). */
  holds: SandboxVersionHolds;
  /** The ready versions of each sandbox that keep their snapshots. */
  keep: number;
};

export type SnapshotSweepTotals = {
  retiredVersions: number;
  deletedSnapshots: number;
  orphanSnapshots: number;
  snapshotErrors: number;
};

/** The sandboxes that one sweep reads, and the snapshots that it deletes. Small: a tick is short. */
const SANDBOX_LIMIT = 20;
const DELETE_LIMIT = 20;

const logger = getLogger("sandboxes/snapshot-sweep");

export async function sweepSnapshots(deps: SnapshotSweepDeps): Promise<SnapshotSweepTotals> {
  const totals = { retiredVersions: 0, deletedSnapshots: 0, orphanSnapshots: 0, snapshotErrors: 0 };
  const { provider } = deps;
  // With no provider no snapshot can be deleted, so no version is retired.
  if (!provider) return totals;
  await retireOld(deps, totals);
  await deleteRetiredSnapshots(provider, deps, totals);
  await deleteOrphans(provider, deps, totals);
  return totals;
}

/** The reason of a retired version, for the developer. */
export function retiredReason(keep: number): string {
  return `Retired: only the newest ${keep} versions of a sandbox keep their image. Push again to run this code.`;
}

/** Retires the ready versions that keep no snapshot. Their snapshots go in the next step. */
async function retireOld(deps: SnapshotSweepDeps, totals: SnapshotSweepTotals): Promise<void> {
  const { store, keep } = deps;
  const crowded = await store.listCrowded(keep, SANDBOX_LIMIT);
  if (crowded.length === 0) return;
  const ids = crowded.map(({ id }) => id);
  const [held, used] = await Promise.all([deps.holds(ids), store.inUse(ids)]);
  // A snapshot with no name of this deployment is never deleted, so its version stays ready.
  const foreign = crowded
    .filter((version) => snapshotVersionId(deps.deploymentId, version.imageRef) !== version.id)
    .map(({ id }) => id);
  const kept = new Set([...held, ...used, ...foreign]);
  for (const version of versionsToRetire(crowded, keep, kept)) {
    try {
      if (await store.retire(version, retiredReason(keep))) totals.retiredVersions += 1;
    } catch (error) {
      totals.snapshotErrors += 1;
      logger.error(
        { project_id: version.projectId, version_id: version.id, err: error },
        "version not retired",
      );
    }
  }
}

/**
 * Deletes the snapshot of each retired version, then clears it on the row. A failed delete keeps
 * the name on the row, so a later sweep tries again.
 */
async function deleteRetiredSnapshots(
  provider: SandboxProvider,
  deps: SnapshotSweepDeps,
  totals: SnapshotSweepTotals,
): Promise<void> {
  for (const retired of await deps.store.listRetiredSnapshots(DELETE_LIMIT)) {
    const logged = { project_id: retired.projectId, version_id: retired.id };
    if (snapshotVersionId(deps.deploymentId, retired.imageRef) !== retired.id) {
      logger.warn(logged, "retired version names a snapshot of no deployment of its own");
      continue;
    }
    try {
      await provider.deleteSnapshot(retired.imageRef);
      await deps.store.markSnapshotDeleted(retired.id);
      totals.deletedSnapshots += 1;
    } catch (error) {
      totals.snapshotErrors += 1;
      logger.error({ ...logged, err: error }, "snapshot of a retired version not deleted");
    }
  }
}

/** Deletes the snapshots of this deployment whose version row is gone. */
async function deleteOrphans(
  provider: SandboxProvider,
  deps: SnapshotSweepDeps,
  totals: SnapshotSweepTotals,
): Promise<void> {
  // The provider lists only names of this deployment. The check stays: a delete is not undone.
  const listed = (await provider.listSnapshots()).filter(
    ({ snapshotRef, versionId }) => snapshotVersionId(deps.deploymentId, snapshotRef) === versionId,
  );
  if (listed.length === 0) return;
  const known = await deps.store.existing(listed.map(({ versionId }) => versionId));
  const orphans = listed.filter(({ versionId }) => !known.has(versionId)).slice(0, DELETE_LIMIT);
  for (const { snapshotRef, versionId } of orphans) {
    try {
      await provider.deleteSnapshot(snapshotRef);
      totals.orphanSnapshots += 1;
    } catch (error) {
      totals.snapshotErrors += 1;
      logger.error({ version_id: versionId, err: error }, "orphan snapshot not deleted");
    }
  }
}
