import type { SandboxRun } from "./domain/run";
import { runView } from "./domain/run";
import type { SandboxVersion, VersionStatus } from "./domain/version";
import type { RunStore } from "./ports/run-store";
import type { SecretStore } from "./ports/secret-store";
import type { VersionStore } from "./ports/version-store";

/** What the Ratel sandbox page shows. Plain data: no image reference, instance or secret value. */
export type SandboxPageModel = {
  projectId: string;
  /** Whether this deployment can build and run sandboxes. */
  configured: boolean;
  canEdit: boolean;
  versions: VersionRow[];
  secrets: SecretRow[];
  runs: RunRow[];
};

export type VersionRow = {
  id: string;
  name: string;
  status: VersionStatus;
  reason: string | null;
  commit: string;
  dirty: boolean;
  createdAt: string;
  buildLog: string | null;
  tools: Array<{ name: string; sideEffect: boolean }>;
};

export type SecretRow = {
  name: string;
  /** Null when there is no value. */
  updatedAt: string | null;
  /** Whether the latest version names it. */
  declared: boolean;
};

export type RunRow = ReturnType<typeof runView>;

const VERSIONS = 20;
const RUNS = 10;

export async function loadSandboxPage(
  projectId: string,
  canEdit: boolean,
  deps: {
    versions: Pick<VersionStore, "list">;
    secrets: Pick<SecretStore, "list">;
    runs: Pick<RunStore, "list">;
    configured: () => boolean;
  },
): Promise<SandboxPageModel> {
  const [versions, secrets, runs] = await Promise.all([
    deps.versions.list(projectId, VERSIONS),
    deps.secrets.list(projectId),
    deps.runs.list(projectId, RUNS),
  ]);
  return {
    projectId,
    configured: deps.configured(),
    canEdit,
    versions: versions.map(versionRow),
    secrets: secretRows(versions, secrets),
    runs: runs.map((run: SandboxRun) => runView(run)),
  };
}

function versionRow(version: SandboxVersion): VersionRow {
  return {
    id: version.id,
    name: version.name,
    status: version.status,
    reason: version.reason,
    commit: version.git.commit,
    dirty: version.git.dirty,
    createdAt: version.createdAt.toISOString(),
    buildLog: version.buildLog,
    tools: version.manifest.tools.map(({ name, sideEffect }) => ({ name, sideEffect })),
  };
}

/** The names that the latest version of each sandbox declares, missing first, then the others. */
export function secretRows(
  versions: readonly SandboxVersion[],
  secrets: ReadonlyArray<{ name: string; updatedAt: Date }>,
): SecretRow[] {
  const latest = new Map<string, SandboxVersion>();
  for (const version of versions) {
    if (!latest.has(version.name)) latest.set(version.name, version);
  }
  const declared = new Set([...latest.values()].flatMap((version) => version.manifest.secrets));
  const set = new Map(secrets.map((secret) => [secret.name, secret.updatedAt.toISOString()]));
  return [...new Set([...declared, ...set.keys()])]
    .map((name) => ({ name, updatedAt: set.get(name) ?? null, declared: declared.has(name) }))
    .sort(
      (a, b) =>
        Number(a.updatedAt !== null) - Number(b.updatedAt !== null) || (a.name < b.name ? -1 : 1),
    );
}
