/**
 * The RQL catalog: the six virtual tables, their columns and types, and the neutral functions.
 * The compiler accepts only the names in this file, and `describeRqlSchema` describes the same
 * names. A change of a name or of a meaning is a new `RQL_VERSION`.
 */

export { RQL_VERSION } from "./version";

export const RQL_TABLE_NAMES = [
  "events",
  "traces",
  "scores",
  "sessions",
  "users",
  "prompts",
] as const;
export type RqlTableName = (typeof RQL_TABLE_NAMES)[number];

/**
 * The value types of RQL. `text_list` is a list of text; `attributes` is a map of text keys.
 * `properties` is the map of the trace properties a project indexes: it is read one key at a time,
 * `properties['key']`, and never as a whole.
 */
export type RqlType =
  | "text"
  | "integer"
  | "number"
  | "boolean"
  | "timestamp"
  | "text_list"
  | "attributes"
  | "properties";

export interface RqlColumn {
  name: string;
  type: RqlType;
  description: string;
  /** Names an agent can try first (often the Postgres name). The error suggests this column. */
  hints?: readonly string[];
  /** Totals tables only: the aggregate over the trace rows of the view that gives the column. */
  total?: string;
}

export interface RqlTable {
  name: RqlTableName;
  description: string;
  /** The view in the `rql` schema that the compiled SQL reads. */
  view: string;
  /**
   * `rows`: one row of the view is one row of the table, and the window applies to `timeColumn`.
   * `totals`: the view has one row per trace. The compiler groups the traces in the window by
   * `key` and the columns are the `total` aggregates.
   */
  grain: "rows" | "totals";
  /** The column of the view that the window applies to. */
  timeColumn: string;
  /**
   * The column a window `by: "known"` applies to: when a row became known to Ratel. An alert
   * counts by it, so a row that arrives late is still counted once. `timeColumn` when absent.
   */
  knownColumn?: string;
  /** False when the rows have no trace: the page filter keeps every row. True when absent. */
  traceRows?: false;
  /** Totals tables only: the column of the view that the traces are grouped by. */
  key?: string;
  hints?: readonly string[];
  columns: readonly RqlColumn[];
}

export interface RqlFunction {
  name: string;
  signature: string;
  returns: string;
  description: string;
  aggregate: boolean;
  example: string;
}

const SESSION_ID: RqlColumn = {
  name: "session_id",
  type: "text",
  description: "The session the trace belongs to (null when the agent sends none).",
};
/** The storage column is `end_user_id`; the views give it the RQL name `user_id`. */
const USER_ID: RqlColumn = {
  name: "user_id",
  type: "text",
  description: "The end user the trace ran for (null when the agent sends none).",
  hints: ["end_user_id", "end_user"],
};
const SERVICE_NAME: RqlColumn = {
  name: "service_name",
  type: "text",
  description: "The OpenTelemetry service name of the root span.",
};
const ENVIRONMENT: RqlColumn = {
  name: "environment",
  type: "text",
  description: "The deployment environment of the root span.",
};
const MODELS: RqlColumn = {
  name: "models",
  type: "text_list",
  description: "The distinct models the trace called. Use contains(models, 'name').",
};
const TOOLS: RqlColumn = {
  name: "tools",
  type: "text_list",
  description: "The distinct tools the trace called. Use contains(tools, 'name').",
};
const AGENTS: RqlColumn = {
  name: "agents",
  type: "text_list",
  description: "The distinct agents of the trace's spans. Use contains(agents, 'name').",
};
/** The trace properties (ADR-0012): only the indexed ones are read, one key at a time. */
const PROPERTIES: RqlColumn = {
  name: "properties",
  type: "properties",
  description:
    "The trace properties the project indexes. Read one with properties['name']: the value is text (null when the trace has none). describe_rql_schema lists the indexed names.",
};
/** The tasks of the trace (RTL-397): a trace can be a step of runs of more than one. */
const TASKS: RqlColumn = {
  name: "tasks",
  type: "text_list",
  description:
    "The ids of the tasks (Agent health workflows, list_tasks) the trace ran in. Use contains(tasks, 'id'); each(tasks) groups by task.",
  hints: ["task", "task_id", "workflow_id"],
};
const MCP_SERVERS: RqlColumn = {
  name: "mcp_servers",
  type: "text_list",
  description: "The distinct MCP servers of the trace's spans. Use contains(mcp_servers, 'name').",
};

