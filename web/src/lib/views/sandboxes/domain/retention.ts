/** A ready version, as the retention rule reads it. */
export type ReadyVersion = { id: string; projectId: string; name: string; createdAt: Date };

/**
 * The ready versions whose snapshots go. Each sandbox (a project and a name) keeps the snapshots
 * of its newest `keep` versions. A held version (a pinned eval baseline, a running eval
 * experiment, an active run or a live VM) also keeps its snapshot, and it does not take a place of
 * the newest `keep`.
 */
export function versionsToRetire(
  versions: readonly ReadyVersion[],
  keep: number,
  held: ReadonlySet<string>,
): ReadyVersion[] {
  const bySandbox = new Map<string, ReadyVersion[]>();
  for (const version of versions) {
    const key = JSON.stringify([version.projectId, version.name]);
    bySandbox.set(key, [...(bySandbox.get(key) ?? []), version]);
  }
  return [...bySandbox.values()].flatMap((own) =>
    own
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(keep)
      .filter((version) => !held.has(version.id)),
  );
}
