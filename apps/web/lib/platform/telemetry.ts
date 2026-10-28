import { composition } from "@/lib/composition/ports";
import type { TelemetryContext } from "@/lib/contracts/telemetry";
import { getLogger, type LogError } from "@/lib/platform/logger";

/**
 * The telemetry shim: the upstream names (`trackServerEvent`, `trackProductEvent`,
 * `reportServerException`) over the telemetry port, so every caller keeps its import and its
 * call. Events carry names, ids and numbers; never asks, prompts, labels or member text.
 */

/** Every typed business event the open-source modules emit. */
export const SERVER_EVENT_NAMES = [
  "otlp_ingest_request",
  "runtime_events_ingested",
  "catalog_snapshot_synced",
  "runtime_catalog_override_updated",
  "intent_graph_synced",
  "intent_graph_pulled",
  "intent_graph_folded",
  "intent_engine_clustered",
  "intent_engine_named",
  "intent_engine_reset",
  "first_trace_received",
  "job_failed",
  "job_completed",
  "cron_drain_completed",
  "trace_summaries_refreshed",
  "quality_snapshots_refreshed",
  "jobs_reaped",
  "query_intents_clustered",
  "organization_created",
  "organization_settings_updated",
  "organization_deleted",
  "project_created",
  "project_settings_updated",
  "project_deleted",
  "api_key_created",
  "api_key_revoked",
  "api_key_expired",
  "api_key_regenerated",
  "quota_limit_hit",
  "dashboard_viewed",
  "playground_run_completed",
  "demo_project_seeded",
  "demo_project_seed_failed",
  "onboarding_tour_finished",
  "mcp_operation_executed",
  "mcp_operation_denied",
  "match_quality_runs_enqueued",
  "match_quality_run_started",
  "match_quality_run_completed",
  "match_quality_run_declined",
  "match_quality_run_failed",
  "match_quality_proposal_applied",
  "match_quality_proposal_dismissed",
  "match_quality_proposal_reverted",
  "health_viewed",
  "health_share_link_created",
  "health_share_link_revoked",
  "health_share_viewed",
  "health_report_opened",
  "health_import_started",
  "health_import_completed",
  "health_import_failed",
  "health_import_needs_attention",
  "health_signal_dismissed",
  "health_signal_restored",
  "trace_turns_built",
  "trace_turns_backlog_lost",
  "trace_signal_runs_enqueued",
  "trace_signal_run_requested",
  "trace_signal_run_completed",
  "trace_signal_run_failed",
  "tool_explorer_run_requested",
  "tool_explorer_run_completed",
  "tool_explorer_run_failed",
  "tool_craft_run_requested",
  "tool_craft_run_completed",
  "tool_craft_run_failed",
  "tool_craft_proposal_dismissed",
  "topic_run_requested",
  "topic_run_completed",
  "topic_run_failed",
] as const;

export type ServerEventName = (typeof SERVER_EVENT_NAMES)[number];
export type ServerEventProperties = Record<string, unknown>;

type CommonServerEventContext = { orgId?: string };
type UserServerEventContext = CommonServerEventContext & {
  externalId: string;
  distinctId?: never;
  projectId?: string;
};
type ProjectServerEventContext = CommonServerEventContext & {
  externalId?: never;
  distinctId?: never;
  projectId: string;
};
type ExplicitServerEventContext = CommonServerEventContext & {
  externalId?: never;
  distinctId: string;
  projectId?: string;
};

/**
 * Who acted: a user (by the identity provider's id), a project (`project:<id>`, API-key
 * surfaces) or an explicit id (`system:<name>` for background work).
 */
export type ServerEventContext =
  | UserServerEventContext
  | ProjectServerEventContext
  | ExplicitServerEventContext;

export function toTelemetryContext(context: ServerEventContext): TelemetryContext {
  const distinctId =
    context.externalId !== undefined
      ? context.externalId
      : context.distinctId !== undefined
        ? context.distinctId
        : `project:${context.projectId}`;
  return { distinctId, orgId: context.orgId, projectId: context.projectId };
}

const logger = getLogger("telemetry");
const defaultLogError: LogError = (message, error, fields) =>
  logger.error({ ...fields, err: error }, message);

/** Best-effort typed server event; never throws into the caller. */
export async function trackServerEvent(
  event: ServerEventName,
  context: ServerEventContext,
  properties: ServerEventProperties = {},
  logError: LogError = defaultLogError,
): Promise<void> {
  try {
    await composition.telemetry.trackEvent(event, toTelemetryContext(context), properties);
  } catch (error) {
    logError("server event tracking failed", error, { event });
  }
}

/** Best-effort server-side exception capture that can never mask the original failure. */
export function reportServerException(
  error: unknown,
  distinctId: string,
  properties: Record<string, unknown>,
): void {
  try {
    composition.telemetry.reportException(error, distinctId, properties);
  } catch (captureError) {
    defaultLogError("exception capture failed", captureError, { distinct_id: distinctId });
  }
}

/**
 * The product events with the shape of their properties. Upstream typed these against page
 * models of higher layers; here the few cross-layer fields are plain strings so the shim stays
 * at L1. Values must remain ids, names and numbers.
 */
export type ProductEventProperties = {
  organization_created: { org_slug: string; source: "personal" | "switcher" };
  organization_settings_updated: { name_changed: boolean; slug_changed: boolean };
  organization_deleted: { organization_slug: string };
  project_created: { project_slug: string };
  project_settings_updated: { field: "name" };
  project_deleted: { project_slug: string };
  api_key_created: { key_prefix: string; named: boolean; expires_in: string };
  api_key_revoked: { key_prefix: string };
  api_key_expired: { key_prefix: string };
  api_key_regenerated: { key_prefix: string };
  quota_limit_hit: { limit: string; cap: number };
  dashboard_viewed: { has_data: boolean };
  health_viewed: { has_signals: boolean; capture_level: string; page_state?: string };
  health_share_link_created: { window_days: number; replaced: boolean };
  health_share_link_revoked: Record<string, never>;
  health_share_viewed: { surface: "page"; has_signals: boolean };
  health_report_opened: { window_days: number; surface: "member" | "shared" };
  health_import_started: { source: string; window_days: number; relay?: boolean };
  health_signal_dismissed: { kind: string; reason: "slow_by_design" };
  health_signal_restored: { kind: string };
  demo_project_seeded: {
    project_slug: string;
    skills: number;
    runs: number;
    traces: number;
    duration_ms: number;
  };
  demo_project_seed_failed: { reason: string };
  onboarding_tour_finished: { outcome: string; last_step_id: string; steps_viewed: number };
};
export type ProductEventName = keyof ProductEventProperties;

export type ProductEventTracker = (
  event: ServerEventName,
  context: ServerEventContext,
  properties?: ServerEventProperties,
) => Promise<void>;

/** Typed business-event seam shared by server actions and page loaders. Best-effort. */
export async function trackProductEvent<Event extends ProductEventName>(
  event: Event,
  context: ServerEventContext,
  properties: ProductEventProperties[Event],
  tracker: ProductEventTracker = trackServerEvent,
  logError: LogError = defaultLogError,
): Promise<void> {
  try {
    await tracker(event, context, { ...properties });
  } catch (error) {
    logError("product event tracking failed", error, {
      event,
      ...(context.orgId ? { organization_id: context.orgId } : {}),
    });
  }
}
