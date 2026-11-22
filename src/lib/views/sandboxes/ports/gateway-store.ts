import type { SandboxCommandKind } from "../domain/command";
import type { SandboxRunStore } from "./store";

/**
 * What the runner gateway (`apps/gateway`) reads and writes beyond the run
 * store: its runners, the commands addressed to it, and the run lifecycle
 * frames of the worker (ack, reject, lease). Events and lost runs go through
 * the run store it extends.
 */
export interface SandboxGatewayStore extends Pick<SandboxRunStore, "appendEvents" | "markLost"> {
  /**
   * Upserts the runner of (project, owner, instance) as connected to this
   * gateway, and moves the unacked commands of its runs to this gateway, so a
   * runner that comes back through another gateway (a restart, a drain) still
   * gets them.
   */
  registerRunner(input: RegisterRunnerInput): Promise<{ runnerId: string }>;
  updateManifest(runnerId: string, manifest: Record<string, unknown>): Promise<void>;
  /** Marks the runner offline, unless a newer connection already took it over. */
  disconnectRunner(runnerId: string, connectionId: string): Promise<void>;
  /** Unacked commands of this gateway, oldest first, with what the gateway checks before it forwards one. */
  pendingCommands(gatewayId: string): Promise<PendingCommand[]>;
  ackCommand(commandId: string): Promise<void>;
  /** Who a run belongs to, for the check that a frame's run is this connection's. */
  runOwner(runId: string): Promise<RunOwner | null>;
  /** `run.ack`: a queued run is running; its lease starts now. */
  markRunAcked(runId: string, now: Date): Promise<void>;
  /** `run.reject` or no ack in time: the run ends as rejected. */
  rejectRun(runId: string, reason: string, message: string | undefined, now: Date): Promise<void>;
  /** The controller ends a live run as `error` (a fake over the daily cap). A later `run.end` changes nothing. */
  failRun(runId: string, error: { code: string; message: string }, now: Date): Promise<void>;
  /** `run.lease`: the runner still works on the run. */
  recordLease(runId: string, now: Date): Promise<void>;
}

export interface RegisterRunnerInput {
  projectId: string;
  ownerUserId: string;
  instanceId: string;
  gatewayId: string;
  connectionId: string;
  manifest: Record<string, unknown>;
  maxConcurrency: number;
}

export interface PendingCommand {
  id: string;
  runId: string;
  kind: SandboxCommandKind;
  payload: Record<string, unknown>;
  runnerId: string | null;
  runStatus: string;
}

export interface RunOwner {
  projectId: string;
  ownerUserId: string;
  runnerId: string | null;
  status: string;
}
