/**
 * Which of these sandbox versions another module still needs, so their snapshots stay: e.g. the
 * version of a pinned eval baseline or of a running eval experiment. The sandboxes module asks it
 * before it retires old versions. It does not know the module that answers: the composition root
 * wires the answer (`lib/composition/registry.ts`), so `views/sandboxes` never imports a module
 * that depends on it.
 */
export type SandboxVersionHolds = (versionIds: readonly string[]) => Promise<ReadonlySet<string>>;

/** Holds no version: the answer when no module needs old versions. */
export const noSandboxVersionHolds: SandboxVersionHolds = async () => new Set();
