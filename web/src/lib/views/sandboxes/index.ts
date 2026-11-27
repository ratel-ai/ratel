import type { SandboxRun } from "./domain/run";
import { runDeps } from "./run-deps";
import * as runs from "./runs";

/** The public interface of the module: other modules import only this file. */
export type { RunStatus, SandboxRun, ToolFixture } from "./domain/run";
export type { StartRunOptions, StartRunResult } from "./runs";

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
