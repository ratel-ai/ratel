import type { UsageCheck, UsageRefusal } from "@/lib/contracts/usage-limits";
import type { RunInput, RunResult, RunStatus, SandboxRun } from "../domain/run";

export type NewRun = {
  id: string;
  projectId: string;
  versionId: string;
  runInput: RunInput;
  tokenHash: string;
  timeoutS: number;
  requestedBy: string;
};

/** A run that still has work for the sweep. */
export type OpenRun = Pick<
  SandboxRun,
  | "id"
  | "projectId"
  | "status"
  | "instanceRef"
  | "instanceStoppedAt"
  | "timeoutS"
  | "createdAt"
  | "startedAt"
> & { usageRecordedAt: Date | null };

export interface RunStore {
  /**
   * Adds a `queued` run when `check` passes. `check` gets the instances that the project has now
   * and its runs of this UTC day. Two starts of a project at the same time do not see the same
   * numbers.
   */
  create(
    run: NewRun,
    check: (present: { instances: number; today: number }) => Promise<UsageCheck>,
  ): Promise<{ ok: true; run: SandboxRun } | UsageRefusal>;
  get(projectId: string, runId: string): Promise<SandboxRun | null>;
  /** The newest first. */
  list(projectId: string, limit: number): Promise<SandboxRun[]>;
  /** The run of a token, while the run is `queued` or `running`. */
  findByTokenHash(tokenHash: string): Promise<{ id: string; projectId: string } | null>;
  /** Keeps the instance, and moves `queued` to `running`. Returns the status after it. */
  markStarted(runId: string, instanceRef: string, now: Date): Promise<RunStatus | null>;
  /** Ends a run that is `queued` or `running`. False when it has ended before. */
  finish(runId: string, outcome: RunOutcome, now: Date): Promise<boolean>;
  markInstanceStopped(runId: string, now: Date): Promise<void>;
  markUsageRecorded(runId: string, now: Date): Promise<void>;
  listOpen(limit: number): Promise<OpenRun[]>;
}

export type RunOutcome =
  | { status: "completed" | "failed"; result: RunResult }
  | { status: "infra_error" | "timed_out"; reason: string };
