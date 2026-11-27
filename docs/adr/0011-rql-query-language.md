# 11. RQL (Ratel Query Language): a neutral read-only query language, behind two walls

## Status

Accepted. RQL is the Ratel Query Language, Ratel's read-only query language over trace data. The
compiler, the views, the role, the runner (`web/src/lib/synthesis/rql`) and the MCP tools
`describe_rql_schema` and `run_rql` are in place, with every metric widget of the dashboards and
Explore on RQL (the metric form writes the text) and RQL alert rules, behind `customMonitoring`
(`FF_CUSTOM_MONITORING`, off by default), the flag of custom monitoring: RQL has no flag of its own.

## Context

Agents ask questions of their own trace data that the console pages do not answer: "which tool
fails most often since Monday", "the p95 of the traces that called gpt-4o". An agent writes SQL
well, and the MCP server is the place where it asks. Raw SQL on the platform database is not
possible: the tables hold every tenant, their names and shapes change with each migration, and
Postgres has many ways to read or change what a tenant must not see (functions, casts to `regclass`,
`pg_*` catalogs, `set role`, a second statement).

A text filter on SQL (deny lists, regexes) fails open: one form that it does not know passes.

## Decision

**A language of our own, RQL version 1.** One `SELECT` over one of six virtual tables, with
`WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT` and `SELECT DISTINCT`:

| Table | One row per | Window on |
|---|---|---|
| `events` | span (`otel_spans`); `type` is `llm_call`, `tool_call`, `search`, `agent_run` or `other` | `started_at` |
| `traces` | trace (`otel_trace_summaries`) | `started_at` |
| `scores` | scorer and trace (`trace_scores`, the scorer name, copied trace columns) | `trace_started_at` |
| `sessions` | session: totals of its traces | its traces' `started_at` |
| `users` | end user: totals of their traces | its traces' `started_at` |
| `prompts` | captured prompt (`event_metrics`): the input tokens of each source of its context | `occurred_at` |

`prompts` is the sixth table (decision `rql-sixth-table-allowed`): the context measures of the
metric form read `event_metrics`, whose rows are model calls an SDK or a trace sent with their
messages, not spans, so no other table has their grain. Its rows have no trace, so a page filter
keeps all of them, as the form applies no trace filter to the context measures.

`events.type` comes from `span_class`: `llm_call` gives `llm_call`, `tool` gives `tool_call` and
`ratel_search` gives `search`. A span of another class with the gen_ai agent operation
`invoke_agent` or `create_agent` gives `agent_run`. Each other span gives `other`.

The end user is `user_id` in each table that has it (`events`, `traces`, `scores`, `sessions`,
`users`). The storage column keeps the name `end_user_id`, and the views give it the alias
`user_id`. A query that names `end_user_id` is refused, and the fix suggests `user_id`.

The catalog (`domain/catalog.ts`) lists each table, column, type and description, and the
language version. RQL has no join: each table copies the trace columns that a question needs.
RQL refuses joins, `UNION`, `WITH`, subqueries, `CASE`, window functions, `OFFSET`, writes, a
second statement and each name that is not in the catalog. Each refusal has a code, a message
and a fix; an unknown name gets the nearest one by edit distance or a hint.

**Neutral functions, no Postgres syntax.** `count` (with `*` and `distinct`), `count_distinct`,
`sum`, `avg`, `min`, `max`, `p50`/`p90`/`p95`/`p99`, `percentile(x, f)`, `rate(condition)`,
`coalesce(x, y, ...)`, `time_bucket('<n> minute|hour|day|week', ts)`, `contains(list, value)` and
`each(list)` for `models`, `tools`, `agents` and `mcp_servers`, `attributes['key']`, and
`properties['name']` for the trace properties a project indexes (ADR-0012). The rewrite maps them to
Postgres (`percentile_cont ... within group`, `avg(case when ...)`, `date_bin`, `@> array[...]`, a
lateral join of `unnest`, `->>`).

**Trace properties: `properties['name']` (decision `rql-properties`).** `traces`, `events` and
`scores` have a `properties` column, read one name at a time: the name is a bound value, never a
name of the SQL, and the bare map is refused (`select *` leaves it out). The compiler stays pure:
the caller gives the project's indexed and detected names (`compileRql(text, { properties })`), and
a name that is not indexed is refused with code `property_not_indexed`, the name and the fix "index
it in project settings". A standard property that is a column of every trace (user, session,
environment, model, service) is refused as `property_is_column`, with its column as the fix: one
name for one value. `sessions` and `users` have none, as a session's traces can hold different
values. A check of the shape alone, with no project (an alert's columns at save), gives
`properties: "any"`; each run checks the project's names again. The metric form writes
`properties['name']` for a property filter and group-by, and `runQuery` refuses a property of a
query object or of a page filter that is not indexed, with the same code.

**Tasks: a `tasks` list (decision `rql-tasks`, RTL-397).** `traces` and `scores` have `tasks`, the
sorted ids of the tasks the trace ran in, read by the rule of the task scorers: the trace's own
OTLP turn, or a turn with a step on an event of the trace, with its `workflow_id`. It is a list, not
one `task_id`, because a trace can be a step of runs of more than one task. RQL filters it with
`contains(tasks, 'id')`. The metric form writes `each(tasks) as task` for the group-by `task`, as it
writes a model; the form compiler reads the same runs (`traceTasks`), so the two agree. A score whose
trace summary is gone has no task, as it has no other trace column.

**Every metric of the form is RQL (decision `metric-is-rql`).** `rate(condition)` is the share of
rows where the condition is true, a null counting as not true, as the form's rates count it (no
`CASE` needed). `coalesce(sum(x), 0)` gives 0 for a sum of no rows, as a metric and an alert read
it. `each(list)` reads a row once per distinct value of the list, as the form groups by a model,
a tool or an agent; every `each` of one list in a query is one value (one join), and under a page
filter of that list it gives only the values the filter keeps, as the form's group does. A
widget's text is `metricAsRql` of its form selection, and a parity test runs both on one fixture
for the whole matrix (`views/dashboards/metric-rql-parity.integration.test.ts`). The code that
draws the rows keeps the 10 groups of the highest sum and fills the empty buckets
(`views/dashboards/sql-chart.ts`): those belong to the chart, not to the language, and it invents
no total for an average or a percentile. The user cannot write
`::`, `->>`, `date_trunc`, `jsonb_*`, `@>`, `$1` or `now()`: the error names the RQL form. The
functions belong to the language, not to Postgres, so a later engine can run the same queries.

