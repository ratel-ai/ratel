import { getDb } from "@/lib/platform/db/client";
import { createDrizzleVersionStore } from "./adapters/drizzle-version-store";
import type { SandboxRun } from "./domain/run";
import type { SandboxVersion } from "./domain/version";
import { runDeps } from "./run-deps";
import * as runs from "./runs";

/** The public interface of the module: other modules import only this file. */
export type { RunStatus, SandboxRun, ToolFixture } from "./domain/run";
export type { StartRunOptions, StartRunResult } from "./runs";

/** A version as another module reads it. */
export type SandboxVersionSummary = Pick<
  SandboxVersion,
  "id" | "projectId" | "sandboxId" | "name" | "git" | "status" | "createdAt"
> & { tools: ReadonlyArray<{ name: string; sideEffect: boolean }> };

/** Starts one run of a ready version in a new instance. */
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

function summary(version: SandboxVersion): SandboxVersionSummary {
  const { id, projectId, sandboxId, name, git, status, createdAt, manifest } = version;
  const tools = manifest.tools.map((tool) => ({ name: tool.name, sideEffect: tool.sideEffect }));
  return { id, projectId, sandboxId, name, git, status, createdAt, tools };
}