/** The totals of the traces in the window that `sessions` and `users` share. */
const TRACE_TOTALS: readonly RqlColumn[] = [
  {
    name: "trace_count",
    type: "integer",
    description: "The traces in the window.",
    total: "count(*)",
  },
  {
    name: "error_count",
    type: "integer",
    description: "The traces in the window with at least one failed span.",
    total: 'count(*) filter (where "has_error")',
  },
  {
    name: "first_trace_at",
    type: "timestamp",
    description: "The start of the first trace in the window.",
    total: 'min("started_at")',
  },
  {
    name: "last_trace_at",
    type: "timestamp",
    description: "The start of the last trace in the window.",
    total: 'max("started_at")',
  },
  {
    name: "total_duration_ms",
    type: "number",
    description: "The sum of the trace durations in the window, in milliseconds.",
    total: 'sum("duration_ms")',
  },
  {
    name: "input_tokens",
    type: "integer",
    description: "The input tokens of the traces in the window.",
    total: 'sum("input_tokens")',
  },
  {
    name: "output_tokens",
    type: "integer",
    description: "The output tokens of the traces in the window.",
    total: 'sum("output_tokens")',
  },
  {
    name: "cost_usd",
    type: "number",
    description: "The cost of the traces in the window, in US dollars.",
    total: 'sum("cost_usd")',
  },
];