**Wall 1: the compiler.** `compileRql(text, { now, window? })` parses with `pgsql-ast-parser`
(behind the `RqlParser` port), checks the tree against the catalog, and prints its own SQL from
the checked tree. Each name in the SQL is a catalog name, each output column is `c1`, `c2`... (the
result names come back in `columns`), and each literal is a bound parameter (`$1`, `$2`...). No
text of the query reaches the database, comments included. The window is always `$1` and `$2`:
the caller gives it (by default the last 24 hours, at most 30 days for an agent's `run_rql`, at
most 372 days for a console run of a dashboard, Explore or an alert: decision `rql-console-window`),
never the query text, and a time filter in `WHERE` can only narrow it. A window `by: "known"` (an
alert rule) applies to when a row became known to Ratel: `traces.known_at` (the summary's last
write) and `scores.scored_at`; a table without such a column keeps its time column. So an alert
counts a trace that arrives late in the window it arrived in, as the metric form does. The `LIMIT` is lowered to a cap (1000; 100 when the
query has none). The bounds are in `domain/limits.ts`.

**The cost of one query is bounded.** Before the parse, which takes time that grows faster than
the text, the compiler refuses a text over 4000 characters, a second statement after a `;`, a
list over 100 items and an expression over 200 levels deep. It refuses more than 50 output
columns (each column of `*` counts). The runner reads the rows through a cursor, cuts each cell
at 2000 characters and stops the rows at 1 MB of JSON; a cut marks the result `truncated`. A
project runs at most 2 queries at the same time, and the RQL pool has 8 connections, so one
project cannot hold every connection. Kind `sql` takes the place of the project before the
compile. A run that waits past the connect timeout of the pool is `rql_busy`.

**Wall 2: the database.** The compiled SQL reads only the views `rql.events`, `rql.traces`,
`rql.scores`, `rql.sessions`, `rql.users` and `rql.prompts`. Each view filters on a per-transaction project
setting, and they are `security_barrier` views: the planner applies that filter before any
condition of the query, so a condition that fails cannot test another project's rows. The runner
executes the SQL as the role `ratel_rql`, which can read only those views,
in a read-only transaction with a statement timeout and a per-project cap on parallel queries.
A compiler bug then gives at most a wrong answer about the same project, not another tenant's
rows or a write.

**Sessions and users: the window applies to the traces, before the totals.** The views
`rql.sessions` and `rql.users` give one row per trace (of a session, of an end user). The compiler
emits a windowed derived query: it filters those trace rows on the window, groups them by
`session_id` or `user_id` into the totals columns (`trace_count`, `error_count`,
`first_trace_at`, `last_trace_at`, `total_duration_ms`, tokens, `cost_usd`, `session_count` for
users), and the query's own `WHERE`, `GROUP BY` and the rest apply to those totals. A view that
held the totals could not take the window: a session's total over all time is not its total in
the window. The views stay simple filters, and the totals have one definition, in the catalog.

**`user_id` is the raw end-user id.** Each view names the storage column `end_user_id` as
`user_id`. Its value is the end-user id as `trace_events` stores it: not hashed, and not a person of
the console.

**The page filter applies like the window, and through the trace.** A query that runs under a
page (a dashboard widget, an Explore panel) gets the page's trace filter from the caller, never
from the text, as it gets the window. The compiler adds it next to the window as bound
parameters: on `traces` as conditions on its own columns, and on `events`, `scores`, `sessions` and `users` as
`trace_id in (select trace_id from rql.traces where ...)`. Each part of the filter then applies on
every table, with the meaning the metric form gives it (the rows of the traces that match), so
the text of the metric form keeps a widget's numbers under a filter. On `sessions` and `users` it narrows the
trace rows before the totals, as the window does. Alert rules have no page and give no filter.

**One catalog, two uses.** `describeRqlSchema()` gives the MCP tool `describe_rql_schema` the
same tables, columns, functions, limits, rules and examples that the compiler checks against. A
test compiles every example.

## Consequences

- A new column, table or function is a change of the catalog, of the views and of the
  description, in one place each. A change of a name or a meaning is a new language version.
- Questions that need a join (span detail of the failed traces of one scorer) need two queries,
  or a column copied into the table. That is the price of a language that a tenant cannot escape.
- The views must expose exactly the catalog columns (`web/src/lib/synthesis/rql/README.md` lists
  them per view); a missing column is a runtime error, not a compile error.
- `pgsql-ast-parser` is a lexer and parser of Postgres in JavaScript, not Postgres itself. Its
  reading is the only reading, as the SQL is printed again: a form it reads otherwise than
  Postgres gives a refusal or another checked query, never text for the database. Its lexer
  reads a quote, a backslash, `--`, a nested `/*` and a non-ASCII character in a block comment
  otherwise than Postgres: the compiler then refuses the query.
