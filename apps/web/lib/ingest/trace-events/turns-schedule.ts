import { getLogger, type LogError } from "@/lib/platform/logger";
import type { Organization } from "@/lib/platform/organizations";
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

/**
 * One agent run, an OTLP `invoke_agent` root span (RC-742): a turn of its own
 * for a run that calls no tool, such as the platform's own backend jobs. Ingest
 * writes it and the build reads it only with `FF_TOOL_RUN_INSIGHTS` on
 * (upstream's `cloud-tool-run-insights`), so it stays out of
 * {@link TURN_EVENT_TYPES} and of the partial index those types mirror.
 */
export const AGENT_RUN_EVENT_TYPE = "agent_run";

/** The turn event types a build reads with `FF_TOOL_RUN_INSIGHTS` on. */
export const TURN_EVENT_TYPES_WITH_AGENT_RUNS = [
  ...TURN_EVENT_TYPES,
  AGENT_RUN_EVENT_TYPE,
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

// Agent runs are written only with `FF_TOOL_RUN_INSIGHTS` on (RC-742), so they kick a build only then.
const TRIGGER_TYPES: ReadonlySet<string> = new Set(TURN_EVENT_TYPES_WITH_AGENT_RUNS);
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