export const RQL_TABLES: readonly RqlTable[] = [
  {
    name: "events",
    description:
      "One row per span: a model call, a tool call, a Ratel search, an agent run or another span of a trace.",
    view: "events",
    grain: "rows",
    timeColumn: "started_at",
    hints: ["spans", "span", "otel_spans", "event"],
    columns: [
      { name: "trace_id", type: "text", description: "The trace of the span." },
      { name: "span_id", type: "text", description: "The span." },
      {
        name: "parent_span_id",
        type: "text",
        description: "The parent span (null for a root span).",
      },
      { name: "name", type: "text", description: "The span name." },
      {
        name: "type",
        type: "text",
        description:
          "What the span is: 'llm_call' (a model call), 'tool_call', 'search' (a Ratel search), 'agent_run' (an invoke_agent or create_agent span) or 'other'.",
        hints: ["span_class", "kind", "class"],
      },
      {
        name: "status",
        type: "text",
        description: "The span outcome: 'unset', 'ok' or 'error'.",
        hints: ["status_code"],
      },
      { name: "started_at", type: "timestamp", description: "The span start." },
      { name: "ended_at", type: "timestamp", description: "The span end." },
      { name: "duration_ms", type: "number", description: "The span duration in milliseconds." },
      { name: "service_name", type: "text", description: "The OpenTelemetry service name." },
      {
        name: "operation",
        type: "text",
        description: "The gen_ai operation (for example 'chat').",
        hints: ["operation_name"],
      },
      {
        name: "provider",
        type: "text",
        description: "The model provider of a model call.",
        hints: ["provider_name"],
      },
      { name: "model", type: "text", description: "The model of a model call." },
      { name: "input_tokens", type: "integer", description: "The input tokens of a model call." },
      { name: "output_tokens", type: "integer", description: "The output tokens of a model call." },
      { name: "cached_tokens", type: "integer", description: "The cached input tokens." },
      { name: "reasoning_tokens", type: "integer", description: "The reasoning tokens." },
      { name: "cost_usd", type: "number", description: "The cost of a model call in US dollars." },
      {
        name: "agent",
        type: "text",
        description: "The agent the span ran under.",
        hints: ["agent_key", "agent_name"],
      },
      {
        name: "caller_agent",
        type: "text",
        description: "The agent that called this agent.",
        hints: ["caller_agent_key"],
      },
      {
        name: "mcp_server",
        type: "text",
        description: "The MCP server the span provides or calls.",
      },
      { name: "experiment_name", type: "text", description: "The Ratel experiment of the span." },
      { name: "experiment_arm", type: "text", description: "The experiment arm of the span." },
      SESSION_ID,
      USER_ID,
      {
        name: "attributes",
        type: "attributes",
        description: "The span attributes that Ratel keeps. Read one with attributes['key'].",
      },
      {
        ...PROPERTIES,
        description:
          "The trace properties the project indexes, as the span holds them (its own value, else its parent's, else its resource's). Read one with properties['name'].",
      },
    ],
  },
  {
    name: "traces",
    description: "One row per trace: the totals of its spans.",
    view: "traces",
    grain: "rows",
    timeColumn: "started_at",
    knownColumn: "known_at",
    hints: ["trace", "otel_trace_summaries", "runs", "turns"],
    columns: [
      { name: "trace_id", type: "text", description: "The trace." },
      { name: "started_at", type: "timestamp", description: "The start of the root span." },
      {
        name: "duration_ms",
        type: "number",
        description: "The duration of the root span in milliseconds.",
      },
      { name: "has_error", type: "boolean", description: "At least one span of the trace failed." },
      {
        name: "root_error",
        type: "boolean",
        description: "The root span failed: the outcome of the run (null on old rows).",
      },
      { name: "input_tokens", type: "integer", description: "The input tokens of the trace." },
      { name: "output_tokens", type: "integer", description: "The output tokens of the trace." },
      { name: "cost_usd", type: "number", description: "The cost of the trace in US dollars." },
      MODELS,
      TOOLS,
      AGENTS,
      MCP_SERVERS,
      SERVICE_NAME,
      ENVIRONMENT,
      {
        name: "geo_country",
        type: "text",
        description: "The ISO 3166-1 alpha-2 country of the trace.",
      },
      SESSION_ID,
      USER_ID,
      {
        name: "known_at",
        type: "timestamp",
        description:
          "When Ratel last wrote the totals of the trace. A window by known time applies to this column.",
        hints: ["updated_at"],
      },
      PROPERTIES,
      TASKS,
    ],
  },
  {
    name: "scores",
    description: "One row per scorer and trace: the result of a scorer on a trace.",
    view: "scores",
    grain: "rows",
    timeColumn: "trace_started_at",
    knownColumn: "scored_at",
    hints: ["score", "trace_scores", "evals"],
    columns: [
      { name: "scorer_id", type: "text", description: "The scorer." },
      { name: "scorer", type: "text", description: "The scorer name.", hints: ["scorer_name"] },
      {
        name: "scorer_kind",
        type: "text",
        description: "The kind of scorer: 'check' or 'judge'.",
        hints: ["kind"],
      },
      { name: "trace_id", type: "text", description: "The trace the scorer read." },
      {
        name: "value",
        type: "number",
        description: "1 or 0 for a pass or a fail; 1 to 5 for a numeric judge.",
        hints: ["score"],
      },
      {
        name: "passed",
        type: "boolean",
        description: "The verdict (null for a numeric judge).",
      },
      {
        name: "confidence",
        type: "number",
        description: "The confidence of the judge model (null for a check).",
      },
      {
        name: "scored_at",
        type: "timestamp",
        description: "When the scorer ran. A window by known time applies to this column.",
      },
      {
        name: "trace_started_at",
        type: "timestamp",
        description: "The start of the trace. The window applies to this column.",
        hints: ["started_at"],
      },
      SESSION_ID,
      USER_ID,
      SERVICE_NAME,
      ENVIRONMENT,
      MODELS,
      TOOLS,
      AGENTS,
      MCP_SERVERS,
      {
        name: "trace_has_error",
        type: "boolean",
        description: "At least one span of the trace failed (null when the trace is gone).",
      },
      {
        name: "trace_input_tokens",
        type: "integer",
        description: "The input tokens of the trace (null when the trace is gone).",
      },
      {
        name: "trace_output_tokens",
        type: "integer",
        description: "The output tokens of the trace (null when the trace is gone).",
      },
      {
        name: "trace_cost_usd",
        type: "number",
        description: "The cost of the trace in US dollars (null when the trace is gone).",
      },
      PROPERTIES,
      TASKS,
    ],
  },
  {
    name: "sessions",
    description:
      "One row per session: the totals of its traces that started in the window. A trace without a session_id is in no session.",
    view: "sessions",
    grain: "totals",
    timeColumn: "started_at",
    key: "session_id",
    hints: ["session", "conversations", "threads"],
    columns: [
      { ...SESSION_ID, description: "The session.", total: '"session_id"' },
      {
        ...USER_ID,
        description: "The end user of the session (the greatest when its traces name more).",
        total: 'max("user_id")',
      },
      ...TRACE_TOTALS,
    ],
  },
  {
    name: "users",
    description:
      "One row per end user: the totals of their traces that started in the window. A trace without a user_id is in no user.",
    view: "users",
    grain: "totals",
    timeColumn: "started_at",
    key: "user_id",
    hints: ["user", "end_users", "customers"],
    columns: [
      { ...USER_ID, description: "The end user.", total: '"user_id"' },
      {
        name: "session_count",
        type: "integer",
        description: "The distinct sessions of the user's traces in the window.",
        total: 'count(distinct "session_id")',
      },
      ...TRACE_TOTALS,
    ],
  },
  {
    name: "prompts",
    description:
      "One row per captured prompt: a model call that an SDK or a trace sent with its messages, and the input tokens of each source of its context. The rows have no trace properties, so the page filter keeps every row.",
    view: "prompts",
    grain: "rows",
    timeColumn: "occurred_at",
    traceRows: false,
    hints: ["prompt", "event_metrics", "context", "calls"],
    columns: [
      {
        name: "occurred_at",
        type: "timestamp",
        description:
          "When the model call happened (when Ratel received it, if the SDK gave no time).",
        hints: ["event_time", "started_at"],
      },
      { name: "provider", type: "text", description: "The model provider." },
      { name: "model", type: "text", description: "The model." },
      { name: "input_tokens", type: "integer", description: "The input tokens of the call." },
      { name: "output_tokens", type: "integer", description: "The output tokens of the call." },
      {
        name: "context_tokens",
        type: "number",
        description:
          "The input tokens of the five sources of the context: skills, tools, history, memory and user input.",
      },
      ...(["skills", "tools", "history", "memory", "user_input"] as const).map(
        (source): RqlColumn => ({
          name: `${source}_tokens`,
          type: "number",
          description: `The input tokens of the source ${source.replace("_", " ")}.`,
        }),
      ),
      {
        name: "cost_usd",
        type: "number",
        description: "The cost of the call in US dollars (null when the model has no price).",
      },
      {
        name: "latency_ms",
        type: "integer",
        description: "The latency of the call in milliseconds.",
      },
    ],
  },
];

