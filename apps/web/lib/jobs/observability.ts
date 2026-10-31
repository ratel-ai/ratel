import { getLogger, type LogError } from "@/lib/platform/logger";
import {
  reportServerException,
  type ServerEventContext,
  type ServerEventName,
  trackServerEvent,
} from "@/lib/platform/telemetry";

/**
 * How background work reports: typed events and exceptions through the telemetry shim, a clock,
 * and a logger. Everything is injected so the runner, the store and the drain are unit-testable
 * without a database or an exporter.
 */
export type BackgroundEventName = Extract<
  ServerEventName,
  | "job_failed"
  | "job_completed"
  | "cron_drain_completed"
  | "trace_summaries_refreshed"
  | "quality_snapshots_refreshed"
  | "jobs_reaped"
  | "query_intents_clustered"
  | "match_quality_runs_enqueued"
  | "match_quality_run_started"
  | "match_quality_run_completed"
  | "match_quality_run_declined"
  | "match_quality_run_failed"
  | "tool_explorer_run_completed"
  | "tool_explorer_run_failed"
  | "tool_craft_run_completed"
  | "tool_craft_run_failed"
  | "topic_run_completed"
  | "topic_run_failed"
  | "trace_turns_built"
  | "trace_turns_backlog_lost"
  | "trace_signal_runs_enqueued"
  | "trace_signal_run_completed"
  | "trace_signal_run_failed"
>;

export interface BackgroundObservabilityDeps {
  trackServerEvent: typeof trackServerEvent;
  reportServerException: typeof reportServerException;
  now: () => number;
  logError: LogError;
}

export interface BackgroundObservability {
  now: () => number;
  trackProjectEvent: (
    event: BackgroundEventName,
    projectId: string,
    properties: Record<string, unknown>,
  ) => Promise<void>;
  trackSystemEvent: (
    event: BackgroundEventName,
    distinctId: string,
    properties: Record<string, unknown>,
  ) => Promise<void>;
  reportException: (
    message: string,
    error: unknown,
    distinctId: string,
    properties: Record<string, unknown>,
  ) => void;
}

const logger = getLogger("jobs/observability");
export const defaultBackgroundObservabilityDeps: BackgroundObservabilityDeps = {
  trackServerEvent,
  reportServerException,
  now: Date.now,
  logError: (message, error, fields) => logger.error({ ...fields, err: error }, message),
};

export function createBackgroundObservability(
  deps: BackgroundObservabilityDeps = defaultBackgroundObservabilityDeps,
): BackgroundObservability {
  return {
    now: deps.now,
    trackProjectEvent: (event, projectId, properties) =>
      trackEvent(event, { projectId }, properties, deps),
    trackSystemEvent: (event, distinctId, properties) =>
      trackEvent(event, { distinctId }, properties, deps),
    reportException: (message, error, distinctId, properties) => {
      // The log line comes first and never depends on the exporter: it is the record that survives.
      deps.logError(message, error, properties);
      try {
        deps.reportServerException(error, distinctId, properties);
      } catch (captureError) {
        deps.logError("exception capture failed", captureError, {
          ...properties,
          distinct_id: distinctId,
        });
      }
    },
  };
}

async function trackEvent(
  event: BackgroundEventName,
  context: ServerEventContext,
  properties: Record<string, unknown>,
  deps: BackgroundObservabilityDeps,
): Promise<void> {
  try {
    await deps.trackServerEvent(event, context, properties);
  } catch (error) {
    deps.logError("event tracking failed", error, { ...properties, event });
  }
}
