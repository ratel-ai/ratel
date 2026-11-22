/**
 * The run lifecycle as pure rules: statuses, which runner may take a run, which
 * events a batch may store, when a lease is gone and when event rows expire.
 * No I/O: the store adapter and the gateway apply these.
 */

export type SandboxRunStatus =
  | "queued"
  | "running"
  | "ok"
  | "error"
  | "canceled"
  | "rejected"
  | "lost";

export const LIVE_RUN_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly SandboxRunStatus[];
export const TERMINAL_RUN_STATUSES = [
  "ok",
  "error",
  "canceled",
  "rejected",
  "lost",
] as const satisfies readonly SandboxRunStatus[];

/** sandbox/v1 `leaseTimeoutMs`: a live run with no lease for this long is lost. */
export const LEASE_TIMEOUT_MS = 60_000;
/** Event rows are kept this long after their run ends. */
export const EVENT_RETENTION_DAYS = 7;
/** sandbox/v1 kinds a run stores as event rows: every `run.event` kind plus the final `run.end`. */
export const SANDBOX_EVENT_KINDS = [
  "text.delta",
  "tool.call",
  "tool.result",
  "log",
  "span.ref",
  "run.end",
] as const;

export type SandboxEventKind = (typeof SANDBOX_EVENT_KINDS)[number];

export interface SandboxEventInput {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RunnerForStart {
  projectId: string;
  ownerUserId: string;
  gatewayId: string | null;
}

export type StartRefusal = "runner_not_found" | "runner_not_owner" | "runner_offline";

const DAY_MS = 86_400_000;
const MAX_EVENTS_PER_BATCH = 500;

/**
 * Why a run may not go to this runner, or null when it may. A run goes only to
 * a connected runner of its owner, in the run's project.
 */
export function refuseStart(
  runner: RunnerForStart | null,
  request: { projectId: string; ownerUserId: string },
): StartRefusal | null {
  if (!runner || runner.projectId !== request.projectId) return "runner_not_found";
  if (runner.ownerUserId !== request.ownerUserId) return "runner_not_owner";
  if (!runner.gatewayId) return "runner_offline";
  return null;
}

/**
 * The events of a batch that may be stored, ordered by seq and with each seq
 * once (the first copy wins). Throws on a seq that is not a positive integer or
 * an unknown kind: the gateway validated the frame, so this is a bug upstream.
 */
export function normalizeEventBatch(events: readonly SandboxEventInput[]): SandboxEventInput[] {
  if (events.length > MAX_EVENTS_PER_BATCH)
    throw new Error(`event batch over ${MAX_EVENTS_PER_BATCH}`);
  const bySeq = new Map<number, SandboxEventInput>();
  for (const event of events) {
    if (!Number.isInteger(event.seq) || event.seq < 1) throw new Error(`invalid seq: ${event.seq}`);
    if (!isSandboxEventKind(event.kind)) throw new Error(`unknown event kind: ${event.kind}`);
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function isSandboxEventKind(kind: string): kind is SandboxEventKind {
  return (SANDBOX_EVENT_KINDS as readonly string[]).includes(kind);
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** Live runs whose last lease (or start, before the first lease) is older than this are lost. */
export function leaseCutoff(now: Date, leaseTimeoutMs: number = LEASE_TIMEOUT_MS): Date {
  return new Date(now.getTime() - leaseTimeoutMs);
}

/** Runs that ended before this have their event rows deleted. */
export function eventRetentionCutoff(
  now: Date,
  retentionDays: number = EVENT_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

export interface RunEndFields {
  status: "ok" | "error" | "canceled";
  output: unknown;
  error: unknown;
  usage: unknown;
  traceId: string | null;
  overrides: string[] | null;
}

/** The run row fields a `run.end` payload sets. An unknown status is an error end. */
export function runEndFields(payload: Record<string, unknown>): RunEndFields {
  const status =
    payload.status === "ok" || payload.status === "canceled" ? payload.status : "error";
  const overrides = Array.isArray(payload.overrides)
    ? payload.overrides.filter((o): o is string => typeof o === "string")
    : null;
  return {
    status,
    output: payload.output ?? null,
    error:
      payload.error ??
      (status === "error" ? { code: "run_failed", message: "The run failed." } : null),
    usage: payload.usage ?? null,
    traceId: typeof payload.traceId === "string" ? payload.traceId : null,
    overrides,
  };
}
