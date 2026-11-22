import type { RunStartRequest } from "../domain/command";
import type { SandboxEventInput, SandboxRunStatus, StartRefusal } from "../domain/run";

/**
 * The sandbox run store: the one seam over the sandbox tables that both the web app
 * and the gateway use. Each write that a reader waits for ends with a NOTIFY
 * inside its transaction, so the wake-up goes out only once the rows are visible.
 */
export interface SandboxRunStore {
  /** Inserts the run and its `run.start` command, then wakes the runner's gateway. */
  startRun(request: RunStartRequest): Promise<StartRunResult>;
  /** Queues a `run.cancel` for a live run of this owner. */
  cancelRun(request: CancelRunRequest): Promise<CancelRunResult>;
  /**
   * Queues a `tool.confirm.decision` for a confirm call of a live run of this
   * owner that has no result yet (its `tool.call` event is stored, mode confirm).
   */
  decideConfirm(request: ConfirmDecisionRequest): Promise<ConfirmDecisionResult>;
  /**
   * Stores each event once (a resent seq is ignored), advances the run's acked
   * seq over the stored prefix, applies a run.end once it is inside that
   * prefix, then notifies the run's readers with that seq.
   * Returns the highest seq stored with no gap before it: the `events.ack` value.
   */
  appendEvents(runId: string, events: readonly SandboxEventInput[]): Promise<{ ackedSeq: number }>;
  /**
   * Event rows after `afterSeq` up to the run's acked seq (the contiguous
   * prefix), in seq order. A reader that resumes from its last seq so never
   * moves past a seq that is still missing.
   */
  readEventsAfter(runId: string, afterSeq: number, limit?: number): Promise<SandboxRunEvent[]>;
  /** Marks live runs with no lease since the cutoff as lost and returns their ids. */
  markLost(now: Date, leaseTimeoutMs?: number): Promise<string[]>;
  /** Deletes event rows of runs that ended before the retention cutoff. */
  pruneExpiredEvents(now: Date, retentionDays?: number): Promise<number>;
  /** Every runner of a project, newest connection first. */
  listRunners(projectId: string): Promise<SandboxRunnerView[]>;
  /** One run of a project, or null. */
  getRun(projectId: string, runId: string): Promise<SandboxRunView | null>;
  /** One owner's runs of one sandbox, newest first, at most `limit` (default 50). */
  listRuns(query: ListRunsQuery): Promise<SandboxRunListItem[]>;
}

export interface ListRunsQuery {
  projectId: string;
  ownerUserId: string;
  sandboxId: string;
  limit?: number;
}

export interface SandboxRunnerView {
  id: string;
  ownerUserId: string;
  instanceId: string;
  online: boolean;
  manifest: Record<string, unknown>;
  /** The runner's `registered` concurrency limit: how many runs it takes at once. */
  maxConcurrency: number;
  connectedAt: Date;
  lastSeenAt: Date;
}

export interface SandboxRunView {
  id: string;
  sandboxId: string;
  sessionId: string | null;
  ownerUserId: string;
  runnerId: string | null;
  status: string;
  configHash: string;
  overrides: string[];
  output: unknown;
  error: unknown;
  traceId: string | null;
  createdAt: Date;
  endedAt: Date | null;
}

/** A run as the playground lists it: the view plus what it ran with and what it used. */
export interface SandboxRunListItem extends SandboxRunView {
  input: unknown;
  params: Record<string, unknown>;
  usage: unknown;
}

export interface SandboxRunEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type StartRunResult =
  | { ok: true; runId: string; sessionId: string; gatewayId: string }
  | { ok: false; reason: StartRefusal | "session_not_owner" };

export interface CancelRunRequest {
  runId: string;
  projectId: string;
  ownerUserId: string;
  reason?: string;
}

export interface ConfirmDecisionRequest {
  runId: string;
  projectId: string;
  ownerUserId: string;
  callId: string;
  decision: "approve" | "edit" | "fake" | "reject";
  /** The edited arguments (edit). */
  args?: unknown;
  /** The fake value (fake). */
  result?: unknown;
}

export type ConfirmDecisionResult =
  | { ok: true; tool: string }
  | { ok: false; reason: "run_not_found" | "run_not_live" | "runner_offline" | "call_not_pending" };

export type CancelRunResult =
  | { ok: true; status: SandboxRunStatus }
  | { ok: false; reason: "run_not_found" | "run_not_live" | "runner_offline" };