/** The functions of RQL. Each one maps to Postgres in `rewrite.ts`; no other function exists. */
export const RQL_FUNCTIONS: readonly RqlFunction[] = [
  {
    name: "count",
    signature: "count(*) | count(x) | count(distinct x)",
    returns: "integer",
    description: "The rows, the rows where x is not null, or the distinct values of x.",
    aggregate: true,
    example: "select count(*) from traces",
  },
  {
    name: "count_distinct",
    signature: "count_distinct(x)",
    returns: "integer",
    description: "The distinct values of x. The same as count(distinct x).",
    aggregate: true,
    example: "select count_distinct(trace_id) from events",
  },
  {
    name: "sum",
    signature: "sum(number)",
    returns: "the type of x",
    description: "The sum of x.",
    aggregate: true,
    example: "select sum(cost_usd) from traces",
  },
  {
    name: "avg",
    signature: "avg(number)",
    returns: "number",
    description: "The mean of x.",
    aggregate: true,
    example: "select avg(duration_ms) from traces",
  },
  {
    name: "min",
    signature: "min(x)",
    returns: "the type of x",
    description: "The smallest x (a number, a timestamp or text).",
    aggregate: true,
    example: "select min(started_at) from traces",
  },
  {
    name: "max",
    signature: "max(x)",
    returns: "the type of x",
    description: "The largest x (a number, a timestamp or text).",
    aggregate: true,
    example: "select max(cost_usd) from traces",
  },
  ...([50, 90, 95, 99] as const).map((p) => ({
    name: `p${p}`,
    signature: `p${p}(number)`,
    returns: "number",
    description: `The ${p}th percentile of x, interpolated.`,
    aggregate: true,
    example: `select p${p}(duration_ms) from traces`,
  })),
  {
    name: "percentile",
    signature: "percentile(number, fraction)",
    returns: "number",
    description: "The percentile of x at the fraction (from 0 to 1), interpolated.",
    aggregate: true,
    example: "select percentile(duration_ms, 0.75) from traces",
  },
  {
    name: "time_bucket",
    signature: "time_bucket('<n> minute|hour|day|week', timestamp)",
    returns: "timestamp",
    description:
      "The start of the bucket of the timestamp. Buckets start at 2000-01-03 00:00 UTC, a Monday: a day starts at midnight UTC and a week on Monday.",
    aggregate: false,
    example:
      "select time_bucket('1 hour', started_at) as hour, count(*) from traces group by hour order by hour",
  },
  {
    name: "rate",
    signature: "rate(boolean)",
    returns: "number",
    description:
      "The share of rows where the condition is true, from 0 to 1. A null condition counts as not true. No rows give null.",
    aggregate: true,
    example: "select rate(has_error) from traces",
  },
  {
    name: "coalesce",
    signature: "coalesce(x, y, ...)",
    returns: "the type of x",
    description:
      "The first value that is not null. The values must be of one type (integer and number mix). coalesce(sum(x), 0) gives 0 for a sum of no rows.",
    aggregate: false,
    example: "select coalesce(sum(cost_usd), 0) from traces",
  },
  {
    name: "each",
    signature: "each(text_list)",
    returns: "text",
    description:
      "One row for each value of the list: a row with two models is read once per model, and a row with an empty list is not read. Every each() of one list in a query is the same value. Under a page filter of that list, only its values.",
    aggregate: false,
    example:
      "select each(models) as model, count(*) as traces from traces group by model order by traces desc",
  },
  {
    name: "contains",
    signature: "contains(text_list, text)",
    returns: "boolean",
    description: "True when the list has the value (models, tools, agents, mcp_servers, tasks).",
    aggregate: false,
    example: "select count(*) from traces where contains(models, 'gpt-4o')",
  },
  {
    name: "properties",
    signature: "properties['name']",
    returns: "text",
    description:
      "The value of one indexed trace property, as text (null when the trace has none). A property that is not indexed is refused: index it in project settings. user, session, environment, model and service are columns: read user_id, session_id, environment, models and service_name.",
    aggregate: false,
    example:
      "select properties['organization'] as organization, count(*) as traces from traces group by organization order by traces desc",
  },
  {
    name: "attributes",
    signature: "attributes['key']",
    returns: "text",
    description: "The value of one span attribute, as text (null when the span has no such key).",
    aggregate: false,
    example:
      "select attributes['gen_ai.tool.name'] as tool, count(*) from events where type = 'tool_call' group by tool",
  },
];

/** The table of this name, or undefined. */
export function rqlTable(name: string): RqlTable | undefined {
  return RQL_TABLES.find((table) => table.name === name);
}
