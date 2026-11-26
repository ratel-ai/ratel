import type { UsageCheck, UsageRefusal } from "@/lib/contracts/usage-limits";
import type { RunResponse } from "../domain/contract";
import type { RunRequest, RunStatus, SandboxRun } from "../domain/run";

export type NewRun = {
  id: string;
  projectId: string;
  versionId: string;
  request: RunRequest;
  tokenHash: string;
  traceId: string;
  timeoutS: number;
  requestedBy: string;
};

/** A run that still has work for the sweep. */
export type OpenRun = Pick<
  SandboxRun,
  | "id"
  | "projectId"
  | "status"
  | "vmId"
  | "instanceRef"
  | "timeoutS"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "durationMs"
> & { usageRecordedAt: Date | null };

export interface RunStore {
  /**
   * Adds a `queued` run when `check` passes. `check` gets the active runs that the project has now
   * and its runs of this UTC day. Two starts of a project at the same time do not see the same
   * numbers.
   */
  create(
    run: NewRun,
    check: (present: { active: number; today: number }) => Promise<UsageCheck>,
  ): Promise<{ ok: true; run: SandboxRun } | UsageRefusal>;
  /** Removes a `queued` run that did not get a VM. */
  discard(runId: string): Promise<void>;
  get(projectId: string, runId: string): Promise<SandboxRun | null>;
  /** The newest first. */
  list(projectId: string, limit: number): Promise<SandboxRun[]>;
  /** The run of a token, while the run is `queued` or `running`. */
  findByTokenHash(tokenHash: string): Promise<{ id: string; projectId: string } | null>;
  /**
   * Keeps the VM reference, and moves `queued` to `running`. Returns the status after it, or null
   * when the run was deleted.
   */
  markStarted(runId: string, instanceRef: string, now: Date): Promise<RunStatus | null>;
  /** Ends a run that is `queued` or `running`. False when it has ended before. */
  finish(runId: string, outcome: RunOutcome, now: Date): Promise<boolean>;
  markUsageRecorded(runId: string, now: Date): Promise<void>;
  /** At most `limit` ended runs with work, then at most `limit` active ones. The oldest first. */
  listOpen(limit: number): Promise<OpenRun[]>;
}

export type RunOutcome =
  | { status: "completed"; response: RunResponse; logs: string; durationMs: number }
  | {
      status: "failed" | "timed_out" | "infra_error";
      errorCode: string;
      message: string;
      logs?: string;
      durationMs?: number;
    };
