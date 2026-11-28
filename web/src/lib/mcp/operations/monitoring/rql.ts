import { z } from "zod";
import type { FlagSubject } from "@/lib/contracts/feature-flags";
import { MAX_SQL_TEXT, QUERY_VERSION, type SqlQuery } from "@/lib/contracts/query";
import type { McpAuthContext } from "@/lib/mcp/auth";
import {
  defaultMonitoringDeps,
  type MonitoringDeps,
  queryRefusal,
  requireMonitoring,
} from "@/lib/mcp/operations/monitoring/deps";
import { tableSummary } from "@/lib/mcp/operations/monitoring/results";
import { projectScoped } from "@/lib/mcp/operations/params";
import { defineOperation, type McpOperation } from "@/lib/mcp/registry";
import { TruncationTracker } from "@/lib/mcp/serialize";
import { resolveWindow, windowParams } from "@/lib/mcp/windows";
import { featureEnabled } from "@/lib/platform/experimental-features";
import type { SqlResult } from "@/lib/synthesis/metrics/query";
import { describeRqlSchema, RQL_LIMITS, RQL_VERSION } from "@/lib/synthesis/rql/compile";

/**
 * RQL over MCP (`customMonitoring`): `describe_rql_schema` gives the language, `run_rql` runs one query and
 * gives its table. `run_rql` is kind `sql` of the query object, through `runQuery`: the same path
 * as `query_monitoring`. The console has no RQL page yet, so the tools have no console action
 * (`parity.ts`, `MCP_ONLY`). Without the flag the tools are not listed (`customMonitoringForCaller`), and a call refuses
 * (`requireMonitoring`).
 */

/** The window of RQL: its default of 24 hours, and its longest window. */
export const RQL_WINDOW = {
  defaultDays: RQL_LIMITS.defaultWindowHours / 24,
  maxDays: RQL_LIMITS.maxWindowDays,
} as const;

const EXAMPLE_RQL =
  "select model, sum(cost_usd) as cost from events where type = 'llm_call' group by model order by cost desc limit 10";

export function rqlOperations(deps: MonitoringDeps = defaultMonitoringDeps): McpOperation[] {
  return [
    defineOperation({
      id: "describe_rql_schema",
      domain: "observability",
      title: "Describe the RQL schema",
      description:
        "Gives RQL (Ratel Query Language), the read-only query language over trace data. It lists the tables (events, traces, scores, sessions, users), their columns, the functions, the operators, the limits, the rules and example queries. Call it before run_rql.",
      keywords: ["rql schema", "rql tables", "query language"],
      scope: "project",
      mutates: false,
      params: z.object({ ...projectScoped }),
      async execute(ctx) {
        await requireMonitoring(deps, ctx);
        return {
          data: describeRqlSchema(),
          hint: "run_rql runs one query. Use only these tables, columns and functions.",
        };
      },
    }),
    defineOperation({
      id: "run_rql",
      domain: "observability",
      title: "Run an RQL query",
      description:
        "Runs one RQL (Ratel Query Language) SELECT over the trace data of the project and gives a table: the columns, the rows and a cut mark. describe_rql_schema gives the tables and the rules. An error gives a code, a message and a fix.",
      keywords: ["rql", "run rql", "sql over traces", "ad hoc query"],
      scope: "project",
      mutates: false,
      params: z.object({
        ...projectScoped,
        text: z
          .string()
          .trim()
          .min(1)
          .max(
            MAX_SQL_TEXT,
            `The RQL text has at most ${MAX_SQL_TEXT} characters. Write a shorter query.`,
          )
          .describe(
            `One RQL SELECT statement, at most ${MAX_SQL_TEXT} characters. Example: ${EXAMPLE_RQL}`,
          ),
        rqlVersion: z
          .int()
          .min(1)
          .optional()
          .describe(`The RQL version of the text. Default: ${RQL_VERSION}, the current version.`),
        since: windowParams.since.describe(
          `ISO 8601 start of the window. Default: ${RQL_LIMITS.defaultWindowHours} hours before until. The most: ${RQL_LIMITS.maxWindowDays} days. A longer window is refused.`,
        ),
        until: windowParams.until,
      }),
      async execute(ctx, params) {
        const { projectId } = await requireMonitoring(deps, ctx);
        const window = resolveWindow(params, RQL_WINDOW, deps.now());
        // RQL refuses a window over its maximum: the compiler names the limit and the fix.
        const since = window.clamped && params.since ? new Date(params.since) : window.since;
        const query: SqlQuery = {
          version: QUERY_VERSION,
          kind: "sql",
          text: params.text,
          rqlVersion: params.rqlVersion ?? RQL_VERSION,
        };
        const result = (await deps
          .runQuery(projectId, query, { since, until: window.until })
          .catch((error: unknown) => {
            throw queryRefusal(error);
          })) as SqlResult;
        const tracker = new TruncationTracker();
        tracker.mark(result.truncated);
        return {
          data: {
            summary: tableSummary(result),
            columns: result.columns,
            rows: result.rows,
            truncated: result.truncated,
          },
          truncated: tracker.value,
          window: window.toJSON(),
          hint: result.truncated
            ? `The query had more rows than its limit. Add a LIMIT of at most ${RQL_LIMITS.maxLimit}, or narrow the WHERE.`
            : "A row is an array in the order of columns.",
        };
      },
    }),
  ];
}

/**
 * Whether the connection gets the RQL tools: for an API key, `customMonitoring` of its project; for
 * a person, the flag of any of their organizations. Each call checks the flag of its project again.
 */
export async function customMonitoringForCaller(
  auth: McpAuthContext,
  enabled: (subject: FlagSubject) => Promise<boolean> = (subject) =>
    featureEnabled("customMonitoring", subject),
): Promise<boolean> {
  const subjects: FlagSubject[] =
    auth.kind === "api-key"
      ? [
          {
            ...(auth.organization ? { organizationId: auth.organization.id } : {}),
            projectId: auth.projectId,
            actor: `project:${auth.projectId}`,
          },
        ]
      : auth.memberships.map(({ organizationId }) => ({
          organizationId,
          actor: auth.externalUserId,
        }));
  return (await Promise.all(subjects.map((subject) => enabled(subject)))).some(Boolean);
}
