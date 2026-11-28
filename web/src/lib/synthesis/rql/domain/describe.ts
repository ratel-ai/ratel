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
import { PROPERTY_SETTINGS, type RqlProperties } from "./properties";

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
  /** The trace properties of the caller's project, when the caller gave them. */
  properties?: { indexed: string[]; detected: string[]; note: string };
}

const RULES = [
  "RQL (Ratel Query Language) is a read-only query language over the trace data of one project.",
  "Send one SELECT from one table: select <columns> from <table> [where] [group by] [having] [order by] [limit].",
  `Every query reads a window of time: by default the last ${RQL_LIMITS.defaultWindowHours} hours, at most ${RQL_LIMITS.maxWindowDays} days for run_rql (a dashboard, Explore or an alert rule reads the range of its page, at most ${RQL_LIMITS.consoleMaxWindowDays} days). The caller of the tool gives the window, not the query. A time filter in WHERE narrows it.`,
  "For events, traces, scores and prompts the window applies to each row. For sessions and users the window applies to their traces, before the totals. An alert rule reads its window by known time: traces.known_at and scores.scored_at.",
  "A page filter (a dashboard, Explore) keeps the rows whose trace matches. prompts has no trace, so the page filter keeps all of its rows. Under a page filter of a list, each(list) gives only the values it keeps.",
  `A query gives at most ${RQL_LIMITS.maxLimit} rows. With no LIMIT it gives ${RQL_LIMITS.defaultLimit}.`,
  `A query has at most ${RQL_LIMITS.maxTextChars} characters, ${RQL_LIMITS.maxSelectItems} output columns (each column of * counts), ${RQL_LIMITS.maxListItems} items in one list and ${RQL_LIMITS.maxExpressionDepth} levels of nesting.`,
  `A cell longer than ${RQL_LIMITS.maxCellChars} characters is cut, and the rows stop at ${RQL_LIMITS.maxResultBytes / 1_000_000} MB of JSON. Either cut marks the result truncated: select fewer or shorter columns.`,
  `run_rql runs at most ${RQL_LIMITS.parallelQueriesPerProject} queries of a project at the same time. One more gives rql_busy: run it again when one ends.`,
  "There are no joins, subqueries, UNION, WITH, CASE, window functions, casts or Postgres operators. Each table copies the trace columns that a question needs.",
  "Write text in single quotes. Compare a timestamp with an ISO 8601 text, for example '2026-11-01T00:00:00Z'.",
  "Read a span attribute with attributes['key']: the value is text. Test a list with contains(list, 'value'). Group by each value of a list with each(list).",
  "Read an indexed trace property with properties['name'] on traces, events or scores: the value is text. A property that is not indexed is refused. user, session, environment, model and service are columns: user_id, session_id, environment, models, service_name.",
  "A share is rate(condition). coalesce(sum(x), 0) gives 0 for a sum of no rows.",
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
    rql: "select scorer, rate(passed) as pass_rate, count(*) as scored from scores where passed is not null group by scorer order by pass_rate",
  },
  {
    question: "What is the error rate of each model?",
    rql: "select each(models) as model, rate(coalesce(root_error, has_error)) as error_rate, count(*) as traces from traces group by model order by error_rate desc",
  },
  {
    question: "How many context tokens did the captured prompts use each day?",
    rql: "select time_bucket('1 day', occurred_at) as day, coalesce(sum(context_tokens), 0) as tokens from prompts group by day order by day",
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

const PROPERTIES_NOTE = `properties['name'] reads the indexed names only. A detected name has no stored values: index it in project settings (${PROPERTY_SETTINGS}) first. user, session, environment, model and service are columns, not properties: user_id, session_id, environment, models and service_name.`;

/**
 * The schema description of the catalog. Pure: the same value on each call. With the project's
 * properties, it lists the indexed names and, apart, the detected ones.
 */
export function describeRqlSchema(properties?: RqlProperties): RqlSchemaDescription {
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
    ...(properties
      ? {
          properties: {
            indexed: [...properties.indexed],
            detected: [...(properties.detected ?? [])],
            note: PROPERTIES_NOTE,
          },
        }
      : {}),
  };
}
