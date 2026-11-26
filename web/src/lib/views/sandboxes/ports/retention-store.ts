import type { ReadyVersion } from "../domain/retention";

/** A ready version with the name of its snapshot. */
export type KeptVersion = ReadyVersion & { imageRef: string };

/** A retired version whose snapshot is not deleted yet. */
export type RetiredSnapshot = { id: string; projectId: string; imageRef: string };

/**
 * The reads and writes of the snapshot sweep (`snapshot-sweep.ts`). A version is retired before
 * its snapshot is deleted, so no ready version is ever without its snapshot.
 */
export interface RetentionStore {
  /**
   * The ready versions of at most `limit` sandboxes that have more than `keep` ready versions. The
   * sandboxes are a random choice: a sandbox whose old versions stay held does not hide the others.
   */
  listCrowded(keep: number, limit: number): Promise<KeptVersion[]>;
  /** Which of these versions have a queued or running run, or a VM that is not deleted. */
  inUse(versionIds: readonly string[]): Promise<Set<string>>;
  /**
   * Moves a `ready` version to `retired`, with the reason, when no queued or running run and no
   * live VM uses it. It takes the lock of a run start (`RunStore.create`), so a run start sees
   * either the version ready and its run keeps the version, or the version retired. True when this
   * call retired it.
   */
  retire(version: Pick<ReadyVersion, "id" | "projectId">, reason: string): Promise<boolean>;
  /** At most `limit` retired versions that still name a snapshot. */
  listRetiredSnapshots(limit: number): Promise<RetiredSnapshot[]>;
  /** Clears the snapshot of a retired version after its delete. */
  markSnapshotDeleted(versionId: string): Promise<void>;
  /** Which of these version ids have a row. */
  existing(versionIds: readonly string[]): Promise<Set<string>>;
}
