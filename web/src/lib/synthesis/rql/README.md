# `lib/synthesis/rql`

RQL (Ratel Query Language) is Ratel's read-only query language over trace data. The RQL compiler
([ADR-0011](../../../../../docs/adr/0011-rql-query-language.md)): RQL text to
Postgres SQL over the `rql` views with bound parameters, or to an error with a fix. The compiler
has no database access. The runner (`run.ts`) runs a compiled query on the read-only path.
`query.ts` makes RQL kind `sql` of the query object. The module has no background work and no
`register.ts`.

```ts
compileRql(text, { now, window? }):
  | { ok: true, sql, params, limitParam, columns: { name, type }[], table, window: { from, to }, limit, oneRow }
  | { ok: false, error: { code, message, fix, at? } }
describeRqlSchema(): RqlSchemaDescription   // for describe_rql_schema
runRql(compiled, { projectId }, deps?):
  | { ok: true, columns: { name, type }[], rows: unknown[][], truncated: boolean }
  | { ok: false, error: { code, message, fix } }
```

| File | Holds |
|---|---|
| `compile.ts` | the entry point: `compileRql` with the `pgsql-ast-parser` adapter, `describeRqlSchema`, the public types |
| `domain/catalog.ts` | pure: `RQL_VERSION`, the five tables (columns, types, descriptions, hints, the totals of `sessions` and `users`) and the functions |
| `domain/limits.ts` | `RQL_LIMITS`: the default and the longest window, the default and the most rows |
| `domain/ast.ts` | the parsed tree the parser port gives, with a `foreign` node for each refused construct |
| `domain/check.ts` | pure: the parsed tree to a typed tree of catalog names and literal values, or the error |
| `domain/rewrite.ts` | pure: prints the SQL from the typed tree; names are quoted catalog names, outputs are `c1`, `c2`..., values are `$n::type`; adds the window and the page filter |
| `domain/version.ts` | `RQL_VERSION` alone, so a browser bundle that writes a query of kind sql does not take the catalog |
| `domain/page-filter.ts` | pure: `RqlPageFilter` (the console's trace filter) and its conditions on `rql.traces` |
| `domain/window.ts`, `domain/compile.ts`, `domain/errors.ts` | the window rules; parse, check and rewrite in one call; the error codes and `nearestName` (edit distance) |
| `domain/describe.ts` | pure: the schema description (tables, columns, functions, operators, limits, rules, examples) |
| `ports/parser.ts`, `adapters/pgsql-ast-parser.ts` | the `RqlParser` port and its one adapter |
| `query.ts` | kind `sql` of the query object: fills `metricSeams.sql` on import (`sqlQueryRunner`), with the version check, the scope window, and every error as a `QueryError` with its code and fix |
| `run.ts` | the entry point of a run: `runRql` with the defaults (the RQL pool, the process gate, the timeout of `RQL_LIMITS`), the `feature.rql.run` span and the `feature.rql.query_run` event |
| `domain/run.ts`, `domain/gate.ts` | the gate first, then limit + 1 rows, the `truncated` mark, the values as JSON, and the run errors; the in-process cap of parallel queries per project |
| `ports/executor.ts`, `adapters/pg-executor.ts` | the `RqlExecutor` port (and `RqlSetupError`) and its node-postgres adapter: one transaction per run |

## The SQL

- `$1` and `$2` are always the window bounds. An equal value of an equal type is one parameter, so
  an expression in the select and in `GROUP BY` stays equal.
- The `LIMIT` is a parameter of its own, at index `limitParam` of `params`. No literal shares it,
  so the runner changes it alone: a literal equal to the limit keeps its value.
- The output columns are `c1`, `c2`...; `columns` gives their RQL names and types in that order.
- A row table reads `"rql"."<table>"` with the window on its time column joined to the query's
  `WHERE` by `and`. `sessions` and `users` read a derived query: the trace rows of the view in the
  window, grouped by `session_id` or `user_id` into the totals of the catalog; the query's
  clauses then apply to those totals.

## What the `rql` views must expose

Each view filters on the project of the transaction and exposes these columns, with these names.
The storage column `end_user_id` is `user_id` in each view: RQL has one name for the end user.
An RQL query that names `end_user_id` is refused, and the fix suggests `user_id`.
`rql.events`, `rql.traces` and `rql.scores` have the catalog columns in the catalog order.
`rql.sessions` and `rql.users` have the trace columns that the totals of the catalog read.

| View | Columns |
|---|---|
| `rql.events` (`otel_spans`) | `trace_id`, `span_id`, `parent_span_id`, `name`, `type` (`span_class`: `llm_call` to `llm_call`, `tool` to `tool_call`, `ratel_search` to `search`; another class with `operation_name` `invoke_agent` or `create_agent` to `agent_run`; each other span to `other`), `status` (`status_code`: 0 `unset`, 1 `ok`, 2 `error`), `started_at`, `ended_at`, `duration_ms`, `service_name`, `operation` (`operation_name`), `provider` (`provider_name`), `model`, `input_tokens`, `output_tokens`, `cached_tokens`, `reasoning_tokens`, `cost_usd`, `agent` (`agent_key`), `caller_agent` (`caller_agent_key`), `mcp_server`, `experiment_name`, `experiment_arm`, `session_id`, `user_id` (`end_user_id`), `attributes` |
| `rql.traces` (`otel_trace_summaries`) | `trace_id`, `started_at`, `duration_ms`, `has_error`, `root_error`, `input_tokens`, `output_tokens`, `cost_usd`, `models`, `tools`, `agents`, `mcp_servers`, `service_name`, `environment`, `geo_country`, `session_id`, `user_id` (`end_user_id`) |
| `rql.scores` (`trace_scores` with `trace_scorers` and `otel_trace_summaries`) | `scorer_id` (text), `scorer` (`trace_scorers.name`), `scorer_kind` (`trace_scorers.kind`), `trace_id`, `value`, `passed`, `confidence`, `scored_at`, `trace_started_at`, and from the trace: `session_id`, `user_id` (`end_user_id`), `service_name`, `environment`, `models`, `tools`, `agents` |
| `rql.sessions` (trace rows with a `session_id`) | `trace_id`, `session_id`, `user_id` (`end_user_id`), `started_at`, `duration_ms`, `has_error`, `input_tokens`, `output_tokens`, `cost_usd` |
| `rql.users` (trace rows with an `end_user_id`) | the columns of `rql.sessions` |

## The run

`adapters/pg-executor.ts` takes a connection of the RQL pool (`platform/db/rql-pool.ts`:
`RQL_DATABASE_URL`, else `DATABASE_URL`, never the primary pool), then:
`BEGIN READ ONLY`, `SET LOCAL ROLE ratel_rql`, `set_config('rql.project_id', $1, true)` and
`set_config('statement_timeout', $2, true)` with bound values, the compiled SQL with its params
and the one at `limitParam` (the `LIMIT`) replaced by `limit + 1`, then `ROLLBACK`. So the four walls are:

- The views of migration `0057_rql_views` keep only the rows of `rql.project_id`; unset, no row.
  They are `security_barrier` views: the project filter runs before any condition of the query, so
  a condition that fails cannot test another project's rows (`tests/isolation.integration.test.ts`).
  They run with the rights of their owner, so `ratel_rql` has SELECT on the views only and no
  grant on a base table: a read of `public.*` is `rql_permission_denied`.
- The transaction is read-only and the role has no write grant: a write is refused.
- `statement_timeout` is `RQL_LIMITS.timeoutMs`: a slow query is `rql_timeout`.
- The gate: `RQL_LIMITS.parallelQueriesPerProject` queries of one project at a time, in one
  process. One more is `rql_busy` at once and never reaches the database.

`rows` are arrays in the order of `columns` (not records: the RQL names can repeat). An integer
or a number is a JS number (pg gives `bigint` and `numeric` as strings), a timestamp is an ISO
string. `truncated` is true when the query had more than `limit` rows.

| Code | When |
|---|---|
| `rql_busy` | the project already runs its parallel maximum |
| `rql_timeout` | Postgres stopped the query (`57014`) |
| `rql_permission_denied` | the query read or wrote outside what `ratel_rql` may (`42501`) |
| `rql_read_only` | the query tried to write in the read-only transaction (`25006`) |
| `rql_unavailable` | no connection, or `SET ROLE ratel_rql` failed: the role is missing or the user is not a member |
| `rql_query_failed` | any other database error, with its message |

The span and the event carry the project, the table, the column and row counts, `truncated`,
the duration and the outcome code. Never the query text or a literal.

`tests/run.integration.test.ts` runs the walls on PGlite, which enforces roles, grants and READ
ONLY but not `statement_timeout`. With `RQL_TEST_DATABASE_URL` (a superuser of an empty Postgres)
it also runs every test, the timeout too, on Postgres:
`docker run --rm -d -e POSTGRES_PASSWORD=ratel -p 127.0.0.1:55923:5432 postgres:16-alpine`, then
`RQL_TEST_DATABASE_URL=postgres://postgres:ratel@127.0.0.1:55923/postgres`.

## Kind `sql` of the query object

`{ "version": 1, "kind": "sql", "text": "<RQL>", "rqlVersion": 1 }` runs through `runQuery` once
something imports `synthesis/rql/query`. The seam has no flag check: each caller of `runQuery` is
behind `customMonitoring` already. The text is compiled at every run, so a
saved query is checked again at load: a version newer than `RQL_VERSION` is `rql_version`, an older
one is compiled with today's RQL and, when it no longer compiles, the compile error says so. The
window of the query is the scope's (`since`, `until`). The filter of the scope (the page filter of a
dashboard or of Explore) goes to the compiler as `filter`: it keeps the rows whose trace matches, as
the metric form does. On `traces` each part is a condition on its own columns; on `events`,
`scores`, `sessions` and `users` it is `trace_id in (select trace_id from rql.traces where ...)`, so
every part (models, tools, services, environments, agents, MCP servers, status, minimum cost,
minimum tokens and the `and` clauses) applies on every table and no part is left out. On `sessions`
and `users` it narrows the trace rows before their totals. Each value is a bound parameter. Alert
rules give no filter.
A widget of chart `sql` holds the kind (`views/dashboards`: a table, or a chart for rows with one
time column), and so do dashboard documents and Explore's SQL mode. An alert rule holds it when the
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
- With `SELECT DISTINCT`, an `ORDER BY` on a value that is not selected is a Postgres error, not a
  compile error.
