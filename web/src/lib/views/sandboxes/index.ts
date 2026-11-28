import { getDb } from "@/lib/platform/db/client";
import { createDrizzleVersionStore } from "./adapters/drizzle-version-store";
import type { SandboxRun } from "./domain/run";
import type { SandboxVersion } from "./domain/version";
import { runDeps } from "./run-deps";
import * as runs from "./runs";

/** The public interface of the module: other modules import only this file. */
export type { RatelYaml } from "./domain/config";
export type { SmokeResult } from "./domain/contract";
export type { RunStatus, SandboxRun, ToolFixture } from "./domain/run";
export { apiStatus as sandboxRunStatus } from "./domain/run";
export type { StartRunOptions, StartRunResult } from "./runs";

/** A version as another module reads it. */
export type SandboxVersionSummary = Pick<
  SandboxVersion,
  "id" | "projectId" | "sandboxId" | "name" | "git" | "status" | "createdAt"
> & { tools: ReadonlyArray<{ name: string; sideEffect: boolean }> };

/**
 * A version as an agent reads it to call it: its configuration (input example, params, tools) and
 * its smoke check. It has no image reference, bundle or preparation log.
 */
export type SandboxVersionDetail = Pick<
  SandboxVersion,
  | "id"
  | "projectId"
  | "sandboxId"
  | "name"
  | "git"
  | "status"
  | "reason"
  | "config"
  | "smoke"
  | "createdAt"
>;

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

/** The newest first, with the configuration and the smoke check of each version. */
export async function listSandboxVersionDetails(
  projectId: string,
  limit: number,
): Promise<SandboxVersionDetail[]> {
  const versions = await createDrizzleVersionStore(getDb()).list(projectId, limit);
  return versions.map(detail);
}

export async function getSandboxVersionDetail(
  projectId: string,
  versionId: string,
): Promise<SandboxVersionDetail | null> {
  const version = await createDrizzleVersionStore(getDb()).get(projectId, versionId);
  return version ? detail(version) : null;
}

/** The newest version of the sandbox with this name that is ready, or null. */
export async function newestReadySandboxVersion(
  projectId: string,
  name: string,
): Promise<SandboxVersionDetail | null> {
  const version = await createDrizzleVersionStore(getDb()).newestReady(projectId, name);
  return version ? detail(version) : null;
}

/** A tool that does not run live in an eval has side effects: it is simulated or recorded. */
function summary(version: SandboxVersion): SandboxVersionSummary {
  const { id, projectId, sandboxId, name, git, status, createdAt, config } = version;
  const tools = Object.entries(config.tools ?? {}).map(([name, tool]) => ({
    name,
    sideEffect: (tool.mode ?? "simulated") !== "live",
  }));
  return { id, projectId, sandboxId, name, git, status, createdAt, tools };
}

function detail(version: SandboxVersion): SandboxVersionDetail {
  const { id, projectId, sandboxId, name, git, status, reason, config, smoke, createdAt } = version;
  return { id, projectId, sandboxId, name, git, status, reason, config, smoke, createdAt };
}
