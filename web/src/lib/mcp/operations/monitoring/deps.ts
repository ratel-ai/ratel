import type { Query } from "@/lib/contracts/query";
import { forbidden, invalidParams, McpOperationError } from "@/lib/mcp/errors";
import { mcpActor, mcpEventContext, mcpSessionDeps } from "@/lib/mcp/operations/loop/tasks";
import type { OperationContext } from "@/lib/mcp/registry";
import { getDb } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { featureEnabled } from "@/lib/platform/experimental-features";
import { secretBoxConfigured } from "@/lib/platform/secret-box";
import { type ServerEventName, trackServerEvent } from "@/lib/platform/telemetry";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import { type QueryResult, runQuery } from "@/lib/synthesis/metrics/query";
import { postTo } from "@/lib/views/alerts/slack";
import { loadWidget } from "@/lib/views/dashboards/data";
import { countLastWeek, previewScorer } from "@/lib/views/scorers/preview";
import { slackAppStatus } from "@/lib/views/slack/app";
import { channelAccess, listChannels, revokeToken } from "@/lib/views/slack/channels";
import { slackWorkspace } from "@/lib/views/slack/workspace";

/**
 * What the monitoring tools (scorers, alerts, Slack destinations, dashboards) stand on. Each tool
 * calls the same action as the console's server action; the MCP caller stands in for the session.
 */
export interface MonitoringDeps {
  enabled(subject: { projectId: string; organizationId: string; actor: string }): Promise<boolean>;
  db(): ReturnType<typeof getDb>;
  previewScorer(...args: Parameters<typeof previewScorer>): ReturnType<typeof previewScorer>;
  countLastWeek(...args: Parameters<typeof countLastWeek>): ReturnType<typeof countLastWeek>;
  /** A query's numbers, under the read timeout. */
  runQuery(projectId: string, query: Query, scope: QueryScope): Promise<QueryResult>;
  /** A widget's numbers, or null when the read failed. */
  loadWidget: typeof loadWidget;
  canSeal(): boolean;
  /** The key webhook URLs are sealed with; the configuration's by default. */
  secretKey?: string;
  slack: {
    appStatus: typeof slackAppStatus;
    listChannels(organizationId: string): ReturnType<typeof listChannels>;
    channelAccess(organizationId: string, channelId: string): ReturnType<typeof channelAccess>;
    revoke(organizationId: string): Promise<void>;
    post: typeof postTo;
  };
  trackServerEvent: typeof trackServerEvent;
  now(): Date;
}

export const defaultMonitoringDeps: MonitoringDeps = {
  enabled: (subject) => featureEnabled("customMonitoring", subject),
  db: () => getDb(),
  previewScorer: (...args) => previewScorer(...args),
  countLastWeek: (...args) => countLastWeek(...args),
  runQuery: (projectId, query, scope) =>
    withStatementTimeout((db) => runQuery(projectId, query, scope, db), {
      operation: "mcp_query_monitoring",
    }),
  loadWidget,
  canSeal: () => secretBoxConfigured(),
  slack: {
    appStatus: (organizationId) => slackAppStatus(organizationId),
    listChannels: (organizationId) => listChannels(organizationId, slackWorkspace()),
    channelAccess: (organizationId, channelId) =>
      channelAccess(organizationId, channelId, slackWorkspace()),
    revoke: (organizationId) => revokeToken(organizationId, slackWorkspace()),
    post: (destination, message) => postTo(destination, message),
  },
  trackServerEvent,
  now: () => new Date(),
};

/** Who acts, once the flag let them in. */
export interface MonitoringCaller {
  projectId: string;
  organizationId: string;
  actor: string;
}

/** Refuses with `forbidden` while `customMonitoring` is off for the caller. */
export async function requireMonitoring(
  deps: Pick<MonitoringDeps, "enabled">,
  ctx: OperationContext,
): Promise<MonitoringCaller> {
  const caller = {
    projectId: ctx.projectId,
    organizationId: ctx.organizationId ?? "",
    actor: mcpActor(ctx.auth, ctx.projectId),
  };
  if (!(await deps.enabled(caller)))
    throw new McpOperationError(
      "forbidden",
      "Custom monitoring (scorers, dashboards and alerts) is off for this project. get_flag_status shows customMonitoring.",
      { reason: "custom_monitoring_off" },
    );
  return caller;
}

/** The access checks of the actions, answered for a caller that `requireMonitoring` let in. */
export function callerAccess(ctx: OperationContext, caller: MonitoringCaller) {
  return {
    ...mcpSessionDeps(ctx, caller.actor),
    enabled: async () => true,
    // A support session is a browser's.
    isRestricted: async () => false,
  };
}

/** A stored change as the console's own event, marked as made through MCP. */
export function observeChange(deps: MonitoringDeps, ctx: OperationContext, event: ServerEventName) {
  return async (fields: object): Promise<void> => {
    ctx.logger.info({ ...fields, surface: "mcp" }, event);
    await deps.trackServerEvent(event, mcpEventContext(ctx), { ...fields, surface: "mcp" });
  };
}

/** The member's role in the project's organization; null for an API key, which is no person. */
export function callerRole(ctx: OperationContext): string | null {
  if (ctx.auth.kind !== "oauth") return null;
  return (
    ctx.auth.memberships.find(({ organizationId }) => organizationId === ctx.organizationId)
      ?.role ?? null
  );
}

const NOT_FOUND = /(does not exist|no longer exists)\.$/;
const FORBIDDEN =
  /^(You cannot|Sign in to|Only (?:an )?organization admin|A support session)| are off for this project\.$/;
const CONFLICT =
  /^A (project|dashboard) can have \d+ (alerts|destinations|dashboards|scorers|widgets)\.$|^A scorer (covers up to|keeps its)|Confirm the change first\.$|is already a destination\.$|cannot store secrets/;

/**
 * An action's refusal as the tool's error. What is neither absent, nor a right, nor a state is the
 * caller's input, unless the tool says what else a refusal means.
 */
export function refusal(
  message: string,
  otherwise: "invalid_params" | "conflict" = "invalid_params",
): McpOperationError {
  if (NOT_FOUND.test(message)) return new McpOperationError("not_found", message);
  if (FORBIDDEN.test(message)) return forbidden(message);
  if (otherwise === "conflict" || CONFLICT.test(message))
    return new McpOperationError("conflict", message);
  return invalidParams(message);
}

/** A parameter one action needs and another does not. */
export function required<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) throw invalidParams(`Pass ${name} to ${action}.`);
  return value;
}
