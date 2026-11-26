import { BINARY_OPS, UNARY_OPS } from "./ast";
import {
  RQL_FUNCTIONS,
  RQL_TABLES,
  RQL_VERSION,
  type RqlFunction,
  type RqlTableName,
  type RqlType,
} from "./catalog";
import { RQL_LIMITS, type RqlLimits } from "./limits";

/** What `describe_rql_schema` gives an agent: the catalog, the limits, the rules and examples. */
export interface RqlSchemaDescription {
  language: "rql";
  version: number;
  tables: {
    name: RqlTableName;
    description: string;
    /** The column the window applies to. A totals table has none: the window applies to its traces. */
    timeColumn?: string;
    columns: { name: string; type: RqlType; description: string }[];
  }[];
  functions: Omit<RqlFunction, "aggregate">[];
  operators: string[];
  limits: RqlLimits;
  rules: string[];
  examples: { question: string; rql: string }[];
}

const RULES = [
  "RQL (Ratel Query Language) is a read-only query language over the trace data of one project.",
  "Send one SELECT from one table: select <columns> from <table> [where] [group by] [having] [order by] [limit].",
  `Every query reads a window of time: by default the last ${RQL_LIMITS.defaultWindowHours} hours, at most ${RQL_LIMITS.maxWindowDays} days. The caller of the tool gives the window, not the query. A time filter in WHERE narrows it.`,
  "For events, traces and scores the window applies to each row. For sessions and users the window applies to their traces, before the totals.",
  `A query gives at most ${RQL_LIMITS.maxLimit} rows. With no LIMIT it gives ${RQL_LIMITS.defaultLimit}.`,
  `A query has at most ${RQL_LIMITS.maxTextChars} characters, ${RQL_LIMITS.maxSelectItems} output columns (each column of * counts), ${RQL_LIMITS.maxListItems} items in one list and ${RQL_LIMITS.maxExpressionDepth} levels of nesting.`,
  `A cell longer than ${RQL_LIMITS.maxCellChars} characters is cut, and the rows stop at ${RQL_LIMITS.maxResultBytes / 1_000_000} MB of JSON. Either cut marks the result truncated: select fewer or shorter columns.`,
  `A project runs at most ${RQL_LIMITS.parallelQueriesPerProject} queries at the same time. One more gives rql_busy: run it again when one ends.`,
  "There are no joins, subqueries, UNION, WITH, CASE, window functions, casts or Postgres operators. Each table copies the trace columns that a question needs.",
  "Write text in single quotes. Compare a timestamp with an ISO 8601 text, for example '2026-11-01T00:00:00Z'.",
  "Read a span attribute with attributes['key']: the value is text. Test a list with contains(list, 'value').",
  "GROUP BY and ORDER BY can name a select alias or a position. HAVING can name an alias. WHERE cannot.",
];

const EXAMPLES: { question: string; rql: string }[] = [
  {
    question: "How many traces failed each hour today?",
    rql: "select time_bucket('1 hour', started_at) as hour, count(*) as failed from traces where has_error group by hour order by hour",
  },
  {
    question: "Which models cost the most?",
    rql: "select model, sum(cost_usd) as cost, count(*) as calls from events where type = 'llm_call' group by model order by cost desc limit 10",
  },
  {
    question: "What is the p95 latency of the traces that called gpt-4o?",
    rql: "select p95(duration_ms) from traces where contains(models, 'gpt-4o')",
  },
  {
    question: "Which tools fail most often?",
    rql: "select attributes['gen_ai.tool.name'] as tool, count(*) as failures from events where type = 'tool_call' and status = 'error' group by tool order by failures desc",
  },
  {
    question: "What is the pass rate of each scorer?",
    rql: "select scorer, avg(value) as pass_rate, count(*) as scored from scores where scorer_kind = 'check' group by scorer order by pass_rate",
  },
  {
    question: "Which sessions were the longest?",
    rql: "select session_id, trace_count, total_duration_ms, cost_usd from sessions order by trace_count desc limit 20",
  },
  {
    question: "Which end users spent the most?",
    rql: "select user_id, session_count, cost_usd from users order by cost_usd desc limit 20",
  },
];

/** The schema description of the catalog. Pure: the same value on each call. */
export function describeRqlSchema(): RqlSchemaDescription {
  return {
    language: "rql",
    version: RQL_VERSION,
    tables: RQL_TABLES.map((table) => ({
      name: table.name,
      description: table.description,
      ...(table.grain === "rows" ? { timeColumn: table.timeColumn } : {}),
      columns: table.columns.map(({ name, type, description }) => ({ name, type, description })),
    })),
    functions: RQL_FUNCTIONS.map(({ aggregate: _aggregate, ...fn }) => ({ ...fn })),
    operators: [...BINARY_OPS, "<>", "IN", "NOT IN", "BETWEEN", "NOT BETWEEN", ...UNARY_OPS],
    limits: { ...RQL_LIMITS },
    rules: [...RULES],
    examples: EXAMPLES.map((example) => ({ ...example })),
  };
}
