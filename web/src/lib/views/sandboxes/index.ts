import { getDb } from "@/lib/platform/db/client";
import { createDrizzleVersionStore } from "./adapters/drizzle-version-store";
import type { SandboxRun } from "./domain/run";
import type { SandboxVersion } from "./domain/version";
import { versionSpec } from "./page-model";
import { runDeps } from "./run-deps";
import type { ParamSpec } from "./run-form";
import * as runs from "./runs";

/** The public interface of the module: other modules import only this file. */
export type { RunStatus, SandboxRun, ToolFixture } from "./domain/run";
export { sandboxesEnabledForProject } from "./gate";
export type { StartRunOptions, StartRunResult } from "./runs";

/** A version as another module reads it. */
export type SandboxVersionSummary = Pick<
  SandboxVersion,
  "id" | "projectId" | "sandboxId" | "name" | "git" | "status" | "createdAt"
> & {
  tools: ReadonlyArray<{ name: string; sideEffect: boolean }>;
  /** The params that `ratel.yaml` declares. */
  params: ParamSpec[];
};

/** Starts one run of a ready version in a new container of a warm VM. It answers before the run ends. */
export function startRun(
  versionId: string,
  input: unknown,
  options: runs.StartRunOptions,
): Promise<runs.StartRunResult> {
  return runs.startRun(versionId, input, options, runDeps());
}

export function getRun(projectId: string, runId: string): Promise<SandboxRun | null> {
  return runs.getRun(projectId, runId, runDeps());
}

/** The newest first. */
export async function listSandboxVersions(
  projectId: string,
  limit: number,
): Promise<SandboxVersionSummary[]> {
  const versions = await createDrizzleVersionStore(getDb()).list(projectId, limit);
  return versions.map(summary);
}

export async function getSandboxVersion(
  projectId: string,
  versionId: string,
): Promise<SandboxVersionSummary | null> {
  const version = await createDrizzleVersionStore(getDb()).get(projectId, versionId);
  return version ? summary(version) : null;
}

/** A tool that does not run live in an eval has side effects: it is simulated or recorded. */
function summary(version: SandboxVersion): SandboxVersionSummary {
  const { id, projectId, sandboxId, name, git, status, createdAt, config } = version;
  const tools = Object.entries(config.tools ?? {}).map(([name, tool]) => ({
    name,
    sideEffect: (tool.mode ?? "simulated") !== "live",
  }));
  const { params } = versionSpec(config);
  return { id, projectId, sandboxId, name, git, status, createdAt, tools, params };
}
