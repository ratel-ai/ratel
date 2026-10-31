import type { Organization } from "@/lib/platform/identity/schema";
import { getLogger, type LogError } from "@/lib/platform/logger";
import { reportServerException as reportServerExceptionFn } from "@/lib/platform/telemetry";

/**
 * The ingest-time kick for the turn ledger: after a runtime-events batch is
 * stored, enqueue one coalesced `build_trace_turns` job for the project and
 * drain it after the response.
 */

/** The runtime event types a turn is made of; mirrors the partial index on `trace_events`. */
export const TURN_EVENT_TYPES = [
  "search",
  "skill_search",
  "gateway_search",
  "invoke_start",
  "invoke_end",
  "invoke_error",
  "gateway_invoke",
  "gateway_error",
  "skill_invoke",
] as const;

export interface TraceTurnsIngestDeps {
  enqueueBuild: (projectId: string) => Promise<{ id: string } | null>;
  scheduleProjectDrain: (projectId: string) => void;
}

export interface ScheduleTraceTurnBuildInput {
  projectId: string;
  organization: Organization | null;
  /** Wire types of the events this batch stored. */
  eventTypes: readonly string[];
  accepted: number;
  /** The ingest route, for the failure report. Defaults to the runtime-events lane. */
  endpoint?: string;
  logError?: LogError;
  reportServerException?: typeof reportServerExceptionFn;
}

const TRIGGER_TYPES: ReadonlySet<string> = new Set(TURN_EVENT_TYPES);
const logger = getLogger("trace-signals/schedule");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

/**
 * Fail-open: a build that cannot be scheduled is logged and reported, never a
 * reason to fail an ingest that already stored the events. The cron safety net
 * picks up anything missed here.
 */
export async function scheduleTraceTurnBuild(
  deps: TraceTurnsIngestDeps | undefined,
  input: ScheduleTraceTurnBuildInput,
): Promise<void> {
  if (!deps || input.accepted === 0) return;
  if (!input.eventTypes.some((type) => TRIGGER_TYPES.has(type))) return;
  try {
    const job = await deps.enqueueBuild(input.projectId);
    if (job) deps.scheduleProjectDrain(input.projectId);
  } catch (error) {
    (input.logError ?? defaultLogError)("trace turns build enqueue failed", error, {
      project_id: input.projectId,
    });
    (input.reportServerException ?? reportServerExceptionFn)(error, `project:${input.projectId}`, {
      endpoint: input.endpoint ?? "/api/v1/events",
      operation: "trace_turns_build_enqueue",
    });
  }
}
