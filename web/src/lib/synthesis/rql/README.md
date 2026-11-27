# `lib/synthesis/rql`

RQL (Ratel Query Language) is Ratel's read-only query language over trace data. The RQL compiler
([ADR-0011](../../../../../docs/adr/0011-rql-query-language.md)): RQL text to
Postgres SQL over the `rql` views with bound parameters, or to an error with a fix. The compiler
has no database access. The runner (`run.ts`) runs a compiled query on the read-only path.
`query.ts` makes RQL kind `sql` of the query object. The module has no background work and no
`register.ts`.

```ts
compileRql(text, { now, window?: { from, to, by? }, filter?, console?, properties?: { indexed, detected? } | "any" }):
  | { ok: true, sql, params, limitParam, columns: { name, type }[], table, window: { from, to }, limit, oneRow }
  | { ok: false, error: { code, message, fix, at?, property? } }
describeRqlSchema(properties?): RqlSchemaDescription   // for describe_rql_schema
runRql(compiled, { projectId }, deps?):
  | { ok: true, columns: { name, type }[], rows: unknown[][], truncated: boolean }
  | { ok: false, error: { code, message, fix } }
```

| File | Holds |
|---|---|
| `compile.ts` | the entry point: `compileRql` with the `pgsql-ast-parser` adapter, `describeRqlSchema`, the public types |
| `domain/catalog.ts` | pure: `RQL_VERSION`, the six tables (columns, types, descriptions, hints, the totals of `sessions` and `users`, the `knownColumn` of a window by known time) and the functions |
| `domain/limits.ts` | `RQL_LIMITS`: the window (24 hours by default, 30 days at most for `run_rql`, 372 days for a console run), the rows (100 by default, 1000 at most), the text (4000 characters), the output columns (50, each column of `*` counts), a list (100 items), the depth of an expression (200), a cell (2000 characters), a result (1 MB of JSON), the timeout (10 s) and the parallel queries of one project (2) |
| `domain/guard.ts` | pure: the checks before the parse, in one linear pass: the text length, a second statement after `;`, a list over 100 items, parentheses over 200 deep |
| `domain/result.ts` | pure: the cell cut and the byte cap of a result, and the row size the executor counts |
| `domain/ast.ts` | the parsed tree the parser port gives, with a `foreign` node for each refused construct |
| `domain/check.ts` | pure: the parsed tree to a typed tree of catalog names and literal values, or the error |
| `domain/rewrite.ts` | pure: prints the SQL from the typed tree; names are quoted catalog names, outputs are `c1`, `c2`..., values are `$n::type`; adds the window (by its time column, or by known time), the page filter, and one lateral join for each list that `each` reads |
| `domain/version.ts` | `RQL_VERSION` alone, so a browser bundle that writes a query of kind sql does not take the catalog |
| `domain/page-filter.ts` | pure: `RqlPageFilter` (the console's trace filter, trace properties included), its conditions on `rql.traces`, and the values it keeps of each list for `each` |
| `domain/properties.ts` | pure: `RqlProperties` (the project's indexed and detected names, which the caller reads: the compiler has no database), `propertyRefusal` (a name over 100 characters, a column property such as `user` with its column as the fix, a name that is not indexed) and `notIndexed` (code `property_not_indexed`: the name, and the fix "index it in project settings"). `"any"` is a check of the shape alone (an alert's columns at save, an old widget's chart): every name reads, and each run checks the project's names again |
| `domain/window.ts`, `domain/compile.ts`, `domain/errors.ts` | the window rules; parse, check and rewrite in one call; the error codes and `nearestName` (edit distance) |
| `domain/describe.ts` | pure: the schema description (tables, columns, functions, operators, limits, rules, examples), and with the project's properties a `properties` part: the indexed names, apart the detected ones, and a note |
| `domain/editor.ts` | pure: what the console's RQL field offers, from the same catalog: `rqlEditorData` (tables, columns, functions, `RQL_KEYWORDS`, the operators of the description) and `rqlCompletions` (tables after FROM, the columns of the table in FROM, else of every table; nothing in a string or a comment, except the project's property names inside `properties['`, a detected one marked `disabled`). The project's names are an input of `rqlEditorData(properties)`, not part of the catalog. `editor.test.ts` fails when it and the catalog or `describe_rql_schema` differ, and compiles every keyword |
| `ports/parser.ts`, `adapters/pgsql-ast-parser.ts` | the `RqlParser` port and its one adapter |
| `query.ts` | kind `sql` of the query object: fills `metricSeams.sql` on import (`sqlQueryRunner`), with the version check, the scope window, the project's properties (read with `loadStoredPropertyNames` only when the text names `properties`), and every error as a `QueryError` with its code and fix |
| `run.ts` | the entry point of a run: `runRql` with the defaults (the RQL pool, the process gate, the timeout of `RQL_LIMITS`), the `feature.rql.run` span and the `feature.rql.query_run` event |
| `domain/run.ts`, `domain/gate.ts` | the gate first, then limit + 1 rows, the cell and byte caps, the `truncated` mark, the values as JSON, and the run errors; the in-process cap of parallel queries per project |
| `ports/executor.ts`, `adapters/pg-executor.ts` | the `RqlExecutor` port (`RqlSetupError`, `RqlBusyError`) and its node-postgres adapter: one transaction and one cursor per run |

## The SQL

- `$1` and `$2` are always the window bounds. An equal value of an equal type is one parameter, so
  an expression in the select and in `GROUP BY` stays equal.
- The `LIMIT` is a parameter of its own, at index `limitParam` of `params`. No literal shares it,
  so the runner changes it alone: a literal equal to the limit keeps its value.
- The output columns are `c1`, `c2`...; `columns` gives their RQL names and types in that order.
- A row table reads `"rql"."<table>"` with the window on its time column joined to the query's
  `WHERE` by `and`. A window `by: "known"` applies to the table's `knownColumn` instead
  (`traces.known_at`, `scores.scored_at`), when it has one.
- `rate(c)` is `avg(case when c then 1.0 else 0.0 end)`: a null condition counts as not true.
  `coalesce` is `coalesce`.
- `each(list)` is `"each_<list>"."v"` of
  `cross join lateral (select distinct "v" from unnest("<list>") as "u"("v")) as "each_<list>"`: one
  join per list, so every `each` of one list is one value. A page filter that names the list adds
  `"each_<list>"."v" in (...)` for each of its clauses, as the metric form groups a filtered list. `sessions` and `users` read a derived query: the trace rows of the view in the
  window, grouped by `session_id` or `user_id` into the totals of the catalog; the query's
  clauses then apply to those totals.
- `properties['name']` is `("properties" ->> $n::text)`: the name is a bound value, never a name of
  the SQL. Only on `traces`, `events` and `scores`, and only for a name the project indexes
  (`property_not_indexed` otherwise, with the name and the fix). `user`, `session`, `environment`,
  `model` and `service` are columns: `properties['user']` is `property_is_column`, with `user_id` as
  the fix. The bare map (`select properties`, `properties is null`) is refused, and `select *` leaves
  it out: a stopped property keeps its stored values until a person erases them. A page filter of a
  property is `("properties" ->> $k) in (...)` on `rql.traces`.
- `tasks` (RTL-397, migration `0065`) is a list, as `models`: the sorted ids of the tasks (Agent
  health workflows) the trace ran in. A run of a task is a `trace_turns` row with its `workflow_id`:
  the trace's own OTLP turn (`turn_key` `otlp:<trace id>`), or a turn with a step on an event of the
  trace, the rule of the task scorers (`views/scorers/traces.ts#taskTraces`). A list, not one
  `task_id`: a trace can be a step of runs of more than one task (a runtime turn and its OTLP turn).
  `contains(tasks, 'id')` filters, `each(tasks) as task` groups (a trace of two tasks is in both
  groups, as with two models). The view reads the runs of the row's own project, with a correlated
  subquery on `trace_turns_project_turn_key_idx`, `trace_events_project_trace_idx` and
  `trace_turn_steps_project_event_idx`; an unread `tasks` costs nothing.

## What the `rql` views must expose

Each view filters on the project of the transaction and exposes these columns, with these names.
The storage column `end_user_id` is `user_id` in each view: RQL has one name for the end user.
`user_id` is the raw end-user id, as `trace_events` stores it: no hash, and no map to a person of
the console.
An RQL query that names `end_user_id` is refused, and the fix suggests `user_id`.
`rql.events`, `rql.traces`, `rql.scores` and `rql.prompts` have the catalog columns in the catalog order.
`rql.sessions` and `rql.users` have the trace columns that the totals of the catalog read.

| View | Columns |
|---|---|
| `rql.events` (`otel_spans`) | `trace_id`, `span_id`, `parent_span_id`, `name`, `type` (`span_class`: `llm_call` to `llm_call`, `tool` to `tool_call`, `ratel_search` to `search`; another class with `operation_name` `invoke_agent` or `create_agent` to `agent_run`; each other span to `other`), `status` (`status_code`: 0 `unset`, 1 `ok`, 2 `error`), `started_at`, `ended_at`, `duration_ms`, `service_name`, `operation` (`operation_name`), `provider` (`provider_name`), `model`, `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens`, `cost_usd`, `agent` (`agent_key`), `caller_agent` (`caller_agent_key`), `mcp_server`, `experiment_name`, `experiment_arm`, `session_id`, `user_id` (`end_user_id`), `attributes`, `properties` (`otel_spans.properties`, `{}` when null: the span's value, else an ancestor's, else its resource's) |
| `rql.traces` (`otel_trace_summaries`) | `trace_id`, `started_at`, `duration_ms`, `has_error`, `root_error`, `input_tokens`, `output_tokens`, `cost_usd`, `models`, `tools`, `agents`, `mcp_servers`, `service_name`, `environment`, `geo_country`, `session_id`, `user_id` (`end_user_id`), `known_at` (`updated_at`), `properties`, `tasks` |
| `rql.scores` (`trace_scores` with `trace_scorers` and `otel_trace_summaries`) | `scorer_id` (text), `scorer` (`trace_scorers.name`), `scorer_kind` (`trace_scorers.kind`), `trace_id`, `value`, `passed`, `confidence`, `scored_at`, `trace_started_at`, and from the trace: `session_id`, `user_id` (`end_user_id`), `service_name`, `environment`, `models`, `tools`, `agents`, `mcp_servers`, `trace_has_error`, `trace_input_tokens`, `trace_output_tokens`, `trace_cost_usd` (null when the trace is gone), `properties` (the trace's; `{}` when the trace is gone), `tasks` (the trace's; empty when the trace is gone) |
| `rql.sessions` (trace rows with a `session_id`) | `trace_id`, `session_id`, `user_id` (`end_user_id`), `started_at`, `duration_ms`, `has_error`, `input_tokens`, `output_tokens`, `cost_usd` |
| `rql.users` (trace rows with an `end_user_id`) | the columns of `rql.sessions` |
| `rql.prompts` (`event_metrics` with `events`) | `occurred_at` (`event_time`), `provider`, `model`, `input_tokens`, `output_tokens`, `context_tokens` (the sum of the five sources), `skills_tokens`, `tools_tokens`, `history_tokens`, `memory_tokens`, `user_input_tokens` (`tokens_by_category`, 0 for a missing key), `cost_usd`, `latency_ms` |

## The run

`adapters/pg-executor.ts` takes a connection of the RQL pool (`platform/db/rql-pool.ts`:
`RQL_DATABASE_URL`, else `DATABASE_URL`, never the primary pool), then:
`BEGIN READ ONLY`, `SET LOCAL ROLE ratel_rql`, `set_config('rql.project_id', $1, true)` and
`set_config('statement_timeout', $2, true)` with bound values, `DECLARE rql_rows NO SCROLL CURSOR FOR`
the compiled SQL with its params and the one at `limitParam` (the `LIMIT`) replaced by
`limit + 1`, `FETCH 100` until the cursor ends or the rows pass `RQL_LIMITS.maxResultBytes`
(the runner then marks the result truncated), each FETCH with what is left of the timeout as its
`statement_timeout`, so the whole read stops at the timeout, then
`ROLLBACK`. A cursor reads only a SELECT, so a write is a syntax error before it runs. So the four walls are:

- The views of migrations `0057_rql_views`, `0060_rql_scores_project`, `0062_rql_metric_parity` and `0064_rql_properties`
  keep only the rows of `rql.project_id`; unset, no row.
  They are `security_barrier` views: the project filter runs before any condition of the query, so
  a condition that fails cannot test another project's rows (`tests/isolation.integration.test.ts`).
  They run with the rights of their owner, so `ratel_rql` has SELECT on the views only and no
  grant on a base table: a read of `public.*` is `rql_permission_denied`.
- The transaction is read-only and the role has no write grant: a write is refused.
- `statement_timeout` is `RQL_LIMITS.timeoutMs`: a slow query is `rql_timeout`.
- The gate: `RQL_LIMITS.parallelQueriesPerProject` (2) queries of one project at a time, in one
  process. Kind `sql` takes the place before the compile, so a busy project costs no parse, and
  waits for it up to `RQL_LIMITS.gateWaitMs` (5 s), in order: a dashboard of more queries than
  the cap waits. None free in that time is `rql_busy`, and never reaches the database. An alert rule
  read by the evaluator (`scope.purpose: "alert"`) takes `rqlAlertGate`
  (`RQL_LIMITS.parallelAlertQueriesPerProject`, one query per project) and
  `RQL_LIMITS.alertTimeoutMs` (2 s) instead. A preview of the alert form stays on the interactive gate. The pool has `RQL_POOL_MAX` (8)
  connections for all projects, more than one project may hold, so another project still gets
  its answer. A run that waits past the connect timeout of the pool is `rql_busy` too.

`rows` are arrays in the order of `columns` (not records: the RQL names can repeat). An integer
or a number is a JS number (pg gives `bigint` and `numeric` as strings), a timestamp is an ISO
string. A cell over `RQL_LIMITS.maxCellChars` (2000) is cut to that length: a text keeps its
start, and a list or `attributes` becomes the start of its JSON, a text. The rows stop before
their JSON passes `RQL_LIMITS.maxResultBytes` (1 MB). `truncated` is true when the query had more
than `limit` rows, a cell was cut, or the rows stopped at the byte cap.

| Code | When |
|---|---|
| `rql_busy` | the project already runs its parallel maximum, or no connection of the pool came free in its connect timeout |
| `rql_timeout` | Postgres stopped the query (`57014`) |
| `rql_permission_denied` | the query read or wrote outside what `ratel_rql` may (`42501`) |
| `rql_read_only` | the query tried to write in the read-only transaction (`25006`) |
| `rql_unavailable` | no connection, or `SET ROLE ratel_rql` failed: the role is missing or the user is not a member |
| `rql_query_failed` | any other database error, with its message |

A compile refusal of `properties['name']` for a name that is not indexed has the code
`property_not_indexed` and the name in `property`: a widget shows "Property is not indexed" with
the link to the property in project settings, and `run_rql` gives the code as `reason`.

The span and the event carry the project, the table, the column and row counts, `truncated`,
the duration and the outcome code. Never the query text or a literal.

`tests/run.integration.test.ts` runs the walls on PGlite, which enforces roles, grants and READ
ONLY but not `statement_timeout`. With `RQL_TEST_DATABASE_URL` (a superuser of an empty Postgres)
it also runs every test, the timeout too, on Postgres:
`docker run --rm -d -e POSTGRES_PASSWORD=ratel -p 127.0.0.1:55923:5432 postgres:16-alpine`, then
`RQL_TEST_DATABASE_URL=postgres://postgres:ratel@127.0.0.1:55923/postgres`.

## Setup of the role

Migration `0057_rql_views` creates `ratel_rql` and grants it to the user that runs the migrations.
When that user cannot `CREATE ROLE`, the migration gives a WARNING and RQL is `rql_unavailable`.
Its comment and its WARNING say to run the DO block again as a superuser: that grants the role to
the superuser, not to the app, so it does not fix RQL. The fix is, as a superuser:
`CREATE ROLE ratel_rql NOLOGIN;`, then run migration 0057's grants (`GRANT USAGE ON SCHEMA rql TO
ratel_rql; GRANT SELECT ON ALL TABLES IN SCHEMA rql TO ratel_rql;`), then
`GRANT ratel_rql TO <app user>;`, where `<app user>` is the user of `RQL_DATABASE_URL` (else of
`DATABASE_URL`).

Migration `0056_session_user_ids` adds columns and builds three indexes. The migrator runs every
pending migration in one transaction, so the `ACCESS EXCLUSIVE` lock of its `ALTER TABLE` stays
through the three index scans, and reads of `otel_spans` and `otel_trace_summaries` wait too. On a
large database run the statements in the comment of the migration first, outside a transaction
(`CREATE INDEX CONCURRENTLY`). The migration then changes nothing.

Migration `0065_rql_tasks` builds `trace_turn_steps_project_event_idx` on `trace_turn_steps` the same
way: on a large database run the `CREATE INDEX CONCURRENTLY` statement in its comment first.

## Kind `sql` of the query object

`{ "version": 1, "kind": "sql", "text": "<RQL>", "rqlVersion": 1 }` runs through `runQuery` once
something imports `synthesis/rql/query`. The seam has no flag check: each caller of `runQuery` is
behind `customMonitoring` already. The text is compiled at every run, so a
saved query is checked again at load: a version newer than `RQL_VERSION` is `rql_version`, an older
one is compiled with today's RQL and, when it no longer compiles, the compile error says so. The
window of the query is the scope's (`since`, `until`, and `by: "known"` for an alert rule), up to
`consoleMaxWindowDays` (372); `run_rql` gives `scope.purpose: "agent"` and keeps `maxWindowDays` (30). The filter of the scope (the page filter of a
dashboard or of Explore) goes to the compiler as `filter`: it keeps the rows whose trace matches, as
the metric form does. On `traces` each part is a condition on its own columns; on `events`,
`scores`, `sessions` and `users` it is `trace_id in (select trace_id from rql.traces where ...)`, so
every part (models, tools, services, environments, agents, MCP servers, status, minimum cost,
minimum tokens and the `and` clauses) applies on every table and no part is left out. `prompts`
has no trace: the filter keeps all of its rows. On `sessions`
and `users` it narrows the trace rows before their totals. Each value is a bound parameter. Alert
rules give no filter.
Every metric widget holds the kind (`views/dashboards`: drawn as a line, a bar, a number or a
table, as its rows allow), with the form's selection when the form wrote the text, and so do
dashboard documents and Explore. An alert rule holds it when the
text gives one row with one number (`oneRow` and the column type, checked at save and at each run;
`views/alerts`). `query_monitoring` refuses it as one of several panels.
`query_monitoring` runs a lone query of the kind, and the MCP tool `run_rql` runs its RQL text as
this kind; `describe_rql_schema` gives `describeRqlSchema()` (`lib/mcp/README.md`, RQL through MCP).

## Limits of the parser

`pgsql-ast-parser` reads a quote, a backslash, `--`, a nested `/*` and a non-ASCII character in a
block comment otherwise than Postgres. The SQL is printed again, so this changes no safety: the
compiler refuses such a query. Line comments, and any text in a literal, are read correctly.

## Later

- Lists of `sessions` and `users` (their models, tools, agents) are not totals yet.
- `sessions` and `users` have no `properties`: a session's traces can hold different values. Read
  them on `traces` and group by `session_id` or `user_id` there.
- `properties['name'] = 'v'` reads `->>`, not the GIN index of the summaries: a `security_barrier`
  view applies the project filter first, and a containment of a later condition does not reach the
  index. The project and time indexes bound the rows.
- With `SELECT DISTINCT`, an `ORDER BY` on a value that is not selected is a Postgres error, not a
  compile error.
