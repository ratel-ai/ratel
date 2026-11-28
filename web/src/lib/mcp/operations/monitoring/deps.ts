import { isGrouped, type Query } from "@/lib/contracts/query";
import { forbidden, invalidParams, type McpErrorCode, McpOperationError } from "@/lib/mcp/errors";
import { mcpActor, mcpEventContext, mcpSessionDeps } from "@/lib/mcp/operations/loop/tasks";
import type { OperationContext } from "@/lib/mcp/registry";
import { getDb } from "@/lib/platform/db/client";
import { withStatementTimeout } from "@/lib/platform/db/statement-timeout";
import { secretBoxConfigured } from "@/lib/platform/secret-box";
import { type ServerEventName, trackServerEvent } from "@/lib/platform/telemetry";
import type { QueryScope } from "@/lib/synthesis/metrics/catalog";
import type { GroupedResult } from "@/lib/synthesis/metrics/groups";
import { QueryError, type QueryResult, runQuery } from "@/lib/synthesis/metrics/query";
// Fills `metricSeams.sql`: kind sql (run_rql, query_monitoring).
import "@/lib/synthesis/rql/query";
import { postTo } from "@/lib/views/alerts/slack";
import { loadWidget, runGroupedQuery } from "@/lib/views/dashboards/data";
import { countLastWeek, previewScorer } from "@/lib/views/scorers/preview";
import { slackAppStatus } from "@/lib/views/slack/app";
import { channelAccess, listChannels, revokeToken } from "@/lib/views/slack/channels";
import { slackWorkspace } from "@/lib/views/slack/workspace";

/**
 * What the monitoring tools (scorers, alerts, Slack destinations, dashboards) stand on. Each tool
 * calls the same action as the console's server action; the MCP caller stands in for the session.
 */
export interface MonitoringDeps {
  db(): ReturnType<typeof getDb>;
  previewScorer(...args: Parameters<typeof previewScorer>): ReturnType<typeof previewScorer>;
  countLastWeek(...args: Parameters<typeof countLastWeek>): ReturnType<typeof countLastWeek>;
  /** A query's numbers, under the read timeout; with a group-by, each value's (`runGroupedQuery`). */
  runQuery(
    projectId: string,
    query: Query,
    scope: QueryScope,
  ): Promise<QueryResult | GroupedResult>;
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
  db: () => getDb(),
  previewScorer: (...args) => previewScorer(...args),
  countLastWeek: (...args) => countLastWeek(...args),
  // RQL runs on its own read-only pool with its own timeout: no transaction of the primary pool.
  runQuery: (projectId, query, scope) =>
    isGrouped(query)
      ? runGroupedQuery(projectId, query, scope, { operation: "mcp_query_monitoring" })
      : query.kind === "sql"
        ? runQuery(projectId, query, scope)
        : withStatementTimeout((db) => runQuery(projectId, query, scope, db), {
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

/** Who acts. */
export interface MonitoringCaller {
  projectId: string;
  organizationId: string;
  actor: string;
}

/** The project, its organization and the actor of a call. */
export function monitoringCaller(ctx: OperationContext): MonitoringCaller {
  return {
    projectId: ctx.projectId,
    organizationId: ctx.organizationId ?? "",
    actor: mcpActor(ctx.auth, ctx.projectId),
  };
}

/** The RQL codes that are not a problem of the query text. */
const RQL_ERROR_CODES: Readonly<Record<string, McpErrorCode>> = {
  rql_busy: "rate_limited",
  rql_timeout: "timeout",
  rql_unavailable: "unavailable",
};

/**
 * A refused query as the tool's error. An RQL refusal keeps its code (as `reason`), its message
 * and its fix, as the compiler or the runner wrote them.
 */
export function queryRefusal(error: unknown): unknown {
  if (!(error instanceof QueryError)) return error;
  if (!error.detail) return invalidParams(error.message);
  const { code, fix } = error.detail;
  return new McpOperationError(RQL_ERROR_CODES[code] ?? "invalid_params", error.message, {
    reason: code,
    fix,
  });
}

/** The access checks of the actions, answered for an MCP caller. */
export function callerAccess(ctx: OperationContext, caller: MonitoringCaller) {
  return {
    ...mcpSessionDeps(ctx, caller.actor),
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
const FORBIDDEN = /^(You cannot|Sign in to|Only (?:an )?organization admin|A support session)/;
const CONFLICT =
  /^A (project|dashboard) can have \d+ (alerts|destinations|dashboards|scorers|widgets)\.$|^This project has \d+ scorers, and the limit is \d+\.|^A scorer (covers up to|keeps its)|Confirm the change first\.$|is already a destination\.$|cannot store secrets/;

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
