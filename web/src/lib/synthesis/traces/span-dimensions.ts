import { and, eq, type SQL, sql } from "drizzle-orm";
import { otelSpans } from "@/lib/ingest/otlp/schema";
import {
  AGENT_DIMENSIONS,
  type AgentDimension,
  type AgentDimensionFilters,
} from "./agent-dimensions";

/**
 * The SQL of the coding-agent dimensions (`agent-dimensions.ts`, AOBS-5).
 * Each is read from the span's kept attributes, so no column and no
 * migration: `otel_spans.attributes` keeps `gen_ai.*`, `ratel.*` and
 * `mcp.server.name` (`otlp/span-rows.ts`).
 *
 * The task and the repository (AOBS-7) are facts of a run, which the emitter
 * puts on the run's root span only: a span reads them from the root of its
 * trace, so a group sums the cost of every span of the runs it holds.
 */

const toolName = sql<string | null>`${otelSpans.attributes} ->> 'gen_ai.tool.name'`;

/**
 * A `ratel.run.*` attribute of the root span of the span's trace. The key is a
 * constant, never a caller's value. The outer columns are written with their
 * table name: without it they would bind to `run_root` inside the subquery
 * (drizzle leaves the table name out of a query on one table).
 */
function runAttribute(key: `ratel.run.${string}`): SQL<string | null> {
  return sql.raw(
    `(select run_root.attributes ->> '${key}' from otel_spans run_root where run_root.project_id = "otel_spans"."project_id" and run_root.trace_id = "otel_spans"."trace_id" and run_root.parent_span_id is null order by run_root.started_at asc limit 1)`,
  ) as SQL<string | null>;
}

const EXPRESSIONS: Readonly<Record<AgentDimension, SQL<string | null>>> = {
  // `mcp.server.name`, else the server inside `mcp__<server>__<tool>` for
  // emitters that send only the name (the same rule as `otlp/span-facts.ts`).
  server: sql<
    string | null
  >`coalesce(nullif(btrim(${otelSpans.attributes} ->> 'mcp.server.name'), ''), substring(${toolName} from '^mcp__(.+?)__.'))`,
  command: sql<string | null>`${otelSpans.attributes} ->> 'ratel.tool.command'`,
  skill: sql<string | null>`${otelSpans.attributes} ->> 'ratel.skill.name'`,
  agent: sql<string | null>`${otelSpans.attributes} ->> 'gen_ai.agent.name'`,
  chat: sql<string | null>`${otelSpans.attributes} ->> 'gen_ai.conversation.id'`,
  task: runAttribute("ratel.run.task"),
  repo: runAttribute("ratel.run.repo"),
};

/** The SQL value of one dimension on an `otel_spans` row; null when the span has none. */
export function agentDimensionExpression(dimension: AgentDimension): SQL<string | null> {
  return EXPRESSIONS[dimension];
}

/**
 * The tool's name with a per-command name rolled up: `Bash:git` reads `Bash`.
 * Only a span that carries a command and a base name rolls up, so an MCP
 * tool keeps its full `mcp__server__tool` name.
 */
export function rolledUpToolName(): SQL<string | null> {
  return sql<
    string | null
  >`case when ${otelSpans.attributes} ->> 'ratel.tool.command' is not null and nullif(btrim(${otelSpans.attributes} ->> 'ratel.tool.base_name'), '') is not null then ${otelSpans.attributes} ->> 'ratel.tool.base_name' else ${toolName} end`;
}

/**
 * The number check is written with `[.]`, not a backslash: the `sql` tag reads
 * the processed template, which drops a backslash.
 *
 * A span's duration without the time it waited for a person (AOBS-7,
 * `ratel.wait.human_ms`): an approval or a question is not the tool's latency.
 */
export function durationWithoutHumanWait(): SQL<number> {
  const wait = sql`${otelSpans.attributes} ->> 'ratel.wait.human_ms'`;
  return sql<number>`greatest(0, ${otelSpans.durationMs} - case when ${wait} ~ '^[0-9]+([.][0-9]+)?$' then (${wait})::float8 else 0 end)`;
}

/** The spans whose dimensions equal the given values; undefined when none is given. */
export function agentDimensionFilter(filters: AgentDimensionFilters): SQL | undefined {
  return and(
    ...AGENT_DIMENSIONS.map((dimension) =>
      filters[dimension] ? eq(EXPRESSIONS[dimension], filters[dimension]) : undefined,
    ),
  );
}
